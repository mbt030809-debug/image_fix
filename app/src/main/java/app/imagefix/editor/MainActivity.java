package app.imagefix.editor;

import android.Manifest;
import android.app.Activity;
import android.app.ActivityManager;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.AssetManager;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.ImageDecoder;
import android.graphics.Matrix;
import android.media.ExifInterface;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.util.Log;
import android.view.HapticFeedbackConstants;
import android.view.View;
import android.view.Window;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URLEncoder;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * ImageFix 쉘: 오프라인 HTML 편집기를 WebView 로 띄우고
 * 갤러리 저장 / 공유 / 파일 선택 / 카메라 / 외부 앱 연결을 담당한다.
 * 편집 로직은 전부 assets/www 의 JS 에 있다. 웹 페이지는 인터넷에 직접 접근할 수 없고(CSP + 외부 요청 403),
 * INTERNET 권한은 AI 수정 요청을 대신 보내는 {@link AiClient} 만 쓴다(사용자가 키를 넣고 동의했을 때만).
 */
public class MainActivity extends Activity {
    static final String TAG = "ImageFix";
    static final String HOST = "appassets.androidplatform.net";
    static final String ORIGIN = "https://" + HOST;
    static final int REQ_CHOOSER = 1001;
    static final int REQ_PICK = 1002;
    static final int REQ_CAMERA = 1003;
    static final int REQ_STORAGE = 1004;
    static final int REQ_NOTIF = 1005;
    static final int BG = 0xFF0F1012;
    static final int MAX_PENDING = 40;
    static final int MAX_DECODE = 4096;

    private static final String CSP =
            "default-src 'self'; "
            + "script-src 'self' 'wasm-unsafe-eval'; "
            + "style-src 'self' 'unsafe-inline'; "
            + "img-src 'self' data: blob:; "
            + "font-src 'self' data:; "
            + "connect-src 'self' data: blob:; "
            + "media-src 'self' data: blob:; "
            + "worker-src 'self' blob:; "
            + "object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

    private FrameLayout root;
    private WebView web;
    private final List<Uri> pending = new ArrayList<Uri>();
    private ValueCallback<Uri[]> chooserCb;
    private Uri cameraUri;
    private final Map<String, Saver> savers = new HashMap<String, Saver>();
    private int saverSeq = 0;
    private boolean pageReady = false;
    private KeyVault vault;
    private AiClient ai;

