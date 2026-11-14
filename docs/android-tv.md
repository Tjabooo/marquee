# Android TV app

Lilin's Android TV app (`tv/android`, package `app.lilin.tv`) runs on Android TV and Google TV: TVs with
Google TV built in, Chromecast with Google TV, Nvidia Shield and other Android TV boxes (Android 7 or newer).
It is the Samsung app's twin: the same screens (`public/tv`, loaded from the server at every start, so a
Lilin update reaches the TV without a new app), the same sign-in, Skip intro and Up next. The app is in Swedish
(`public/tv/sv.js`), like the Samsung app.

## Installing it on a TV

Nothing to set up on the TV beyond one free app. On a phone at home, open Lilin → **Settings → Android TV →
Show the steps** (the page is `/android` on your server). It shows these steps with your server's real address:

1. **Get Downloader.** On the TV, open Google Play, search for *Downloader* (by AFTVnews, orange icon) and install it.
2. **Type the address.** Open Downloader, select the address box and type the address the page shows, for example
   `192.168.1.10:8080/android.apk`. Press **Go**.
3. **Install.** When the download is done, press **Install**. The first time, the TV asks to let Downloader install
   apps: choose **Settings**, turn Downloader on, press **Back**, then **Install**.
4. **Sign in.** Press **Open**. The TV shows a code: on your phone, open Lilin → Settings → **Sign in on a TV** and
   enter it (or press Down on the TV for the shared Home network account, when there is one).

Lilin then sits among the TV's apps, with its own banner on the home screen. An app built with a home address
is only offered on the home network (it reaches Lilin there, like the Samsung app).

**From anywhere.** Build the app with your public address plus `/c/tv` (`LILIN_URL=https://lilin.example.com/c/tv`)
and it works on any TV with internet, for people who don't live with the server. Behind Cloudflare Access only `/c/...`
is open (see [remote-access.md](remote-access.md)), so the TV gateway (`src/tv-gateway.js`) answers there: it serves
the TV app's own files, the sign-in code and updates, and the TV app's API calls only with the TV's own session from
signing in (cookies are ignored). Such an app is offered to anyone: send people
`https://lilin.example.com/c/tv/android`, and they type `https://lilin.example.com/c/tv/android.apk` in
Downloader. They sign in with the code like at home, from their phone signed in to Lilin.

**Language.** The app speaks Swedish on a TV set to Swedish and English on every other TV.

**Updates.** The app checks the server for a newer version (`/android.json`) when it opens and every 6 hours.
On Android 12 and later, once Lilin may install apps, it updates itself with no questions: the new version
downloads in the background (its size, SHA-256, package and version are checked) and installs while the app isn't
on screen, a few seconds after you leave it, or in the background between uses. Before that permission, and on
Android 7–11, the app offers the update as it starts (never during a video): **Update now** downloads it and Android
asks to confirm. The first time, Android wants Lilin allowed to install apps; the app opens that switch for you
and carries on when you press Back; from then on, Android 12+ TVs update by themselves.

## Building the app

The server offers whatever is in `tv/android/dist` (or `ANDROID_APP_DIR`). Releases carry a ready-made app
(`Lilin.apk` + `Lilin.json`, built without a server address, so it asks for it on its first start), and
`install.sh`, `install.ps1` and LilinSetup.exe put it there unless an app with the same or a newer version is
already in place. Docker and git installs can download both from the
[latest release](https://github.com/Tjabooo/lilin/releases/latest) into that folder. To build your own (with your
server's address built in, or after changing the app), use any Linux or macOS machine
with a JDK 17–21 and the Android SDK (platform 36 + build-tools; the build fetches the rest):

```sh
cp tv/android/.env.example tv/android/.env   # then fill it in (or pass the same as environment variables)
tv/android/build.sh                          # → tv/android/dist/Lilin.apk + Lilin.json
tv/android/build.sh --publish                # …and copy both to the server (PUBLISH_TO, over scp)
```

No restart is needed: the server reads `dist` on each request. The first build makes a signing key in
`~/.config/lilin-tv/` (`ANDROID_KEYSTORE`, `ANDROID_KEYSTORE_PASSWORD_FILE`). **Back it up**: an update signed
with another key won't install over the app (the TV would have to uninstall it first, losing its sign-in).

To ship a new version of the app itself, raise `code` (and `name`) in `tv/android/version.properties`, build and
publish; installed apps update themselves (Android 12+) or offer it on their next start. Changes to `public/tv` need no new app at all.

`--install` with `TV=<address>` installs over adb instead (Developer options → USB/network debugging on the TV);
`--debug` builds a debuggable app whose page shows up in `chrome://inspect`.

## How it works

- **A thin shell.** `MainActivity` shows `assets/shell.html` in a WebView whose address is the Lilin server, so the
  TV screens' requests are same-origin. The shell loads `tv.css`, `sv.js`, `logic.js` and `tv.js` side by side and
  runs them in order. The page is laid out at 1920×1080 and fitted to the screen; the TV's font-size setting
  doesn't reflow it. Lilin's font ships inside the app, so the first screen draws in it at once.
- **The player.** `tv.js` was written for Samsung's AVPlay. The shell gives it an object with the same methods
  (`webapis.avplay`), backed by Android's ExoPlayer (`VideoPlayer.java`) drawing into a surface *under* the page;
  while a video is open the page turns see-through, so the OSD, Skip intro, Up next and subtitles sit on top of the
  picture. Positions come twice a second and the clock runs on in between, so reading the time costs nothing.
  Subtitles are drawn by the page, never by the player. MKV and MP4, HEVC/H.264, AC3/E-AC3 passthrough to a
  receiver, audio track choice.
- **Which video.** On TVs with a hardware decoder for 10-bit HEVC at 4K, the app asks for the same file as the
  Samsung app. Others ask for `variant=browser&quality=auto`: an H.264 copy, or a live 1080p stream when the file is
  too heavy (`Codecs.java`).
- **The remote.** Arrows and OK reach the page as they are (no round trip). Back and the media keys
  (play/pause, play, pause, stop, rewind, fast-forward) arrive with Samsung's key codes. The Home button closes the
  player and keeps the resume point, as on Samsung.
- **Server side.** `src/android-tv.js`: `/android` (the steps, in English or Swedish), `/android.apk`,
  `/android.json`.
