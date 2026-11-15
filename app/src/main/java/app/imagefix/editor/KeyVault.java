package app.imagefix.editor;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.Charset;
import java.security.Key;
import java.security.KeyStore;
import java.security.SecureRandom;
import java.util.Arrays;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Pattern;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * AI 제공자별 API 키/부가 값 보관소 (cloudflare: 토큰 + 계정 ID, modelscope: 토큰, gemini: API 키, huggingface: 토큰).
 * 키는 AES-256-GCM 으로 암호화해 SharedPreferences 에 저장하고, 웹(JS) 쪽에는 마지막 4자리 힌트만 돌려준다.
 *
 * 암호화 방식(Tier)은 세 가지다. 키를 저장할 때 위에서부터 차례로 시도한다.
 * - hw : Android Keystore 의 AES-256-GCM 키(별칭 v1) — 키 자체가 기기 보안 영역에 있어 앱도 꺼낼 수 없다. 기본
 * - hw2: 같은 Keystore 의 다른 별칭(v2). v1 별칭이 망가진 기기(OS 업데이트·복원 뒤 남은 깨진 키 등)에서도 새 키로 계속 저장하려는 용도.
 *        망가진 별칭을 지우지는 않는다(지우면 이미 저장된 다른 키까지 잃을 수 있다).
 * - sw : Keystore 를 아예 쓸 수 없는 기기(일부 에뮬레이터·PC 용 안드로이드 등)용 대체. 앱 전용 폴더(noBackup)의 임의 AES-256 키 파일.
 *        앱 샌드박스가 지켜 주는 수준이라 hw 보다 약하므로 웹 화면에 그 사실을 알린다(info 의 prot).
 * 저장 직후 그 방식으로 다시 풀어 보아 같은 값이 나오는지 확인하고, 실패하면 다음 방식으로 넘어간다(저장했다고 해 놓고 못 읽는 일을 막는다).
 * 저장 키 이름: "<제공자>.iv" · ".ct" · ".hint" · ".prot" · ".extra". 이전 버전의 OpenAI/OpenRouter 항목은 시작할 때 지운다(제공자 삭제).
 */
final class KeyVault implements AiClient.Config {
    private static final String ALIAS = "imagefix_ai_v1", ALIAS2 = "imagefix_ai_v2";
    private static final String PREFS = "imagefix_ai";
    private static final Charset UTF8 = Charset.forName("UTF-8");
    private static final Pattern KEY_OK = Pattern.compile("^[\\x21-\\x7e]{8,400}$");
    static final String[] PROVIDERS = {"cloudflare", "modelscope", "gemini", "huggingface"};

    /** 문자열 저장소 (실기기: SharedPreferences, 테스트: 메모리) */
    interface Store {
        String get(String key);

        /** removes 를 지우고 puts 를 쓴 것을 한 번에 반영. 저장에 실패하면 예외 */
        void commit(Map<String, String> puts, String... removes) throws IOException;
    }

    /** 암호화 방식 한 가지. 어느 단계든 실패하면 예외 */
    interface Tier {
        String id();

        /** {iv, 암호문} */
        byte[][] seal(byte[] plain) throws Exception;

        byte[] open(byte[] iv, byte[] ct) throws Exception;
    }

    private final Store store;
    private final Tier hw, hw2, sw;
    /** 제공자별 "저장된 키를 풀 수 있나" 확인 결과(저장·삭제 때 비움) — 설정 화면을 열 때마다 Keystore 를 두드리지 않으려고 */
    private final Map<String, Boolean> readableCache = new HashMap<String, Boolean>();

    KeyVault(Context c) {
        this(new PrefsStore(c.getSharedPreferences(PREFS, Context.MODE_PRIVATE)), new HwTier("hw", ALIAS), new HwTier("hw2", ALIAS2), new SwTier(swFile(c)));
    }

    KeyVault(Store store, Tier hw, Tier hw2, Tier sw) {
        this.store = store;
        this.hw = hw;
        this.hw2 = hw2;
        this.sw = sw;
        purgeRemovedProviders();
    }

