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
import java.net.ConnectException;
import java.net.HttpURLConnection;
import java.net.NoRouteToHostException;
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
 * 허용된 제공자(서버)·경로로만 이 클래스가 대신 요청한다.
 *
 * - 제공자 프로필: openai(서버 주소 변경 가능) / openrouter / cloudflare(Workers AI). 서버는 프로필의 https 주소 하나뿐.
 * - 경로는 프로필별 허용 목록(정규식)만, 요청 본문 형식도 경로별로 제한. 리다이렉트는 따라가지 않는다.
 * - Authorization 헤더는 여기서만 붙이고, 키는 JS 로 돌려주지 않는다.
 * - 응답 모드: images(OpenAI data[].b64_json 을 풀어 n장) / models(id 목록) / raw(응답 본문 그대로, 최대 48MB — 웹에서 해석).
 * - 결과는 메모리에 두었다가 /__ai/&lt;id&gt;/&lt;n&gt; 으로 WebView 에 제공한다(MainActivity.serveAi).
 * - Android 클래스는 JsonReader 만 써서 JVM 단위 테스트(tests/jvm)가 가능하다.
 */
final class AiClient {
    /** 서버 주소/키/부가 값 공급자 (실기기: KeyVault, 테스트: 가짜) */
    interface Config {
        /** 제공자 서버 주소(https://…, 끝 슬래시 없음) */
        String baseUrl(String provider);

        String apiKey(String provider);

        /** 제공자별 부가 값 (cloudflare: 계정 ID). 없으면 빈 문자열 */
        String extra(String provider);
    }

    static final int UPLOADING = 0, RUNNING = 1, DONE = 2, ERROR = 3, CANCELLED = 4;
    static final long MAX_BODY = 24L * 1024 * 1024;
    static final long MAX_RESPONSE = 96L * 1024 * 1024;
    static final int MAX_RAW = 48 * 1024 * 1024;
    static final int MAX_JOBS = 8;
    static final long KEEP_MS = 20L * 60 * 1000;
    /** 테스트 전용: http:// 와 localhost 허용 */
    static boolean insecureForTests = false;

    private static final Pattern MULTIPART = Pattern.compile("^multipart/form-data; boundary=[A-Za-z0-9'()+_,./:=?-]{1,70}$");
    private static final Pattern JSON_TYPE = Pattern.compile("^application/json$");
    private static final Pattern MULTI_OR_JSON = Pattern.compile("^(application/json|multipart/form-data; boundary=[A-Za-z0-9'()+_,./:=?-]{1,70})$");
    private static final Pattern QUERY_OK = Pattern.compile("^[A-Za-z0-9=&._,%:-]{0,160}$");
    private static final Pattern ACCOUNT_OK = Pattern.compile("^[0-9a-f]{32}$");

    /** 허용된 요청 한 종류 */
    static final class Route {
        final String method;
        final Pattern path;
        final Pattern type; // 요청 본문 Content-Type 허용 형식 (GET 은 null)
        final String mode;  // images | models | raw

        Route(String method, String pathRegex, Pattern type, String mode) {
            this.method = method;
            this.path = Pattern.compile(pathRegex);
            this.type = type;
            this.mode = mode;
        }
    }

    /** 제공자 프로필: 인증 방식 + 허용 경로 */
    static final class Profile {
        final String id;
        final String authHeader, authPrefix;
        final String[][] extraHeaders;
        final Route[] routes;

        Profile(String id, String authHeader, String authPrefix, String[][] extraHeaders, Route... routes) {
            this.id = id;
            this.authHeader = authHeader;
            this.authPrefix = authPrefix;
            this.extraHeaders = extraHeaders;
            this.routes = routes;
        }
    }

    static final Map<String, Profile> PROFILES = new HashMap<String, Profile>();

