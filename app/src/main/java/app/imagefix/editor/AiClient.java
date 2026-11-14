package app.imagefix.editor;

import android.util.JsonReader;
import android.util.JsonToken;
import android.util.MalformedJsonException;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.NoRouteToHostException;
import java.net.ConnectException;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.net.UnknownHostException;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadFactory;
import java.util.regex.Pattern;

import javax.net.ssl.SSLException;

/**
 * AI 요청 릴레이. 웹 페이지(WebView)는 CSP 와 외부 요청 차단 때문에 인터넷에 직접 접근할 수 없으므로,
 * 허용된 서버·경로로만 이 클래스가 대신 요청한다.
 *
 * - 서버는 {@link Config#baseUrl()} 하나(기본 https://api.openai.com/v1). 리다이렉트는 따라가지 않는다.
 * - 경로는 POST /images/edits, GET /models 두 가지뿐.
 * - Authorization 헤더는 여기서만 붙이고, 키는 JS 로 돌려주지 않는다.
 * - 결과 이미지는 메모리에 두었다가 /__ai/&lt;id&gt;/&lt;n&gt; 으로 WebView 에 제공한다(MainActivity.serveAi).
 * - Android 클래스는 JsonReader 만 써서 JVM 단위 테스트(tests/jvm)가 가능하다.
 */
final class AiClient {
    /** 서버 주소/키 공급자 (실기기: KeyVault, 테스트: 가짜) */
    interface Config {
        String baseUrl();

        String apiKey();
    }

    static final int UPLOADING = 0, RUNNING = 1, DONE = 2, ERROR = 3, CANCELLED = 4;
    static final long MAX_BODY = 24L * 1024 * 1024;
    static final long MAX_RESPONSE = 96L * 1024 * 1024;
    static final int MAX_JOBS = 8;
    static final long KEEP_MS = 20L * 60 * 1000;
    /** 테스트 전용: http:// 와 localhost 허용 */
    static boolean insecureForTests = false;

    private static final Pattern MULTIPART = Pattern.compile("^multipart/form-data; boundary=[A-Za-z0-9'()+_,./:=?-]{1,70}$");

    private static final class Job {
        String id, method, path, type;
        long len;
        ByteArrayOutputStream body;
        volatile int state = UPLOADING;
        volatile boolean cancelled;
        volatile HttpURLConnection conn;
        volatile long touched;
        final List<byte[]> images = new ArrayList<byte[]>();
        List<String> ids;
        int status;
        String code = "", errType = "", message = "";
    }

    private final Config cfg;
    private final Map<String, Job> jobs = new HashMap<String, Job>();
    private int seq = 0;
    private final ExecutorService exec = Executors.newFixedThreadPool(3, new ThreadFactory() {
        @Override
        public Thread newThread(Runnable r) {
            Thread t = new Thread(r, "ai-relay");
            t.setDaemon(true);
            return t;
        }
    });

    AiClient(Config cfg) {
        this.cfg = cfg;
    }

    private static long now() {
        return System.currentTimeMillis();
    }

    private Job get(String id) {
        synchronized (jobs) {
            return id == null ? null : jobs.get(id);
        }
    }

    private void purge() {
        List<String> drop = new ArrayList<String>();
        synchronized (jobs) {
            for (Map.Entry<String, Job> e : jobs.entrySet()) {
                Job j = e.getValue();
                if (j.state != RUNNING && now() - j.touched > KEEP_MS) drop.add(e.getKey());
            }
            for (String k : drop) jobs.remove(k);
        }
    }

    // ------------------------------------------------------------------ 공개 API (JS 브리지에서 호출)

