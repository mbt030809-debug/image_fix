package app.imagefix.editor;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.ConnectException;
import java.net.HttpURLConnection;
import java.net.NoRouteToHostException;
import java.net.SocketTimeoutException;
import java.net.URI;
import java.net.URISyntaxException;
import java.net.URL;
import java.net.UnknownHostException;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
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
 * - 제공자 프로필: cloudflare(Workers AI) / pollinations(키 없는 무료 클래식 API) / modelscope(API-Inference, 비동기 작업).
 *   서버는 프로필의 https 주소 하나뿐이다. 예외는 결과 이미지 내려받기 하나: modelscope 가 응답으로 알려 주는 이미지 주소를
 *   허용된 도메인 접미사(aliyuncs.com · modelscope.cn · modelscope.ai) 안에서만 받는다(https, 자격 증명·포트 없음).
 * - 경로는 프로필별 허용 목록(정규식)만, 요청 본문 형식도 경로별로 제한. 리다이렉트는 따라가지 않는다.
 * - Authorization 헤더는 여기서만 붙이고(키는 JS 로 돌려주지 않는다), 결과 이미지 내려받기에는 붙이지 않는다.
 * - 응답은 모두 본문 그대로(raw, 최대 48MB) 보관하고 웹이 해석한다. 결과는 /__ai/&lt;id&gt;/&lt;n&gt; 으로 WebView 에 제공(MainActivity.serveAi).
 * - Android 클래스는 쓰지 않아 JVM 단위 테스트(tests/jvm)가 가능하다.
 */
final class AiClient {
    /** 서버 주소/키/부가 값 공급자 (실기기: KeyVault, 테스트: 가짜) */
    interface Config {
        /** 제공자 서버 주소(https://…, 끝 슬래시 없음) */
        String baseUrl(String provider);

        String apiKey(String provider);

        /** 제공자별 부가 값 (cloudflare: 계정 ID). 없으면 빈 문자열 */
        String extra(String provider);

        /** 키가 저장돼 있는데 풀어 읽을 수 없나(보안 저장소 초기화·고장). 이 경우 "키 없음"이 아니라 "다시 저장" 안내가 나가야 한다 */
        default boolean keyUnreadable(String provider) {
            return false;
        }
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
    /** 결과 이미지 주소의 경로/쿼리(서명된 OSS 주소는 쿼리가 길다) */
    private static final Pattern RESULT_PATH_OK = Pattern.compile("^/[A-Za-z0-9._~%!$&'()*+,;=:@/-]{0,600}$");
    private static final Pattern RESULT_QUERY_OK = Pattern.compile("^[A-Za-z0-9=&._,%:+/~!*'()-]{0,900}$");

    /** 허용된 요청 한 종류 */
    static final class Route {
        final String method;
        final Pattern path;
        final Pattern type; // 요청 본문 Content-Type 허용 형식 (GET 은 null)
        String accept = "application/json";
        final List<String[]> headers = new ArrayList<String[]>(); // 이 경로에만 붙는 고정 헤더(JS 가 정할 수 없다)

        Route(String method, String pathRegex, Pattern type) {
            this.method = method;
            this.path = Pattern.compile(pathRegex);
            this.type = type;
        }

        Route accept(String a) {
            this.accept = a;
            return this;
        }

        Route header(String k, String v) {
            headers.add(new String[]{k, v});
            return this;
        }
    }

    /** 제공자 프로필: 인증 방식 + 허용 경로 (+ 결과 이미지를 받을 수 있는 도메인) */
    static final class Profile {
        final String id;
        final String authHeader, authPrefix; // authHeader == null → 인증 없음
        final boolean needsKey;
        final Pattern resultHost; // null → 결과 이미지 주소 내려받기 없음
        final Route[] routes;

        Profile(String id, String authHeader, String authPrefix, boolean needsKey, Pattern resultHost, Route... routes) {
            this.id = id;
            this.authHeader = authHeader;
            this.authPrefix = authPrefix;
            this.needsKey = needsKey;
            this.resultHost = resultHost;
            this.routes = routes;
        }
    }

    static final Map<String, Profile> PROFILES = new HashMap<String, Profile>();
    /** 결과 이미지 내려받기 요청에 쓰는 고정 설정 */
    private static final Route DOWNLOAD = new Route("GET", "^$", null).accept("image/png,image/jpeg,image/webp,image/*;q=0.8,*/*;q=0.5");