    /** 삭제된 제공자(OpenAI·OpenRouter)가 저장해 둔 키/주소를 지운다 — 더는 쓸 수 없는 암호화된 키를 기기에 남겨 두지 않는다 */
    private void purgeRemovedProviders() {
        try {
            List<String> names = new ArrayList<String>();
            for (String n : new String[]{"iv", "ct", "hint", "base", "prot", "extra"}) {
                names.add(n); // 1.1~1.4: OpenAI 는 접두사 없는 이름을 썼다
                names.add("openrouter." + n);
                names.add("openai." + n);
            }
            boolean any = false;
            for (String n : names) if (store.get(n) != null) {
                any = true;
                break;
            }
            if (any) store.commit(new HashMap<String, String>(), names.toArray(new String[0]));
        } catch (Throwable ignore) {
            // 지우지 못해도 쓰이지 않는다
        }
    }

    private static File swFile(Context c) {
        File dir = c.getNoBackupFilesDir();
        if (dir == null) dir = c.getFilesDir();
        return new File(dir, "imagefix_ai.k");
    }

    static String defaultBase(String provider) {
        if ("gemini".equals(provider)) return "https://generativelanguage.googleapis.com/v1beta";
        if ("huggingface".equals(provider)) return "https://router.huggingface.co";
        if ("modelscope".equals(provider)) return "https://api-inference.modelscope.cn/v1";
        return "https://api.cloudflare.com/client/v4";
    }

    private static String k(String provider, String name) {
        return provider + "." + name;
    }

    // ------------------------------------------------------------------ 저장

    /**
     * 저장. key 가 비어 있으면 기존 키를 유지한 채 부가 값(cloudflare 계정 ID)만 바꾼다.
     * 성공 "OK", 실패 "ERR:provider|nokey|badkey|badextra" 또는 "ERR:store:<원인>"(원인 = 예외 클래스 이름, 키 내용은 절대 넣지 않는다)
     */
    synchronized String set(String provider, String key, String extra) {
        if (!AiClient.knownProvider(provider)) return "ERR:provider";
        if (!AiClient.needsKey(provider)) return "ERR:nokey"; // 알 수 없는 제공자
        boolean isCf = "cloudflare".equals(provider);
        String ex = extra == null ? "" : extra.trim().toLowerCase(Locale.ROOT);
        if (isCf && ex.length() > 0 && !AiClient.validAccount(ex)) return "ERR:badextra";
        Map<String, String> puts = new HashMap<String, String>();
        if (isCf && ex.length() > 0) puts.put(k(provider, "extra"), ex);
        try {
            if (key == null || key.length() == 0) {
                if (!hasKey(provider)) return "ERR:badkey";
                store.commit(puts);
                return "OK";
            }
            String kk = key.trim();
            if (!KEY_OK.matcher(kk).matches()) return "ERR:badkey";
            if (isCf && ex.length() == 0 && extra(provider).length() == 0) return "ERR:badextra";
            String why = sealInto(provider, kk, puts);
            if (why != null) return "ERR:store:" + why;
            store.commit(puts);
            readableCache.clear();
            return "OK";
        } catch (Throwable e) {
            readableCache.clear();
            return "ERR:store:" + e.getClass().getSimpleName();
        }
    }

    /**
     * 키를 암호화해 puts 에 담는다. 성공 null, 실패 원인("hw:KeyStoreException/hw2:…/sw:…").
     * hw → hw2 → sw 순으로 시도하고, 매번 저장 직후 풀어 보아 같은 값인지 확인한다. 어떤 키도 지우지 않는다.
     */
    private String sealInto(String provider, String kk, Map<String, String> puts) {
        byte[] plain = kk.getBytes(UTF8);
        StringBuilder why = new StringBuilder();
        for (Tier t : new Tier[]{hw, hw2, sw}) {
            String w = trySeal(t, plain, kk, provider, puts);
            if (w == null) return null;
            if (why.length() > 0) why.append('/');
            why.append(w);
        }
        return why.toString();
    }

    private String trySeal(Tier t, byte[] plain, String kk, String provider, Map<String, String> puts) {
        try {
            byte[][] s = t.seal(plain);
            byte[] back = t.open(s[0], s[1]);
            if (!Arrays.equals(plain, back)) return t.id() + ":mismatch";
            puts.put(k(provider, "iv"), b64(s[0]));
            puts.put(k(provider, "ct"), b64(s[1]));
            puts.put(k(provider, "prot"), t.id());
            puts.put(k(provider, "hint"), kk.substring(0, Math.min(3, kk.length())) + "…" + kk.substring(kk.length() - 4));
            return null;
        } catch (Throwable e) {
            return t.id() + ":" + e.getClass().getSimpleName();
        }
    }

