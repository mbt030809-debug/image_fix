package app.imagefix.editor;

import com.sun.net.httpserver.Headers;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import com.sun.net.httpserver.HttpServer;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.InetSocketAddress;
import java.nio.charset.Charset;
import java.util.Arrays;
import java.util.Base64;
import java.util.Random;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

/**
 * AiClient / KeyVault.validateBase JVM 테스트 (모의 HTTP 서버). 실행: tests/jvm/run.sh
 * 실기기와 같은 코드(AiClient)를 그대로 쓰고, https 제한만 insecureForTests 로 풀어 localhost 로 보낸다.
 */
public class AiClientTest {
    static int pass = 0, fail = 0;
    static final Charset UTF8 = Charset.forName("UTF-8");

    static void ok(boolean cond, String name) {
        if (cond) pass++;
        else {
            fail++;
            System.out.println("  ✗ FAIL: " + name);
        }
    }

    static class Cfg implements AiClient.Config {
        String base, key;

        Cfg(String base, String key) {
            this.base = base;
            this.key = key;
        }

        @Override
        public String baseUrl() {
            return base;
        }

        @Override
        public String apiKey() {
            return key;
        }
    }

    static final AtomicReference<byte[]> lastBody = new AtomicReference<byte[]>();
    static final AtomicReference<Headers> lastHeaders = new AtomicReference<Headers>();
    static final AtomicInteger evilHits = new AtomicInteger();
    static final byte[] IMG_A = new byte[]{(byte) 0x89, 'P', 'N', 'G', 1, 2, 3, 4, 5, 6, 7, 8, 9, 10};
    static final byte[] IMG_B = new byte[]{(byte) 0x89, 'P', 'N', 'G', 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9};

    static byte[] readAll(InputStream in) throws Exception {
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        byte[] b = new byte[8192];
        int n;
        while ((n = in.read(b)) > 0) bo.write(b, 0, n);
        return bo.toByteArray();
    }

    static void reply(HttpExchange x, int code, String body) throws Exception {
        byte[] b = body.getBytes(UTF8);
        x.getResponseHeaders().add("Content-Type", "application/json");
        x.sendResponseHeaders(code, b.length);
        x.getResponseBody().write(b);
        x.close();
    }

