package app.imagefix.editor;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;

import org.json.JSONObject;

import java.net.URI;
import java.net.URISyntaxException;
import java.nio.charset.Charset;
import java.security.KeyStore;
import java.util.Base64;
import java.util.Locale;
import java.util.regex.Pattern;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * AI 제공자별 API 키/서버 주소/부가 값 보관소.
 * 키는 Android Keystore 의 AES-256-GCM 키로 암호화해 SharedPreferences 에 저장하고, 웹(JS) 쪽에는 마지막 4자리 힌트만 돌려준다.
 * Keystore 를 쓸 수 없는 기기에서는 평문으로 저장하지 않고 저장을 거부한다.
 * 저장 키 이름: openai 는 iv/ct/hint/base (이전 버전과 호환), 그 외는 "<제공자>.iv" 등.
 */
final class KeyVault implements AiClient.Config {
    static final String DEFAULT_BASE = "https://api.openai.com/v1";
    private static final String ALIAS = "imagefix_ai_v1";
    private static final String PREFS = "imagefix_ai";
    private static final Charset UTF8 = Charset.forName("UTF-8");
    private static final Pattern KEY_OK = Pattern.compile("^[\\x21-\\x7e]{8,400}$");
    private static final Pattern HOST_OK = Pattern.compile("^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$");
    private static final Pattern PATH_OK = Pattern.compile("^(/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$"); // "."/".." 구간 거부
    static final String[] PROVIDERS = {"openai", "openrouter", "cloudflare"};

    private final SharedPreferences sp;

