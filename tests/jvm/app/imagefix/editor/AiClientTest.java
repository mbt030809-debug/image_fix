package app.imagefix.editor;

import com.sun.net.httpserver.Headers;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import com.sun.net.httpserver.HttpServer;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.InetSocketAddress;
import java.nio.charset.Charset;
import java.util.Arrays;
import java.util.Base64;
import java.util.Random;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * AiClient JVM 테스트 (모의 HTTP 서버). 실행: tests/jvm/run.sh
 * 실기기와 같은 코드(AiClient)를 그대로 쓰고, https 제한만 insecureForTests 로 풀어 localhost 로 보낸다.
 * 제공자: cloudflare(키+계정 ID, JSON/multipart) · modelscope(편집: 비동기 작업 + 결과 내려받기) · gemini(generateContent) · huggingface(FLUX.1 Fill, fal 경유)
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
        final java.util.Map<String, String> bases = new java.util.HashMap<String, String>();
        final java.util.Map<String, String> keys = new java.util.HashMap<String, String>();
        final java.util.Map<String, String> extras = new java.util.HashMap<String, String>();
        final java.util.Set<String> unreadable = new java.util.HashSet<String>();

        Cfg with(String provider, String base, String key, String extra) {
            bases.put(provider, base);
            if (key != null) keys.put(provider, key);
            if (extra != null) extras.put(provider, extra);
            return this;
        }

        @Override
        public String baseUrl(String provider) {
            String b = bases.get(provider);
            return b != null ? b : "https://invalid.example";
        }

        @Override
        public String apiKey(String provider) {
            return keys.get(provider);
        }

        @Override
        public String extra(String provider) {
            String e = extras.get(provider);
            return e == null ? "" : e;
        }

        @Override
        public boolean keyUnreadable(String provider) {
            return unreadable.contains(provider);
        }
    }

    // 모의 서버가 마지막으로 받은 요청(이름별)
    static final ConcurrentHashMap<String, Headers> H = new ConcurrentHashMap<String, Headers>();
    static final ConcurrentHashMap<String, byte[]> B = new ConcurrentHashMap<String, byte[]>();
    static final ConcurrentHashMap<String, String> U = new ConcurrentHashMap<String, String>();
    static final ConcurrentHashMap<String, String> M = new ConcurrentHashMap<String, String>();
    static final AtomicInteger evilHits = new AtomicInteger(), polls = new AtomicInteger();
    static final byte[] IMG_A = new byte[]{(byte) 0x89, 'P', 'N', 'G', 1, 2, 3, 4, 5, 6, 7, 8, 9, 10};
    static final byte[] JPG = new byte[]{(byte) 0xff, (byte) 0xd8, (byte) 0xff, (byte) 0xe0, 0, 16, 'J', 'F', 'I', 'F', 0, 1, 2, 3};

    static void rec(String name, HttpExchange x, byte[] body) {
        H.put(name, x.getRequestHeaders());
        B.put(name, body);
        U.put(name, x.getRequestURI().getRawPath() + (x.getRequestURI().getRawQuery() == null ? "" : "?" + x.getRequestURI().getRawQuery()));
        M.put(name, x.getRequestMethod());
    }

    static byte[] readAll(InputStream in) throws Exception {
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        byte[] b = new byte[8192];
        int n;
        while ((n = in.read(b)) > 0) bo.write(b, 0, n);
        return bo.toByteArray();
    }

    static void reply(HttpExchange x, int code, String body) throws Exception {
        replyBytes(x, code, "application/json", body.getBytes(UTF8));
    }

    static void replyBytes(HttpExchange x, int code, String type, byte[] b) throws Exception {
        if (type != null) x.getResponseHeaders().add("Content-Type", type);
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
                    } else if (p.startsWith("/cf/client/v4/accounts/") && p.contains("/ai/run/")) {
                        rec("cf", x, body);
                        reply(x, 200, "{\"result\":{\"image\":\"QUJD\"},\"success\":true,\"errors\":[],\"messages\":[]}");
                    } else if (p.startsWith("/cf/client/v4/accounts/") && p.endsWith("/ai/models/search")) {
                        rec("cfsearch", x, body);
                        reply(x, 200, "{\"result\":[{\"name\":\"@cf/black-forest-labs/flux-2-klein-4b\"}],\"success\":true}");
                    } else if (p.startsWith("/cf401/")) {
                        reply(x, 401, "{\"success\":false,\"errors\":[{\"code\":10000,\"message\":\"Authentication error\"}],\"messages\":[],\"result\":null}");
                    } else if (p.startsWith("/cferr/client/v4/")) {
                        reply(x, 429, "{\"success\":false,\"errors\":[{\"code\":3036,\"message\":\"you have used up your daily free allocation of 10,000 neurons\"}],\"messages\":[],\"result\":null}");
                    } else if (p.startsWith("/cfbin/client/v4/")) {
                        replyBytes(x, 200, "image/png", IMG_A);
                    } else if (p.startsWith("/cfhtml/client/v4/")) {
                        replyBytes(x, 200, "text/html; charset=utf-8", "<html>x</html>".getBytes(UTF8));
                    } else if (p.startsWith("/e500/")) {
                        reply(x, 500, "<html>oops</html>");
                    } else if (p.startsWith("/empty/")) {
                        replyBytes(x, 200, "application/json", new byte[0]);
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
                    } else if (p.startsWith("/gm/models/") && p.endsWith(":generateContent")) {
                        rec("gm", x, body);
                        reply(x, 200, "{\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"ok\"},{\"inlineData\":{\"mimeType\":\"image/png\",\"data\":\"QUJD\"}}]}}]}");
                    } else if (p.equals("/gm/models")) {
                        rec("gmList", x, body);
                        reply(x, 200, "{\"models\":[{\"name\":\"models/gemini-2.5-flash-image\"},{\"name\":\"models/gemini-2.5-pro\"}]}");
                    } else if (p.startsWith("/gm400/models/")) {
                        reply(x, 400, "{\"error\":{\"code\":400,\"message\":\"API key not valid. Please pass a valid API key.\",\"status\":\"INVALID_ARGUMENT\"}}");
                    } else if (p.equals("/hf/fal-ai/fal-ai/flux-lora-fill")) {
                        rec("hf", x, body);
                        reply(x, 200, "{\"images\":[{\"url\":\"data:image/png;base64,QUJD\",\"content_type\":\"image/png\"}]}");
                    } else if (p.startsWith("/hf403/")) {
                        reply(x, 403, "{\"error\":\"Access to model black-forest-labs/FLUX.1-Fill-dev is restricted (gated)\"}");
                    } else if (p.equals("/ms/v1/images/generations")) {
                        rec("msSubmit", x, body);
                        reply(x, 200, "{\"task_id\":\"task-abc123456\",\"request_id\":\"r1\"}");
                    } else if (p.startsWith("/ms/v1/tasks/")) {
                        rec("msPoll", x, body);
                        if (polls.incrementAndGet() < 2) reply(x, 200, "{\"task_status\":\"RUNNING\"}");
                        else reply(x, 200, "{\"task_status\":\"SUCCEED\",\"output_images\":[\"http://127.0.0.1:" + srvPort(x) + "/img/result.png?Expires=1&Signature=abc%2Bdef%3D\"]}");
                    } else if (p.equals("/ms/v1/models")) {
                        rec("msModels", x, body);
                        reply(x, 200, "{\"object\":\"list\",\"data\":[{\"id\":\"Qwen/Qwen3-8B\"}]}");
                    } else if (p.equals("/img/result.png")) {
                        rec("img", x, body);
                        replyBytes(x, 200, "image/png", IMG_A);
                    } else if (p.equals("/img/octet.png")) {
                        replyBytes(x, 200, "application/octet-stream", IMG_A);
                    } else if (p.equals("/img/html")) {
                        replyBytes(x, 200, "text/html", "<html>x</html>".getBytes(UTF8));
                    } else if (p.equals("/img/redir")) {
                        x.getResponseHeaders().add("Location", "http://127.0.0.1:" + srvPort(x) + "/evil");
                        x.sendResponseHeaders(302, -1);
                        x.close();
                    } else if (p.equals("/img/missing")) {
                        reply(x, 404, "{\"message\":\"not found\"}");
                    } else if (p.startsWith("/ms401/v1/")) {
                        reply(x, 401, "{\"errors\":{\"message\":\"Invalid token\",\"code\":401},\"request_id\":\"x\"}");
                    } else if (p.startsWith("/ms429/v1/")) {
                        reply(x, 429, "{\"errors\":{\"message\":\"Request limit exceeded\",\"code\":\"RateLimitExceeded\"}}");
                    } else if (p.startsWith("/msmsg/v1/")) {
                        reply(x, 400, "{\"message\":\"model not supported\",\"request_id\":\"x\"}");
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
        final String ACC = "0123456789abcdef0123456789abcdef";
        final String MP = "multipart/form-data; boundary=----ImageFixTest123";

        // ---------------------------------------------------------------- 제공자/키 규칙
        System.out.println("▶ providers");
        ok(AiClient.knownProvider("cloudflare") && AiClient.knownProvider("modelscope") && AiClient.knownProvider("gemini") && AiClient.knownProvider("huggingface"), "four providers");
        ok(!AiClient.knownProvider("pollinations"), "Pollinations is gone");
        ok(!AiClient.knownProvider("openai") && !AiClient.knownProvider("openrouter") && !AiClient.knownProvider(null) && !AiClient.knownProvider(""), "OpenAI/OpenRouter are gone");
        ok(AiClient.needsKey("cloudflare") && AiClient.needsKey("modelscope") && AiClient.needsKey("gemini") && AiClient.needsKey("huggingface") && !AiClient.needsKey("pollinations") && !AiClient.needsKey("openai"), "every provider needs a key");
        ok(AiClient.validAccount(ACC) && !AiClient.validAccount("ABCDEF0123456789abcdef0123456789") && !AiClient.validAccount("short") && !AiClient.validAccount(null), "account id validation");

        // ---------------------------------------------------------------- begin 검증 (cloudflare)
        System.out.println("▶ AiClient.begin (cloudflare)");
        Cfg cfc = new Cfg().with("cloudflare", root + "/cf/client/v4", "cf-token-333333", ACC);
        AiClient c0 = new AiClient(cfc);
        String RUN = "/accounts/{account}/ai/run/@cf/black-forest-labs/flux-2-klein-4b";
        ok(c0.begin("not json").startsWith("ERR:"), "begin: not json");
        ok("ERR:provider".equals(c0.begin("{\"provider\":\"openai\",\"method\":\"GET\",\"path\":\"/models\"}")), "begin: openai is not a provider anymore");
        ok("ERR:provider".equals(c0.begin("{\"method\":\"GET\",\"path\":\"/models\"}")), "begin: provider is required");
        ok("ERR:path".equals(c0.begin("{\"provider\":\"cloudflare\",\"method\":\"DELETE\",\"path\":\"" + RUN + "\"}")), "begin: method not allowed");
        ok("ERR:path".equals(c0.begin("{\"provider\":\"cloudflare\",\"method\":\"GET\",\"path\":\"" + RUN + "\"}")), "begin: GET on a POST route");
        ok("ERR:path".equals(c0.begin("{\"provider\":\"cloudflare\",\"method\":\"POST\",\"path\":\"/chat/completions\",\"type\":\"application/json\",\"len\":5}")), "begin: path not allowed");
        ok("ERR:type".equals(c0.begin("{\"provider\":\"cloudflare\",\"method\":\"POST\",\"path\":\"" + RUN + "\",\"type\":\"text/plain\",\"len\":5}")), "begin: content type");
        ok("ERR:type".equals(c0.begin("{\"provider\":\"cloudflare\",\"method\":\"POST\",\"path\":\"" + RUN + "\",\"type\":\"multipart/form-data; boundary=x\\r\\nX-Evil: 1\",\"len\":5}")), "begin: header injection in type");
        ok("ERR:len".equals(c0.begin("{\"provider\":\"cloudflare\",\"method\":\"POST\",\"path\":\"" + RUN + "\",\"type\":\"application/json\",\"len\":0}")), "begin: len 0");
        ok("ERR:len".equals(c0.begin("{\"provider\":\"cloudflare\",\"method\":\"POST\",\"path\":\"" + RUN + "\",\"type\":\"application/json\",\"len\":99999999999}")), "begin: len too big");
        ok("ERR:path".equals(c0.begin("{\"provider\":\"cloudflare\",\"method\":\"POST\",\"path\":\"/accounts/" + ACC + "/ai/run/@cf/a/b\",\"type\":\"application/json\",\"len\":3}")), "cloudflare: literal account id not allowed (must use {account})");
        ok("ERR:path".equals(c0.begin("{\"provider\":\"cloudflare\",\"method\":\"POST\",\"path\":\"/accounts/{account}/ai/run/@cf/../b\",\"type\":\"application/json\",\"len\":3}")), "cloudflare: traversal rejected");
        ok("ERR:path".equals(c0.begin("{\"provider\":\"cloudflare\",\"method\":\"POST\",\"path\":\"/accounts/{account}/ai/run/@hf/a/b\",\"type\":\"application/json\",\"len\":3}")), "cloudflare: only @cf models");
        ok("ERR:path".equals(c0.begin("{\"provider\":\"cloudflare\",\"method\":\"GET\",\"path\":\"/accounts/{account}/ai/models/search?a=b c\"}")), "query with illegal chars rejected");
        ok("ERR:path".equals(c0.begin("{\"provider\":\"cloudflare\",\"method\":\"GET\",\"path\":\"/user/tokens/verify\"}")), "cloudflare: other paths rejected");
        ok(c0.jobCount() == 0, "failed begins leave no jobs");
        AiClient cb = new AiClient(cfc);
        for (int i = 0; i < AiClient.MAX_JOBS; i++) ok(cb.begin("{\"provider\":\"cloudflare\",\"method\":\"GET\",\"path\":\"/accounts/{account}/ai/models/search\"}").startsWith("a"), "begin job " + i);
        ok("ERR:busy".equals(cb.begin("{\"provider\":\"cloudflare\",\"method\":\"GET\",\"path\":\"/accounts/{account}/ai/models/search\"}")), "begin: too many jobs");

        // ---------------------------------------------------------------- 업로드 + 성공 (Cloudflare multipart)
        System.out.println("▶ AiClient upload → success (cloudflare)");
        byte[] payload = new byte[300 * 1024 + 17];
        new Random(7).nextBytes(payload);
        String id = c0.begin("{\"provider\":\"cloudflare\",\"method\":\"POST\",\"path\":\"" + RUN + "\",\"type\":\"" + MP + "\",\"len\":" + payload.length + "}");
        ok(id.startsWith("a"), "begin ok → id");
        ok(!c0.send(id), "send before full body is rejected");
        ok("uploading".equals(new JSONObject(c0.status(id)).getString("state")), "state uploading");
        int off = 0;
        while (off < payload.length) {
            int n = Math.min(192 * 1024, payload.length - off);
            ok(c0.chunk(id, Base64.getEncoder().encodeToString(Arrays.copyOfRange(payload, off, off + n))), "chunk accepted @" + off);
            off += n;
        }
        ok(!c0.chunk(id, Base64.getEncoder().encodeToString(new byte[1])), "chunk beyond declared length rejected");
        ok(c0.send(id), "send ok");
        JSONObject st = waitDone(c0, id, 8000);
        ok("done".equals(st.optString("state")) && st.optInt("n") == 1 && st.optBoolean("raw") && "application/json".equals(st.optString("ctype")), "state done (raw json): " + st);
        ok(Arrays.equals(B.get("cf"), payload), "server received exact body bytes");
        Headers h = H.get("cf");
        ok(h != null && "Bearer cf-token-333333".equals(h.getFirst("Authorization")), "Authorization header set by native");
        ok(h != null && MP.equals(h.getFirst("Content-Type")), "Content-Type forwarded");
        ok(h != null && String.valueOf(h.getFirst("User-Agent")).startsWith("ImageFix"), "User-Agent");
        ok(("/cf/client/v4/accounts/" + ACC + "/ai/run/@cf/black-forest-labs/flux-2-klein-4b").equals(U.get("cf")), "{account} replaced with the stored id: " + U.get("cf"));
        ok("QUJD".equals(new JSONObject(new String(c0.result(id, 0), UTF8)).getJSONObject("result").getString("image")) && c0.result(id, 1) == null && c0.result(id, -1) == null, "result bytes by index");
        ok(c0.result("nope", 0) == null, "result unknown id");
        c0.release(id);
        ok("gone".equals(new JSONObject(c0.status(id)).getString("code")) && c0.result(id, 0) == null, "released job is gone");
        String sid3 = c0.begin("{\"provider\":\"cloudflare\",\"method\":\"GET\",\"path\":\"/accounts/{account}/ai/models/search?per_page=50&search=flux\"}");
        c0.send(sid3);
        ok("done".equals(waitDone(c0, sid3, 6000).optString("state")) && U.get("cfsearch").endsWith("/ai/models/search?per_page=50&search=flux"), "models/search with query");

        // ---------------------------------------------------------------- 오류 매핑
        System.out.println("▶ AiClient errors");
        expectCf(root + "/cf401/client/v4", "cf-token-333333", ACC, 401, "cf_10000", "Authentication error", "401 (Cloudflare errors[])");
        expectCf(root + "/cferr/client/v4", "cf-token-333333", ACC, 429, "cf_3036", "daily free allocation", "429 free allocation used up");
        expectCf(root + "/e500/v1", "cf-token-333333", ACC, 500, "http_500", "", "500 html body");
        expectCf(root + "/empty/v1", "cf-token-333333", ACC, 200, "bad_response", "empty", "200 with an empty body");
        expectCf(root + "/redir/v1", "cf-token-333333", ACC, 302, "http_302", "", "redirect is not followed");
        ok(evilHits.get() == 0, "redirect target never contacted");
        expectCf("http://127.0.0.1:1/v1", "cf-token-333333", ACC, 0, "offline", "", "connection refused → offline");
        expectCf(root + "/cf/client/v4", null, ACC, 401, "no_key", "", "no key stored");
        expectCf(root + "/cf/client/v4", "cf-token-333333", "", 0, "no_account", "", "no account id");
        Cfg unread = new Cfg().with("cloudflare", root + "/cf/client/v4", null, ACC);
        unread.unreadable.add("cloudflare");
        AiClient cu = new AiClient(unread);
        String uid = cu.begin("{\"provider\":\"cloudflare\",\"method\":\"POST\",\"path\":\"" + RUN + "\",\"type\":\"application/json\",\"len\":2}");
        cu.chunk(uid, Base64.getEncoder().encodeToString(new byte[]{'{', '}'}));
        cu.send(uid);
        JSONObject uo = waitDone(cu, uid, 4000);
        ok("error".equals(uo.optString("state")) && "key_unreadable".equals(uo.optString("code")) && uo.optInt("status") == 401, "stored key that cannot be decrypted → key_unreadable (not no_key): " + uo);
        AiClient.insecureForTests = false;
        expectCf(root + "/cf/client/v4", "cf-token-333333", ACC, 0, "bad_base", "", "http base rejected when not testing");
        AiClient.insecureForTests = true;
        // 바이너리 이미지 응답(raw) / 허용되지 않은 Content-Type
        AiClient cbin = new AiClient(new Cfg().with("cloudflare", root + "/cfbin/client/v4", "cf-token-333333", ACC));
        String bid = cbin.begin("{\"provider\":\"cloudflare\",\"method\":\"POST\",\"path\":\"" + RUN + "\",\"type\":\"application/json\",\"len\":2}");
        cbin.chunk(bid, Base64.getEncoder().encodeToString(new byte[]{'{', '}'}));
        cbin.send(bid);
        JSONObject bst = waitDone(cbin, bid, 6000);
        ok("done".equals(bst.optString("state")) && "image/png".equals(bst.optString("ctype")) && Arrays.equals(cbin.result(bid, 0), IMG_A) && "image/png".equals(cbin.resultType(bid)), "binary png response kept as raw: " + bst);
        AiClient chtml = new AiClient(new Cfg().with("cloudflare", root + "/cfhtml/client/v4", "cf-token-333333", ACC));
        String hid = chtml.begin("{\"provider\":\"cloudflare\",\"method\":\"POST\",\"path\":\"" + RUN + "\",\"type\":\"application/json\",\"len\":2}");
        chtml.chunk(hid, Base64.getEncoder().encodeToString(new byte[]{'{', '}'}));
        chtml.send(hid);
        waitDone(chtml, hid, 6000);
        ok("application/octet-stream".equals(chtml.resultType(hid)), "unexpected content-type is not trusted (octet-stream)");

        // ---------------------------------------------------------------- 취소
        System.out.println("▶ AiClient cancel");
        AiClient cs = new AiClient(new Cfg().with("cloudflare", root + "/slow/v1", "cf-token-333333", ACC));
        String sid = cs.begin("{\"provider\":\"cloudflare\",\"method\":\"GET\",\"path\":\"/accounts/{account}/ai/models/search\"}");
        cs.send(sid);
        Thread.sleep(250);
        long t0 = System.currentTimeMillis();
        cs.cancel(sid);
        JSONObject cst = waitDone(cs, sid, 3000);
        long dt = System.currentTimeMillis() - t0;
        ok("cancelled".equals(cst.optString("state")) && dt < 2000, "cancel interrupts a slow request (" + dt + "ms): " + cst);
        String sid2 = cs.begin("{\"provider\":\"cloudflare\",\"method\":\"GET\",\"path\":\"/accounts/{account}/ai/models/search\"}");
        cs.cancel(sid2);
        ok("cancelled".equals(new JSONObject(cs.status(sid2)).getString("state")) && !cs.send(sid2), "cancel before send → cancelled, cannot send");

        // ---------------------------------------------------------------- Gemini
        System.out.println("▶ Gemini: generateContent");
        AiClient cg = new AiClient(new Cfg().with("gemini", root + "/gm", "AIza-test-key-5555", null));
        for (String bad : new String[]{"/models/x", "/models/gemini:streamGenerateContent", "/models/../x:generateContent", "/models/a b:generateContent", "/models/:generateContent", "/v1/models/gemini-x:generateContent", "/models/" + new String(new char[62]).replace('\0', 'a') + ":generateContent"})
            ok("ERR:path".equals(cg.begin("{\"provider\":\"gemini\",\"method\":\"POST\",\"path\":\"" + bad + "\",\"type\":\"application/json\",\"len\":2}")), "gemini: rejects " + bad.substring(0, Math.min(30, bad.length())));
        ok("ERR:type".equals(cg.begin("{\"provider\":\"gemini\",\"method\":\"POST\",\"path\":\"/models/gemini-2.5-flash-image:generateContent\",\"type\":\"" + MP + "\",\"len\":3}")), "gemini: JSON only");
        ok("ERR:path".equals(cg.begin("{\"provider\":\"gemini\",\"method\":\"GET\",\"url\":\"https://x.aliyuncs.com/x.png\"}")), "gemini: no result-download host");
        byte[] gbody = "{\"contents\":[{\"parts\":[{\"text\":\"한글\"}]}]}".getBytes(UTF8);
        String gid = cg.begin("{\"provider\":\"gemini\",\"method\":\"POST\",\"path\":\"/models/gemini-2.5-flash-image:generateContent\",\"type\":\"application/json\",\"len\":" + gbody.length + "}");
        ok(gid.startsWith("a"), "gemini begin ok (colon in the path)");
        cg.chunk(gid, Base64.getEncoder().encodeToString(gbody));
        cg.send(gid);
        JSONObject gst = waitDone(cg, gid, 6000);
        ok("done".equals(gst.optString("state")) && new String(cg.result(gid, 0), UTF8).contains("inlineData"), "gemini JSON result kept raw: " + gst);
        Headers gh = H.get("gm");
        ok(gh != null && "AIza-test-key-5555".equals(gh.getFirst("x-goog-api-key")) && gh.getFirst("Authorization") == null && "application/json".equals(gh.getFirst("Content-Type")), "key goes in x-goog-api-key only");
        ok(Arrays.equals(B.get("gm"), gbody) && "/gm/models/gemini-2.5-flash-image:generateContent".equals(U.get("gm")), "body forwarded intact, path with the colon");
        cg.release(gid);
        String gl = cg.begin("{\"provider\":\"gemini\",\"method\":\"GET\",\"path\":\"/models?pageSize=100\"}");
        cg.send(gl);
        ok("done".equals(waitDone(cg, gl, 6000).optString("state")) && "AIza-test-key-5555".equals(H.get("gmList").getFirst("x-goog-api-key")), "gemini model list (key check)");
        expectErrorWith(new AiClient(new Cfg().with("gemini", root + "/gm400", "bad", null)), "gemini", "/models/gemini-2.5-flash-image:generateContent", 400, "400", "API key not valid");
        expectErrorWith(new AiClient(new Cfg().with("gemini", root + "/gm", null, null)), "gemini", "/models/gemini-2.5-flash-image:generateContent", 401, "no_key", "");

        // ---------------------------------------------------------------- Hugging Face (fal 경유 FLUX.1 Fill)
        System.out.println("▶ Hugging Face: FLUX.1 Fill via fal");
        AiClient ch = new AiClient(new Cfg().with("huggingface", root + "/hf", "hf_test_token_6666", null));
        for (String bad : new String[]{"/fal-ai/fal-ai/flux-lora", "/fal-ai/fal-ai/flux-lora-fill/x", "/hf-inference/models/x", "/../fal-ai/fal-ai/flux-lora-fill", "/models"})
            ok("ERR:path".equals(ch.begin("{\"provider\":\"huggingface\",\"method\":\"POST\",\"path\":\"" + bad + "\",\"type\":\"application/json\",\"len\":2}")), "huggingface: rejects " + bad);
        ok("ERR:path".equals(ch.begin("{\"provider\":\"huggingface\",\"method\":\"GET\",\"path\":\"/fal-ai/fal-ai/flux-lora-fill\"}")), "huggingface: POST only");
        ok("ERR:type".equals(ch.begin("{\"provider\":\"huggingface\",\"method\":\"POST\",\"path\":\"/fal-ai/fal-ai/flux-lora-fill\",\"type\":\"" + MP + "\",\"len\":3}")), "huggingface: JSON only");
        byte[] hbody = "{\"prompt\":\"x\",\"image_url\":\"data:image/png;base64,AA==\",\"mask_url\":\"data:image/png;base64,AA==\",\"sync_mode\":true}".getBytes(UTF8);
        String hfid = ch.begin("{\"provider\":\"huggingface\",\"method\":\"POST\",\"path\":\"/fal-ai/fal-ai/flux-lora-fill\",\"type\":\"application/json\",\"len\":" + hbody.length + "}");
        ok(hfid.startsWith("a"), "huggingface begin ok");
        ch.chunk(hfid, Base64.getEncoder().encodeToString(hbody));
        ch.send(hfid);
        JSONObject hfst = waitDone(ch, hfid, 6000);
        ok("done".equals(hfst.optString("state")) && new String(ch.result(hfid, 0), UTF8).contains("data:image/png"), "huggingface JSON result kept raw: " + hfst);
        Headers hh = H.get("hf");
        ok(hh != null && "Bearer hf_test_token_6666".equals(hh.getFirst("Authorization")) && Arrays.equals(B.get("hf"), hbody), "bearer token + body intact");
        ch.release(hfid);
        expectErrorWith(new AiClient(new Cfg().with("huggingface", root + "/hf403", "hf_x", null)), "huggingface", "/fal-ai/fal-ai/flux-lora-fill", 403, "http_403", "gated");

        // ---------------------------------------------------------------- ModelScope (비동기 작업 + 결과 내려받기)
        System.out.println("▶ ModelScope: submit → poll → download");
        Cfg mcfg = new Cfg().with("modelscope", root + "/ms/v1", "ms-token-444444", null);
        AiClient cm = new AiClient(mcfg);
        ok("ERR:path".equals(cm.begin("{\"provider\":\"modelscope\",\"method\":\"POST\",\"path\":\"/chat/completions\",\"type\":\"application/json\",\"len\":3}")), "modelscope: chat/completions not allowed");
        ok("ERR:type".equals(cm.begin("{\"provider\":\"modelscope\",\"method\":\"POST\",\"path\":\"/images/generations\",\"type\":\"" + MP + "\",\"len\":3}")), "modelscope: submit needs JSON");
        ok("ERR:path".equals(cm.begin("{\"provider\":\"modelscope\",\"method\":\"GET\",\"path\":\"/images/generations\"}")), "modelscope: GET on the submit route");
        ok("ERR:path".equals(cm.begin("{\"provider\":\"modelscope\",\"method\":\"POST\",\"path\":\"/tasks/task-abc123456\",\"type\":\"application/json\",\"len\":2}")), "modelscope: POST on the task route");
        for (String bad : new String[]{"/tasks/", "/tasks/abc", "/tasks/../models", "/tasks/a b c d e f g", "/tasks/.hidden-task-id", "/tasks/task-abc/../x", "/tasks/" + new String(new char[81]).replace('\0', 'a')})
            ok("ERR:path".equals(cm.begin("{\"provider\":\"modelscope\",\"method\":\"GET\",\"path\":\"" + bad + "\"}")), "modelscope: rejects " + bad.substring(0, Math.min(24, bad.length())));
        byte[] sub = "{\"model\":\"Qwen/Qwen-Image\",\"prompt\":\"한글 문구\",\"size\":\"1024x1024\"}".getBytes(UTF8);
        String mid = cm.begin("{\"provider\":\"modelscope\",\"method\":\"POST\",\"path\":\"/images/generations\",\"type\":\"application/json\",\"len\":" + sub.length + "}");
        ok(mid.startsWith("a"), "submit begin ok");
        cm.chunk(mid, Base64.getEncoder().encodeToString(sub));
        cm.send(mid);
        JSONObject mst = waitDone(cm, mid, 6000);
        ok("done".equals(mst.optString("state")) && "task-abc123456".equals(new JSONObject(new String(cm.result(mid, 0), UTF8)).getString("task_id")), "submit returns the task id: " + mst);
        Headers sh = H.get("msSubmit");
        ok(sh != null && "Bearer ms-token-444444".equals(sh.getFirst("Authorization")) && "true".equals(sh.getFirst("X-ModelScope-Async-Mode")) && "application/json".equals(sh.getFirst("Content-Type")), "submit headers: token + async mode + json");
        ok(sh != null && sh.getFirst("X-ModelScope-Task-Type") == null, "submit does not send a task-type header");
        ok(Arrays.equals(B.get("msSubmit"), sub) && "/ms/v1/images/generations".equals(U.get("msSubmit")), "submit body forwarded intact (UTF-8)");
        cm.release(mid);
        // 편집(Qwen-Image-Edit): 작업 종류 헤더를 spec 의 tt 로 고른다
        String me = cm.begin("{\"provider\":\"modelscope\",\"method\":\"POST\",\"path\":\"/images/generations\",\"type\":\"application/json\",\"len\":" + sub.length + ",\"tt\":\"image-to-image-generation\"}");
        ok(me.startsWith("a"), "edit submit begin ok (tt)");
        cm.chunk(me, Base64.getEncoder().encodeToString(sub));
        cm.send(me);
        waitDone(cm, me, 6000);
        ok("image-to-image-generation".equals(H.get("msSubmit").getFirst("X-ModelScope-Task-Type")) && "true".equals(H.get("msSubmit").getFirst("X-ModelScope-Async-Mode")), "edit submit sends the image-to-image task type");
        cm.release(me);
        for (String badTt : new String[]{"evil", "image_generation\\r\\nX: y", "IMAGE_GENERATION"})
            ok("ERR:spec".equals(cm.begin("{\"provider\":\"modelscope\",\"method\":\"GET\",\"path\":\"/tasks/task-abc123456\",\"tt\":\"" + badTt + "\"}")), "tt rejected: " + badTt.substring(0, Math.min(10, badTt.length())));
        ok("ERR:spec".equals(cg.begin("{\"provider\":\"gemini\",\"method\":\"GET\",\"path\":\"/models\",\"tt\":\"image_generation\"}")), "tt only for modelscope");
        polls.set(0);
        String te = cm.begin("{\"provider\":\"modelscope\",\"method\":\"GET\",\"path\":\"/tasks/task-abc123456\",\"tt\":\"image-to-image-generation\"}");
        cm.send(te);
        waitDone(cm, te, 6000);
        ok("image-to-image-generation".equals(H.get("msPoll").getFirst("X-ModelScope-Task-Type")), "edit poll sends the image-to-image task type");
        cm.release(te);
        polls.set(0);
        String t1 = cm.begin("{\"provider\":\"modelscope\",\"method\":\"GET\",\"path\":\"/tasks/task-abc123456\"}");
        cm.send(t1);
        JSONObject p1 = waitDone(cm, t1, 6000);
        ok("RUNNING".equals(new JSONObject(new String(cm.result(t1, 0), UTF8)).getString("task_status")), "first poll: still running: " + p1);
        Headers th = H.get("msPoll");
        ok(th != null && "image_generation".equals(th.getFirst("X-ModelScope-Task-Type")) && "Bearer ms-token-444444".equals(th.getFirst("Authorization")) && th.getFirst("X-ModelScope-Async-Mode") == null, "poll headers: task-type image_generation + token, no async header");
        ok("/ms/v1/tasks/task-abc123456".equals(U.get("msPoll")) && "GET".equals(M.get("msPoll")), "poll path");
        cm.release(t1);
        String t2 = cm.begin("{\"provider\":\"modelscope\",\"method\":\"GET\",\"path\":\"/tasks/task-abc123456\"}");
        cm.send(t2);
        waitDone(cm, t2, 6000);
        JSONObject done = new JSONObject(new String(cm.result(t2, 0), UTF8));
        String imgUrl = done.getJSONArray("output_images").getString(0);
        ok("SUCCEED".equals(done.getString("task_status")) && imgUrl.contains("/img/result.png?Expires=1&Signature=abc%2Bdef%3D"), "second poll: SUCCEED + image url: " + imgUrl);
        cm.release(t2);
        String d1 = cm.begin("{\"provider\":\"modelscope\",\"method\":\"GET\",\"url\":\"" + imgUrl + "\"}");
        ok(d1.startsWith("a"), "download begin ok (allowed host in test mode)");
        cm.send(d1);
        JSONObject dst = waitDone(cm, d1, 6000);
        ok("done".equals(dst.optString("state")) && "image/png".equals(dst.optString("ctype")) && Arrays.equals(cm.result(d1, 0), IMG_A), "image bytes downloaded: " + dst);
        Headers dh = H.get("img");
        ok(dh != null && dh.getFirst("Authorization") == null && dh.getFirst("X-ModelScope-Task-Type") == null && String.valueOf(dh.getFirst("Accept")).startsWith("image/"), "the download carries NO token (the token only goes to the API host)");
        ok(U.get("img").equals("/img/result.png?Expires=1&Signature=abc%2Bdef%3D"), "signed query forwarded unchanged: " + U.get("img"));
        cm.release(d1);
        ok("ERR:path".equals(cm.begin("{\"provider\":\"modelscope\",\"method\":\"POST\",\"url\":\"" + imgUrl + "\",\"type\":\"application/json\",\"len\":2}")), "download is GET only");
        expectDownload(cm, "http://127.0.0.1:" + srv.getAddress().getPort() + "/img/octet.png", "done", "application/octet-stream", "octet-stream is kept (the web sniffs the bytes)");
        expectDownload(cm, "http://127.0.0.1:" + srv.getAddress().getPort() + "/img/html", "done", "application/octet-stream", "html is not trusted as an image");
        expectDownload(cm, "http://127.0.0.1:" + srv.getAddress().getPort() + "/img/redir", "error", "", "download redirect is not followed");
        expectDownload(cm, "http://127.0.0.1:" + srv.getAddress().getPort() + "/img/missing", "error", "", "download 404 → error");
        ok(evilHits.get() == 0, "redirect target never contacted (download)");
        // ModelScope 오류 형식: errors 객체 / message
        expectMs(root + "/ms401/v1", 401, "401", "Invalid token", "{errors:{message,code}} object");
        expectMs(root + "/ms429/v1", 429, "RateLimitExceeded", "Request limit exceeded", "429 with a string code");
        expectMs(root + "/msmsg/v1", 400, "http_400", "model not supported", "top-level message");
        expectErrorWith(new AiClient(new Cfg().with("modelscope", root + "/ms/v1", null, null)), "modelscope", "/images/generations", 401, "no_key", "");
        String mm = cm.begin("{\"provider\":\"modelscope\",\"method\":\"GET\",\"path\":\"/models\"}");
        cm.send(mm);
        ok("done".equals(waitDone(cm, mm, 6000).optString("state")) && "Bearer ms-token-444444".equals(H.get("msModels").getFirst("Authorization")), "modelscope /models (token check)");

        // ---------------------------------------------------------------- 결과 이미지 주소 검증 (실제 동작과 같은 규칙: insecureForTests = false)
        System.out.println("▶ checkResultUrl");
        AiClient.insecureForTests = false;
        AiClient.Profile ms = AiClient.PROFILES.get("modelscope");
        for (String good : new String[]{"https://muse-ai.oss-cn-hangzhou.aliyuncs.com/img/ab12-34.png?Expires=1700000000&OSSAccessKeyId=LTAI&Signature=a%2Bb%3D",
                "https://modelscope.cn/x.jpg", "https://cdn.modelscope.cn/a/b/c.webp", "https://www.modelscope.ai/p.png", "https://BUCKET.OSS-cn-beijing.ALIYUNCS.COM/x.png"})
            ok(AiClient.checkResultUrl(ms, good) != null, "accepts " + good.substring(0, Math.min(48, good.length())));
        for (String bad : new String[]{"http://muse-ai.oss-cn-hangzhou.aliyuncs.com/x.png", "https://evil.com/x.png", "https://aliyuncs.com.evil.com/x.png", "https://xaliyuncs.com/x.png",
                "https://x.aliyuncs.com:8443/x.png", "https://u:p@x.aliyuncs.com/x.png", "https://x.aliyuncs.com/x.png#frag", "https://x.aliyuncs.com/a b.png", "https://x.aliyuncs.com/x.png?" + new String(new char[1000]).replace('\0', 'a'),
                "https://127.0.0.1/x.png", "https://localhost/x.png", "ftp://x.aliyuncs.com/x.png", "javascript:alert(1)", "", "https://", "//x.aliyuncs.com/x.png", "https://x.aliyuncs.com/%0d%0a<x>.png", "https://x.aliyuncs.com"})
            ok(AiClient.checkResultUrl(ms, bad) == null, "rejects " + (bad.isEmpty() ? "(empty)" : bad.substring(0, Math.min(40, bad.length()))));
        ok(AiClient.checkResultUrl(AiClient.PROFILES.get("cloudflare"), "https://x.aliyuncs.com/x.png") == null && AiClient.checkResultUrl(AiClient.PROFILES.get("gemini"), "https://x.aliyuncs.com/x.png") == null && AiClient.checkResultUrl(AiClient.PROFILES.get("huggingface"), "https://x.aliyuncs.com/x.png") == null && AiClient.checkResultUrl(AiClient.PROFILES.get("huggingface"), "https://v3.fal.media/files/a/x.png?x=1") != null && AiClient.checkResultUrl(AiClient.PROFILES.get("huggingface"), "https://fal.media.evil.com/x.png") == null && AiClient.checkResultUrl(null, "https://x.aliyuncs.com/x.png") == null, "only modelscope (aliyuncs/modelscope) and huggingface (fal) may download result images, each from its own hosts");
        AiClient.insecureForTests = true;

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

    static void expectErrorWith(AiClient c, String provider, String path, int status, String code, String msgPart) throws Exception {
        String id = c.begin("{\"provider\":\"" + provider + "\",\"method\":\"POST\",\"path\":\"" + path + "\",\"type\":\"application/json\",\"len\":2}");
        c.chunk(id, Base64.getEncoder().encodeToString(new byte[]{'{', '}'}));
        c.send(id);
        JSONObject o = waitDone(c, id, 8000);
        boolean good = "error".equals(o.optString("state")) && o.optInt("status", -1) == status && code.equals(o.optString("code")) && o.optString("message").contains(msgPart);
        ok(good, "error mapping " + provider + " " + code + " → " + o);
        c.release(id);
    }

    /** Cloudflare 실행 경로에 요청해서 오류 상태/코드/메시지를 확인 */
    static void expectCf(String base, String key, String account, int status, String code, String msgPart, String label) throws Exception {
        Cfg c = new Cfg().with("cloudflare", base, key, account);
        AiClient ac = new AiClient(c);
        String id = ac.begin("{\"provider\":\"cloudflare\",\"method\":\"POST\",\"path\":\"/accounts/{account}/ai/run/@cf/a/b\",\"type\":\"application/json\",\"len\":2}");
        ac.chunk(id, Base64.getEncoder().encodeToString(new byte[]{'{', '}'}));
        ac.send(id);
        JSONObject o = waitDone(ac, id, 8000);
        boolean good = "error".equals(o.optString("state")) && o.optInt("status", -1) == status && code.equals(o.optString("code")) && o.optString("message").contains(msgPart);
        ok(good, "error mapping " + label + " → " + o);
        ac.release(id);
    }

    static void expectMs(String base, int status, String code, String msgPart, String label) throws Exception {
        AiClient ac = new AiClient(new Cfg().with("modelscope", base, "ms-token-444444", null));
        String id = ac.begin("{\"provider\":\"modelscope\",\"method\":\"POST\",\"path\":\"/images/generations\",\"type\":\"application/json\",\"len\":2}");
        ac.chunk(id, Base64.getEncoder().encodeToString(new byte[]{'{', '}'}));
        ac.send(id);
        JSONObject o = waitDone(ac, id, 8000);
        boolean good = "error".equals(o.optString("state")) && o.optInt("status", -1) == status && code.equals(o.optString("code")) && o.optString("message").contains(msgPart);
        ok(good, "error mapping modelscope " + label + " → " + o);
        ac.release(id);
    }

    static void expectDownload(AiClient c, String url, String state, String ctype, String label) throws Exception {
        String id = c.begin("{\"provider\":\"modelscope\",\"method\":\"GET\",\"url\":\"" + url + "\"}");
        if (!id.startsWith("a")) {
            ok(false, "download begin failed: " + id + " (" + label + ")");
            return;
        }
        c.send(id);
        JSONObject o = waitDone(c, id, 8000);
        ok(state.equals(o.optString("state")) && (ctype.isEmpty() || ctype.equals(o.optString("ctype"))), "download " + label + " → " + o);
        c.release(id);
    }
}