    static {
        PROFILES.put("cloudflare", new Profile("cloudflare", "Authorization", "Bearer ", true, null,
                // 모델 구간은 "."/".." 로 시작할 수 없다(경로 이탈 방지)
                new Route("POST", "^/accounts/\\{account\\}/ai/run/@cf/[A-Za-z0-9_-][A-Za-z0-9._-]*/[A-Za-z0-9_-][A-Za-z0-9._-]*$", MULTI_OR_JSON),
                new Route("GET", "^/accounts/\\{account\\}/ai/models/search$", null)));
        // 키 없이 쓰는 무료 클래식 API: GET /prompt/<URL 인코딩한 문구>?width=&height=&seed= → 이미지(JPEG)
        PROFILES.put("pollinations", new Profile("pollinations", null, "", false, null,
                new Route("GET", "^/prompt/[A-Za-z0-9%._~-]{1,2400}$", null).accept("image/jpeg,image/png,image/webp,image/*;q=0.8")));
        // API-Inference: 이미지 생성은 비동기 작업(POST 로 task_id → GET 으로 상태 확인 → 결과 이미지 주소 내려받기)
        PROFILES.put("modelscope", new Profile("modelscope", "Authorization", "Bearer ", true,
                Pattern.compile("^([a-z0-9-]+\\.)*(aliyuncs\\.com|modelscope\\.cn|modelscope\\.ai)$"),
                new Route("POST", "^/images/generations$", JSON_TYPE).header("X-ModelScope-Async-Mode", "true"),
                new Route("GET", "^/tasks/[A-Za-z0-9][A-Za-z0-9._-]{5,79}$", null).header("X-ModelScope-Task-Type", "image_generation"),
                new Route("GET", "^/models$", null)));
    }

    private static final class Job {
        String id, provider, method, path = "", query = "", type;
        Route route;
        long len;
        ByteArrayOutputStream body;
        volatile int state = UPLOADING;
        volatile boolean cancelled;
        volatile HttpURLConnection conn;
        volatile long touched;
        final List<byte[]> images = new ArrayList<byte[]>();
        String rawType;
        boolean download;
        String absUrl;
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

    /** 이 제공자가 API 키(토큰)를 요구하나 (pollinations 는 아니다) */
    static boolean needsKey(String id) {
        Profile p = id == null ? null : PROFILES.get(id);
        return p != null && p.needsKey;
    }

    static boolean validAccount(String s) {
        return s != null && ACCOUNT_OK.matcher(s).matches();
    }