    public static void main(String[] args) throws Exception {
        HttpServer srv = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        srv.createContext("/", new HttpHandler() {
            @Override
            public void handle(HttpExchange x) {
                try {
                    String p = x.getRequestURI().getPath();
                    byte[] body = readAll(x.getRequestBody());
                    if (p.equals("/evil")) {
                        evilHits.incrementAndGet();
                        reply(x, 200, "{}");
                    } else if (p.equals("/ok/v1/images/edits")) {
                        lastBody.set(body);
                        lastHeaders.set(x.getRequestHeaders());
                        String a = Base64.getEncoder().encodeToString(IMG_A), b = Base64.getEncoder().encodeToString(IMG_B);
                        reply(x, 200, "{\"created\":1,\"data\":[{\"b64_json\":\"" + a + "\",\"revised_prompt\":\"x\"},{\"b64_json\":\"" + b + "\"}],\"usage\":{\"total_tokens\":5}}");
                    } else if (p.equals("/ok/v1/models")) {
                        lastHeaders.set(x.getRequestHeaders());
                        reply(x, 200, "{\"object\":\"list\",\"data\":[{\"id\":\"gpt-4o\",\"object\":\"model\"},{\"id\":\"gpt-image-1\"},{\"id\":\"gpt-image-1.5\",\"owned_by\":\"system\"}]}");
                    } else if (p.startsWith("/e401/")) {
                        reply(x, 401, "{\"error\":{\"message\":\"Incorrect API key provided: sk-...1234.\",\"type\":\"invalid_request_error\",\"param\":null,\"code\":\"invalid_api_key\"}}");
                    } else if (p.startsWith("/e429/")) {
                        reply(x, 429, "{\"error\":{\"message\":\"You exceeded your current quota\",\"type\":\"insufficient_quota\",\"code\":\"insufficient_quota\"}}");
                    } else if (p.startsWith("/e403/")) {
                        reply(x, 403, "{\"error\":{\"message\":\"Your organization must be verified to use the model `gpt-image-1`.\",\"type\":\"invalid_request_error\",\"code\":null}}");
                    } else if (p.startsWith("/e500/")) {
                        reply(x, 500, "<html>oops</html>");
                    } else if (p.startsWith("/html/")) {
                        reply(x, 200, "<html>captive portal</html>");
                    } else if (p.startsWith("/empty/")) {
                        reply(x, 200, "{\"data\":[]}");
                    } else if (p.startsWith("/redir/")) {
                        x.getResponseHeaders().add("Location", "http://127.0.0.1:" + srvPort(x) + "/evil");
                        x.sendResponseHeaders(302, -1);
                        x.close();
                    } else if (p.startsWith("/slow/")) {
                        try {
                            Thread.sleep(4000);
                        } catch (InterruptedException ignored) {
                            // 클라이언트가 끊음
                        }
                        reply(x, 200, "{\"data\":[]}");
                    } else {
                        reply(x, 404, "{}");
                    }
                } catch (Exception e) {
                    x.close();
                }
            }
        });
        srv.start();
        final String root = "http://127.0.0.1:" + srv.getAddress().getPort();
        AiClient.insecureForTests = true;

        // ---------------------------------------------------------------- KeyVault.validateBase
        System.out.println("▶ KeyVault.validateBase");
        ok(KeyVault.DEFAULT_BASE.equals(KeyVault.validateBase(null)) && KeyVault.DEFAULT_BASE.equals(KeyVault.validateBase("  ")), "empty → default");
        ok("https://api.openai.com/v1".equals(KeyVault.validateBase("https://api.openai.com/v1/")), "trailing slash trimmed");
        ok("https://example.com".equals(KeyVault.validateBase("https://EXAMPLE.com")), "host lowercased, no path");
        ok("https://gw.example.co.kr/openai/v1".equals(KeyVault.validateBase(" https://gw.example.co.kr/openai/v1 ")), "path kept");
        String[] bad = {"http://api.openai.com/v1", "https://user:pw@api.openai.com/v1", "https://127.0.0.1/v1", "https://localhost/v1", "https://printer.local/v1",
                "https://a.internal/v1", "https://x.com:8443/v1", "https://x.com/v1?a=1", "https://x.com/v1#f", "https://x.com/a b", "https://[::1]/v1", "ftp://x.com", "https://x.com/../v1",
                "https://x.com/./v1", "https://nodot/v1", "https://-bad.com/v1", "https://10.0.0.1/v1", "javascript:alert(1)", "https://", "https://x.com/" + new String(new char[200]).replace('\0', 'a')};
        for (String b : bad) ok(KeyVault.validateBase(b) == null, "rejects " + b.substring(0, Math.min(40, b.length())));

        // ---------------------------------------------------------------- begin 검증
        System.out.println("▶ AiClient.begin");
        AiClient c0 = new AiClient(new Cfg(root + "/ok/v1", "sk-test-1234567890"));
        ok(c0.begin("not json").startsWith("ERR:"), "begin: not json");
        ok("ERR:path".equals(c0.begin("{\"method\":\"POST\",\"path\":\"/chat/completions\",\"type\":\"multipart/form-data; boundary=x\",\"len\":5}")), "begin: path not allowed");
        ok("ERR:path".equals(c0.begin("{\"method\":\"DELETE\",\"path\":\"/models\"}")), "begin: method not allowed");
        ok("ERR:path".equals(c0.begin("{\"method\":\"GET\",\"path\":\"/images/edits\"}")), "begin: GET edits not allowed");
        ok("ERR:type".equals(c0.begin("{\"method\":\"POST\",\"path\":\"/images/edits\",\"type\":\"application/json\",\"len\":5}")), "begin: content type");
        ok("ERR:type".equals(c0.begin("{\"method\":\"POST\",\"path\":\"/images/edits\",\"type\":\"multipart/form-data; boundary=x\\r\\nX-Evil: 1\",\"len\":5}")), "begin: header injection in type");
        ok("ERR:len".equals(c0.begin("{\"method\":\"POST\",\"path\":\"/images/edits\",\"type\":\"multipart/form-data; boundary=abc\",\"len\":0}")), "begin: len 0");
        ok("ERR:len".equals(c0.begin("{\"method\":\"POST\",\"path\":\"/images/edits\",\"type\":\"multipart/form-data; boundary=abc\",\"len\":99999999999}")), "begin: len too big");
        ok(c0.jobCount() == 0, "failed begins leave no jobs");
        AiClient cb = new AiClient(new Cfg(root + "/ok/v1", "k"));
        for (int i = 0; i < AiClient.MAX_JOBS; i++) ok(cb.begin("{\"method\":\"GET\",\"path\":\"/models\"}").startsWith("a"), "begin job " + i);
        ok("ERR:busy".equals(cb.begin("{\"method\":\"GET\",\"path\":\"/models\"}")), "begin: too many jobs");

        // ---------------------------------------------------------------- 업로드 + 성공
        System.out.println("▶ AiClient edit: upload → success");
        byte[] payload = new byte[300 * 1024 + 17];
        new Random(7).nextBytes(payload);
        String ct = "multipart/form-data; boundary=----ImageFixTest123";
        String id = c0.begin("{\"method\":\"POST\",\"path\":\"/images/edits\",\"type\":\"" + ct + "\",\"len\":" + payload.length + "}");
        ok(id.startsWith("a"), "begin ok → id");
        ok(!c0.send(id), "send before full body is rejected");
        ok(new JSONObject(c0.status(id)).getString("state").equals("uploading"), "state uploading");
        int off = 0;
        while (off < payload.length) {
            int n = Math.min(192 * 1024, payload.length - off);
            ok(c0.chunk(id, Base64.getEncoder().encodeToString(Arrays.copyOfRange(payload, off, off + n))), "chunk accepted @" + off);
            off += n;
        }
        ok(!c0.chunk(id, Base64.getEncoder().encodeToString(new byte[1])), "chunk beyond declared length rejected");
        ok(c0.send(id), "send ok");
        JSONObject st = waitDone(c0, id, 8000);
        ok("done".equals(st.optString("state")) && st.optInt("n") == 2, "state done n=2: " + st);
        ok(Arrays.equals(lastBody.get(), payload), "server received exact body bytes");
        Headers h = lastHeaders.get();
        ok(h != null && "Bearer sk-test-1234567890".equals(h.getFirst("Authorization")), "Authorization header set by native");
        ok(h != null && ct.equals(h.getFirst("Content-Type")), "Content-Type forwarded");
        ok(h != null && String.valueOf(h.getFirst("User-Agent")).startsWith("ImageFix"), "User-Agent");
        ok(Arrays.equals(c0.result(id, 0), IMG_A) && Arrays.equals(c0.result(id, 1), IMG_B) && c0.result(id, 2) == null && c0.result(id, -1) == null, "result bytes by index");
        ok(c0.result("nope", 0) == null, "result unknown id");
        c0.release(id);
        ok("error".equals(new JSONObject(c0.status(id)).getString("state")) && "gone".equals(new JSONObject(c0.status(id)).getString("code")), "released job is gone");
        ok(c0.result(id, 0) == null, "released result is gone");

        // ---------------------------------------------------------------- /models
        System.out.println("▶ AiClient models");
        String mid = c0.begin("{\"method\":\"GET\",\"path\":\"/models\"}");
        ok(c0.send(mid), "models send (no body)");
        JSONObject ms = waitDone(c0, mid, 6000);
        JSONArray ids = ms.optJSONArray("ids");
        ok("done".equals(ms.optString("state")) && ids != null && ids.length() == 3 && "gpt-image-1.5".equals(ids.getString(2)), "models ids parsed: " + ms);

        // ---------------------------------------------------------------- 오류 매핑
        System.out.println("▶ AiClient errors");
        expectError(root + "/e401/v1", "sk-x1234567", 401, "invalid_api_key", "Incorrect API key", "401");
        expectError(root + "/e429/v1", "sk-x1234567", 429, "insufficient_quota", "quota", "429");
        expectError(root + "/e403/v1", "sk-x1234567", 403, "http_403", "verified", "403 (null code → http_403)");
        expectError(root + "/e500/v1", "sk-x1234567", 500, "http_500", "", "500 html body");
        expectError(root + "/html/v1", "sk-x1234567", 200, "bad_response", "", "200 but not JSON");
        expectError(root + "/empty/v1", "sk-x1234567", 200, "bad_response", "no images", "200 with no images");
        expectError(root + "/redir/v1", "sk-x1234567", 302, "http_302", "", "redirect is not followed");
        ok(evilHits.get() == 0, "redirect target never contacted");
        expectError("http://127.0.0.1:1/v1", "sk-x1234567", 0, "offline", "", "connection refused → offline");
        expectError(root + "/ok/v1", null, 401, "no_key", "", "no key stored");
        AiClient.insecureForTests = false;
        expectError(root + "/ok/v1", "sk-x1234567", 0, "bad_base", "", "http base rejected when not testing");
        AiClient.insecureForTests = true;

        // ---------------------------------------------------------------- 취소
        System.out.println("▶ AiClient cancel");
        AiClient cs = new AiClient(new Cfg(root + "/slow/v1", "sk-x1234567"));
        String sid = cs.begin("{\"method\":\"GET\",\"path\":\"/models\"}");
        cs.send(sid);
        Thread.sleep(250);
        long t0 = System.currentTimeMillis();
        cs.cancel(sid);
        JSONObject cst = waitFinal(cs, sid, 3000);
        long dt = System.currentTimeMillis() - t0;
        ok("cancelled".equals(cst.optString("state")) && dt < 2000, "cancel interrupts a slow request (" + dt + "ms): " + cst);
        String sid2 = cs.begin("{\"method\":\"GET\",\"path\":\"/models\"}");
        cs.cancel(sid2);
        ok("cancelled".equals(new JSONObject(cs.status(sid2)).getString("state")) && !cs.send(sid2), "cancel before send → cancelled, cannot send");

        srv.stop(0);
        System.out.println("\nJVM tests: " + pass + " passed, " + fail + " failed");
        System.exit(fail == 0 ? 0 : 1);
    }