    static {
        PROFILES.put("openai", new Profile("openai", "Authorization", "Bearer ", new String[0][],
                new Route("POST", "^/images/edits$", MULTIPART, "images"),
                new Route("POST", "^/images/generations$", JSON_TYPE, "images"), // 문구만으로 새 이미지(사진을 보내지 않음)
                new Route("GET", "^/models$", null, "models")));
        PROFILES.put("openrouter", new Profile("openrouter", "Authorization", "Bearer ", new String[][]{{"X-Title", "ImageFix"}},
                new Route("POST", "^/chat/completions$", JSON_TYPE, "raw"),
                new Route("GET", "^/models$", null, "raw"),
                new Route("GET", "^/key$", null, "raw")));
        PROFILES.put("cloudflare", new Profile("cloudflare", "Authorization", "Bearer ", new String[0][],
                // 모델 구간은 "."/".." 로 시작할 수 없다(경로 이탈 방지)
                new Route("POST", "^/accounts/\\{account\\}/ai/run/@cf/[A-Za-z0-9_-][A-Za-z0-9._-]*/[A-Za-z0-9_-][A-Za-z0-9._-]*$", MULTI_OR_JSON, "raw"),
                new Route("GET", "^/accounts/\\{account\\}/ai/models/search$", null, "raw")));
    }

    private static final class Job {
        String id, provider, method, path, query = "", type;
        Route route;
        long len;
        ByteArrayOutputStream body;
        volatile int state = UPLOADING;
        volatile boolean cancelled;
        volatile HttpURLConnection conn;
        volatile long touched;
        final List<byte[]> images = new ArrayList<byte[]>();
        List<String> ids;
        String rawType;
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

    static boolean knownProvider(String id) {
        return id != null && PROFILES.containsKey(id);
    }

