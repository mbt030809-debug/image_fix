package app.imagefix.editor;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import com.sun.net.httpserver.HttpServer;

import java.io.File;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.Charset;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.Arrays;

/** Updater(새 버전 확인 · APK 내려받기 검증) JVM 테스트: 모의 HTTP 서버. 실행: tests/jvm/run.sh */
public class UpdaterTest {
    static int pass = 0, fail = 0;
    static final Charset UTF8 = Charset.forName("UTF-8");
    static byte[] APK = new byte[300000];
    static String SHA;
    static String manifest = "";

    static void ok(boolean c, String n) {
        if (c) pass++;
        else {
            fail++;
            System.out.println("  ✗ FAIL: " + n);
        }
    }

    static String sha(byte[] b) throws Exception {
        StringBuilder sb = new StringBuilder();
        for (byte x : MessageDigest.getInstance("SHA-256").digest(b)) sb.append(String.format("%02x", x));
        return sb.toString();
    }

    static String mf(int code, String name, String apk, String sha, long size, String notes) {
        return "{\"versionCode\":" + code + ",\"versionName\":\"" + name + "\",\"apk\":\"" + apk + "\",\"sha256\":\"" + sha + "\",\"size\":" + size + ",\"notes\":\"" + notes + "\"}";
    }

    public static void main(String[] a) throws Exception {
        for (int i = 0; i < APK.length; i++) APK[i] = (byte) (i * 31 + 7);
        SHA = sha(APK);
        HttpServer srv = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        srv.createContext("/", new HttpHandler() {
            @Override
            public void handle(HttpExchange x) throws IOException {
                String p = x.getRequestURI().getPath();
                byte[] body;
                int st = 200;
                if (p.equals("/ok/release/latest.json")) body = manifest.getBytes(UTF8);
                else if (p.equals("/big/release/latest.json")) body = new byte[70000];
                else if (p.equals("/ok/release/ImageFix_2026-11-15.apk")) body = APK;
                else if (p.equals("/trunc/release/ImageFix_2026-11-15.apk")) body = Arrays.copyOf(APK, 1000);
                else if (p.equals("/bad/release/ImageFix_2026-11-15.apk")) { body = APK.clone(); body[5] ^= 1; }
                else if (p.startsWith("/redir/")) {
                    x.getResponseHeaders().add("Location", "http://127.0.0.1:" + x.getLocalAddress().getPort() + "/ok/release/latest.json");
                    x.sendResponseHeaders(302, -1);
                    x.close();
                    return;
                } else { st = 404; body = "nf".getBytes(UTF8); }
                x.sendResponseHeaders(st, body.length);
                OutputStream o = x.getResponseBody();
                o.write(body);
                o.close();
            }
        });
        srv.start();
        String root = "http://127.0.0.1:" + srv.getAddress().getPort();
        Updater.insecureForTests = true;
        File dir = Files.createTempDirectory("imagefix-upd").toFile();

        System.out.println("▶ Updater.parse");
        String good = mf(26111600, "1.8.0", "release/ImageFix_2026-11-15.apk", SHA, APK.length, "새 기능");
        Updater.Info i = Updater.parse(good);
        ok(i != null && i.code == 26111600 && "1.8.0".equals(i.name) && SHA.equals(i.sha256) && i.size == APK.length && "새 기능".equals(i.notes), "valid manifest");
        ok(Updater.parse(good.replace(SHA, SHA.toUpperCase())) != null, "sha256 case-insensitive");
        String[] bad = {"", "{}", "not json", mf(0, "1.0", "release/ImageFix_2026-11-15.apk", SHA, 5, ""), mf(1, "1 0", "release/ImageFix_2026-11-15.apk", SHA, 5, ""),
                mf(1, "1.0", "../evil.apk", SHA, 5, ""), mf(1, "1.0", "release/ImageFix_2026-11-15.apk/../x", SHA, 5, ""), mf(1, "1.0", "https://evil.com/x.apk", SHA, 5, ""), mf(1, "1.0", "release/other.apk", SHA, 5, ""),
                mf(1, "1.0", "release/ImageFix_2026-11-15.apk", "abc", 5, ""), mf(1, "1.0", "release/ImageFix_2026-11-15.apk", SHA, 0, ""), mf(1, "1.0", "release/ImageFix_2026-11-15.apk", SHA, 50L * 1024 * 1024, "")};
        for (String b : bad) ok(Updater.parse(b) == null, "rejects: " + (b.length() > 50 ? b.substring(0, 50) : b));
        ok(Updater.parse(mf(1, "1.0", "release/ImageFix_2026-11-15.apk", SHA, 5, new String(new char[2000]).replace('\0', 'n'))).notes.length() == 600, "notes capped");

        System.out.println("▶ Updater.fetch");
        manifest = good;
        Updater.baseOverride = root + "/ok/";
        Updater.Info f = Updater.fetch();
        ok(f.code == 26111600 && "1.8.0".equals(f.name), "fetch returns the parsed manifest");
        manifest = "{}";
        boolean threw = false;
        try { Updater.fetch(); } catch (IOException e) { threw = "bad manifest".equals(e.getMessage()); }
        ok(threw, "bad manifest → IOException");
        Updater.baseOverride = root + "/big/";
        threw = false;
        try { Updater.fetch(); } catch (IOException e) { threw = true; }
        ok(threw, "oversized manifest refused");
        Updater.baseOverride = root + "/missing/";
        threw = false;
        try { Updater.fetch(); } catch (IOException e) { threw = String.valueOf(e.getMessage()).contains("404"); }
        ok(threw, "404 → IOException");
        Updater.baseOverride = root + "/redir/";
        threw = false;
        try { Updater.fetch(); } catch (IOException e) { threw = true; }
        ok(threw, "redirect is not followed");
        Updater.baseOverride = "http://example.com/";
        threw = false;
        try { Updater.fetch(); } catch (IOException e) { threw = "not https".equals(e.getMessage()); }
        ok(threw, "plain http (non-test host) refused");

        System.out.println("▶ Updater.download");
        Updater.baseOverride = root + "/ok/";
        final long[] last = {0, 0};
        File out = Updater.download(i, dir, new Updater.Progress() {
            @Override
            public void on(long d, long t) {
                last[0] = d;
                last[1] = t;
            }
        }, new boolean[]{false});
        ok(out.isFile() && out.length() == APK.length && Arrays.equals(Files.readAllBytes(out.toPath()), APK) && "ImageFix.apk".equals(out.getName()), "downloaded and verified");
        ok(last[0] == APK.length && last[1] == APK.length, "progress reaches 100%");
        ok(!new File(dir, "ImageFix.apk.part").exists(), "no partial file left");
        Updater.Info wrongSha = Updater.parse(mf(1, "1.0", "release/ImageFix_2026-11-15.apk", sha("x".getBytes(UTF8)), APK.length, ""));
        threw = false;
        try { Updater.download(wrongSha, dir, null, null); } catch (IOException e) { threw = "sha256 mismatch".equals(e.getMessage()); }
        ok(threw && !new File(dir, "ImageFix.apk").exists(), "wrong hash → refused, previous file removed");
        Updater.baseOverride = root + "/bad/";
        threw = false;
        try { Updater.download(i, dir, null, null); } catch (IOException e) { threw = "sha256 mismatch".equals(e.getMessage()); }
        ok(threw, "tampered APK → sha256 mismatch");
        Updater.baseOverride = root + "/trunc/";
        threw = false;
        try { Updater.download(i, dir, null, null); } catch (IOException e) { threw = "size mismatch".equals(e.getMessage()); }
        ok(threw, "truncated download → size mismatch");
        Updater.baseOverride = root + "/ok/";
        Updater.Info small = Updater.parse(mf(1, "1.0", "release/ImageFix_2026-11-15.apk", SHA, 1000, ""));
        threw = false;
        try { Updater.download(small, dir, null, null); } catch (IOException e) { threw = "size mismatch".equals(e.getMessage()); }
        ok(threw, "more bytes than the manifest says → refused");
        threw = false;
        try { Updater.download(i, dir, null, new boolean[]{true}); } catch (IOException e) { threw = "cancelled".equals(e.getMessage()); }
        ok(threw && !new File(dir, "ImageFix.apk.part").exists(), "cancel stops the download and cleans up");

        srv.stop(0);
        System.out.println("\nUpdater tests: " + pass + " passed, " + fail + " failed");
        System.exit(fail == 0 ? 0 : 1);
    }
}
