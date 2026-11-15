package app.imagefix.editor;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.Charset;
import java.security.MessageDigest;
import java.util.regex.Pattern;

/**
 * 앱 업데이트 확인/내려받기(안드로이드 클래스 없이 — JVM 에서 시험 가능).
 * GitHub 저장소의 release/latest.json(고정 주소) 을 읽어 새 버전이 있는지 보고, 있으면 같은 저장소의 APK 를 내려받아 SHA-256 을 확인한다.
 * 설치는 MainActivity 가 PackageInstaller 로 한다(같은 서명키가 아니면 안드로이드가 거부한다).
 * 이 클래스가 접속하는 곳은 아래 두 주소(raw.githubusercontent.com 의 이 저장소)뿐이다. 리다이렉트는 따라가지 않는다.
 */
final class Updater {
    static final String BASE = "https://raw.githubusercontent.com/mbt030809-debug/image_fix/ccr-e993314a-wbx5os/";
    static final String MANIFEST_PATH = "release/latest.json";
    static final int MAX_MANIFEST = 64 * 1024;
    static final long MAX_APK = 40L * 1024 * 1024;
    /** 테스트 전용: 기본 주소와 http 허용 */
    static String baseOverride = null;
    static boolean insecureForTests = false;

    private static final Pattern NAME_OK = Pattern.compile("^[0-9A-Za-z.+-]{1,20}$");
    private static final Pattern APK_OK = Pattern.compile("^release/ImageFix_[0-9]{4}-[0-9]{2}-[0-9]{2}\\.apk$");
    private static final Pattern SHA_OK = Pattern.compile("^[0-9a-f]{64}$");
    private static final Charset UTF8 = Charset.forName("UTF-8");

    static final class Info {
        int code;
        String name, apk, sha256, notes = "";
        long size;
    }

    interface Progress {
        void on(long done, long total);
    }

    static String base() {
        return baseOverride != null ? baseOverride : BASE;
    }

    /** 매니페스트 JSON → 검증된 정보. 형식이 어긋나면 null */
    static Info parse(String json) {
        try {
            JSONObject o = new JSONObject(json);
            Info i = new Info();
            i.code = o.getInt("versionCode");
            i.name = o.getString("versionName");
            i.apk = o.getString("apk");
            i.sha256 = o.getString("sha256").toLowerCase(java.util.Locale.ROOT);
            i.size = o.getLong("size");
            String n = o.optString("notes", "");
            i.notes = n.length() > 600 ? n.substring(0, 600) : n;
            if (i.code < 1 || !NAME_OK.matcher(i.name).matches() || !APK_OK.matcher(i.apk).matches() || !SHA_OK.matcher(i.sha256).matches() || i.size < 1 || i.size > MAX_APK) return null;
            return i;
        } catch (Throwable e) {
            return null;
        }
    }

    private static HttpURLConnection open(String url) throws IOException {
        if (!url.startsWith("https://") && !(insecureForTests && url.startsWith("http://127.0.0.1"))) throw new IOException("not https");
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setInstanceFollowRedirects(false);
        c.setUseCaches(false);
        c.setConnectTimeout(15000);
        c.setReadTimeout(30000);
        c.setRequestProperty("User-Agent", "ImageFix-Updater/1");
        c.setRequestProperty("Cache-Control", "no-cache");
        return c;
    }

    /** 새 버전 정보를 가져온다. 실패는 예외(IOException), 형식 오류는 IOException("bad manifest") */
    static Info fetch() throws IOException {
        HttpURLConnection c = open(base() + MANIFEST_PATH);
        try {
            if (c.getResponseCode() != 200) throw new IOException("http " + c.getResponseCode());
            InputStream in = c.getInputStream();
            ByteArrayOutputStream bo = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) > 0) {
                bo.write(buf, 0, n);
                if (bo.size() > MAX_MANIFEST) throw new IOException("manifest too large");
            }
            Info i = parse(new String(bo.toByteArray(), UTF8));
            if (i == null) throw new IOException("bad manifest");
            return i;
        } finally {
            c.disconnect();
        }
    }

    /** APK 를 dir 에 내려받아 크기·SHA-256 을 확인한 파일을 돌려준다. 취소는 cancel[0]=true */
    static File download(Info info, File dir, Progress cb, boolean[] cancel) throws IOException {
        if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("no dir");
        File tmp = new File(dir, "ImageFix.apk.part"), out = new File(dir, "ImageFix.apk");
        tmp.delete();
        out.delete();
        HttpURLConnection c = open(base() + info.apk);
        try {
            if (c.getResponseCode() != 200) throw new IOException("http " + c.getResponseCode());
            long total = c.getContentLength() > 0 ? c.getContentLength() : info.size;
            if (total > MAX_APK) throw new IOException("too large");
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            InputStream in = c.getInputStream();
            OutputStream os = new FileOutputStream(tmp);
            long done = 0;
            try {
                byte[] buf = new byte[65536];
                int n;
                while ((n = in.read(buf)) > 0) {
                    if (cancel != null && cancel[0]) throw new IOException("cancelled");
                    done += n;
                    if (done > info.size) throw new IOException("size mismatch");
                    md.update(buf, 0, n);
                    os.write(buf, 0, n);
                    if (cb != null) cb.on(done, info.size);
                }
            } finally {
                os.close();
            }
            if (done != info.size) throw new IOException("size mismatch");
            StringBuilder sb = new StringBuilder();
            for (byte b : md.digest()) sb.append(String.format("%02x", b));
            if (!sb.toString().equals(info.sha256)) throw new IOException("sha256 mismatch");
            if (!tmp.renameTo(out)) throw new IOException("rename failed");
            return out;
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IOException("no sha256");
        } finally {
            c.disconnect();
            tmp.delete();
        }
    }
}
