# The page calls these through window.LilinNative.
-keepclassmembers class app.lilin.tv.Bridge { @android.webkit.JavascriptInterface <methods>; }
-keepattributes JavascriptInterface