    /** spec: {"method":"POST","path":"/images/edits","type":"multipart/form-data; boundary=…","len":123} 또는 {"method":"GET","path":"/models"}. 성공 시 작업 id */
    String begin(String specJson) {
        try {
            purge();
            JSONObject o = new JSONObject(specJson);
            String method = o.optString("method", "");
            String path = o.optString("path", "");
            Job j = new Job();
            if ("POST".equals(method) && "/images/edits".equals(path)) {
                String type = o.optString("type", "");
                long len = o.optLong("len", -1);
                if (!MULTIPART.matcher(type).matches()) return "ERR:type";
                if (len < 1 || len > MAX_BODY) return "ERR:len";
                j.type = type;
                j.len = len;
                j.body = new ByteArrayOutputStream((int) Math.min(len, 8L * 1024 * 1024));
            } else if ("GET".equals(method) && "/models".equals(path)) {
                j.len = 0;
            } else {
                return "ERR:path";
            }
            j.method = method;
            j.path = path;
            j.touched = now();
            synchronized (jobs) {
                if (jobs.size() >= MAX_JOBS) return "ERR:busy";
                j.id = "a" + (++seq);
                jobs.put(j.id, j);
            }
            return j.id;
        } catch (Throwable e) {
            return "ERR:spec";
        }
    }

    boolean chunk(String id, String b64) {
        Job j = get(id);
        if (j == null || j.state != UPLOADING || j.body == null || b64 == null) return false;
        try {
            byte[] d = Base64.getMimeDecoder().decode(b64);
            synchronized (j) {
                if (j.body == null || j.body.size() + (long) d.length > j.len) return false;
                j.body.write(d, 0, d.length);
            }
            j.touched = now();
            return true;
        } catch (Throwable e) {
            return false;
        }
    }

    boolean send(String id) {
        final Job j = get(id);
        if (j == null || j.state != UPLOADING) return false;
        synchronized (j) {
            if (j.body != null && j.body.size() != j.len) return false;
            if (j.cancelled) return false;
            j.state = RUNNING;
        }
        j.touched = now();
        exec.execute(new Runnable() {
            @Override
            public void run() {
                AiClient.this.run(j);
            }
        });
        return true;
    }

    String status(String id) {
        Job j = get(id);
        JSONObject o = new JSONObject();
        try {
            if (j == null) {
                o.put("state", "error").put("status", 0).put("code", "gone");
                return o.toString();
            }
            j.touched = now();
            switch (j.state) {
                case UPLOADING:
                    o.put("state", "uploading");
                    break;
                case RUNNING:
                    o.put("state", "running");
                    break;
                case DONE:
                    o.put("state", "done").put("n", j.images.size());
                    if (j.ids != null) o.put("ids", new JSONArray(j.ids));
                    break;
                case CANCELLED:
                    o.put("state", "cancelled");
                    break;
                default:
                    o.put("state", "error").put("status", j.status).put("code", j.code).put("type", j.errType).put("message", j.message);
            }
        } catch (Exception ignored) {
            // JSON 구성 실패는 없음
        }
        return o.toString();
    }

    byte[] result(String id, int i) {
        Job j = get(id);
        if (j == null || j.state != DONE || i < 0 || i >= j.images.size()) return null;
        j.touched = now();
        return j.images.get(i);
    }

    void cancel(String id) {
        final Job j = get(id);
        if (j == null) return;
        synchronized (j) {
            j.cancelled = true;
            if (j.state == UPLOADING) {
                j.state = CANCELLED;
                j.body = null;
            }
        }
        final HttpURLConnection c = j.conn;
        if (c != null) {
            exec.execute(new Runnable() {
                @Override
                public void run() {
                    try {
                        c.disconnect();
                    } catch (Throwable ignored) {
                        // 이미 닫힘
                    }
                }
            });
        }
    }

    void release(String id) {
        cancel(id);
        synchronized (jobs) {
            jobs.remove(id);
        }
    }

    // ------------------------------------------------------------------ 요청 실행 (백그라운드 스레드)

    private void fail(Job j, int status, String code, String type, String msg) {
        j.status = status;
        j.code = code == null ? "" : code;
        j.errType = type == null ? "" : type;
        j.message = msg == null ? "" : (msg.length() > 300 ? msg.substring(0, 300) : msg);
        j.state = j.cancelled ? CANCELLED : ERROR;
    }

