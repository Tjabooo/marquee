package app.marquee.tv;

import android.content.Intent;
import android.os.Build;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * The update offer in the app (shell.html), for TVs where the app can't update itself quietly (SelfUpdate):
 * downloads the APK, then hands it to Android's installer, which asks the viewer to confirm. The first time,
 * Android wants Marquee allowed to install apps; the TV's settings screen for that opens, and the install
 * carries on on return. Progress goes to the page as "update" events.
 */
final class Updater {
  private final MainActivity app;
  private boolean busy;
  private boolean waitingForPermission;
  private int code;

  Updater(MainActivity app) { this.app = app; }

  void start() {
    if (busy) return;
    busy = true;
    String server = app.server();
    new Thread(() -> {
      try {
        SelfUpdate.Info info = SelfUpdate.newer(server);
        if (info == null) throw new IllegalStateException("no update");
        code = info.code;
        SelfUpdate.download(app, server, info, (pct) -> app.main.post(() -> send("progress", pct)));
        app.main.post(this::install);
      } catch (Exception e) {
        app.main.post(() -> { busy = false; send("error", -1); });
      }
    }, "marquee-update").start();
  }

  private void install() {
    if (Build.VERSION.SDK_INT >= 26 && !app.getPackageManager().canRequestPackageInstalls()) {
      waitingForPermission = true;
      send(app.openInstallPermission() ? "allow" : "allow-manual", -1);
      return;
    }
    // Android 12+ and now allowed: no installer screen, it goes in when the viewer leaves the app.
    if (SelfUpdate.updatesItself(app, code)) { send("later", 100); busy = false; return; }
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
