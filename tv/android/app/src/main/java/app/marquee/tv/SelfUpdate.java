package app.marquee.tv;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageInstaller;
import android.os.Build;
import android.util.Log;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Locale;

/**
 * The app's own updates. The server says which version it has (/android.json: versionCode, size,
 * sha256, apk). On Android 12 and later, once Marquee may install apps, a new version downloads by
 * itself and installs while the app isn't on screen, with no questions: Android lets an app update
 * itself quietly. On older TVs, or before that permission, the app offers the update when it starts
 * (Updater) and Android's installer asks to confirm.
 */
final class SelfUpdate {
  private static final String TAG = "MarqueeUpdate";
  private static final String PREF_READY = "update_ready";     // version code of the checked APK in the cache
  private static final String PREF_REFUSED = "update_refused"; // a quiet install of this code (or older) didn't go through
  private static final Object LOCK = new Object();

  /** True between MainActivity's onStart and onStop: Android closes an app to update it, so never then. */
  static volatile boolean onScreen;

  /** What /android.json says. */
  static final class Info {
    final int code; final String name; final long size; final String sha256; final String apk;
    Info(JSONObject j) {
      code = j.optInt("versionCode", 0);
      name = j.optString("versionName", "");
      size = j.optLong("size", 0);
      sha256 = j.optString("sha256", "");
      apk = j.optString("apk", "/android.apk");
    }
  }

  interface Progress { void at(int pct); }

  private SelfUpdate() {}

  private static SharedPreferences prefs(Context c) { return c.getSharedPreferences(MainActivity.PREFS, Context.MODE_PRIVATE); }

  /** The server's address: the one typed on the TV, else the one the app was built with. Empty when neither. */
  static String server(Context c) {
    String saved = prefs(c).getString(MainActivity.PREF_SERVER, "");
    return saved.isEmpty() ? BuildConfig.MARQUEE_URL : saved;
  }

  /** Android 12+ and Marquee may install apps: updates need nobody. */
  static boolean canInstallQuietly(Context c) {
    return Build.VERSION.SDK_INT >= 31 && c.getPackageManager().canRequestPackageInstalls();
  }

  /** Will this version arrive by itself? False means the app should offer it instead. */
  static boolean updatesItself(Context c, int code) {
    return canInstallQuietly(c) && code > prefs(c).getInt(PREF_REFUSED, 0);
  }

  /** At start: forget an update that's now installed. */
  static void tidy(Context c) {
    SharedPreferences p = prefs(c);
    if (p.getInt(PREF_READY, 0) <= BuildConfig.VERSION_CODE) {
      File apk = ApkProvider.file(c);
      apk.delete();
      new File(apk.getPath() + ".part").delete();
      p.edit().remove(PREF_READY).apply();
    }
    if (p.contains(PREF_REFUSED) && p.getInt(PREF_REFUSED, 0) <= BuildConfig.VERSION_CODE) p.edit().remove(PREF_REFUSED).apply();
  }

  /** The server's newer version, or null when this one is the newest (or the server can't say). */
  static Info newer(String server) throws Exception {
    if (server == null || server.isEmpty()) return null;
    HttpURLConnection c = open(server + "/android.json");
    try {
      if (c.getResponseCode() != 200) return null;
      ByteArrayOutputStream out = new ByteArrayOutputStream();
      try (InputStream in = c.getInputStream()) {
        byte[] buf = new byte[8192];
        for (int n; (n = in.read(buf)) > 0 && out.size() < 65536; ) out.write(buf, 0, n);
      }
      Info info = new Info(new JSONObject(out.toString(StandardCharsets.UTF_8.name())));
      return info.code > BuildConfig.VERSION_CODE ? info : null;
    } finally {
      c.disconnect();
    }
  }

