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
        final java.util.Map<String, String> bases = new java.util.HashMap<String, String>();
        final java.util.Map<String, String> keys = new java.util.HashMap<String, String>();
        final java.util.Map<String, String> extras = new java.util.HashMap<String, String>();

        Cfg(String base, String key) {
            bases.put("openai", base);
            keys.put("openai", key);
        }

        Cfg with(String provider, String base, String key, String extra) {
            bases.put(provider, base);
            keys.put(provider, key);
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
    }

    static final AtomicReference<byte[]> lastBody = new AtomicReference<byte[]>();
    static final AtomicReference<Headers> lastHeaders = new AtomicReference<Headers>();
    static final AtomicReference<String> lastPath = new AtomicReference<String>();
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
                    } else if (p.equals("/ok/v1/images/generations")) {
                        lastBody.set(body);
                        lastHeaders.set(x.getRequestHeaders());
                        lastPath.set(p);
                        reply(x, 200, "{\"created\":1,\"data\":[{\"b64_json\":\"" + Base64.getEncoder().encodeToString(IMG_A) + "\"}]}");
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
                    } else if (p.equals("/or/api/v1/chat/completions")) {
                        lastBody.set(body);
                        lastHeaders.set(x.getRequestHeaders());
                        lastPath.set(p);
                        reply(x, 200, "{\"id\":\"gen-1\",\"choices\":[{\"message\":{\"role\":\"assistant\",\"content\":\"ok\",\"images\":[{\"type\":\"image_url\",\"image_url\":{\"url\":\"data:image/png;base64,AAAA\"}}]}}]}");
                    } else if (p.equals("/or/api/v1/models")) {
                        lastHeaders.set(x.getRequestHeaders());
                        lastPath.set(p + "?" + x.getRequestURI().getRawQuery());
                        reply(x, 200, "{\"data\":[{\"id\":\"a/b:free\",\"architecture\":{\"output_modalities\":[\"image\",\"text\"]},\"pricing\":{\"prompt\":\"0\"}}]}");
                    } else if (p.equals("/or/api/v1/key")) {
                        lastHeaders.set(x.getRequestHeaders());
                        reply(x, 200, "{\"data\":{\"label\":\"k\",\"is_free_tier\":true}}");
                    } else if (p.equals("/orerr/api/v1/chat/completions")) {
                        reply(x, 429, "{\"error\":{\"code\":429,\"message\":\"Rate limit exceeded: free-models-per-day\",\"metadata\":{\"raw\":\"upstream details\"}}}");
                    } else if (p.equals("/or402/api/v1/chat/completions")) {
                        reply(x, 402, "{\"error\":{\"code\":402,\"message\":\"Insufficient credits\"}}");
                    } else if (p.startsWith("/cf/client/v4/accounts/") && p.contains("/ai/run/")) {
                        lastBody.set(body);
                        lastHeaders.set(x.getRequestHeaders());
                        lastPath.set(p);
                        reply(x, 200, "{\"result\":{\"image\":\"QUJD\"},\"success\":true,\"errors\":[],\"messages\":[]}");
                    } else if (p.startsWith("/cf/client/v4/accounts/") && p.endsWith("/ai/models/search")) {
                        lastHeaders.set(x.getRequestHeaders());
                        lastPath.set(p + "?" + x.getRequestURI().getRawQuery());
                        reply(x, 200, "{\"result\":[{\"name\":\"@cf/black-forest-labs/flux-2-klein-4b\"}],\"success\":true}");
                    } else if (p.startsWith("/cferr/client/v4/")) {
                        reply(x, 429, "{\"success\":false,\"errors\":[{\"code\":3036,\"message\":\"you have used up your daily free allocation of 10,000 neurons\"}],\"messages\":[],\"result\":null}");
                    } else if (p.startsWith("/cfbin/client/v4/")) {
                        byte[] png = IMG_A;
                        x.getResponseHeaders().add("Content-Type", "image/png");
                        x.sendResponseHeaders(200, png.length);
                        x.getResponseBody().write(png);
                        x.close();
                    } else if (p.startsWith("/cfhtml/client/v4/")) {
                        byte[] hb = "<html>x</html>".getBytes(UTF8);
                        x.getResponseHeaders().add("Content-Type", "text/html; charset=utf-8");
                        x.sendResponseHeaders(200, hb.length);
                        x.getResponseBody().write(hb);
                        x.close();
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

        // ---------------------------------------------------------------- 제공자 프로필 (openrouter / cloudflare)
        System.out.println("▶ AiClient providers");
        String ACC = "0123456789abcdef0123456789abcdef";
        Cfg pc = new Cfg(root + "/ok/v1", "sk-openai-111111").with("openrouter", root + "/or/api/v1", "sk-or-v1-222222", null).with("cloudflare", root + "/cf/client/v4", "cf-token-333333", ACC);
        AiClient cp = new AiClient(pc);
        String MP = "multipart/form-data; boundary=----X1";
        ok("ERR:provider".equals(cp.begin("{\"provider\":\"gemini\",\"method\":\"GET\",\"path\":\"/models\"}")), "unknown provider rejected");
        ok("ERR:path".equals(cp.begin("{\"provider\":\"openrouter\",\"method\":\"POST\",\"path\":\"/images/edits\",\"type\":\"" + MP + "\",\"len\":3}")), "openrouter: images/edits not allowed");
        ok("ERR:type".equals(cp.begin("{\"provider\":\"openrouter\",\"method\":\"POST\",\"path\":\"/chat/completions\",\"type\":\"" + MP + "\",\"len\":3}")), "openrouter: chat requires json");
        ok("ERR:path".equals(cp.begin("{\"provider\":\"openai\",\"method\":\"POST\",\"path\":\"/chat/completions\",\"type\":\"application/json\",\"len\":3}")), "openai: chat/completions not allowed");
        ok("ERR:path".equals(cp.begin("{\"provider\":\"cloudflare\",\"method\":\"POST\",\"path\":\"/accounts/0123456789abcdef0123456789abcdef/ai/run/@cf/a/b\",\"type\":\"application/json\",\"len\":3}")), "cloudflare: literal account id not allowed (must use {account})");
        ok("ERR:path".equals(cp.begin("{\"provider\":\"cloudflare\",\"method\":\"POST\",\"path\":\"/accounts/{account}/ai/run/@cf/../b\",\"type\":\"application/json\",\"len\":3}")), "cloudflare: traversal rejected");
        ok("ERR:path".equals(cp.begin("{\"provider\":\"cloudflare\",\"method\":\"POST\",\"path\":\"/accounts/{account}/ai/run/@hf/a/b\",\"type\":\"application/json\",\"len\":3}")), "cloudflare: only @cf models");
        ok("ERR:path".equals(cp.begin("{\"provider\":\"openrouter\",\"method\":\"GET\",\"path\":\"/models?a=b c\"}")), "query with illegal chars rejected");
        ok("ERR:path".equals(cp.begin("{\"provider\":\"openrouter\",\"method\":\"GET\",\"path\":\"/credits\"}")), "openrouter: other paths rejected");
        ok(cp.jobCount() == 0, "rejected provider begins leave no jobs");

        // OpenRouter: JSON 본문 → raw 응답 (+ X-Title, 제공자별 키)
        byte[] jbody = "{\"model\":\"a/b:free\",\"messages\":[{\"role\":\"user\",\"content\":\"한글\"}],\"modalities\":[\"image\",\"text\"]}".getBytes(UTF8);
        String oid = cp.begin("{\"provider\":\"openrouter\",\"method\":\"POST\",\"path\":\"/chat/completions\",\"type\":\"application/json\",\"len\":" + jbody.length + "}");
        ok(oid.startsWith("a"), "openrouter begin ok");
        cp.chunk(oid, Base64.getEncoder().encodeToString(jbody));
        ok(cp.send(oid), "openrouter send");
        JSONObject ost = waitDone(cp, oid, 6000);
        ok("done".equals(ost.optString("state")) && ost.optBoolean("raw") && "application/json".equals(ost.optString("ctype")) && ost.optInt("n") == 1, "openrouter raw done: " + ost);
        Headers oh = lastHeaders.get();
        ok(oh != null && "Bearer sk-or-v1-222222".equals(oh.getFirst("Authorization")) && "ImageFix".equals(oh.getFirst("X-Title")) && "application/json".equals(oh.getFirst("Content-Type")), "openrouter headers (own key, X-Title, json)");
        ok(Arrays.equals(lastBody.get(), jbody), "openrouter body forwarded intact (UTF-8)");
        ok("/or/api/v1/chat/completions".equals(lastPath.get()), "openrouter path = base + route");
        String rj = new String(cp.result(oid, 0), UTF8);
        ok(new JSONObject(rj).getJSONArray("choices").getJSONObject(0).getJSONObject("message").getJSONArray("images").length() == 1 && "application/json".equals(cp.resultType(oid)), "openrouter raw body returned unmodified");
        cp.release(oid);

        String mid2 = cp.begin("{\"provider\":\"openrouter\",\"method\":\"GET\",\"path\":\"/models?output_modalities=image\"}");
        cp.send(mid2);
        JSONObject mst = waitDone(cp, mid2, 6000);
        ok("done".equals(mst.optString("state")) && mst.optBoolean("raw") && "/or/api/v1/models?output_modalities=image".equals(lastPath.get()), "openrouter models raw + query passed: " + mst + " " + lastPath.get());
        ok(new JSONObject(new String(cp.result(mid2, 0), UTF8)).getJSONArray("data").length() == 1, "openrouter models json");
        String kid = cp.begin("{\"provider\":\"openrouter\",\"method\":\"GET\",\"path\":\"/key\"}");
        cp.send(kid);
        ok("done".equals(waitDone(cp, kid, 6000).optString("state")), "openrouter /key");

        // Cloudflare: {account} 치환 + multipart + JSON 응답
        byte[] cbody = new byte[50 * 1024];
        new Random(3).nextBytes(cbody);
        String cid = cp.begin("{\"provider\":\"cloudflare\",\"method\":\"POST\",\"path\":\"/accounts/{account}/ai/run/@cf/black-forest-labs/flux-2-klein-4b\",\"type\":\"" + MP + "\",\"len\":" + cbody.length + "}");
        ok(cid.startsWith("a"), "cloudflare begin ok");
        cp.chunk(cid, Base64.getEncoder().encodeToString(cbody));
        cp.send(cid);
        JSONObject cst2 = waitDone(cp, cid, 6000);
        ok("done".equals(cst2.optString("state")) && cst2.optBoolean("raw"), "cloudflare raw done: " + cst2);
        ok(("/cf/client/v4/accounts/" + ACC + "/ai/run/@cf/black-forest-labs/flux-2-klein-4b").equals(lastPath.get()), "cloudflare {account} replaced with stored id: " + lastPath.get());
        ok("Bearer cf-token-333333".equals(lastHeaders.get().getFirst("Authorization")) && MP.equals(lastHeaders.get().getFirst("Content-Type")) && Arrays.equals(lastBody.get(), cbody), "cloudflare headers/body");
        ok("QUJD".equals(new JSONObject(new String(cp.result(cid, 0), UTF8)).getJSONObject("result").getString("image")), "cloudflare json result");
        String sid3 = cp.begin("{\"provider\":\"cloudflare\",\"method\":\"GET\",\"path\":\"/accounts/{account}/ai/models/search?per_page=50&search=flux\"}");
        cp.send(sid3);
        ok("done".equals(waitDone(cp, sid3, 6000).optString("state")) && lastPath.get().endsWith("/ai/models/search?per_page=50&search=flux"), "cloudflare models/search with query");

        // 계정 ID 없음 / 잘못됨
        Cfg noAcc = new Cfg(root + "/ok/v1", "k").with("cloudflare", root + "/cf/client/v4", "cf-token-333333", "");
        expectErrorWith(new AiClient(noAcc), "cloudflare", "/accounts/{account}/ai/run/@cf/a/b", 0, "no_account", "");

        // 오류 형식: OpenRouter(숫자 code + metadata.raw), Cloudflare(errors[]), 402
        expectErrorWith(new AiClient(new Cfg("x", "x").with("openrouter", root + "/orerr/api/v1", "sk-or-v1-222222", null)), "openrouter", "/chat/completions", 429, "429", "free-models-per-day | upstream details");
        expectErrorWith(new AiClient(new Cfg("x", "x").with("openrouter", root + "/or402/api/v1", "sk-or-v1-222222", null)), "openrouter", "/chat/completions", 402, "402", "Insufficient credits");
        expectErrorWith(new AiClient(new Cfg("x", "x").with("cloudflare", root + "/cferr/client/v4", "cf-token-333333", ACC)), "cloudflare", "/accounts/{account}/ai/run/@cf/a/b", 429, "cf_3036", "daily free allocation");

        // 문구만으로 생성하는 경로: OpenAI /images/generations(JSON → images 모드), Cloudflare flux-1-schnell · m2m100(번역)
        ok("ERR:type".equals(cp.begin("{\"provider\":\"openai\",\"method\":\"POST\",\"path\":\"/images/generations\",\"type\":\"" + MP + "\",\"len\":3}")), "openai generations requires json");
        byte[] gbody = "{\"model\":\"gpt-image-1\",\"prompt\":\"a boat\",\"size\":\"1024x1024\",\"n\":1}".getBytes(UTF8);
        String gid = cp.begin("{\"provider\":\"openai\",\"method\":\"POST\",\"path\":\"/images/generations\",\"type\":\"application/json\",\"len\":" + gbody.length + "}");
        ok(gid.startsWith("a"), "openai generations begin ok");
        cp.chunk(gid, Base64.getEncoder().encodeToString(gbody));
        cp.send(gid);
        JSONObject gst = waitDone(cp, gid, 6000);
        ok("done".equals(gst.optString("state")) && gst.optInt("n") == 1 && !gst.has("raw") && Arrays.equals(cp.result(gid, 0), IMG_A) && Arrays.equals(lastBody.get(), gbody) && "Bearer sk-openai-111111".equals(lastHeaders.get().getFirst("Authorization")), "openai generations → decoded image (images mode), own key: " + gst);
        String fid = cp.begin("{\"provider\":\"cloudflare\",\"method\":\"POST\",\"path\":\"/accounts/{account}/ai/run/@cf/black-forest-labs/flux-1-schnell\",\"type\":\"application/json\",\"len\":2}");
        String tid = cp.begin("{\"provider\":\"cloudflare\",\"method\":\"POST\",\"path\":\"/accounts/{account}/ai/run/@cf/meta/m2m100-1.2b\",\"type\":\"application/json\",\"len\":2}");
        ok(fid.startsWith("a") && tid.startsWith("a"), "cloudflare flux-1-schnell and m2m100 paths are allowed (json, {account})");
        cp.release(fid);
        cp.release(tid);

        // 바이너리 이미지 응답(raw) / 허용되지 않은 Content-Type
        AiClient cbin = new AiClient(new Cfg("x", "x").with("cloudflare", root + "/cfbin/client/v4", "cf-token-333333", ACC));
        String bid = cbin.begin("{\"provider\":\"cloudflare\",\"method\":\"POST\",\"path\":\"/accounts/{account}/ai/run/@cf/runwayml/sd\",\"type\":\"application/json\",\"len\":2}");
        cbin.chunk(bid, Base64.getEncoder().encodeToString(new byte[]{'{', '}'}));
        cbin.send(bid);
        JSONObject bst = waitDone(cbin, bid, 6000);
        ok("done".equals(bst.optString("state")) && "image/png".equals(bst.optString("ctype")) && Arrays.equals(cbin.result(bid, 0), IMG_A), "binary png response kept as raw: " + bst);
        AiClient chtml = new AiClient(new Cfg("x", "x").with("cloudflare", root + "/cfhtml/client/v4", "cf-token-333333", ACC));
        String hid = chtml.begin("{\"provider\":\"cloudflare\",\"method\":\"POST\",\"path\":\"/accounts/{account}/ai/run/@cf/runwayml/sd\",\"type\":\"application/json\",\"len\":2}");
        chtml.chunk(hid, Base64.getEncoder().encodeToString(new byte[]{'{', '}'}));
        chtml.send(hid);
        waitDone(chtml, hid, 6000);
        ok("application/octet-stream".equals(chtml.resultType(hid)), "unexpected content-type is not trusted (octet-stream)");
        ok(AiClient.validAccount(ACC) && !AiClient.validAccount("ABCDEF0123456789abcdef0123456789") && !AiClient.validAccount("short") && !AiClient.validAccount(null), "account id validation");

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


    static void expectErrorWith(AiClient c, String provider, String path, int status, String code, String msgPart) throws Exception {
        String id = c.begin("{\"provider\":\"" + provider + "\",\"method\":\"POST\",\"path\":\"" + path + "\",\"type\":\"application/json\",\"len\":2}");
        c.chunk(id, Base64.getEncoder().encodeToString(new byte[]{'{', '}'}));
        c.send(id);
        JSONObject o = waitDone(c, id, 8000);
        boolean good = "error".equals(o.optString("state")) && o.optInt("status", -1) == status && code.equals(o.optString("code")) && o.optString("message").contains(msgPart);
        ok(good, "provider error mapping " + provider + " " + code + " → " + o);
        c.release(id);
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
