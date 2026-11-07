# Samsung TV Preview: side-by-side install

Marquee Preview is a second Samsung Tizen app for testing the lightweight TV Discover and Smart Download UI.
It is intentionally isolated from the stable app:

- **Stable app:** `Marquee` → package/application `MrqTvApp01.Marquee` → server files under `/tv/`
- **Preview app:** `Marquee Preview` → package/application `MrqTvPrv01.MarqueePreview` → server files under `/tv-preview/`

Installing Preview does **not** replace or update stable Marquee. Both can be installed at the same time, and each
has separate Tizen app storage/sign-in state. The stable app keeps loading only `/tv/`; Preview keeps loading only
`/tv-preview/`.

## 1. Put the preview files on the Marquee server

The server checkout must contain `public/tv-preview/`. After this change is merged/pulled, restart Marquee only if
your normal deployment process requires it; static TV files themselves are read directly from `public/`.

Use a LAN URL that the TV can reach, for example `http://192.168.1.10:8080`.

## 2. Prepare Samsung/Tizen development access

Samsung's current TV-device instructions are at:
<https://developer.samsung.com/smarttv/develop/getting-started/using-sdk/tv-device.html>

In short:

1. Put the TV and development computer on the same network.
2. On the TV open **Apps**, open **App Settings**, enter **12345**, and turn **Developer mode** on.
3. Enter the development computer's LAN IP when the TV asks for it, then reboot the TV.
4. Install Tizen Studio plus the Samsung TV Extension and Samsung Certificate Extension.
5. Create/select a Samsung TV certificate profile. The scripts default to a profile named `marquee`.

If installation is refused even though the TV connects, open Tizen Studio's Device Manager and use
**Permit to install applications** for the connected TV, then retry.

## 3. Configure the preview build

From the repository:

```bash
cp tv/tizen-preview/.env.example tv/tizen-preview/.env
```

Edit `tv/tizen-preview/.env`:

```text
MARQUEE_URL=http://192.168.1.10:8080
TV=192.168.1.30
TIZEN_PROFILE=marquee
```

- `MARQUEE_URL`: the Marquee server address **as seen by the TV**
- `TV`: the TV's LAN IP
- `TIZEN_PROFILE`: your signing profile if it is not named `marquee`

## 4. Build and install Preview

Use `bash` explicitly so the script works even if a checkout did not preserve its executable bit:

```bash
MARQUEE_URL=http://192.168.1.10:8080 TV=192.168.1.30 bash tv/tizen-preview/build.sh --install
```

Or, after filling in `.env`:

```bash
bash tv/tizen-preview/build.sh --install
```

The package is written to:

```text
tv/tizen-preview/dist/MarqueePreview.wgt
```

The install command connects with Samsung's SDB tooling, installs `MarqueePreview.wgt`, and launches
`MrqTvPrv01.MarqueePreview`.

A normal consumer TV does not accept a raw `.wgt` copied over USB; use the development connection above.

## 5. First launch

Open **Marquee Preview** from Apps. Pair it just like the stable TV app. Preview has separate app storage, so pairing
it does not sign out or alter stable Marquee.

On the Preview home screen, press **Up** once to reach the top controls:

- **Discover** opens lightweight server-curated rows.
- Choose a film to Download immediately.
- Choose a show, pick a season, then Download.
- **Quality** defaults to the person's existing Marquee download settings and can be overridden for that request.

The TV never performs media searching or transfer work itself. It only renders a limited number of cards and sends
the request to Marquee; the server handles the download job.

## Rollback / fallback

Do nothing to stable Marquee. If Preview has a problem, exit it and launch **Marquee**.

You can uninstall **Marquee Preview** independently because it has a different Tizen package ID. Stable Marquee will
continue to load its unchanged `/tv/` frontend.
