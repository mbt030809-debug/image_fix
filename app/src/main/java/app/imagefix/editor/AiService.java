package app.imagefix.editor;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;

/**
 * AI 요청이 진행되는 동안 앱을 백그라운드로 보내도 작업이 끊기지 않게 하는 포그라운드 서비스.
 * 진행 중 알림("AI 작업 중")을 띄우고 CPU 를 깨워 둔다(PARTIAL_WAKE_LOCK, 최대 12분). 작업이 끝나면 JS 가 끈다.
 * 끝났을 때 앱이 화면에 없으면 {@link #done} 으로 "결과가 준비됐어요" 알림을 띄운다. 이 앱은 서버와의 통신을 이 서비스에서 하지 않는다 —
 * 통신은 {@link AiClient} 가 하고, 이 서비스는 프로세스(와 WebView)를 살려 두는 역할만 한다.
 */
public class AiService extends Service {
    static final String CH_WORK = "ai_work", CH_DONE = "ai_done";
    static final int ID_WORK = 4101, ID_DONE = 4102;
    static final long MAX_MS = 12L * 60 * 1000;
    private PowerManager.WakeLock lock;
    private final Handler h = new Handler(Looper.getMainLooper());
    private final Runnable stopper = new Runnable() {
        @Override
        public void run() {
            stopSelf();
        }
    };

    static void channels(Context c) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        nm.createNotificationChannel(new NotificationChannel(CH_WORK, "AI 작업 진행", NotificationManager.IMPORTANCE_LOW));
        nm.createNotificationChannel(new NotificationChannel(CH_DONE, "AI 작업 완료", NotificationManager.IMPORTANCE_DEFAULT));
    }

    static PendingIntent open(Context c) {
        Intent i = new Intent(c, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(c, 0, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    static Notification.Builder builder(Context c, String channel, String title, String text) {
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(c, channel) : new Notification.Builder(c);
        return b.setSmallIcon(android.R.drawable.stat_notify_sync).setContentTitle(title).setContentText(text).setContentIntent(open(c)).setCategory(Notification.CATEGORY_PROGRESS);
    }

    /** 작업 시작: 포그라운드 서비스를 켠다(이미 켜져 있으면 문구만 바꾼다) */
    static void start(Context c, String text) {
        try {
            Intent i = new Intent(c, AiService.class).putExtra("text", text == null ? "" : text);
            if (Build.VERSION.SDK_INT >= 26) c.startForegroundService(i);
            else c.startService(i);
        } catch (Throwable ignore) {
            // 백그라운드 시작이 막힌 경우 등 — 서비스 없이도 앱이 화면에 있는 동안은 정상 동작한다
        }
    }

    static void stop(Context c) {
        try {
            c.stopService(new Intent(c, AiService.class));
        } catch (Throwable ignore) {
            // 이미 꺼짐
        }
    }

    /** 작업이 끝났다는 알림(앱이 화면에 있을 때는 부르지 않는다) */
    static void done(Context c, String title, String text) {
        try {
            channels(c);
            NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            Notification n = builder(c, CH_DONE, title, text).setAutoCancel(true).setCategory(Notification.CATEGORY_STATUS).build();
            nm.notify(ID_DONE, n);
        } catch (Throwable ignore) {
            // 알림 권한이 없으면 조용히 넘어간다
        }
    }

    static void clearDone(Context c) {
        try {
            NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) nm.cancel(ID_DONE);
        } catch (Throwable ignore) {
            // noop
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        channels(this);
        String text = intent == null ? "" : intent.getStringExtra("text");
        Notification n = builder(this, CH_WORK, "ImageFix · AI 작업 중", text == null || text.length() == 0 ? "결과를 기다리는 중이에요" : text).setOngoing(true).build();
        try {
            if (Build.VERSION.SDK_INT >= 29) startForeground(ID_WORK, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
            else startForeground(ID_WORK, n);
        } catch (Throwable e) {
            stopSelf();
            return START_NOT_STICKY;
        }
        if (lock == null) {
            try {
                PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
                if (pm != null) {
                    lock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "imagefix:ai");
                    lock.setReferenceCounted(false);
                    lock.acquire(MAX_MS);
                }
            } catch (Throwable ignore) {
                lock = null;
            }
        }
        h.removeCallbacks(stopper);
        h.postDelayed(stopper, MAX_MS); // 안전장치: JS 가 못 끄는 경우(앱이 죽음 등)에도 영원히 남지 않게
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        h.removeCallbacks(stopper);
        try {
            if (lock != null && lock.isHeld()) lock.release();
        } catch (Throwable ignore) {
            // noop
        }
        lock = null;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
