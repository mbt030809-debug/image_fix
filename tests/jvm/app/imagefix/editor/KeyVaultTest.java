package app.imagefix.editor;

import org.json.JSONObject;

import java.io.File;
import java.io.IOException;
import java.nio.charset.Charset;
import java.util.HashMap;
import java.util.Map;

/**
 * KeyVault 저장 흐름 JVM 테스트: 세 가지 암호화 방식(hw=Keystore 별칭 v1 / hw2=별칭 v2 / sw=앱 전용 키 파일) 사이의 대체·검증.
 * 실기기에서만 나던 "키 저장 오류 / 키가 사라짐"을 막는 로직(저장 직후 복호화 확인, 아무것도 지우지 않는 대체, 읽을 수 없는 키 표시)을 확인한다.
 * 실행: tests/jvm/run.sh
 */
public class KeyVaultTest {
    static int pass = 0, fail = 0;
    static final Charset UTF8 = Charset.forName("UTF-8");

    static void ok(boolean cond, String name) {
        if (cond) pass++;
        else {
            fail++;
            System.out.println("  ✗ FAIL: " + name);
        }
    }

    /** 메모리 저장소 */
    static class MemStore implements KeyVault.Store {
        final Map<String, String> m = new HashMap<String, String>();
        boolean failCommit;

        @Override
        public String get(String key) {
            return m.get(key);
        }

        @Override
        public void commit(Map<String, String> puts, String... removes) throws IOException {
            if (failCommit) throw new IOException("prefs");
            for (String r : removes) m.remove(r);
            m.putAll(puts);
        }
    }

    /** 진짜 AES-GCM(SwTier)에 실패를 주입하는 대역 */
    static class FakeTier implements KeyVault.Tier {
        final String id;
        final KeyVault.SwTier real;
        final File file;
        boolean failSeal, failOpen, garbleOpen;

        FakeTier(String id, File file) {
            this.id = id;
            this.file = file;
            this.real = new KeyVault.SwTier(file);
        }

        @Override
        public String id() {
            return id;
        }

        @Override
        public byte[][] seal(byte[] plain) throws Exception {
            if (failSeal) throw new java.security.KeyStoreException("seal");
            return real.seal(plain);
        }

        @Override
        public byte[] open(byte[] iv, byte[] ct) throws Exception {
            if (failOpen) throw new java.security.UnrecoverableKeyException("open");
            byte[] p = real.open(iv, ct);
            if (garbleOpen) p[0] ^= 1;
            return p;
        }
    }

    static File tmp(String name) throws IOException {
        File d = java.nio.file.Files.createTempDirectory("kv").toFile();
        d.deleteOnExit();
        File f = new File(d, name);
        f.deleteOnExit();
        return f;
    }

    static final String K1 = "ms-test-AAAAAAAA1234", K2 = "ms-test-BBBBBBBB5678", K3 = "cf-token-CCCCCCCC9012";
    static final String ACC = "0123456789abcdef0123456789abcdef";

    static MemStore st;
    static FakeTier hw, hw2, sw;
    static KeyVault v;

    static void fresh() throws IOException {
        st = new MemStore();
        hw = new FakeTier("hw", tmp("hw.k"));
        hw2 = new FakeTier("hw2", tmp("hw2.k"));
        sw = new FakeTier("sw", tmp("sw.k"));
        v = new KeyVault(st, hw, hw2, sw);
    }

