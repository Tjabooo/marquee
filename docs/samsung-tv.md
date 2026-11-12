# Samsung TV app

Lilin's Samsung TV app is a small Tizen shell (`tv/tizen`, package `LilTvApp01.Lilin`) that loads the app itself
from the server every time it starts, so a Lilin update reaches the TV without reinstalling.
The app is in Swedish (`public/tv/sv.js`).

The app is written in Rust (`tv/rust`, built into `public/tv-rs/lilin_tv.wasm`): every screen is drawn with WebGL
in one canvas, so the TV's slow CPU does no page layout or styling at all. The shell starts it through
`public/tv-rs/host.js`. If a TV can't run it (no WebGL or WebAssembly) or it stops, the shell starts the
JavaScript app in `public/tv` instead, which the Android TV app also uses. To force the JavaScript app on a TV, set
`localStorage['lilin:tv-engine'] = 'js'` (over DevTools). See [tv/rust/README.md](../tv/rust/README.md).

## 1. Have Lilin running

The TV loads `public/tv-rs/` (and `public/tv/` as the fallback) from the server; those files are read directly, so
updating them needs no restart. Changes to the Rust app need `bash tv/rust/build.sh` before committing (the built
`.wasm` is committed, so the server needs no Rust).

Use a LAN URL that the TV can reach, for example `http://192.168.1.10:8080`.

## 2. Prepare Samsung/Tizen development access

Samsung's current TV-device instructions are at:
<https://developer.samsung.com/smarttv/develop/getting-started/using-sdk/tv-device.html>

In short:

1. Put the TV and development computer on the same network.
2. On the TV open **Apps**, open **App Settings**, enter **12345**, and turn **Developer mode** on.
3. Enter the development computer's LAN IP when the TV asks for it, then reboot the TV.
4. Install Tizen Studio plus the Samsung TV Extension and Samsung Certificate Extension.
5. Create/select a Samsung TV certificate profile. The scripts default to a profile named `lilin`.

If installation is refused even though the TV connects, open Tizen Studio's Device Manager and use
**Permit to install applications** for the connected TV, then retry.

## 3. Configure the build

From the repository:

```bash
cp tv/tizen/.env.example tv/tizen/.env
```

Edit `tv/tizen/.env`:

```text
LILIN_URL=http://192.168.1.10:8080
TV=192.168.1.30
TIZEN_PROFILE=lilin
```

- `LILIN_URL`: the Lilin server address **as seen by the TV**
- `TV`: the TV's LAN IP
- `TIZEN_PROFILE`: your signing profile if it is not named `lilin`

## 4. Build and install

Use `bash` explicitly so the script works even if a checkout did not preserve its executable bit:

```bash
LILIN_URL=http://192.168.1.10:8080 TV=192.168.1.30 bash tv/tizen/build.sh --install
```

Or, after filling in `.env`:

```bash
bash tv/tizen/build.sh --install
```

The package is written to:

```text
tv/tizen/dist/Lilin.wgt
```

The install command connects with Samsung's SDB tooling, installs `Lilin.wgt`, and launches
`LilTvApp01.Lilin`.

A normal consumer TV does not accept a raw `.wgt` copied over USB; use the development connection above.

## 5. First launch

Open **Lilin** from Apps and pair it: the TV shows a code, and you enter it under Settings → Sign in a TV on your phone.

The home screen shows Continue watching, Shows, Films and then one row per genre you own something in.
Press **Up** to reach the top controls:

- **Search** opens an on-screen keyboard (a USB/Bluetooth keyboard and the remote's number keys type too). Your own
  titles show up at once; TMDB results follow when you stop typing.
- **Discover** opens server-curated rows. **Films / Shows / All** tabs sit at the top; the focused title's backdrop
  and description fill the top half. Rows keep loading as you move right (up to 60 cards) and end in **See all**,
  a full grid. Below them: a row of genres (each opens a grid with Popular / Top rated / Newest) and one row per genre.
- Choose a film to Download immediately, or Play it if it's already yours.
- Choose a show, pick a season, then Download (or Open it if it's already yours).
- **Quality** defaults to the person's existing Lilin download settings and can be overridden for that request.

The TV never performs media searching or transfer work itself. It only renders cards near the screen (posters load
lazily, rows and grids stop at a cap) and sends the request to Lilin; the server handles TMDB and the download job.

## Moving from Lilin Preview

Earlier versions had a separate Lilin Preview app. It's now the only app, so remove the old one from the TV:

```bash
tizen uninstall -p LilTvPrv01.LilinPreview -s <tv-address>:26101
```