    static boolean validAccount(String s) {
        return s != null && ACCOUNT_OK.matcher(s).matches();
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

    /**
     * spec: {"provider":"openrouter","method":"POST","path":"/chat/completions","type":"application/json","len":123}
     * 또는 {"provider":"openai","method":"GET","path":"/models"}. path 에는 허용된 쿼리(?a=b)를 붙일 수 있고,
     * cloudflare 경로의 {account} 는 저장된 계정 ID 로 치환된다. 성공 시 작업 id
     */
    String begin(String specJson) {
        try {
            purge();
            JSONObject o = new JSONObject(specJson);
            String provider = o.optString("provider", "openai");
            Profile pf = PROFILES.get(provider);
            if (pf == null) return "ERR:provider";
            String method = o.optString("method", "");
            String full = o.optString("path", "");
            String path = full, query = "";
            int q = full.indexOf('?');
            if (q >= 0) {
                path = full.substring(0, q);
                query = full.substring(q + 1);
                if (!QUERY_OK.matcher(query).matches()) return "ERR:path";
            }
            Route route = null;
            for (Route r : pf.routes) {
                if (r.method.equals(method) && r.path.matcher(path).matches()) {
                    route = r;
                    break;
                }
            }
            if (route == null) return "ERR:path";
            Job j = new Job();
            if ("POST".equals(method)) {
                String type = o.optString("type", "");
                long len = o.optLong("len", -1);
                if (route.type == null || !route.type.matcher(type).matches()) return "ERR:type";
                if (len < 1 || len > MAX_BODY) return "ERR:len";
                j.type = type;
                j.len = len;
                j.body = new ByteArrayOutputStream((int) Math.min(len, 8L * 1024 * 1024));
            }
            j.provider = provider;
            j.method = method;
            j.path = path;
            j.query = query;
            j.route = route;
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
                    if (j.rawType != null) o.put("raw", true).put("ctype", j.rawType);
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

    /** raw 모드 응답의 Content-Type (그 외 null) */
    String resultType(String id) {
        Job j = get(id);
        return j == null ? null : j.rawType;
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

    private static String baseType(String ct) {
        if (ct == null) return "application/octet-stream";
        int s = ct.indexOf(';');
        String t = (s >= 0 ? ct.substring(0, s) : ct).trim().toLowerCase(java.util.Locale.ROOT);
        if (t.equals("application/json") || t.equals("image/png") || t.equals("image/jpeg") || t.equals("image/webp") || t.equals("text/plain")) return t;
        return "application/octet-stream";
    }

    private void run(Job j) {
        HttpURLConnection c = null;
        try {
            Profile pf = PROFILES.get(j.provider);
            String base = cfg.baseUrl(j.provider);
            String key = cfg.apiKey(j.provider);
            if (base == null || !(base.startsWith("https://") || (insecureForTests && base.startsWith("http://")))) {
                fail(j, 0, "bad_base", "", "server address is not https");
                return;
            }
            if (key == null || key.length() == 0) {
                fail(j, 401, "no_key", "", "no api key");
                return;
            }
            String path = j.path;
            if (path.contains("{account}")) {
                String acc = cfg.extra(j.provider);
                if (!validAccount(acc)) {
                    fail(j, 0, "no_account", "", "account id is missing");
                    return;
                }
                path = path.replace("{account}", acc);
            }
            String url = base + path + (j.query.length() > 0 ? "?" + j.query : "");
            c = (HttpURLConnection) new URL(url).openConnection();
            j.conn = c;
            if (j.cancelled) throw new IOException("cancelled");
            c.setInstanceFollowRedirects(false);
            c.setUseCaches(false);
            c.setConnectTimeout(20000);
            c.setReadTimeout(270000);
            c.setRequestMethod(j.method);
            c.setRequestProperty(pf.authHeader, pf.authPrefix + key);
            c.setRequestProperty("Accept", "application/json");
            c.setRequestProperty("User-Agent", "ImageFix/1");
            for (String[] h : pf.extraHeaders) c.setRequestProperty(h[0], h[1]);
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
            String mode = j.route.mode;
            try {
                if ("models".equals(mode)) parseModels(j, in);
                else if ("raw".equals(mode)) readRaw(j, in, c.getContentType());
                else parseImages(j, in);
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
            } else if ("models".equals(mode) || "raw".equals(mode) || !j.images.isEmpty()) {
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

    /** raw 모드: 응답 본문을 그대로 보관 (너무 크면 오류) */
    private void readRaw(Job j, InputStream in, String contentType) throws IOException {
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        byte[] buf = new byte[16384];
        int n;
        while ((n = in.read(buf)) > 0) {
            if (bo.size() + (long) n > MAX_RAW) throw new IllegalStateException("raw response too large");
            bo.write(buf, 0, n);
            if (j.cancelled) throw new IOException("cancelled");
        }
        if (bo.size() == 0) throw new IllegalStateException("empty response");
        j.images.add(bo.toByteArray());
        j.rawType = baseType(contentType);
    }

    private void readError(Job j, int status, InputStream in) {
        String code = "http_" + status, type = "", msg = "";
        try {
            if (in != null) {
                JSONObject o = new JSONObject(new String(readAll(in, 64 * 1024), "UTF-8"));
                JSONObject e = o.optJSONObject("error");
                JSONArray errs = o.optJSONArray("errors");
                if (e != null) {
                    Object c = e.opt("code");
                    if (c != null && c != JSONObject.NULL) code = String.valueOf(c);
                    type = e.optString("type", "");
                    msg = e.optString("message", "");
                    JSONObject md = e.optJSONObject("metadata");
                    if (md != null) {
                        String raw = md.optString("raw", "");
                        if (raw.length() > 0) msg = msg + " | " + raw;
                    }
                } else if (errs != null && errs.length() > 0) {
                    JSONObject e0 = errs.optJSONObject(0);
                    if (e0 != null) {
                        Object c = e0.opt("code");
                        if (c != null && c != JSONObject.NULL) code = "cf_" + c;
                        msg = e0.optString("message", "");
                    }
                } else if (o.has("message")) {
                    msg = o.optString("message", "");
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