    KeyVault(Context c) {
        sp = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static String defaultBase(String provider) {
        if ("openrouter".equals(provider)) return "https://openrouter.ai/api/v1";
        if ("cloudflare".equals(provider)) return "https://api.cloudflare.com/client/v4";
        return DEFAULT_BASE;
    }

    private static String k(String provider, String name) {
        return "openai".equals(provider) ? name : provider + "." + name;
    }

    /** 서버 주소 정규화. 공개 도메인의 https 주소만 허용(IP·localhost·사내 도메인·자격 증명·쿼리 거부). 빈 값이면 기본값. 잘못되면 null */
    static String validateBase(String raw) {
        if (raw == null || raw.trim().length() == 0) return DEFAULT_BASE;
        String s = raw.trim();
        if (s.length() > 200) return null;
        URI u;
        try {
            u = new URI(s);
        } catch (URISyntaxException e) {
            return null;
        }
        if (!"https".equals(u.getScheme())) return null;
        if (u.getRawUserInfo() != null || u.getRawQuery() != null || u.getRawFragment() != null) return null;
        if (u.getPort() != -1 && u.getPort() != 443) return null;
        String host = u.getHost();
        if (host == null) return null;
        host = host.toLowerCase(Locale.ROOT);
        if (!HOST_OK.matcher(host).matches()) return null;
        if (host.matches("[0-9.]+")) return null; // IPv4 리터럴
        if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".localhost") || host.endsWith(".lan") || host.endsWith(".home")) return null;
        String path = u.getRawPath() == null ? "" : u.getRawPath();
        while (path.endsWith("/")) path = path.substring(0, path.length() - 1);
        if (!PATH_OK.matcher(path).matches() || path.length() > 80) return null;
        return "https://" + host + path;
    }

    private SecretKey secret() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        if (!ks.containsAlias(ALIAS)) {
            KeyGenerator kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            kg.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .build());
            return kg.generateKey();
        }
        return ((KeyStore.SecretKeyEntry) ks.getEntry(ALIAS, null)).getSecretKey();
    }

    /**
     * 저장. key 가 비어 있으면 기존 키를 유지한 채 서버 주소(openai 만)/부가 값(cloudflare 계정 ID)만 바꾼다.
     * 성공 "OK", 실패 "ERR:provider|badbase|badkey|badextra|store"
     */
    synchronized String set(String provider, String key, String base, String extra) {
        if (!AiClient.knownProvider(provider)) return "ERR:provider";
        boolean isOpenAi = "openai".equals(provider), isCf = "cloudflare".equals(provider);
        String nb = null;
        if (isOpenAi) {
            nb = validateBase(base);
            if (nb == null) return "ERR:badbase";
        }
        String ex = extra == null ? "" : extra.trim().toLowerCase(Locale.ROOT);
        if (isCf && ex.length() > 0 && !AiClient.validAccount(ex)) return "ERR:badextra";
        try {
            if (key == null || key.length() == 0) {
                if (!hasKey(provider)) return "ERR:badkey";
                SharedPreferences.Editor ed = sp.edit();
                if (isOpenAi) ed.putString(k(provider, "base"), nb);
                if (isCf && ex.length() > 0) ed.putString(k(provider, "extra"), ex);
                ed.apply();
                return "OK";
            }
            String kk = key.trim();
            if (!KEY_OK.matcher(kk).matches()) return "ERR:badkey";
            if (isCf && ex.length() == 0 && extra(provider).length() == 0) return "ERR:badextra";
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.ENCRYPT_MODE, secret());
            byte[] ct = c.doFinal(kk.getBytes(UTF8));
            String hint = kk.substring(0, Math.min(3, kk.length())) + "…" + kk.substring(kk.length() - 4);
            SharedPreferences.Editor ed = sp.edit()
                    .putString(k(provider, "iv"), Base64.getEncoder().encodeToString(c.getIV()))
                    .putString(k(provider, "ct"), Base64.getEncoder().encodeToString(ct))
                    .putString(k(provider, "hint"), hint);
            if (isOpenAi) ed.putString(k(provider, "base"), nb);
            if (isCf && ex.length() > 0) ed.putString(k(provider, "extra"), ex);
            ed.apply();
            return "OK";
        } catch (Throwable e) {
            return "ERR:store";
        }
    }

    synchronized boolean hasKey(String provider) {
        return sp.getString(k(provider, "ct"), null) != null && sp.getString(k(provider, "iv"), null) != null;
    }

    synchronized String hint(String provider) {
        return sp.getString(k(provider, "hint"), "");
    }

    synchronized void clear(String provider) {
        if (!AiClient.knownProvider(provider)) return;
        SharedPreferences.Editor ed = sp.edit();
        for (String n : new String[]{"iv", "ct", "hint", "base", "extra"}) ed.remove(k(provider, n));
        ed.apply();
    }

    /** 웹에 돌려줄 상태: {"v":2,"providers":{"openai":{"hasKey":..,"hint":..,"base":..,"extra":..},…}} (키 자체는 없음) */
    synchronized String infoJson() {
        try {
            JSONObject ps = new JSONObject();
            for (String p : PROVIDERS) {
                JSONObject o = new JSONObject();
                o.put("hasKey", hasKey(p));
                o.put("hint", hint(p));
                o.put("base", baseUrl(p));
                o.put("extra", extra(p));
                ps.put(p, o);
            }
            return new JSONObject().put("v", 2).put("providers", ps).toString();
        } catch (Throwable e) {
            return "{\"v\":2,\"providers\":{}}";
        }
    }

    @Override
    public synchronized String baseUrl(String provider) {
        if (!"openai".equals(provider)) return defaultBase(provider);
        String b = sp.getString(k(provider, "base"), null);
        String v = b == null ? DEFAULT_BASE : validateBase(b);
        return v == null ? DEFAULT_BASE : v;
    }

    @Override
    public synchronized String extra(String provider) {
        return sp.getString(k(provider, "extra"), "");
    }

    @Override
    public synchronized String apiKey(String provider) {
        try {
            String iv = sp.getString(k(provider, "iv"), null), ct = sp.getString(k(provider, "ct"), null);
            if (iv == null || ct == null) return null;
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.DECRYPT_MODE, secret(), new GCMParameterSpec(128, Base64.getDecoder().decode(iv)));
            return new String(c.doFinal(Base64.getDecoder().decode(ct)), UTF8);
        } catch (Throwable e) {
            return null;
        }
    }
}
