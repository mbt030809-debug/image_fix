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

    static final String K1 = "sk-test-AAAAAAAA1234", K2 = "sk-or-v1-BBBBBBBB5678", K3 = "cf-token-CCCCCCCC9012";
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
        ok("OK".equals(v.set("openai", "  " + K1 + " \n", "", "")), "save (trimmed) → OK");
        ok(K1.equals(v.apiKey("openai")) && v.hasKey("openai") && "hw".equals(v.prot("openai")), "read back through hw");
        ok("sk-…1234".equals(v.hint("openai")), "hint = first 3 + … + last 4");
        ok(!st.m.get("ct").contains("AAAAAAAA") && "hw".equals(st.m.get("prot")), "ciphertext is stored, not the key; prot=hw (legacy key names for openai)");
        ok(!v.keyUnreadable("openai"), "readable");
        String info = v.infoJson();
        JSONObject jo = new JSONObject(info).getJSONObject("providers").getJSONObject("openai");
        ok(jo.getBoolean("hasKey") && jo.getBoolean("readable") && "hw".equals(jo.getString("prot")) && !info.contains("AAAAAAAA"), "info: hasKey/readable/prot, no key material");
        ok(!hw2.file.exists() && !sw.file.exists(), "the other tiers are not even touched when hw works");
        ok("hw=ok sw=ok".equals(v.selfTest()), "selfTest ok");

        // ---------------------------------------------------------------- 입력 검증
        System.out.println("▶ KeyVault: 입력 검증");
        ok("ERR:provider".equals(v.set("nope", K1, "", "")), "unknown provider");
        ok("ERR:badkey".equals(v.set("openai", "short", "", "")), "too short key");
        ok("ERR:badkey".equals(v.set("openai", "sk-aaaa bbbbbbbb", "", "")), "inner whitespace");
        ok("ERR:badkey".equals(v.set("openai", "sk-한글한글한글한글", "", "")), "non-ASCII key");
        ok("ERR:badbase".equals(v.set("openai", K1, "http://api.openai.com/v1", "")), "bad base");
        ok("ERR:badkey".equals(v.set("openrouter", "", "", "")), "empty key without a stored one");
        ok("ERR:badextra".equals(v.set("cloudflare", K3, "", "")), "cloudflare needs the account ID");
        ok("ERR:badextra".equals(v.set("cloudflare", K3, "", "1234")), "malformed account ID");
        ok("OK".equals(v.set("cloudflare", K3, "", ACC.toUpperCase())) && ACC.equals(v.extra("cloudflare")), "account ID stored lowercase");
        ok("OK".equals(v.set("cloudflare", "", "", "")) && K3.equals(v.apiKey("cloudflare")), "empty key keeps the stored key");
        ok("OK".equals(v.set("openai", "", "https://gw.example.com/v1", "")) && "https://gw.example.com/v1".equals(v.baseUrl("openai")) && K1.equals(v.apiKey("openai")), "base can change without re-entering the key");
        ok(v.set("openai", K1, "", "").equals("OK") && KeyVault.DEFAULT_BASE.equals(v.baseUrl("openai")), "re-save with empty base → default");

        // ---------------------------------------------------------------- 대체: hw → hw2 → sw
        System.out.println("▶ KeyVault: hw 실패 → hw2(별칭 v2) → sw(앱 전용 저장소)");
        fresh();
        hw.failSeal = true;
        ok("OK".equals(v.set("openrouter", K2, "", "")), "hw cannot seal → still saved");
        ok(K2.equals(v.apiKey("openrouter")) && "hw2".equals(v.prot("openrouter")) && "hw2".equals(st.m.get("openrouter.prot")), "stored with hw2 (second Keystore alias)");
        jo = new JSONObject(v.infoJson()).getJSONObject("providers").getJSONObject("openrouter");
        ok("hw2".equals(jo.getString("prot")) && jo.getBoolean("readable"), "info reports prot=hw2, readable");
        ok(!sw.file.exists(), "sw is not used while a Keystore alias works");
        // 저장 직후 풀어 보았을 때 값이 다르면(오염) 그 방식은 쓰지 않는다
        fresh();
        hw.garbleOpen = true;
        ok("OK".equals(v.set("openai", K1, "", "")) && "hw2".equals(v.prot("openai")) && K1.equals(v.apiKey("openai")), "hw round trip mismatch → hw2");
        // Keystore 전체가 안 되면 앱 전용 저장소
        fresh();
        hw.failSeal = true; hw2.failSeal = true;
        ok("OK".equals(v.set("openrouter", K2, "", "")) && "sw".equals(v.prot("openrouter")) && K2.equals(v.apiKey("openrouter")), "no Keystore at all → sw");
        ok("sw".equals(st.m.get("openrouter.prot")) && !st.m.get("openrouter.ct").contains("BBBBBBBB"), "sw ciphertext is not the key");
        jo = new JSONObject(v.infoJson()).getJSONObject("providers").getJSONObject("openrouter");
        ok("sw".equals(jo.getString("prot")) && jo.getBoolean("readable"), "info reports prot=sw");

        // ---------------------------------------------------------------- 아무것도 지우지 않는다
        System.out.println("▶ KeyVault: 대체 저장은 기존 키를 건드리지 않는다");
        fresh();
        ok("OK".equals(v.set("openai", K1, "", "")), "first key saved with hw");
        byte[] hwFile = java.nio.file.Files.readAllBytes(hw.file.toPath());
        hw.failSeal = true;
        ok("OK".equals(v.set("openrouter", K2, "", "")) && "hw2".equals(v.prot("openrouter")), "second key goes to hw2 while hw sealing is down");
        ok(K1.equals(v.apiKey("openai")) && java.util.Arrays.equals(hwFile, java.nio.file.Files.readAllBytes(hw.file.toPath())), "the first key is still readable; the hw key file is untouched (nothing is ever deleted)");
        // 전부 실패해도 기존 키는 그대로
        hw2.failSeal = true; sw.failSeal = true;
        String r = v.set("openai", "sk-new-DDDDDDDD3456", "", "");
        ok(r.startsWith("ERR:store:") && r.contains("hw:") && r.contains("hw2:") && r.contains("sw:"), "every tier down → ERR:store with all three reasons: " + r);
        ok(!r.contains("DDDDDDDD"), "the error never contains the key");
        ok(K1.equals(v.apiKey("openai")) && K2.equals(v.apiKey("openrouter")), "failed save leaves the stored keys intact");
        // 저장소(SharedPreferences) 쓰기 실패
        hw.failSeal = false; hw2.failSeal = false; sw.failSeal = false; st.failCommit = true;
        r = v.set("openai", "sk-new-DDDDDDDD3456", "", "");
        ok("ERR:store:IOException".equals(r) && K1.equals(v.apiKey("openai")), "commit failure → ERR:store:IOException, nothing changed");
        st.failCommit = false;

        // ---------------------------------------------------------------- 읽을 수 없는 키
        System.out.println("▶ KeyVault: 저장된 키를 읽을 수 없을 때");
        fresh();
        v.set("openai", K1, "", "");
        hw.failOpen = true; // 보안 저장소 키가 망가짐(별칭은 있는데 못 연다)
        ok(v.hasKey("openai") && v.keyUnreadable("openai") && v.apiKey("openai") == null, "hasKey but unreadable");
        jo = new JSONObject(v.infoJson()).getJSONObject("providers").getJSONObject("openai");
        ok(jo.getBoolean("hasKey") && !jo.getBoolean("readable"), "info: readable=false");
        ok(!v.keyUnreadable("openrouter"), "a provider without a key is not 'unreadable'");
        // 같은 상태에서 키를 다시 입력하면 망가진 별칭을 건너뛰고 v2 로 저장돼 다시 읽힌다
        ok("OK".equals(v.set("openai", K1, "", "")) && "hw2".equals(v.prot("openai")) && !v.keyUnreadable("openai") && K1.equals(v.apiKey("openai")), "re-entering the key while v1 is broken → saved with hw2, readable again");
        // 이후 요청 중 복호화 실패가 일어나면 곧바로 "읽을 수 없음"으로 보인다(캐시가 실패를 따라간다)
        hw2.failOpen = true;
        ok(v.apiKey("openai") == null && v.keyUnreadable("openai"), "a failed decrypt during a request flips the status to unreadable");

        // ---------------------------------------------------------------- 이전 버전(prot 없음) 호환 / 삭제
        System.out.println("▶ KeyVault: 이전 저장 형식 호환 · 삭제");
        fresh();
        byte[][] legacy = hw.seal(K1.getBytes(UTF8));
        st.m.put("iv", java.util.Base64.getEncoder().encodeToString(legacy[0]));
        st.m.put("ct", java.util.Base64.getEncoder().encodeToString(legacy[1]));
        st.m.put("hint", "sk-…1234");
        st.m.put("base", "https://api.openai.com/v1");
        ok(K1.equals(v.apiKey("openai")) && "hw".equals(v.prot("openai")) && v.hasKey("openai"), "1.1.x–1.3.0 saved key (no prot) still opens via hw");
        v.set("openrouter", K2, "", "");
        v.set("cloudflare", K3, "", ACC);
        v.clear("openai");
        ok(!v.hasKey("openai") && v.hint("openai").isEmpty() && st.m.get("prot") == null && st.m.get("base") == null, "clear removes every openai field");
        ok(v.hasKey("openrouter") && v.hasKey("cloudflare") && ACC.equals(v.extra("cloudflare")), "other providers untouched");
        v.clear("cloudflare");
        ok(!v.hasKey("cloudflare") && v.extra("cloudflare").isEmpty() && st.m.get("cloudflare.prot") == null, "clear cloudflare incl. account ID");
        v.clear("nope");
        ok(!v.keyUnreadable("openai"), "after clear → not 'unreadable'");

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