  /**
   * Downloads the update and checks it: size and SHA-256 as the server gave them, and that it's this app at
   * that version (Android itself refuses one signed with another key). An already checked copy is reused.
   */
  static File download(Context ctx, String server, Info info, Progress progress) throws Exception {
    synchronized (LOCK) {
      File done = ApkProvider.file(ctx);
      if (prefs(ctx).getInt(PREF_READY, 0) == info.code && done.isFile() && isApp(ctx, done, info.code)) {
        if (progress != null) progress.at(100);
        return done;
      }
      prefs(ctx).edit().remove(PREF_READY).commit();
      done.delete();
      File part = new File(done.getPath() + ".part");
      String url = info.apk.startsWith("http") ? info.apk : server + info.apk;
      HttpURLConnection c = open(url);
      try {
        if (c.getResponseCode() != 200) throw new IllegalStateException("HTTP " + c.getResponseCode());
        long total = info.size > 0 ? info.size : c.getContentLengthLong();
        MessageDigest sha = MessageDigest.getInstance("SHA-256");
        long got = 0;
        try (InputStream in = c.getInputStream(); OutputStream out = new FileOutputStream(part)) {
          byte[] buf = new byte[65536];
          int lastPct = -1;
          for (int n; (n = in.read(buf)) > 0; ) {
            out.write(buf, 0, n);
            sha.update(buf, 0, n);
            got += n;
            int pct = total > 0 ? (int) Math.min(100, got * 100 / total) : -1;
            if (progress != null && pct != lastPct && pct % 5 == 0) { lastPct = pct; progress.at(pct); }
          }
        }
        if (info.size > 0 && got != info.size) throw new IllegalStateException("size " + got + " != " + info.size);
        if (!info.sha256.isEmpty() && !hex(sha.digest()).equals(info.sha256.toLowerCase(Locale.ROOT))) throw new IllegalStateException("sha256");
        if (!isApp(ctx, part, info.code)) throw new IllegalStateException("not Marquee " + info.code);
        if (!part.renameTo(done)) throw new IllegalStateException("rename");
        prefs(ctx).edit().putInt(PREF_READY, info.code).commit();
        return done;
      } finally {
        c.disconnect();
        part.delete();
      }
    }
  }

  /** Is the file this app at that version? */
  @SuppressWarnings("deprecation") // versionCode, for Android 7–8
  private static boolean isApp(Context ctx, File apk, int code) {
    PackageInfo p = ctx.getPackageManager().getPackageArchiveInfo(apk.getPath(), 0);
    if (p == null || !ctx.getPackageName().equals(p.packageName)) return false;
    long v = Build.VERSION.SDK_INT >= 28 ? p.getLongVersionCode() : p.versionCode;
    return v == code;
  }

  /**
   * Checks, downloads and, while the app isn't on screen, installs without asking. Runs on a background
   * thread (UpdateJob, MainActivity). Returns true when an install was handed to Android.
   */
  static boolean run(Context ctx) {
    if (!canInstallQuietly(ctx)) return false;
    try {
      Info info = newer(server(ctx));
      if (info == null || !updatesItself(ctx, info.code)) return false;
      download(ctx, server(ctx), info, null);
      return installQuietly(ctx, info.code);
    } catch (Exception e) {
      Log.w(TAG, "update check failed: " + e);
      return false;
    }
  }

  /** Hands the checked APK to Android's installer, asking for no confirmation. Not while the app is on screen. */
  static boolean installQuietly(Context ctx, int code) {
    if (onScreen || Build.VERSION.SDK_INT < 31 || !updatesItself(ctx, code)) return false;
    File apk = ApkProvider.file(ctx);
    synchronized (LOCK) {
      if (prefs(ctx).getInt(PREF_READY, 0) != code || !apk.isFile()) return false;
      PackageInstaller installer = ctx.getPackageManager().getPackageInstaller();
      PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
      params.setAppPackageName(ctx.getPackageName());
      params.setSize(apk.length());
      params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED);
      int id = -1;
      try {
        id = installer.createSession(params);
        try (PackageInstaller.Session session = installer.openSession(id)) {
          try (InputStream in = new FileInputStream(apk); OutputStream out = session.openWrite("Marquee.apk", 0, apk.length())) {
            byte[] buf = new byte[65536];
            for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
            session.fsync(out);
          }
          if (onScreen) { session.abandon(); return false; } // opened again meanwhile
          Intent result = new Intent(ctx, UpdateReceiver.class).putExtra(UpdateReceiver.EXTRA_CODE, code);
          PendingIntent pending = PendingIntent.getBroadcast(ctx, code, result, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_MUTABLE);
          session.commit(pending.getIntentSender());
        }
        Log.i(TAG, "installing version " + code);
        return true;
      } catch (Exception e) {
        Log.w(TAG, "install failed: " + e);
        if (id >= 0) try { installer.abandonSession(id); } catch (Exception ignored) { /* gone already */ }
        return false;
      }
    }
  }

  /** Android wanted a person after all (or failed): offer this version in the app instead. */
  static void refused(Context ctx, int code) {
    prefs(ctx).edit().putInt(PREF_REFUSED, Math.max(code, prefs(ctx).getInt(PREF_REFUSED, 0))).apply();
  }

  private static HttpURLConnection open(String url) throws Exception {
    HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
    c.setConnectTimeout(10_000);
    c.setReadTimeout(30_000);
    c.setUseCaches(false);
    c.setRequestProperty("User-Agent", "MarqueeTV/" + BuildConfig.VERSION_NAME + " (Android TV)");
    return c;
  }

  private static String hex(byte[] b) {
    StringBuilder s = new StringBuilder(b.length * 2);
    for (byte x : b) s.append(String.format(Locale.ROOT, "%02x", x));
    return s.toString();
  }
}
