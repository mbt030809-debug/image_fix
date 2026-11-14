package app.imagefix.editor;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;

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
 * AI 서버 주소와 API 키 보관소.
 * 키는 Android Keystore 의 AES-256-GCM 키로 암호화해 SharedPreferences 에 저장하고, 웹(JS) 쪽에는 마지막 4자리 힌트만 돌려준다.
 * Keystore 를 쓸 수 없는 기기에서는 평문으로 저장하지 않고 저장을 거부한다.
 */
final class KeyVault implements AiClient.Config {
    static final String DEFAULT_BASE = "https://api.openai.com/v1";
    private static final String ALIAS = "imagefix_ai_v1";
    private static final String PREFS = "imagefix_ai";
    private static final Charset UTF8 = Charset.forName("UTF-8");
    private static final Pattern KEY_OK = Pattern.compile("^[\\x21-\\x7e]{8,400}$");
    private static final Pattern HOST_OK = Pattern.compile("^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$");
    private static final Pattern PATH_OK = Pattern.compile("^(/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$"); // "."/".." 구간 거부

    private final SharedPreferences sp;

    KeyVault(Context c) {
        sp = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
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

    /** 저장. key 가 비어 있으면 기존 키를 유지한 채 서버 주소만 바꾼다. 성공 "OK", 실패 "ERR:…" */
    synchronized String set(String key, String base) {
        String nb = validateBase(base);
        if (nb == null) return "ERR:badbase";
        try {
            if (key == null || key.length() == 0) {
                if (!hasKey()) return "ERR:badkey";
                sp.edit().putString("base", nb).apply();
                return "OK";
            }
            String k = key.trim();
            if (!KEY_OK.matcher(k).matches()) return "ERR:badkey";
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.ENCRYPT_MODE, secret());
            byte[] ct = c.doFinal(k.getBytes(UTF8));
            String hint = k.substring(0, Math.min(3, k.length())) + "…" + k.substring(k.length() - 4);
            sp.edit()
                    .putString("iv", Base64.getEncoder().encodeToString(c.getIV()))
                    .putString("ct", Base64.getEncoder().encodeToString(ct))
                    .putString("hint", hint)
                    .putString("base", nb)
                    .apply();
            return "OK";
        } catch (Throwable e) {
            return "ERR:store";
        }
    }

    synchronized boolean hasKey() {
        return sp.getString("ct", null) != null && sp.getString("iv", null) != null;
    }

    synchronized String hint() {
        return sp.getString("hint", "");
    }

    synchronized void clear() {
        sp.edit().clear().apply();
    }

    @Override
    public synchronized String baseUrl() {
        String b = sp.getString("base", null);
        String v = b == null ? DEFAULT_BASE : validateBase(b);
        return v == null ? DEFAULT_BASE : v;
    }

    @Override
    public synchronized String apiKey() {
        try {
            String iv = sp.getString("iv", null), ct = sp.getString("ct", null);
            if (iv == null || ct == null) return null;
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.DECRYPT_MODE, secret(), new GCMParameterSpec(128, Base64.getDecoder().decode(iv)));
            return new String(c.doFinal(Base64.getDecoder().decode(ct)), UTF8);
        } catch (Throwable e) {
            return null;
        }
    }
}