    private static String b64(byte[] b) {
        return Base64.getEncoder().encodeToString(b);
    }

    // ------------------------------------------------------------------ 읽기

    synchronized boolean hasKey(String provider) {
        return store.get(k(provider, "ct")) != null && store.get(k(provider, "iv")) != null;
    }

    synchronized String hint(String provider) {
        String h = store.get(k(provider, "hint"));
        return h == null ? "" : h;
    }

    /** 저장된 방식: "hw"(Keystore 별칭 v1) / "hw2"(별칭 v2) / "sw"(앱 전용 키 파일). 이전 버전에서 저장한 값은 hw */
    synchronized String prot(String provider) {
        String p = store.get(k(provider, "prot"));
        return "sw".equals(p) || "hw2".equals(p) ? p : "hw";
    }

    private Tier tierOf(String protId) {
        return "sw".equals(protId) ? sw : "hw2".equals(protId) ? hw2 : hw;
    }

    /** 저장된 키를 푼다(없거나 못 풀면 null). 결과는 readableCache 에도 반영한다 — 실제 요청 중 복호화가 실패하면 바로 "읽을 수 없음"으로 보이도록 */
    private String openKey(String provider) {
        String out = null;
        try {
            String iv = store.get(k(provider, "iv")), ct = store.get(k(provider, "ct"));
            if (iv == null || ct == null) {
                readableCache.remove(provider);
                return null;
            }
            Tier t = tierOf(prot(provider));
            out = new String(t.open(Base64.getDecoder().decode(iv), Base64.getDecoder().decode(ct)), UTF8);
        } catch (Throwable e) {
            out = null;
        }
        readableCache.put(provider, out != null);
        return out;
    }

    /** 키가 저장돼 있는데 풀 수 없나(보안 저장소가 초기화됐거나 고장) */
    @Override
    public synchronized boolean keyUnreadable(String provider) {
        if (!hasKey(provider)) return false;
        Boolean c = readableCache.get(provider);
        if (c == null) c = openKey(provider) != null;
        return !c;
    }

    synchronized void clear(String provider) {
        if (!AiClient.knownProvider(provider)) return;
        try {
            store.commit(new HashMap<String, String>(), k(provider, "iv"), k(provider, "ct"), k(provider, "hint"), k(provider, "extra"), k(provider, "prot"));
        } catch (Throwable ignore) {
            // 삭제 실패는 다음 저장 때 덮어써진다
        }
        readableCache.clear();
    }

    /** 웹에 돌려줄 상태: {"v":3,"providers":{"cloudflare":{"hasKey":..,"hint":..,"extra":..,"readable":..,"prot":..},…}} (키 자체는 없음) */
    synchronized String infoJson() {
        try {
            JSONObject ps = new JSONObject();
            for (String p : PROVIDERS) {
                JSONObject o = new JSONObject();
                boolean has = hasKey(p);
                o.put("hasKey", has);
                o.put("hint", hint(p));
                o.put("extra", extra(p));
                o.put("readable", !keyUnreadable(p));
                o.put("prot", has ? prot(p) : "");
                ps.put(p, o);
            }
            return new JSONObject().put("v", 3).put("providers", ps).toString();
        } catch (Throwable e) {
            return "{\"v\":3,\"providers\":{}}";
        }
    }

    /** 문제 해결용 점검: 저장 방식이 각각 암호화→복호화를 해내는지. 예) "hw=ok sw=ok" / "hw=KeyStoreException hw2=ok sw=ok"(hw 가 안 될 때만 hw2 도 점검). 키 값은 쓰지 않는다 */
    synchronized String selfTest() {
        String h = probe(hw);
        return "hw=" + h + ("ok".equals(h) ? "" : " hw2=" + probe(hw2)) + " sw=" + probe(sw);
    }

    private static String probe(Tier t) {
        try {
            byte[] p = "imagefix-selftest".getBytes(UTF8);
            byte[][] s = t.seal(p);
            return Arrays.equals(p, t.open(s[0], s[1])) ? "ok" : "mismatch";
        } catch (Throwable e) {
            return e.getClass().getSimpleName();
        }
    }

    @Override
    public synchronized String baseUrl(String provider) {
        return defaultBase(provider);
    }

    @Override
    public synchronized String extra(String provider) {
        String e = store.get(k(provider, "extra"));
        return e == null ? "" : e;
    }

