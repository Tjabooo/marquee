package app.lilin.tv;

import android.webkit.JavascriptInterface;

import org.json.JSONException;
import org.json.JSONObject;

import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Locale;

/**
 * window.LilinNative: what the page (shell.html) may ask of the app. Calls arrive on the web
 * engine's own thread and are handed to the main thread, where the player and the page live.
 */
final class Bridge {
  private final MainActivity app;

  Bridge(MainActivity app) { this.app = app; }

  private void onMain(Runnable r) { app.main.post(r); }

  // ---- the player (AVPlay's shape is made in shell.html) ----
  @JavascriptInterface public void open(String url) { onMain(() -> app.player.open(url)); }
  @JavascriptInterface public void prepare() { onMain(() -> app.player.prepare()); }
  @JavascriptInterface public void play() { onMain(() -> app.player.play()); }
  @JavascriptInterface public void pause() { onMain(() -> app.player.pause()); }
  @JavascriptInterface public void seek(double ms, int id) { onMain(() -> app.player.seek((long) ms, id)); }
  @JavascriptInterface public void stop() { onMain(() -> app.player.stop()); }
  @JavascriptInterface public void close() { onMain(() -> app.player.release()); }
  @JavascriptInterface public void selectAudio(int index) { onMain(() -> app.player.selectAudio(index)); }

  // ---- the app ----
  @JavascriptInterface public void exit() { onMain(app::exit); }
  @JavascriptInterface public int versionCode() { return BuildConfig.VERSION_CODE; }
  @JavascriptInterface public String versionName() { return BuildConfig.VERSION_NAME; }
  @JavascriptInterface public String playVariant() { return Codecs.playVariant(); }
  @JavascriptInterface public void update(String apkUrl) { onMain(() -> app.updater.start()); }
  /** True when this version arrives by itself (Android 12+, see SelfUpdate): the page offers nothing then. */
  @JavascriptInterface public boolean updatesItself(int code) { return SelfUpdate.updatesItself(app, code); }

  /** Checks the address answers as Lilin, then switches to it. Answers with a "server" event. */
  @JavascriptInterface public void setServer(String typed) {
    String url = normalize(typed);
    new Thread(() -> {
      String problem = url == null ? "address" : check(url);
      onMain(() -> {
        JSONObject e = new JSONObject();
        try { e.put("t", "server").put("ok", problem == null).put("problem", problem == null ? JSONObject.NULL : problem); }
        catch (JSONException ignored) { /* never */ }
        app.send(e);
        if (problem == null) app.useServer(url);
      });
    }, "lilin-server-check").start();
  }

  static String normalize(String typed) {
    String s = typed == null ? "" : typed.trim().replaceAll("/+$", "");
    if (s.isEmpty()) return null;
    if (!s.toLowerCase(Locale.ROOT).matches("^https?://.*")) s = "http://" + s;
    try {
      URL u = new URL(s);
      if (u.getHost().isEmpty()) return null;
      // The path stays: an app that reaches Lilin from anywhere uses https://<Lilin>/c/tv.
      return u.getProtocol() + "://" + u.getAuthority() + u.getPath().replaceAll("/+$", "");
    } catch (Exception e) {
      return null;
    }
  }

  /** null when url is a Lilin server, else a short reason the page turns into words. */
  private static String check(String url) {
    HttpURLConnection c = null;
    try {
      c = (HttpURLConnection) new URL(url + "/api/health").openConnection();
      c.setConnectTimeout(5000);
      c.setReadTimeout(5000);
      int status = c.getResponseCode();
      if (status != 200) return "not-lilin";
      byte[] body = new byte[512];
      int n = c.getInputStream().read(body);
      String text = n > 0 ? new String(body, 0, n, "UTF-8") : "";
      return text.contains("\"status\"") ? null : "not-lilin";
    } catch (Exception e) {
      return "unreachable";
    } finally {
      if (c != null) c.disconnect();
    }
  }
}
