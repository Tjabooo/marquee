package app.marquee.tv;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Installs a newer Marquee app from the server: downloads the APK, then hands it to Android's
 * installer, which asks the viewer to confirm. The first time, Android wants Marquee allowed to
 * install apps; the TV's settings screen for that opens, and the install carries on on return.
 * Progress goes to the page as "update" events.
 */
final class Updater {
  private final MainActivity app;
  private boolean busy;
  private boolean waitingForPermission;

  Updater(MainActivity app) { this.app = app; }

  void start(String apkUrl) {
    if (busy) return;
    busy = true;
    String url = apkUrl.startsWith("http") ? apkUrl : app.server() + apkUrl;
    new Thread(() -> {
      File done = ApkProvider.file(app);
      File part = new File(done.getPath() + ".part");
      HttpURLConnection c = null;
      try {
        c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(10_000);
        c.setReadTimeout(30_000);
        if (c.getResponseCode() != 200) throw new IllegalStateException("HTTP " + c.getResponseCode());
        long total = c.getContentLengthLong();
        try (InputStream in = c.getInputStream(); OutputStream out = new FileOutputStream(part)) {
          byte[] buf = new byte[65536];
          long got = 0;
          int lastPct = -1;
          for (int n; (n = in.read(buf)) > 0; ) {
            out.write(buf, 0, n);
            got += n;
            int pct = total > 0 ? (int) (got * 100 / total) : -1;
            if (pct != lastPct && pct % 5 == 0) { lastPct = pct; final int p = pct; app.main.post(() -> send("progress", p)); }
          }
        }
        if (!part.renameTo(done)) throw new IllegalStateException("rename");
        app.main.post(this::install);
      } catch (Exception e) {
        part.delete();
        app.main.post(() -> { busy = false; send("error", -1); });
      } finally {
        if (c != null) c.disconnect();
      }
    }, "marquee-update").start();
  }

  private void install() {
    if (Build.VERSION.SDK_INT >= 26 && !app.getPackageManager().canRequestPackageInstalls()) {
      waitingForPermission = true;
      send(app.openInstallPermission() ? "allow" : "allow-manual", -1);
      return;
    }
    send("installing", 100);
    Intent i = new Intent(Intent.ACTION_VIEW)
        .setDataAndType(ApkProvider.uri(), "application/vnd.android.package-archive")
        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
    try {
      app.startActivity(i);
    } catch (Exception e) {
      send("error", -1);
    }
    busy = false;
  }

  /** Back from the settings screen: install if Marquee may now. */
  void resume() {
    if (!waitingForPermission) return;
    if (Build.VERSION.SDK_INT >= 26 && !app.getPackageManager().canRequestPackageInstalls()) { send("denied", -1); busy = false; waitingForPermission = false; return; }
    waitingForPermission = false;
    install();
  }

  private void send(String state, int pct) {
    JSONObject e = new JSONObject();
    try { e.put("t", "update").put("s", state).put("pct", pct); } catch (JSONException ignored) { /* never */ }
    app.send(e);
  }
}