    // ------------------------------------------------------------------ lifecycle

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        Window w = getWindow();
        w.setStatusBarColor(BG);
        w.setNavigationBarColor(BG);
        root = new FrameLayout(this);
        root.setBackgroundColor(BG);
        setContentView(root);
        vault = new KeyVault(this);
        ai = new AiClient(vault);
        collect(getIntent());
        createWebView();
        web.loadUrl(ORIGIN + "/index.html");
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (collect(intent) > 0) notifyNative();
    }

    // ------------------------------------------------------------ 앱 업데이트(GitHub 의 release/latest.json → APK 내려받기 → PackageInstaller)
    private final Object updLock = new Object();
    private String updState = "idle"; // idle | checking | none | available | downloading | ready | installing | needperm | error
    private Updater.Info updInfo;
    private long updDone, updTotal;
    private String updErr = "";
    private boolean[] updCancel = new boolean[]{false};
    private File updFile;

    private int installedCode() {
        try {
            android.content.pm.PackageInfo p = getPackageManager().getPackageInfo(getPackageName(), 0);
            return Build.VERSION.SDK_INT >= 28 ? (int) p.getLongVersionCode() : p.versionCode;
        } catch (Throwable e) {
            return 0;
        }
    }

    private void updSet(String st, String err) {
        synchronized (updLock) {
            updState = st;
            updErr = err == null ? "" : err;
        }
    }

    private String updJson() {
        synchronized (updLock) {
            try {
                JSONObject o = new JSONObject().put("state", updState).put("err", updErr).put("done", updDone).put("total", updTotal).put("current", installedCode());
                if (updInfo != null) o.put("versionName", updInfo.name).put("versionCode", updInfo.code).put("notes", updInfo.notes).put("size", updInfo.size);
                return o.toString();
            } catch (Throwable e) {
                return "{\"state\":\"error\"}";
            }
        }
    }

    private void installApk(File f) {
        if (Build.VERSION.SDK_INT >= 26 && !getPackageManager().canRequestPackageInstalls()) {
            updSet("needperm", "");
            try {
                startActivity(new Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getPackageName())));
            } catch (Throwable ignore) {
                // 설정 화면을 못 열면 JS 가 안내문만 보여 준다
            }
            return;
        }
        try {
            android.content.pm.PackageInstaller pi = getPackageManager().getPackageInstaller();
            int id = pi.createSession(new android.content.pm.PackageInstaller.SessionParams(android.content.pm.PackageInstaller.SessionParams.MODE_FULL_INSTALL));
            android.content.pm.PackageInstaller.Session s = pi.openSession(id);
            try {
                java.io.InputStream in = new java.io.FileInputStream(f);
                java.io.OutputStream out = s.openWrite("ImageFix", 0, f.length());
                try {
                    byte[] buf = new byte[65536];
                    int n;
                    while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                    s.fsync(out);
                } finally {
                    out.close();
                    in.close();
                }
                Intent ri = new Intent(this, UpdateReceiver.class).setAction("app.imagefix.editor.UPDATE_RESULT");
                int fl = android.app.PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? android.app.PendingIntent.FLAG_MUTABLE : 0);
                s.commit(android.app.PendingIntent.getBroadcast(this, id, ri, fl).getIntentSender());
                updSet("installing", "");
            } finally {
                s.close();
            }
        } catch (Throwable e) {
            updSet("error", "install:" + e.getClass().getSimpleName());
        }
    }

    /** 화면(앞)에 있나 / AI 작업이 진행 중인가(진행 중에는 WebView 를 멈추지 않아 백그라운드에서도 결과를 받는다) */
    private volatile boolean resumed = true, aiBusy = false;
    private boolean askedNotif = false;

    @Override
    protected void onResume() {
        super.onResume();
        resumed = true;
        if (web != null) web.onResume();
        AiService.clearDone(this);
    }

    @Override
    protected void onPause() {
        resumed = false;
        if (web != null) {
            web.evaluateJavascript("window.__onPause&&window.__onPause()", null);
            if (!aiBusy) web.onPause(); // AI 작업 중에는 JS(상태 확인·결과 합성)가 계속 돌아야 한다
        }
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        AiService.stop(this);
        if (web != null) {
            root.removeView(web);
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        if (web == null) {
            finish();
            return;
        }
        web.evaluateJavascript(
                "(function(){try{return !!(window.__onBack&&window.__onBack())}catch(e){return false}})()",
                new ValueCallback<String>() {
                    @Override
                    public void onReceiveValue(String v) {
                        if (!"true".equals(v)) finish();
                    }
                });
    }

    // ------------------------------------------------------------------ WebView

    @SuppressWarnings("deprecation")
    private void createWebView() {
        pageReady = false;
        web = new WebView(this);
        web.setBackgroundColor(BG);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        // 파일 선택(input[type=file]) 결과가 content:// 로 넘어오므로 허용. 페이지는 CSP(self/data/blob)와
        // shouldInterceptRequest(외부 스킴 403)로 어차피 content:// 를 직접 불러올 수 없다.
        s.setAllowContentAccess(true);
        s.setAllowFileAccessFromFileURLs(false);
        s.setAllowUniversalAccessFromFileURLs(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setTextZoom(100);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setGeolocationEnabled(false);
        s.setSaveFormData(false);
        s.setSupportMultipleWindows(false);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        if (Build.VERSION.SDK_INT >= 29) s.setForceDark(WebSettings.FORCE_DARK_OFF);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        web.setVerticalScrollBarEnabled(false);
        web.setHorizontalScrollBarEnabled(false);
        web.setLongClickable(false);
        web.setOnLongClickListener(new View.OnLongClickListener() {
            @Override
            public boolean onLongClick(View v) {
                return true;
            }
        });
        web.addJavascriptInterface(new JsBridge(), "Android");
        web.setWebViewClient(new Client());
        web.setWebChromeClient(new Chrome());
        root.addView(web, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
    }

    private void rebuildWebView() {
        try {
            if (web != null) {
                root.removeView(web);
                web.destroy();
            }
        } catch (Throwable e) {
            Log.w(TAG, "destroy failed", e);
        }
        createWebView();
        web.loadUrl(ORIGIN + "/index.html");
    }

    private void notifyNative() {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                if (web != null) web.evaluateJavascript("window.__nativeImages&&window.__nativeImages()", null);
            }
        });
    }

    private class Client extends WebViewClient {
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
            return serve(req.getUrl());
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
            return true; // 외부 이동 금지
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            pageReady = true;
        }

        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            Log.e(TAG, "render process gone, crashed=" + detail.didCrash());
            new Handler(Looper.getMainLooper()).post(new Runnable() {
                @Override
                public void run() {
                    Toast.makeText(MainActivity.this, "메모리 부족으로 화면이 다시 시작됩니다", Toast.LENGTH_LONG).show();
                    rebuildWebView();
                }
            });
            return true;
        }
    }

    private class Chrome extends WebChromeClient {
        @Override
        public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams p) {
            if (chooserCb != null) {
                chooserCb.onReceiveValue(null);
                chooserCb = null;
            }
            Intent i = new Intent(Intent.ACTION_GET_CONTENT);
            i.addCategory(Intent.CATEGORY_OPENABLE);
            String type = "image/*";
            String[] acc = p.getAcceptTypes();
            if (acc != null) {
                for (String a : acc) {
                    if (a != null && a.length() > 0 && !a.contains("/")) type = "*/*"; // 확장자 지정(.cube 등)
                    else if (a != null && a.length() > 0 && !a.startsWith("image/")) type = "*/*";
                }
            }
            i.setType(type);
            if (p.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
            chooserCb = cb;
            try {
                startActivityForResult(i, REQ_CHOOSER);
            } catch (Throwable e) {
                chooserCb = null;
                cb.onReceiveValue(null);
                return false;
            }
            return true;
        }

        @Override
        public boolean onConsoleMessage(ConsoleMessage m) {
            Log.d(TAG, m.message() + " [" + m.sourceId() + ":" + m.lineNumber() + "]");
            return true;
        }

        @Override
        public void onPermissionRequest(PermissionRequest r) {
            r.deny();
        }
    }

    // ------------------------------------------------------------------ 가상 오리진 에셋 서빙

    private WebResourceResponse status(int code, String reason) {
        Map<String, String> h = new HashMap<String, String>();
        h.put("Cache-Control", "no-store");
        return new WebResourceResponse("text/plain", "utf-8", code, reason, h,
                new ByteArrayInputStream(new byte[0]));
    }

    private WebResourceResponse serve(Uri u) {
        String scheme = u.getScheme();
        if (!"https".equals(scheme) || !HOST.equals(u.getHost())) {
            return status(403, "Blocked"); // 외부 네트워크 접근 전면 차단
        }
        String path = u.getPath();
        if (path == null || path.length() == 0 || "/".equals(path)) path = "/index.html";
        if (path.startsWith("/__shared/")) return servePending(u);
        if (path.startsWith("/__ai/")) return serveAi(u);
        if (path.contains("..") || path.contains("//")) return status(404, "Not Found");
        String mime = mimeFor(path);
        try {
            InputStream in = getAssets().open("www" + path, AssetManager.ACCESS_STREAMING);
            Map<String, String> h = new HashMap<String, String>();
            h.put("Cache-Control", "no-cache");
            h.put("X-Content-Type-Options", "nosniff");
            if (mime.equals("text/html")) h.put("Content-Security-Policy", CSP);
            boolean text = mime.startsWith("text/") || mime.equals("application/json") || mime.equals("image/svg+xml");
            return new WebResourceResponse(mime, text ? "utf-8" : null, 200, "OK", h, in);
        } catch (IOException e) {
            return status(404, "Not Found");
        }
    }

    private static String mimeFor(String p) {
        String s = p.toLowerCase();
        if (s.endsWith(".html") || s.endsWith(".htm")) return "text/html";
        if (s.endsWith(".js") || s.endsWith(".mjs")) return "text/javascript";
        if (s.endsWith(".css")) return "text/css";
        if (s.endsWith(".json") || s.endsWith(".webmanifest")) return "application/json";
        if (s.endsWith(".svg")) return "image/svg+xml";
        if (s.endsWith(".png")) return "image/png";
        if (s.endsWith(".jpg") || s.endsWith(".jpeg")) return "image/jpeg";
        if (s.endsWith(".webp")) return "image/webp";
        if (s.endsWith(".gif")) return "image/gif";
        if (s.endsWith(".woff2")) return "font/woff2";
        if (s.endsWith(".woff")) return "font/woff";
        if (s.endsWith(".ttf")) return "font/ttf";
        if (s.endsWith(".otf")) return "font/otf";
        if (s.endsWith(".wasm")) return "application/wasm";
        if (s.endsWith(".txt") || s.endsWith(".cube")) return "text/plain";
        if (s.endsWith(".ico")) return "image/x-icon";
        return "application/octet-stream";
    }

    private WebResourceResponse servePending(Uri u) {
        List<String> seg = u.getPathSegments();
        if (seg.size() < 2) return status(404, "Not Found");
        int idx;
        try {
            idx = Integer.parseInt(seg.get(1));
        } catch (NumberFormatException e) {
            return status(404, "Not Found");
        }
        Uri src;
        synchronized (pending) {
            if (idx < 0 || idx >= pending.size()) return status(404, "Not Found");
            src = pending.get(idx);
        }
        Map<String, String> h = new HashMap<String, String>();
        h.put("Cache-Control", "no-store");
        h.put("X-File-Name", encName(displayName(src)));
        try {
            if ("1".equals(u.getQueryParameter("convert"))) {
                byte[] jpg = convertToJpeg(src);
                return new WebResourceResponse("image/jpeg", null, 200, "OK", h, new ByteArrayInputStream(jpg));
            }
            InputStream in = getContentResolver().openInputStream(src);
            if (in == null) return status(404, "Not Found");
            String mime = getContentResolver().getType(src);
            return new WebResourceResponse(mime == null ? "application/octet-stream" : mime, null, 200, "OK", h, in);
        } catch (Throwable e) {
            Log.w(TAG, "serve shared failed", e);
            return status(500, "Error");
        }
    }

    /** AI 결과 이미지: /__ai/&lt;작업id&gt;/&lt;번호&gt; (메모리에서 바로 제공) */
    private WebResourceResponse serveAi(Uri u) {
        List<String> seg = u.getPathSegments();
        if (seg.size() != 3 || ai == null) return status(404, "Not Found");
        int idx;
        try {
            idx = Integer.parseInt(seg.get(2));
        } catch (NumberFormatException e) {
            return status(404, "Not Found");
        }
        byte[] b = ai.result(seg.get(1), idx);
        if (b == null || b.length < 2) return status(404, "Not Found");
        String mime = "application/octet-stream";
        String rt = ai.resultType(seg.get(1));
        if (rt != null) mime = rt;
        else if (b.length >= 12 && (b[0] & 0xff) == 0x89 && b[1] == 'P' && b[2] == 'N' && b[3] == 'G') mime = "image/png";
        else if ((b[0] & 0xff) == 0xff && (b[1] & 0xff) == 0xd8) mime = "image/jpeg";
        else if (b.length >= 12 && b[0] == 'R' && b[1] == 'I' && b[2] == 'F' && b[3] == 'F' && b[8] == 'W' && b[9] == 'E' && b[10] == 'B' && b[11] == 'P') mime = "image/webp";
        Map<String, String> h = new HashMap<String, String>();
        h.put("Cache-Control", "no-store");
        h.put("X-Content-Type-Options", "nosniff");
        return new WebResourceResponse(mime, null, 200, "OK", h, new ByteArrayInputStream(b));
    }

    private static String encName(String n) {
        try {
            return URLEncoder.encode(n == null ? "image" : n, "UTF-8").replace("+", "%20");
        } catch (Throwable e) {
            return "image";
        }
    }

    private String displayName(Uri uri) {
        Cursor c = null;
        try {
            c = getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null);
            if (c != null && c.moveToFirst()) {
                String n = c.getString(0);
                if (n != null) return n;
            }
        } catch (Throwable ignored) {
        } finally {
            if (c != null) c.close();
        }
        String last = uri.getLastPathSegment();
        return last == null ? "image" : last;
    }

    /** WebView 가 못 읽는 포맷(HEIC 등)을 네이티브 디코더로 읽어 JPEG 로 변환 */
    private byte[] convertToJpeg(Uri uri) throws IOException {
        ContentResolver cr = getContentResolver();
        Bitmap bmp;
        if (Build.VERSION.SDK_INT >= 28) {
            ImageDecoder.Source src = ImageDecoder.createSource(cr, uri);
            bmp = ImageDecoder.decodeBitmap(src, new ImageDecoder.OnHeaderDecodedListener() {
                @Override
                public void onHeaderDecoded(ImageDecoder d, ImageDecoder.ImageInfo info, ImageDecoder.Source s) {
                    int w = info.getSize().getWidth();
                    int hgt = info.getSize().getHeight();
                    int max = Math.max(w, hgt);
                    if (max > MAX_DECODE) {
                        float f = (float) MAX_DECODE / max;
                        d.setTargetSize(Math.max(1, Math.round(w * f)), Math.max(1, Math.round(hgt * f)));
                    }
                    d.setAllocator(ImageDecoder.ALLOCATOR_SOFTWARE);
                }
            });
        } else {
            BitmapFactory.Options o = new BitmapFactory.Options();
            o.inJustDecodeBounds = true;
            InputStream in = cr.openInputStream(uri);
            if (in == null) throw new IOException("open failed");
            BitmapFactory.decodeStream(in, null, o);
            in.close();
            int sample = 1;
            while (Math.max(o.outWidth, o.outHeight) / sample > MAX_DECODE) sample *= 2;
            o = new BitmapFactory.Options();
            o.inSampleSize = sample;
            in = cr.openInputStream(uri);
            if (in == null) throw new IOException("open failed");
            bmp = BitmapFactory.decodeStream(in, null, o);
            in.close();
            if (bmp != null) {
                int ori = ExifInterface.ORIENTATION_NORMAL;
                try {
                    InputStream ein = cr.openInputStream(uri);
                    if (ein != null) {
                        ori = new ExifInterface(ein).getAttributeInt(
                                ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL);
                        ein.close();
                    }
                } catch (Throwable ignored) {
                }
                Matrix m = new Matrix();
                switch (ori) {
                    case ExifInterface.ORIENTATION_ROTATE_90: m.postRotate(90); break;
                    case ExifInterface.ORIENTATION_ROTATE_180: m.postRotate(180); break;
                    case ExifInterface.ORIENTATION_ROTATE_270: m.postRotate(270); break;
                    case ExifInterface.ORIENTATION_FLIP_HORIZONTAL: m.postScale(-1, 1); break;
                    case ExifInterface.ORIENTATION_FLIP_VERTICAL: m.postScale(1, -1); break;
                    default: break;
                }
                if (!m.isIdentity()) {
                    Bitmap r = Bitmap.createBitmap(bmp, 0, 0, bmp.getWidth(), bmp.getHeight(), m, true);
                    if (r != bmp) bmp.recycle();
                    bmp = r;
                }
            }
        }
        if (bmp == null) throw new IOException("decode failed");
        ByteArrayOutputStream bos = new ByteArrayOutputStream(1 << 20);
        bmp.compress(Bitmap.CompressFormat.JPEG, 95, bos);
        bmp.recycle();
        return bos.toByteArray();
    }

    // ------------------------------------------------------------------ 인텐트 / 결과

    /** 공유·열기 인텐트의 이미지 URI 를 pending 목록에 추가 */
    private int collect(Intent it) {
        if (it == null) return 0;
        String a = it.getAction();
        int n = 0;
        synchronized (pending) {
            if (Intent.ACTION_SEND.equals(a)) {
                Uri u = it.getParcelableExtra(Intent.EXTRA_STREAM);
                if (u == null) {
                    ClipData cd = it.getClipData();
                    if (cd != null && cd.getItemCount() > 0) u = cd.getItemAt(0).getUri();
                }
                if (u != null && pending.size() < MAX_PENDING) {
                    pending.add(u);
                    n++;
                }
            } else if (Intent.ACTION_SEND_MULTIPLE.equals(a)) {
                ArrayList<Uri> l = it.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
                if (l != null) {
                    for (Uri u : l) {
                        if (u != null && pending.size() < MAX_PENDING) {
                            pending.add(u);
                            n++;
                        }
                    }
                }
            } else if (Intent.ACTION_VIEW.equals(a) || Intent.ACTION_EDIT.equals(a)) {
                Uri u = it.getData();
                if (u != null && pending.size() < MAX_PENDING) {
                    pending.add(u);
                    n++;
                }
            }
        }
        return n;
    }

    private int collectResult(Intent data) {
        if (data == null) return 0;
        int n = 0;
        synchronized (pending) {
            ClipData cd = data.getClipData();
            if (cd != null) {
                for (int i = 0; i < cd.getItemCount() && pending.size() < MAX_PENDING; i++) {
                    Uri u = cd.getItemAt(i).getUri();
                    if (u != null) {
                        pending.add(u);
                        n++;
                    }
                }
            } else if (data.getData() != null && pending.size() < MAX_PENDING) {
                pending.add(data.getData());
                n++;
            }
        }
        return n;
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (req == REQ_CHOOSER) {
            if (chooserCb != null) {
                Uri[] r = null;
                if (res == RESULT_OK) r = WebChromeClient.FileChooserParams.parseResult(res, data);
                chooserCb.onReceiveValue(r);
                chooserCb = null;
            }
        } else if (req == REQ_PICK) {
            if (res == RESULT_OK && collectResult(data) > 0) notifyNative();
        } else if (req == REQ_CAMERA) {
            Uri u = cameraUri;
            cameraUri = null;
            if (u != null) {
                if (res == RESULT_OK) {
                    synchronized (pending) {
                        if (pending.size() < MAX_PENDING) pending.add(u);
                    }
                    notifyNative();
                } else {
                    try {
                        getContentResolver().delete(u, null, null);
                    } catch (Throwable ignored) {
                    }
                }
            }
        }
    }

    // ------------------------------------------------------------------ 저장

    private static class Saver {
        Uri uri;
        File file;
        OutputStream out;
        String mime;
        String name;
    }

    private static String sanitize(String n) {
        if (n == null || n.length() == 0) n = "ImageFix.jpg";
        n = n.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_");
        if (n.length() > 100) n = n.substring(0, 100);
        return n;
    }

    // ------------------------------------------------------------------ JS 브리지

    private class JsBridge {
        @JavascriptInterface
        public String version() {
            return "1";
        }

        @JavascriptInterface
        public String deviceInfo() {
            try {
                ActivityManager am = (ActivityManager) getSystemService(Context.ACTIVITY_SERVICE);
                ActivityManager.MemoryInfo mi = new ActivityManager.MemoryInfo();
                am.getMemoryInfo(mi);
                JSONObject o = new JSONObject();
                o.put("sdk", Build.VERSION.SDK_INT);
                o.put("model", Build.MODEL);
                o.put("memMB", mi.totalMem / (1024 * 1024));
                o.put("lowRam", am.isLowRamDevice());
                o.put("classMB", am.getMemoryClass());
                o.put("camera", Build.VERSION.SDK_INT >= 29);
                return o.toString();
            } catch (Throwable e) {
                return "{}";
            }
        }

        // ---------------------------------------------------------- AI 릴레이 (AiClient / KeyVault)

        @JavascriptInterface
        public String aiInfo() {
            return vault.infoJson();
        }

        /** 제공자별 키 저장. key 가 비면 키는 유지하고 계정 ID(cloudflare)만 바꾼다. 성공 "OK" */
        @JavascriptInterface
        public String aiSetKey(String provider, String key, String extra) {
            return vault.set(provider, key, extra);
        }

        @JavascriptInterface
        public void aiClearKey(String provider) {
            vault.clear(provider);
        }

        /** 문제 해결용: 키 보관(암호화) 방식 점검. 예) "hw=ok sw=ok". 키 값은 다루지 않는다 */
        @JavascriptInterface
        public String aiSelfTest() {
            return vault.selfTest();
        }

        @JavascriptInterface
        public String aiBegin(String spec) {
            return ai.begin(spec);
        }

        @JavascriptInterface
        public boolean aiChunk(String id, String b64) {
            return ai.chunk(id, b64);
        }

        @JavascriptInterface
        public boolean aiSend(String id) {
            return ai.send(id);
        }

        @JavascriptInterface
        public String aiStatus(String id) {
            return ai.status(id);
        }

        @JavascriptInterface
        public void aiCancel(String id) {
            ai.cancel(id);
        }

        @JavascriptInterface
        public void aiRelease(String id) {
            ai.release(id);
        }

        @JavascriptInterface
        public int pendingCount() {
            synchronized (pending) {
                return pending.size();
            }
        }

        @JavascriptInterface
        public void clearPending() {
            synchronized (pending) {
                pending.clear();
            }
        }

        @JavascriptInterface
        public void pickImages(final boolean multiple) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    Intent i = new Intent(Intent.ACTION_GET_CONTENT);
                    i.addCategory(Intent.CATEGORY_OPENABLE);
                    i.setType("image/*");
                    if (multiple) i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                    try {
                        startActivityForResult(i, REQ_PICK);
                    } catch (Throwable e) {
                        Toast.makeText(MainActivity.this, "사진 선택 앱을 열 수 없습니다", Toast.LENGTH_SHORT).show();
                    }
                }
            });
        }

        @JavascriptInterface
        public void takePhoto() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    if (Build.VERSION.SDK_INT < 29) {
                        Toast.makeText(MainActivity.this, "이 기기에서는 카메라 촬영을 지원하지 않습니다", Toast.LENGTH_SHORT).show();
                        return;
                    }
                    try {
                        ContentValues v = new ContentValues();
                        v.put(MediaStore.MediaColumns.DISPLAY_NAME, "ImageFix_cam_" + System.currentTimeMillis() + ".jpg");
                        v.put(MediaStore.MediaColumns.MIME_TYPE, "image/jpeg");
                        v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/ImageFix");
                        Uri out = getContentResolver().insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, v);
                        if (out == null) throw new IOException("insert failed");
                        cameraUri = out;
                        Intent i = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
                        i.putExtra(MediaStore.EXTRA_OUTPUT, out);
                        i.setClipData(ClipData.newRawUri("photo", out));
                        i.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
                        startActivityForResult(i, REQ_CAMERA);
                    } catch (Throwable e) {
                        Log.w(TAG, "camera failed", e);
                        cameraUri = null;
                        Toast.makeText(MainActivity.this, "카메라를 열 수 없습니다", Toast.LENGTH_SHORT).show();
                    }
                }
            });
        }

        @JavascriptInterface
        public String beginSave(String name, String mime) {
            try {
                name = sanitize(name);
                if (mime == null || mime.length() == 0) mime = "image/jpeg";
                Saver s = new Saver();
                s.mime = mime;
                s.name = name;
                if (Build.VERSION.SDK_INT >= 29) {
                    ContentValues v = new ContentValues();
                    v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
                    v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
                    v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/ImageFix");
                    v.put(MediaStore.MediaColumns.IS_PENDING, 1);
                    s.uri = getContentResolver().insert(
                            MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY), v);
                    if (s.uri == null) return "ERR:insert";
                    s.out = getContentResolver().openOutputStream(s.uri);
                } else {
                    if (checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE)
                            != PackageManager.PERMISSION_GRANTED) {
                        runOnUiThread(new Runnable() {
                            @Override
                            public void run() {
                                requestPermissions(new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE}, REQ_STORAGE);
                            }
                        });
                        return "ERR:permission";
                    }
                    File dir = new File(Environment.getExternalStoragePublicDirectory(
                            Environment.DIRECTORY_PICTURES), "ImageFix");
                    if (!dir.exists() && !dir.mkdirs()) return "ERR:mkdir";
                    String base = name;
                    String ext = "";
                    int dot = name.lastIndexOf('.');
                    if (dot > 0) {
                        base = name.substring(0, dot);
                        ext = name.substring(dot);
                    }
                    File f = new File(dir, name);
                    int k = 1;
                    while (f.exists()) f = new File(dir, base + "_" + (k++) + ext);
                    s.file = f;
                    s.out = new FileOutputStream(f);
                }
                if (s.out == null) return "ERR:open";
                String id;
                synchronized (savers) {
                    id = "s" + (++saverSeq);
                    savers.put(id, s);
                }
                return id;
            } catch (Throwable e) {
                Log.e(TAG, "beginSave", e);
                return "ERR:" + e.getClass().getSimpleName();
            }
        }

        @JavascriptInterface
        public boolean writeChunk(String id, String b64) {
            Saver s;
            synchronized (savers) {
                s = savers.get(id);
            }
            if (s == null) return false;
            try {
                s.out.write(Base64.decode(b64, Base64.DEFAULT));
                return true;
            } catch (Throwable e) {
                Log.e(TAG, "writeChunk", e);
                return false;
            }
        }

        @JavascriptInterface
        public String endSave(String id) {
            Saver s;
            synchronized (savers) {
                s = savers.remove(id);
            }
            if (s == null) return "ERR:nosession";
            try {
                s.out.flush();
                s.out.close();
                if (Build.VERSION.SDK_INT >= 29) {
                    ContentValues v = new ContentValues();
                    v.put(MediaStore.MediaColumns.IS_PENDING, 0);
                    getContentResolver().update(s.uri, v, null, null);
                    return s.uri.toString();
                }
                ContentValues v = new ContentValues();
                v.put(MediaStore.Images.Media.DISPLAY_NAME, s.name);
                v.put(MediaStore.Images.Media.MIME_TYPE, s.mime);
                v.put(MediaStore.Images.Media.DATA, s.file.getAbsolutePath());
                Uri u = getContentResolver().insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, v);
                return u != null ? u.toString() : Uri.fromFile(s.file).toString();
            } catch (Throwable e) {
                Log.e(TAG, "endSave", e);
                abort(s);
                return "ERR:" + e.getClass().getSimpleName();
            }
        }

        @JavascriptInterface
        public void abortSave(String id) {
            Saver s;
            synchronized (savers) {
                s = savers.remove(id);
            }
            if (s != null) abort(s);
        }

        private void abort(Saver s) {
            try {
                if (s.out != null) s.out.close();
            } catch (Throwable ignored) {
            }
            try {
                if (s.uri != null) getContentResolver().delete(s.uri, null, null);
                if (s.file != null) s.file.delete();
            } catch (Throwable ignored) {
            }
        }

        @JavascriptInterface
        public void share(final String uri, final String mime) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try {
                        Intent i = new Intent(Intent.ACTION_SEND);
                        i.setType(mime == null || mime.length() == 0 ? "image/*" : mime);
                        i.putExtra(Intent.EXTRA_STREAM, Uri.parse(uri));
                        i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                        startActivity(Intent.createChooser(i, "공유"));
                    } catch (Throwable e) {
                        Toast.makeText(MainActivity.this, "공유할 수 없습니다", Toast.LENGTH_SHORT).show();
                    }
                }
            });
        }

        @JavascriptInterface
        public void viewImage(final String uri) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try {
                        Intent i = new Intent(Intent.ACTION_VIEW);
                        i.setDataAndType(Uri.parse(uri), "image/*");
                        i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                        startActivity(i);
                    } catch (Throwable e) {
                        Toast.makeText(MainActivity.this, "갤러리를 열 수 없습니다", Toast.LENGTH_SHORT).show();
                    }
                }
            });
        }

        @JavascriptInterface
        public void setBars(final String hex, final boolean darkIcons) {
            runOnUiThread(new Runnable() {
                @Override
                @SuppressWarnings("deprecation")
                public void run() {
                    try {
                        int c = Color.parseColor(hex);
                        Window w = getWindow();
                        w.setStatusBarColor(c);
                        w.setNavigationBarColor(c);
                        View d = w.getDecorView();
                        int f = d.getSystemUiVisibility();
                        int mask = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
                        d.setSystemUiVisibility(darkIcons ? (f | mask) : (f & ~mask));
                        root.setBackgroundColor(c);
                        if (web != null) web.setBackgroundColor(c);
                    } catch (Throwable ignored) {
                    }
                }
            });
        }

        @JavascriptInterface
        public void toast(final String msg) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    Toast.makeText(MainActivity.this, msg, Toast.LENGTH_SHORT).show();
                }
            });
        }

        @JavascriptInterface
        public void haptic() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    if (web != null) {
                        web.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP,
                                android.view.HapticFeedbackConstants.FLAG_IGNORE_VIEW_SETTING);
                    }
                }
            });
        }

        /** 새 버전 확인(백그라운드 스레드). 결과는 updStatus() 로 */
        @JavascriptInterface
        public void updCheck() {
            synchronized (updLock) {
                if ("checking".equals(updState) || "downloading".equals(updState)) return;
                updState = "checking";
                updErr = "";
            }
            new Thread(new Runnable() {
                @Override
                public void run() {
                    try {
                        Updater.Info i = Updater.fetch();
                        synchronized (updLock) {
                            updInfo = i;
                            updState = i.code > installedCode() ? "available" : "none";
                        }
                    } catch (Throwable e) {
                        updSet("error", "check:" + String.valueOf(e.getMessage()));
                    }
                }
            }, "imagefix-update-check").start();
        }

        /** 새 APK 내려받기(SHA-256 확인까지). 끝나면 state=ready */
        @JavascriptInterface
        public void updDownload() {
            final Updater.Info i;
            synchronized (updLock) {
                if (!"available".equals(updState) && !"error".equals(updState) && !"ready".equals(updState) || updInfo == null) return;
                i = updInfo;
                updState = "downloading";
                updErr = "";
                updDone = 0;
                updTotal = i.size;
                updCancel = new boolean[]{false};
            }
            final boolean[] cancel = updCancel;
            new Thread(new Runnable() {
                @Override
                public void run() {
                    try {
                        File f = Updater.download(i, new File(getCacheDir(), "update"), new Updater.Progress() {
                            @Override
                            public void on(long d, long t) {
                                updDone = d;
                                updTotal = t;
                            }
                        }, cancel);
                        synchronized (updLock) {
                            updFile = f;
                            updState = "ready";
                        }
                    } catch (Throwable e) {
                        updSet(cancel[0] ? "available" : "error", cancel[0] ? "" : "download:" + String.valueOf(e.getMessage()));
                    }
                }
            }, "imagefix-update-download").start();
        }

        @JavascriptInterface
        public void updCancel() {
            synchronized (updLock) {
                updCancel[0] = true;
            }
        }

        /** 내려받은 APK 설치 시작(안드로이드의 설치 확인 화면이 뜬다) */
        @JavascriptInterface
        public void updInstall() {
            final File f;
            synchronized (updLock) {
                f = updFile;
                if (f == null || !f.isFile() || !("ready".equals(updState) || "needperm".equals(updState))) return;
            }
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    installApk(f);
                }
            });
        }

        @JavascriptInterface
        public String updStatus() {
            return updJson();
        }

        /** AI 작업 시작/끝: 포그라운드 서비스(진행 중 알림)로 앱을 백그라운드에 보내도 이어지게 한다. 끝나면 멈췄던 WebView 를 멈춘다 */
        @JavascriptInterface
        public void aiKeepAlive(final boolean on, final String text) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    aiBusy = on;
                    if (on) {
                        if (Build.VERSION.SDK_INT >= 33 && !askedNotif && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                            askedNotif = true;
                            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIF);
                        }
                        AiService.start(MainActivity.this, text);
                    } else {
                        AiService.stop(MainActivity.this);
                        if (!resumed && web != null) web.onPause();
                    }
                }
            });
        }

        /** 작업이 끝났을 때 알림("결과가 준비됐어요") — 앱이 화면에 없을 때만 띄운다 */
        @JavascriptInterface
        public void aiNotify(final String title, final String text) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    if (!resumed) AiService.done(MainActivity.this, title, text);
                }
            });
        }

        @JavascriptInterface
        public void keepScreenOn(final boolean on) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    if (web != null) web.setKeepScreenOn(on);
                }
            });
        }

        @JavascriptInterface
        public void exit() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    finish();
                }
            });
        }
    }
}
