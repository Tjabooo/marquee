package app.marquee.tv;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.view.KeyEvent;
import android.view.SurfaceView;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.RenderProcessGoneDetail;
import android.window.OnBackInvokedDispatcher;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * Marquee's Android TV app. Like the Samsung app (tv/tizen), it is a small shell: the TV screens
 * themselves (public/tv) load from the Marquee server at every start, so a server update reaches the
 * TV without a new app. What the shell adds is what a web page can't do on its own: the native video
 * player (VideoPlayer, shaped like Samsung's AVPlay so tv.js runs unchanged), the remote's Back and
 * media keys, and installing the app's own updates.
 */
public class MainActivity extends Activity {
  static final String PREFS = "marquee";
  static final String PREF_SERVER = "server";
  private static final String NO_SERVER_BASE = "http://marquee.invalid/";

  // Samsung's key codes, which tv.js listens for.
  private static final int JS_BACK = 10009, JS_PLAY_PAUSE = 10252, JS_PLAY = 415, JS_PAUSE = 19,
      JS_STOP = 413, JS_FF = 417, JS_RW = 412, JS_ENTER = 13;

  final Handler main = new Handler(Looper.getMainLooper());
  WebView web;
  VideoPlayer player;
  Updater updater;
  private String server = "";
  private final Runnable pauseTimers = () -> { if (web != null) web.pauseTimers(); };

  @Override protected void onCreate(Bundle saved) {
    super.onCreate(saved);
    FrameLayout root = new FrameLayout(this);
    root.setBackgroundColor(Color.BLACK);

    // The video: a black box (letterbox bars) holding the surface, below the page. Hidden until a video opens.
    FrameLayout videoBox = new FrameLayout(this);
    videoBox.setBackgroundColor(Color.BLACK);
    videoBox.setVisibility(View.GONE);
    videoBox.setFocusable(false);
    SurfaceView surface = new SurfaceView(this);
    surface.setFocusable(false);
    videoBox.addView(surface, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    root.addView(videoBox, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

    web = new WebView(this);
    setUpWebView(web);
    root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    setContentView(root);

    player = new VideoPlayer(this, videoBox, surface, userAgent(), this::send);
    updater = new Updater(this);
    web.addJavascriptInterface(new Bridge(this), "MarqueeNative");
    server = savedServer();
    loadShell();
    web.requestFocus();
    // Android 13+ hands Back to a callback instead of a key event (the manifest opts in, so every version
    // behaves the same). The page decides what Back does; it leaves the app itself at its first screen.
    if (Build.VERSION.SDK_INT >= 33) {
      getOnBackInvokedDispatcher().registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, () -> sendKey(JS_BACK));
    }
  }

  @SuppressLint("SetJavaScriptEnabled")
  private void setUpWebView(WebView w) {
    WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
    WebSettings s = w.getSettings();
    s.setJavaScriptEnabled(true);
    s.setDomStorageEnabled(true);                 // the TV's sign-in lives in localStorage
    s.setMediaPlaybackRequiresUserGesture(false);
    // The TV screens are drawn for a 1920×1080 page: lay out at that width and fit it to the screen.
    s.setUseWideViewPort(true);
    s.setLoadWithOverviewMode(true);
    s.setSupportZoom(false);
    s.setBuiltInZoomControls(false);
    s.setDisplayZoomControls(false);
    s.setTextZoom(100);                           // the TV's font size setting must not reflow the layout
    s.setAllowFileAccess(false);
    s.setAllowContentAccess(false);
    s.setOffscreenPreRaster(true);                // rows sliding in are already drawn: smoother moves
    if (Build.VERSION.SDK_INT >= 26) s.setSafeBrowsingEnabled(false); // no lookup before each start
    s.setUserAgentString(userAgent());
    w.setBackgroundColor(Color.TRANSPARENT);      // the video shows through while the player is open
    w.setVerticalScrollBarEnabled(false);
    w.setHorizontalScrollBarEnabled(false);
    w.setOverScrollMode(View.OVER_SCROLL_NEVER);
    w.setFocusable(true);
    w.setFocusableInTouchMode(true);
    if (Build.VERSION.SDK_INT >= 26) w.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
    w.setWebViewClient(new WebViewClient() {
      // The app never navigates away from its one page.
      @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) { return true; }
      // Marquee's font comes with the app: the first screen is drawn in it at once, with no download.
      @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        Uri u = request.getUrl();
        String path = u.getPath();
        // /fonts/… from the shell, or …/fonts/… beside tv.css (under /c/tv for an app that reaches Marquee from anywhere)
        int at = path == null ? -1 : path.lastIndexOf("/fonts/bricolage-grotesque-");
        if (at < 0 || !path.endsWith(".woff2") || path.indexOf('/', at + 7) >= 0) return null;
        if (!baseUrl().startsWith(u.getScheme() + "://" + u.getAuthority() + "/")) return null;
        try {
          WebResourceResponse r = new WebResourceResponse("font/woff2", null, getAssets().open(path.substring(at + 1)));
          Map<String, String> headers = new HashMap<>();
          headers.put("Access-Control-Allow-Origin", "*");
          headers.put("Cache-Control", "max-age=31536000");
          r.setResponseHeaders(headers);
          return r;
        } catch (IOException e) {
          return null; // not bundled: the server's copy loads instead
        }
      }
      // The web engine was killed (low memory): start over rather than show a dead screen.
      @Override public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
        if (player != null) player.release();
        ViewGroup parent = (ViewGroup) view.getParent();
        if (parent != null) parent.removeView(view);
        view.destroy();
        web = null;
        recreate();
        return true;
      }
    });
  }

  private String userAgent() {
    return WebSettings.getDefaultUserAgent(this) + " MarqueeTV/" + BuildConfig.VERSION_NAME + " (Android TV)";
  }

  // ---------- the server and the shell page ----------
  String server() { return server; }

  private String savedServer() {
    String saved = getSharedPreferences(PREFS, MODE_PRIVATE).getString(PREF_SERVER, "");
    return saved.isEmpty() ? BuildConfig.MARQUEE_URL : saved;
  }

  void useServer(String url) {
    SharedPreferences.Editor e = getSharedPreferences(PREFS, MODE_PRIVATE).edit();
    if (url.equals(BuildConfig.MARQUEE_URL)) e.remove(PREF_SERVER); else e.putString(PREF_SERVER, url);
    e.apply();
    server = url;
    player.release();
    loadShell();
  }

  /** The shell has the server's address as its base, so the TV screens' requests are same-origin. */
  void loadShell() {
    if (web == null) return;
    String html = asset("shell.html")
        .replace("\"__MARQUEE_SERVER__\"", JSONObject.quote(server))
        .replace("\"__MARQUEE_BUILT_IN__\"", JSONObject.quote(BuildConfig.MARQUEE_URL))
        // The TV's own language: Swedish TVs get Swedish, every other TV English.
        .replace("\"__MARQUEE_LANG__\"", JSONObject.quote(Locale.getDefault().getLanguage()));
    web.loadDataWithBaseURL(baseUrl(), html, "text/html", "utf-8", null);
  }

  private String baseUrl() { return server.isEmpty() ? NO_SERVER_BASE : server + "/"; }

  private String asset(String name) {
    try (InputStream in = getAssets().open(name)) {
      ByteArrayOutputStream out = new ByteArrayOutputStream();
      byte[] buf = new byte[16384];
      for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
      return out.toString(StandardCharsets.UTF_8.name());
    } catch (IOException e) {
      throw new IllegalStateException("Missing asset " + name, e);
    }
  }

  // ---------- page ⇄ app ----------
  void send(JSONObject event) {
    if (web != null) web.evaluateJavascript("window.__mq&&__mq.ev(" + event + ")", null);
  }

  private void sendKey(int code) {
    if (web == null) { finish(); return; }
    // No page to take the key (the shell failed to load): Back still leaves the app.
    web.evaluateJavascript("window.__mqKey?__mqKey(" + code + "):'none'", (r) -> {
      if (code == JS_BACK && "\"none\"".equals(r)) finish();
    });
  }

  @Override public boolean dispatchKeyEvent(KeyEvent e) {
    int js;
    switch (e.getKeyCode()) {
      case KeyEvent.KEYCODE_BACK:
        if (Build.VERSION.SDK_INT >= 33) return super.dispatchKeyEvent(e); // the back callback takes it (onCreate)
        js = JS_BACK; break;
      case KeyEvent.KEYCODE_BUTTON_B: js = JS_BACK; break; // game controllers (Escape reaches the page as it is)
      case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE:
      case KeyEvent.KEYCODE_HEADSETHOOK: js = JS_PLAY_PAUSE; break;
      case KeyEvent.KEYCODE_MEDIA_PLAY: js = JS_PLAY; break;
      case KeyEvent.KEYCODE_MEDIA_PAUSE: js = JS_PAUSE; break;
      case KeyEvent.KEYCODE_MEDIA_STOP: js = JS_STOP; break;
      case KeyEvent.KEYCODE_MEDIA_FAST_FORWARD:
      case KeyEvent.KEYCODE_MEDIA_SKIP_FORWARD: js = JS_FF; break;
      case KeyEvent.KEYCODE_MEDIA_REWIND:
      case KeyEvent.KEYCODE_MEDIA_SKIP_BACKWARD: js = JS_RW; break;
      case KeyEvent.KEYCODE_BUTTON_A: js = JS_ENTER; break; // game controllers
      default: return super.dispatchKeyEvent(e); // arrows, OK and typing go to the page as they are
    }
    if (e.getAction() == KeyEvent.ACTION_DOWN && (js != JS_BACK || e.getRepeatCount() == 0)) sendKey(js);
    return true;
  }

  // ---------- lifecycle ----------
  @Override protected void onStart() {
    super.onStart();
    main.removeCallbacks(pauseTimers);
    if (web != null) { web.resumeTimers(); web.onResume(); }
    updater.resume();
  }

  @Override protected void onStop() {
    // Home button or another app: the player closes and keeps the resume point, like on Samsung.
    if (player.active()) { sendKey(JS_STOP); player.pause(); }
    if (web != null) web.onPause();
    main.postDelayed(pauseTimers, 3000); // after the resume point is saved
    super.onStop();
  }

  @Override protected void onDestroy() {
    main.removeCallbacksAndMessages(null);
    player.release();
    if (web != null) { web.destroy(); web = null; }
    super.onDestroy();
  }

  void exit() { player.release(); finishAndRemoveTask(); }

  /** Sends the TV to its "Install unknown apps" switch for Marquee. False when this TV has no such screen. */
  boolean openInstallPermission() {
    try {
      startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getPackageName())));
      return true;
    } catch (ActivityNotFoundException e) {
      return false;
    }
  }
}