    private void run(Job j) {
        HttpURLConnection c = null;
        try {
            String base = cfg.baseUrl();
            String key = cfg.apiKey();
            if (base == null || !(base.startsWith("https://") || (insecureForTests && base.startsWith("http://")))) {
                fail(j, 0, "bad_base", "", "server address is not https");
                return;
            }
            if (key == null || key.length() == 0) {
                fail(j, 401, "no_key", "", "no api key");
                return;
            }
            c = (HttpURLConnection) new URL(base + j.path).openConnection();
            j.conn = c;
            if (j.cancelled) throw new IOException("cancelled");
            c.setInstanceFollowRedirects(false);
            c.setUseCaches(false);
            c.setConnectTimeout(20000);
            c.setReadTimeout(270000);
            c.setRequestMethod(j.method);
            c.setRequestProperty("Authorization", "Bearer " + key);
            c.setRequestProperty("Accept", "application/json");
            c.setRequestProperty("User-Agent", "ImageFix/1");
            if ("POST".equals(j.method)) {
                byte[] body;
                synchronized (j) {
                    body = j.body.toByteArray();
                    j.body = null;
                }
                c.setDoOutput(true);
                c.setRequestProperty("Content-Type", j.type);
                // 스트리밍 모드를 쓰지 않는다: 401 같은 오류 응답의 본문을 JDK/안드로이드 모두에서 읽을 수 있게 하기 위함(본문은 이미 메모리에 있음)
                OutputStream out = c.getOutputStream();
                for (int off = 0; off < body.length; off += 65536) {
                    if (j.cancelled) throw new IOException("cancelled");
                    out.write(body, off, Math.min(65536, body.length - off));
                }
                out.flush();
            }
            int status = c.getResponseCode();
            if (j.cancelled) throw new IOException("cancelled");
            if (status != 200) {
                readError(j, status, status >= 400 ? c.getErrorStream() : c.getInputStream());
                return;
            }
            InputStream in = new Limited(c.getInputStream(), MAX_RESPONSE);
            try {
                if ("/models".equals(j.path)) parseModels(j, in); else parseImages(j, in);
            } catch (MalformedJsonException e) {
                fail(j, 200, "bad_response", "", "malformed response");
                return;
            } catch (IllegalStateException e) {
                fail(j, 200, "bad_response", "", "unexpected response shape");
                return;
            } catch (IllegalArgumentException e) {
                fail(j, 200, "bad_response", "", "invalid image data");
                return;
            }
            if (j.cancelled) {
                j.state = CANCELLED;
            } else if ("/models".equals(j.path) || !j.images.isEmpty()) {
                j.state = DONE;
            } else {
                fail(j, 200, "bad_response", "", "no images in response");
            }
        } catch (SocketTimeoutException e) {
            fail(j, 0, j.cancelled ? "cancelled" : "timeout", "", String.valueOf(e.getMessage()));
        } catch (UnknownHostException e) {
            fail(j, 0, "offline", "", String.valueOf(e.getMessage()));
        } catch (ConnectException e) {
            fail(j, 0, "offline", "", String.valueOf(e.getMessage()));
        } catch (NoRouteToHostException e) {
            fail(j, 0, "offline", "", String.valueOf(e.getMessage()));
        } catch (SSLException e) {
            fail(j, 0, j.cancelled ? "cancelled" : "tls", "", String.valueOf(e.getMessage()));
        } catch (IOException e) {
            fail(j, 0, j.cancelled ? "cancelled" : "network", "", String.valueOf(e.getMessage()));
        } catch (Throwable e) {
            fail(j, 0, j.cancelled ? "cancelled" : "bad_response", "", String.valueOf(e));
        } finally {
            if (j.state == RUNNING) fail(j, 0, "network", "", "interrupted");
            j.touched = now();
            j.conn = null;
            if (c != null) {
                try {
                    c.disconnect();
                } catch (Throwable ignored) {
                    // 이미 닫힘
                }
            }
        }
    }

    private static final class Limited extends FilterInputStream {
        private long left;

        Limited(InputStream in, long max) {
            super(in);
            left = max;
        }

        @Override
        public int read() throws IOException {
            if (left <= 0) throw new IOException("response too large");
            int r = super.read();
            if (r >= 0) left--;
            return r;
        }