    /**
     * 결과 이미지 주소 검증: https · 허용된 도메인 접미사 · 자격 증명/조각 없음 · 포트 없음 · 경로/쿼리 문자 제한.
     * 통과하면 그 주소, 아니면 null. (테스트에서는 insecureForTests 로 localhost 의 http 를 허용)
     */
    static String checkResultUrl(Profile pf, String raw) {
        if (pf == null || pf.resultHost == null || raw == null || raw.length() == 0 || raw.length() > 1500) return null;
        URI u;
        try {
            u = new URI(raw);
        } catch (URISyntaxException e) {
            return null;
        }
        String scheme = u.getScheme();
        boolean http = insecureForTests && "http".equals(scheme);
        if (!"https".equals(scheme) && !http) return null;
        if (u.getRawUserInfo() != null || u.getRawFragment() != null) return null;
        String host = u.getHost();
        if (host == null) return null;
        host = host.toLowerCase(Locale.ROOT);
        boolean testHost = insecureForTests && (host.equals("127.0.0.1") || host.equals("localhost"));
        if (!testHost) {
            if (u.getPort() != -1 && u.getPort() != 443) return null;
            if (!pf.resultHost.matcher(host).matches()) return null;
        }
        String path = u.getRawPath();
        if (path == null || !RESULT_PATH_OK.matcher(path).matches()) return null;
        String q = u.getRawQuery();
        if (q != null && !RESULT_QUERY_OK.matcher(q).matches()) return null;
        return raw;
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
     * spec: {"provider":"modelscope","method":"POST","path":"/images/generations","type":"application/json","len":123}
     * 또는 {"provider":"pollinations","method":"GET","path":"/prompt/a%20cat?width=768&height=768".
     * path 에는 허용된 쿼리(?a=b)를 붙일 수 있고, cloudflare 경로의 {account} 는 저장된 계정 ID 로 치환된다.
     * 결과 이미지 내려받기: {"provider":"modelscope","method":"GET","url":"https://….aliyuncs.com/…"} (허용된 도메인만).
     * 성공 시 작업 id
     */
    String begin(String specJson) {
        try {
            purge();
            JSONObject o = new JSONObject(specJson);
            String provider = o.optString("provider", "");
            Profile pf = PROFILES.get(provider);
            if (pf == null) return "ERR:provider";
            String method = o.optString("method", "");
            Job j = new Job();
            String abs = o.optString("url", "");
            if (abs.length() > 0) {
                if (!"GET".equals(method)) return "ERR:path";
                String ok = checkResultUrl(pf, abs);
                if (ok == null) return "ERR:path";
                j.download = true;
                j.absUrl = ok;
                j.route = DOWNLOAD;
            } else {
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
                if ("POST".equals(method)) {
                    String type = o.optString("type", "");
                    long len = o.optLong("len", -1);
                    if (route.type == null || !route.type.matcher(type).matches()) return "ERR:type";
                    if (len < 1 || len > MAX_BODY) return "ERR:len";
                    j.type = type;
                    j.len = len;
                    j.body = new ByteArrayOutputStream((int) Math.min(len, 8L * 1024 * 1024));
                }
                j.path = path;
                j.query = query;
                j.route = route;
            }
            j.provider = provider;
            j.method = method;
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

    /** 응답의 Content-Type (알려진 이미지/JSON 형식이 아니면 application/octet-stream) */
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
        String t = (s >= 0 ? ct.substring(0, s) : ct).trim().toLowerCase(Locale.ROOT);
        if (t.equals("application/json") || t.equals("image/png") || t.equals("image/jpeg") || t.equals("image/webp") || t.equals("text/plain")) return t;
        return "application/octet-stream";
    }

    private void run(Job j) {
        HttpURLConnection c = null;
        try {
            Profile pf = PROFILES.get(j.provider);
            String url;
            String key = null;
            if (j.download) {
                url = j.absUrl; // 인증 헤더 없이, 검증된 주소로만
            } else {
                String base = cfg.baseUrl(j.provider);
                if (base == null || !(base.startsWith("https://") || (insecureForTests && base.startsWith("http://")))) {
                    fail(j, 0, "bad_base", "", "server address is not https");
                    return;
                }
                if (pf.needsKey) {
                    key = cfg.apiKey(j.provider);
                    if (key == null || key.length() == 0) {
                        if (cfg.keyUnreadable(j.provider)) fail(j, 401, "key_unreadable", "", "stored api key cannot be decrypted");
                        else fail(j, 401, "no_key", "", "no api key");
                        return;
                    }
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
                url = base + path + (j.query.length() > 0 ? "?" + j.query : "");
            }
            c = (HttpURLConnection) new URL(url).openConnection();
            j.conn = c;
            if (j.cancelled) throw new IOException("cancelled");
            c.setInstanceFollowRedirects(false);
            c.setUseCaches(false);
            c.setConnectTimeout(20000);
            c.setReadTimeout(270000);
            c.setRequestMethod(j.method);
            if (key != null && pf.authHeader != null) c.setRequestProperty(pf.authHeader, pf.authPrefix + key);
            c.setRequestProperty("Accept", j.route.accept);
            c.setRequestProperty("User-Agent", "ImageFix/1");
            for (String[] h : j.route.headers) c.setRequestProperty(h[0], h[1]);
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
                readRaw(j, in, c.getContentType());
            } catch (IllegalStateException e) {
                fail(j, 200, "bad_response", "", String.valueOf(e.getMessage()));
                return;
            }
            j.state = j.cancelled ? CANCELLED : DONE;
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

    /** 응답 본문을 그대로 보관 (너무 크면 오류) */
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

    /** 오류 응답에서 code/message 를 뽑는다: {error:{code,message}} · {errors:[{code,message}]}(Cloudflare) · {errors:{code,message}}(ModelScope) · {error:"…"} · {message:"…"} · 일반 텍스트 */
    private void readError(Job j, int status, InputStream in) {
        String code = "http_" + status, type = "", msg = "";
        try {
            if (in != null) {
                String text = new String(readAll(in, 64 * 1024), "UTF-8");
                JSONObject o = null;
                try {
                    o = new JSONObject(text);
                } catch (Throwable notJson) {
                    String s = text.trim();
                    if (s.length() > 0 && s.length() < 400 && s.indexOf('<') < 0) msg = s; // 짧은 일반 텍스트 오류(예: 한도 안내)
                }
                if (o != null) {
                    Object eo = o.opt("error");
                    JSONObject e = o.optJSONObject("error");
                    JSONArray errs = o.optJSONArray("errors");
                    JSONObject errObj = o.optJSONObject("errors");
                    if (e != null) {
                        Object c = e.opt("code");
                        if (c != null && c != JSONObject.NULL) code = String.valueOf(c);
                        type = e.optString("type", "");
                        msg = e.optString("message", "");
                    } else if (errs != null && errs.length() > 0) {
                        JSONObject e0 = errs.optJSONObject(0);
                        if (e0 != null) {
                            Object c = e0.opt("code");
                            if (c != null && c != JSONObject.NULL) code = "cf_" + c;
                            msg = e0.optString("message", "");
                        }
                    } else if (errObj != null) {
                        Object c = errObj.opt("code");
                        if (c != null && c != JSONObject.NULL && String.valueOf(c).length() > 0) code = String.valueOf(c);
                        msg = errObj.optString("message", "");
                    } else if (eo instanceof String) {
                        msg = (String) eo;
                    }
                    if (msg.length() == 0 && o.has("message")) msg = o.optString("message", "");
                    if (msg.length() == 0 && o.has("detail")) msg = o.optString("detail", "");
                }
            }
        } catch (Throwable ignored) {
            // 본문을 못 읽으면 상태 코드만 전달
        }
        fail(j, status, code, type, msg);
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