    public static void main(String[] args) throws Exception {
        // ---------------------------------------------------------------- 정상: hw
        System.out.println("▶ KeyVault: 기기 보안 저장소(hw) 정상");
        fresh();
        ok("OK".equals(v.set("modelscope", "  " + K1 + " \n", "")), "save (trimmed) → OK");
        ok(K1.equals(v.apiKey("modelscope")) && v.hasKey("modelscope") && "hw".equals(v.prot("modelscope")), "read back through hw");
        ok("ms-…1234".equals(v.hint("modelscope")), "hint = first 3 + … + last 4");
        ok(!st.m.get("modelscope.ct").contains("AAAAAAAA") && "hw".equals(st.m.get("modelscope.prot")), "ciphertext is stored, not the key; prot=hw");
        ok(!v.keyUnreadable("modelscope"), "readable");
        String info = v.infoJson();
        JSONObject jo = new JSONObject(info).getJSONObject("providers").getJSONObject("modelscope");
        ok(jo.getBoolean("hasKey") && jo.getBoolean("readable") && "hw".equals(jo.getString("prot")) && !info.contains("AAAAAAAA") && !jo.has("base"), "info: hasKey/readable/prot, no key material, no base");
        JSONObject jp = new JSONObject(info).getJSONObject("providers").getJSONObject("gemini");
        ok(!jp.getBoolean("hasKey") && jp.getBoolean("readable") && "".equals(jp.getString("prot")) && new JSONObject(info).getInt("v") == 3, "info v3 lists gemini (no key yet)");
        ok(new JSONObject(info).getJSONObject("providers").has("huggingface") && !new JSONObject(info).getJSONObject("providers").has("pollinations"), "huggingface listed, pollinations gone");
        ok(new JSONObject(info).getJSONObject("providers").length() == 4 && !new JSONObject(info).getJSONObject("providers").has("openai") && !new JSONObject(info).getJSONObject("providers").has("openrouter"), "exactly cloudflare / modelscope / gemini / huggingface");
        ok(!hw2.file.exists() && !sw.file.exists(), "the other tiers are not even touched when hw works");
        ok("hw=ok sw=ok".equals(v.selfTest()), "selfTest ok");

        // ---------------------------------------------------------------- 입력 검증
        System.out.println("▶ KeyVault: 입력 검증");
        ok("ERR:provider".equals(v.set("nope", K1, "")), "unknown provider");
        ok("ERR:provider".equals(v.set("openai", K1, "")) && "ERR:provider".equals(v.set("openrouter", K1, "")), "OpenAI/OpenRouter are not providers anymore");
        ok("ERR:provider".equals(v.set("pollinations", K1, "")), "pollinations is not a provider anymore");
        ok("OK".equals(v.set("gemini", "AIzaSyTestKey-1234567890", "")) && "AIz…7890".equals(v.hint("gemini")) && "OK".equals(v.set("huggingface", "hf_testtoken1234567890", "")) && "hf_…7890".equals(v.hint("huggingface")), "gemini / huggingface keys: stored per provider, no extra value");
        v.clear("gemini"); v.clear("huggingface");
        ok("ERR:badkey".equals(v.set("modelscope", "short", "")), "too short key");
        ok("ERR:badkey".equals(v.set("modelscope", "ms-aaaa bbbbbbbb", "")), "inner whitespace");
        ok("ERR:badkey".equals(v.set("modelscope", "ms-한글한글한글한글", "")), "non-ASCII key");
        fresh();
        ok("ERR:badkey".equals(v.set("modelscope", "", "")), "empty key without a stored one");
        ok("ERR:badextra".equals(v.set("cloudflare", K3, "")), "cloudflare needs the account ID");
        ok("ERR:badextra".equals(v.set("cloudflare", K3, "1234")), "malformed account ID");
        ok("OK".equals(v.set("cloudflare", K3, ACC.toUpperCase())) && ACC.equals(v.extra("cloudflare")), "account ID stored lowercase");
        ok("OK".equals(v.set("cloudflare", "", "")) && K3.equals(v.apiKey("cloudflare")), "empty key keeps the stored key");
        ok("OK".equals(v.set("cloudflare", "", "ffffffffffffffffffffffffffffffff")) && "ffffffffffffffffffffffffffffffff".equals(v.extra("cloudflare")) && K3.equals(v.apiKey("cloudflare")), "the account id can change without re-entering the token");
        ok("OK".equals(v.set("cloudflare", K3, "")) && "ffffffffffffffffffffffffffffffff".equals(v.extra("cloudflare")), "re-saving the token without an id keeps the stored id");
        ok("https://generativelanguage.googleapis.com/v1beta".equals(v.baseUrl("gemini")) && "https://router.huggingface.co".equals(v.baseUrl("huggingface")) && "https://api-inference.modelscope.cn/v1".equals(v.baseUrl("modelscope")) && "https://api.cloudflare.com/client/v4".equals(v.baseUrl("cloudflare")), "fixed server addresses (no custom base)");
        ok(v.apiKey("gemini") == null && !v.keyUnreadable("gemini"), "gemini: no key yet, never 'unreadable'");

        // ---------------------------------------------------------------- 대체: hw → hw2 → sw
        System.out.println("▶ KeyVault: hw 실패 → hw2(별칭 v2) → sw(앱 전용 저장소)");
        fresh();
        hw.failSeal = true;
        ok("OK".equals(v.set("modelscope", K2, "")), "hw cannot seal → still saved");
        ok(K2.equals(v.apiKey("modelscope")) && "hw2".equals(v.prot("modelscope")) && "hw2".equals(st.m.get("modelscope.prot")), "stored with hw2 (second Keystore alias)");
        jo = new JSONObject(v.infoJson()).getJSONObject("providers").getJSONObject("modelscope");
        ok("hw2".equals(jo.getString("prot")) && jo.getBoolean("readable"), "info reports prot=hw2, readable");
        ok(!sw.file.exists(), "sw is not used while a Keystore alias works");
        // 저장 직후 풀어 보았을 때 값이 다르면(오염) 그 방식은 쓰지 않는다
        fresh();
        hw.garbleOpen = true;
        ok("OK".equals(v.set("modelscope", K1, "")) && "hw2".equals(v.prot("modelscope")) && K1.equals(v.apiKey("modelscope")), "hw round trip mismatch → hw2");
        // Keystore 전체가 안 되면 앱 전용 저장소
        fresh();
        hw.failSeal = true; hw2.failSeal = true;
        ok("OK".equals(v.set("modelscope", K2, "")) && "sw".equals(v.prot("modelscope")) && K2.equals(v.apiKey("modelscope")), "no Keystore at all → sw");
        ok("sw".equals(st.m.get("modelscope.prot")) && !st.m.get("modelscope.ct").contains("BBBBBBBB"), "sw ciphertext is not the key");
        jo = new JSONObject(v.infoJson()).getJSONObject("providers").getJSONObject("modelscope");
        ok("sw".equals(jo.getString("prot")) && jo.getBoolean("readable"), "info reports prot=sw");

        // ---------------------------------------------------------------- 아무것도 지우지 않는다
        System.out.println("▶ KeyVault: 대체 저장은 기존 키를 건드리지 않는다");
        fresh();
        ok("OK".equals(v.set("modelscope", K1, "")), "first key saved with hw");
        byte[] hwFile = java.nio.file.Files.readAllBytes(hw.file.toPath());
        hw.failSeal = true;
        ok("OK".equals(v.set("cloudflare", K2, ACC)) && "hw2".equals(v.prot("cloudflare")), "second key goes to hw2 while hw sealing is down");
        ok(K1.equals(v.apiKey("modelscope")) && java.util.Arrays.equals(hwFile, java.nio.file.Files.readAllBytes(hw.file.toPath())), "the first key is still readable; the hw key file is untouched (nothing is ever deleted)");
        // 전부 실패해도 기존 키는 그대로
        hw2.failSeal = true; sw.failSeal = true;
        String r = v.set("modelscope", "ms-new-DDDDDDDD3456", "");
        ok(r.startsWith("ERR:store:") && r.contains("hw:") && r.contains("hw2:") && r.contains("sw:"), "every tier down → ERR:store with all three reasons: " + r);
        ok(!r.contains("DDDDDDDD"), "the error never contains the key");
        ok(K1.equals(v.apiKey("modelscope")) && K2.equals(v.apiKey("cloudflare")), "failed save leaves the stored keys intact");
        // 저장소(SharedPreferences) 쓰기 실패
        hw.failSeal = false; hw2.failSeal = false; sw.failSeal = false; st.failCommit = true;
        r = v.set("modelscope", "ms-new-DDDDDDDD3456", "");
        ok("ERR:store:IOException".equals(r) && K1.equals(v.apiKey("modelscope")), "commit failure → ERR:store:IOException, nothing changed");
        st.failCommit = false;

        // ---------------------------------------------------------------- 읽을 수 없는 키
        System.out.println("▶ KeyVault: 저장된 키를 읽을 수 없을 때");
        fresh();
        v.set("modelscope", K1, "");
        hw.failOpen = true; // 보안 저장소 키가 망가짐(별칭은 있는데 못 연다)
        ok(v.hasKey("modelscope") && v.keyUnreadable("modelscope") && v.apiKey("modelscope") == null, "hasKey but unreadable");
        jo = new JSONObject(v.infoJson()).getJSONObject("providers").getJSONObject("modelscope");
        ok(jo.getBoolean("hasKey") && !jo.getBoolean("readable"), "info: readable=false");
        ok(!v.keyUnreadable("cloudflare"), "a provider without a key is not 'unreadable'");
        // 같은 상태에서 키를 다시 입력하면 망가진 별칭을 건너뛰고 v2 로 저장돼 다시 읽힌다
        ok("OK".equals(v.set("modelscope", K1, "")) && "hw2".equals(v.prot("modelscope")) && !v.keyUnreadable("modelscope") && K1.equals(v.apiKey("modelscope")), "re-entering the key while v1 is broken → saved with hw2, readable again");
        // 이후 요청 중 복호화 실패가 일어나면 곧바로 "읽을 수 없음"으로 보인다(캐시가 실패를 따라간다)
        hw2.failOpen = true;
        ok(v.apiKey("modelscope") == null && v.keyUnreadable("modelscope"), "a failed decrypt during a request flips the status to unreadable");

        // ---------------------------------------------------------------- 삭제된 제공자의 옛 항목 정리 / 삭제
        System.out.println("▶ KeyVault: OpenAI·OpenRouter 옛 항목 정리 · 삭제");
        st = new MemStore();
        hw = new FakeTier("hw", tmp("hw.k"));
        hw2 = new FakeTier("hw2", tmp("hw2.k"));
        sw = new FakeTier("sw", tmp("sw.k"));
        byte[][] legacy = hw.seal(K1.getBytes(UTF8));
        st.m.put("iv", java.util.Base64.getEncoder().encodeToString(legacy[0])); // 1.1~1.4 의 OpenAI 키(접두사 없는 이름)
        st.m.put("ct", java.util.Base64.getEncoder().encodeToString(legacy[1]));
        st.m.put("hint", "sk-…1234");
        st.m.put("base", "https://api.openai.com/v1");
        st.m.put("openrouter.iv", "x"); st.m.put("openrouter.ct", "y"); st.m.put("openrouter.hint", "sk-or-…9999"); st.m.put("openrouter.prot", "hw");
        st.m.put("cloudflare.iv", "keep-iv"); st.m.put("cloudflare.ct", "keep-ct"); st.m.put("cloudflare.extra", ACC);
        v = new KeyVault(st, hw, hw2, sw);
        ok(st.m.get("iv") == null && st.m.get("ct") == null && st.m.get("hint") == null && st.m.get("base") == null && st.m.get("openrouter.iv") == null && st.m.get("openrouter.ct") == null && st.m.get("openrouter.hint") == null && st.m.get("openrouter.prot") == null, "the removed providers' encrypted keys are deleted at start-up");
        ok("keep-iv".equals(st.m.get("cloudflare.iv")) && "keep-ct".equals(st.m.get("cloudflare.ct")) && ACC.equals(st.m.get("cloudflare.extra")), "other providers' entries are untouched");
        ok(!v.hasKey("modelscope") && !v.hasKey("gemini") && !v.hasKey("huggingface"), "nothing leaks into the new providers");
        v.set("modelscope", K1, "");
        v.set("cloudflare", K3, ACC);
        v.clear("modelscope");
        ok(!v.hasKey("modelscope") && v.hint("modelscope").isEmpty() && st.m.get("modelscope.prot") == null, "clear removes every modelscope field");
        ok(v.hasKey("cloudflare") && K3.equals(v.apiKey("cloudflare")) && ACC.equals(v.extra("cloudflare")), "other providers untouched");
        v.clear("cloudflare");
        ok(!v.hasKey("cloudflare") && v.extra("cloudflare").isEmpty() && st.m.get("cloudflare.prot") == null, "clear cloudflare incl. account ID");
        v.clear("nope");
        ok(!v.keyUnreadable("modelscope"), "after clear → not 'unreadable'");

        // ---------------------------------------------------------------- 점검
        System.out.println("▶ KeyVault.selfTest");
        fresh();
        hw.failSeal = true;
        ok("hw=KeyStoreException hw2=ok sw=ok".equals(v.selfTest()), "selfTest names the failing tier (and tries the second alias): " + v.selfTest());
        hw2.failSeal = true;
        ok("hw=KeyStoreException hw2=KeyStoreException sw=ok".equals(v.selfTest()), "both aliases failing, sw ok");
        sw.failSeal = true;
        ok("hw=KeyStoreException hw2=KeyStoreException sw=KeyStoreException".equals(v.selfTest()), "everything failing");

        // ---------------------------------------------------------------- SwTier (진짜 AES-256-GCM, 키 파일)
        System.out.println("▶ SwTier");
        File kf = tmp("a.k");
        KeyVault.SwTier a = new KeyVault.SwTier(kf);
        byte[][] sealed = a.seal("hello-key-12345".getBytes(UTF8));
        ok(sealed[0].length == 12 && kf.length() == 32, "12-byte IV, 32-byte key file");
        ok("hello-key-12345".equals(new String(a.open(sealed[0], sealed[1]), UTF8)), "round trip");
        ok("hello-key-12345".equals(new String(new KeyVault.SwTier(kf).open(sealed[0], sealed[1]), UTF8)), "key persists across instances");
        byte[][] sealed2 = a.seal("hello-key-12345".getBytes(UTF8));
        ok(!java.util.Arrays.equals(sealed[0], sealed2[0]) && !java.util.Arrays.equals(sealed[1], sealed2[1]), "fresh random IV every time");
        boolean threw = false;
        try {
            new KeyVault.SwTier(tmp("other2.k")).open(sealed[0], sealed[1]);
        } catch (Exception e) {
            threw = true;
        }
        ok(threw, "open without the key file fails");
        byte[] tampered = sealed[1].clone();
        tampered[0] ^= 1;
        threw = false;
        try {
            a.open(sealed[0], tampered);
        } catch (Exception e) {
            threw = true;
        }
        ok(threw, "tampered ciphertext is rejected (GCM tag)");
        a.reset();
        threw = false;
        try {
            a.open(sealed[0], sealed[1]);
        } catch (Exception e) {
            threw = true;
        }
        ok(threw, "after the key file is gone the old ciphertext cannot be opened");

        System.out.println("\nKeyVault tests: " + pass + " passed, " + fail + " failed");
        System.exit(fail == 0 ? 0 : 1);
    }
}