        @Override
        public int read(byte[] b, int off, int len) throws IOException {
            if (left <= 0) throw new IOException("response too large");
            int r = super.read(b, off, (int) Math.min(len, left));
            if (r > 0) left -= r;
            return r;
        }
    }

    private static byte[] readAll(InputStream in, int max) throws IOException {
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while (bo.size() < max && (n = in.read(buf)) > 0) bo.write(buf, 0, Math.min(n, max - bo.size()));
        return bo.toByteArray();
    }

    private void readError(Job j, int status, InputStream in) {
        String code = "http_" + status, type = "", msg = "";
        try {
            if (in != null) {
                JSONObject o = new JSONObject(new String(readAll(in, 64 * 1024), "UTF-8"));
                JSONObject e = o.optJSONObject("error");
                if (e != null) {
                    Object c = e.opt("code");
                    if (c != null && c != JSONObject.NULL) code = String.valueOf(c);
                    type = e.optString("type", "");
                    msg = e.optString("message", "");
                }
            }
        } catch (Throwable ignored) {
            // 본문이 JSON 이 아니면 상태 코드만 전달
        }
        fail(j, status, code, type, msg);
    }

    /** {"data":[{"b64_json":"…"},…]} → 이미지 바이트. 큰 문자열이라 스트리밍으로 읽는다 */
    private void parseImages(Job j, InputStream in) throws IOException {
        JsonReader r = new JsonReader(new InputStreamReader(in, "UTF-8"));
        try {
            r.beginObject();
            while (r.hasNext()) {
                String name = r.nextName();
                if ("data".equals(name) && r.peek() == JsonToken.BEGIN_ARRAY) {
                    r.beginArray();
                    while (r.hasNext()) {
                        if (r.peek() != JsonToken.BEGIN_OBJECT) {
                            r.skipValue();
                            continue;
                        }
                        r.beginObject();
                        while (r.hasNext()) {
                            String k = r.nextName();
                            if ("b64_json".equals(k) && r.peek() == JsonToken.STRING) {
                                j.images.add(Base64.getMimeDecoder().decode(r.nextString()));
                            } else {
                                r.skipValue();
                            }
                            if (j.cancelled) throw new IOException("cancelled");
                        }
                        r.endObject();
                    }
                    r.endArray();
                } else {
                    r.skipValue();
                }
            }
            r.endObject();
        } finally {
            try {
                r.close();
            } catch (IOException ignored) {
                // noop
            }
        }
    }

    /** {"data":[{"id":"gpt-image-1"},…]} → id 목록(최대 600개) */
    private void parseModels(Job j, InputStream in) throws IOException {
        JsonReader r = new JsonReader(new InputStreamReader(in, "UTF-8"));
        List<String> ids = new ArrayList<String>();
        try {
            r.beginObject();
            while (r.hasNext()) {
                String name = r.nextName();
                if ("data".equals(name) && r.peek() == JsonToken.BEGIN_ARRAY) {
                    r.beginArray();
                    while (r.hasNext()) {
                        if (r.peek() != JsonToken.BEGIN_OBJECT) {
                            r.skipValue();
                            continue;
                        }
                        r.beginObject();
                        while (r.hasNext()) {
                            String k = r.nextName();
                            if ("id".equals(k) && r.peek() == JsonToken.STRING) {
                                String id = r.nextString();
                                if (ids.size() < 600 && id.length() <= 100) ids.add(id);
                            } else {
                                r.skipValue();
                            }
                        }
                        r.endObject();
                    }
                    r.endArray();
                } else {
                    r.skipValue();
                }
            }
            r.endObject();
        } finally {
            try {
                r.close();
            } catch (IOException ignored) {
                // noop
            }
        }
        j.ids = ids;
    }

    /** 테스트용: 진행 중 작업 수 */
    int jobCount() {
        synchronized (jobs) {
            return jobs.size();
        }
    }

    /** 테스트용: 남은 작업의 상태 이름들 */
    String debugStates() {
        StringBuilder sb = new StringBuilder();
        synchronized (jobs) {
            Iterator<Job> it = jobs.values().iterator();
            while (it.hasNext()) sb.append(it.next().state).append(',');
        }
        return sb.toString();
    }
}