    @Override
    public synchronized String apiKey(String provider) {
        return openKey(provider);
    }

    // ------------------------------------------------------------------ 저장소 / 암호화 방식 구현

    /** SharedPreferences 저장소. apply() 가 아니라 commit() — 돌아온 뒤 곧바로 앱이 끝나도 남고, 실패하면 알 수 있다 */
    private static final class PrefsStore implements Store {
        private final SharedPreferences sp;

        PrefsStore(SharedPreferences sp) {
            this.sp = sp;
        }

        @Override
        public String get(String key) {
            return sp.getString(key, null);
        }

        @Override
        public void commit(Map<String, String> puts, String... removes) throws IOException {
            SharedPreferences.Editor ed = sp.edit();
            for (String r : removes) ed.remove(r);
            for (Map.Entry<String, String> e : puts.entrySet()) ed.putString(e.getKey(), e.getValue());
            if (!ed.commit()) throw new IOException("prefs");
        }
    }

    /** Android Keystore AES-256-GCM (별칭 하나당 한 방식) */
    private static final class HwTier implements Tier {
        private final String id, alias;

        HwTier(String id, String alias) {
            this.id = id;
            this.alias = alias;
        }

        @Override
        public String id() {
            return id;
        }

        private SecretKey key(boolean create) throws Exception {
            KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
            ks.load(null);
            Key existing = ks.containsAlias(alias) ? ks.getKey(alias, null) : null;
            if (existing instanceof SecretKey) return (SecretKey) existing;
            if (!create) throw new IllegalStateException("nokey");
            KeyGenerator kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            kg.init(new KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .build());
            return kg.generateKey();
        }

        @Override
        public byte[][] seal(byte[] plain) throws Exception {
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.ENCRYPT_MODE, key(true));
            byte[] ct = c.doFinal(plain);
            return new byte[][]{c.getIV(), ct};
        }

        @Override
        public byte[] open(byte[] iv, byte[] ct) throws Exception {
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.DECRYPT_MODE, key(false), new GCMParameterSpec(128, iv));
            return c.doFinal(ct);
        }
    }

    /** 앱 전용 폴더의 임의 AES-256 키 파일로 암호화(Keystore 를 쓸 수 없는 기기용 대체). JVM 에서도 돌아간다(테스트) */
    static final class SwTier implements Tier {
        private final File file;
        private final SecureRandom rnd = new SecureRandom();

        SwTier(File file) {
            this.file = file;
        }

        @Override
        public String id() {
            return "sw";
        }

        private synchronized SecretKey key(boolean create) throws Exception {
            if (file.isFile() && file.length() == 32) {
                byte[] b = new byte[32];
                FileInputStream in = new FileInputStream(file);
                try {
                    int n = 0, r;
                    while (n < 32 && (r = in.read(b, n, 32 - n)) > 0) n += r;
                    if (n != 32) throw new IOException("short");
                } finally {
                    in.close();
                }
                return new SecretKeySpec(b, "AES");
            }
            if (!create) throw new IllegalStateException("nokey");
            File dir = file.getParentFile();
            if (dir != null && !dir.isDirectory() && !dir.mkdirs()) throw new IOException("mkdir");
            byte[] b = new byte[32];
            rnd.nextBytes(b);
            File tmp = new File(file.getPath() + ".tmp");
            FileOutputStream out = new FileOutputStream(tmp);
            try {
                out.write(b);
                out.getFD().sync();
            } finally {
                out.close();
            }
            tmp.setReadable(false, false);
            tmp.setReadable(true, true);
            tmp.setWritable(false, false);
            tmp.setWritable(true, true);
            if (!tmp.renameTo(file)) throw new IOException("rename");
            return new SecretKeySpec(b, "AES");
        }

        @Override
        public byte[][] seal(byte[] plain) throws Exception {
            byte[] iv = new byte[12];
            rnd.nextBytes(iv);
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.ENCRYPT_MODE, key(true), new GCMParameterSpec(128, iv));
            return new byte[][]{iv, c.doFinal(plain)};
        }

        @Override
        public byte[] open(byte[] iv, byte[] ct) throws Exception {
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.DECRYPT_MODE, key(false), new GCMParameterSpec(128, iv));
            return c.doFinal(ct);
        }

        /** 키 파일 삭제(테스트용 — 앱은 쓰지 않는다) */
        void reset() {
            file.delete();
        }
    }
}
