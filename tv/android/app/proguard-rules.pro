# The page calls these through window.MarqueeNative.
-keepclassmembers class app.marquee.tv.Bridge { @android.webkit.JavascriptInterface <methods>; }
-keepattributes JavascriptInterface