    static int srvPort(HttpExchange x) {
        return x.getLocalAddress().getPort();
    }

    static JSONObject waitDone(AiClient c, String id, long ms) throws Exception {
        long end = System.currentTimeMillis() + ms;
        while (System.currentTimeMillis() < end) {
            JSONObject o = new JSONObject(c.status(id));
            String s = o.optString("state");
            if (!s.equals("running") && !s.equals("uploading")) return o;
            Thread.sleep(25);
        }
        return new JSONObject(c.status(id));
    }

    static JSONObject waitFinal(AiClient c, String id, long ms) throws Exception {
        return waitDone(c, id, ms);
    }

    static void expectError(String base, String key, int status, String code, String msgPart, String label) throws Exception {
        AiClient c = new AiClient(new Cfg(base, key));
        String id = c.begin("{\"method\":\"POST\",\"path\":\"/images/edits\",\"type\":\"multipart/form-data; boundary=abc\",\"len\":3}");
        c.chunk(id, Base64.getEncoder().encodeToString(new byte[]{1, 2, 3}));
        c.send(id);
        JSONObject o = waitDone(c, id, 8000);
        boolean good = "error".equals(o.optString("state")) && o.optInt("status", -1) == status && code.equals(o.optString("code")) && o.optString("message").contains(msgPart);
        ok(good, "error mapping " + label + " → " + o);
        c.release(id);
    }
}
