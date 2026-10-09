# Marquee

A self-hosted media server for your home network. Browse and search films and shows, find and download torrents, fetch subtitles, and play anything on your phone, in a browser, or on a smart TV or Apple TV.

Marquee is a single Node.js process with no dependencies, served as a mobile-first web app that can be added to your phone's home screen.

## Features

- **Discover**: trending titles, search, posters and descriptions from TMDB, with titles you already have marked as on the server.
- **Library**: every video in your media folder, grouped by title with season and episode detection. Remembers where you stopped watching.
- **Torrent search**: searches The Pirate Bay and 1337x in parallel, ranked by seeders, with quality filters (4K, 1080p, 720p) and cinema recordings flagged. One tap sends a result to qBittorrent.
- **Downloads**: live qBittorrent progress, speed and time remaining.
- **Subtitles**: pick a language in the player or TV remote and Marquee fetches the best match from OpenSubtitles, preferring subtitles timed for your exact file. Downloaded subtitles that weren't made for your exact file have their timing checked and fixed automatically. Subtitles can also be requested when starting a download and are fetched automatically when it finishes.
- **Casting**: play on DLNA smart TVs (Samsung, LG, Sony and others) and Apple TV, with a full-screen remote for play/pause, seeking, volume and subtitles.
- **Automatic conversion**: MKV, AVI, WebM and similar files get an MP4 copy that plays on iPhone and Apple TV. Streams are copied where possible; video is re-encoded on an NVIDIA GPU (NVENC) or CPU only when needed.
- **Browser audio fix**: Chrome and Firefox can't decode Dolby (AC3/E-AC3) or DTS. Marquee adds a stereo AAC track so these files play with sound, while TVs still receive the original surround audio.
- **Library management**: delete films, single episodes or whole torrents. Files are removed through qBittorrent, together with any copies and subtitles Marquee created.

## Requirements

| Component | Required | Used for |
| --- | --- | --- |
| [Node.js](https://nodejs.org) 20 or later | Yes | Running the server |
| [TMDB](https://www.themoviedb.org) API token | Recommended | Discover, search, posters |
| [qBittorrent](https://www.qbittorrent.org) with Web UI | Optional | Downloads |
| [ffmpeg](https://ffmpeg.org) | Optional | Conversion and browser audio fix |
| [OpenSubtitles](https://www.opensubtitles.com) API key | Optional | Subtitles |
| [pyatv](https://pyatv.dev) | Optional | Apple TV |
| [FlareSolverr](https://github.com/FlareSolverr/FlareSolverr) | Optional | 1337x when it's behind a Cloudflare check |

Marquee is developed on Windows, and the auto-start scripts are Windows-only. The server itself runs anywhere Node.js does.

## Quick start

```bash
git clone https://github.com/Tjabooo/marquee.git
cd marquee
cp .env.example .env      # Windows: copy .env.example .env
```

Edit `.env`: at minimum set `MEDIA_DIR` to your video folder and add a `TMDB_TOKEN`. Then start the server:

```bash
npm start
```

The console lists which features are enabled and the address to open. On your phone, browse to `http://<server-ip>:8080`. To use it like an app, choose **Add to Home Screen** (Safari: Share menu; Chrome: browser menu).

Any feature whose settings are left blank is simply switched off, so you can start small and add integrations later.

## Configuration

All settings live in `.env`. Changes take effect after a restart.

### Server

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `8080` | Port for the web app. |
| `SERVER_IP` | auto | LAN address TVs use to stream from the server. Set it if the address printed at startup is wrong. |
| `ADMIN_EMAILS` | | Cloudflare Access emails that see the Activity tab, comma-separated. |

### Metadata and library

| Variable | Default | Description |
| --- | --- | --- |
| `TMDB_TOKEN` | | TMDB API Read Access Token. |
| `TMDB_API_KEY` | | Alternative to `TMDB_TOKEN`: a TMDB v3 API key. |
| `TMDB_LANG` | `en-US` | Language for titles and descriptions. |
| `MEDIA_DIR` | | Folder containing your videos. Subfolders are scanned. |

### Downloads and torrent search

| Variable | Default | Description |
| --- | --- | --- |
| `QBIT_URL` | | qBittorrent Web UI address, e.g. `http://localhost:8081`. |
| `QBIT_USER` / `QBIT_PASS` | | Web UI credentials. |
| `TORRENTS` | `on` | Set to `off` to hide torrent search. |
| `TPB_API` | `https://apibay.org` | The Pirate Bay API endpoint. |
| `X1337_URL` | built-in list | Comma-separated 1337x mirrors, tried in order. |
| `FLARESOLVERR_URL` | | FlareSolverr address, e.g. `http://localhost:8191`. |

### Subtitles

| Variable | Default | Description |
| --- | --- | --- |
| `OPENSUBTITLES_API_KEY` | | Enables subtitles. |
| `OPENSUBTITLES_USER` / `OPENSUBTITLES_PASS` | | Optional account login; raises the daily download limit from 5 to 20. |
| `SUB_LANGS` | `en,sv,da,...` | Languages offered, in display order. Codes follow OpenSubtitles (`en`, `pt-br`, `zh-cn`, ...). |
| `SUBSYNC` | `on` | Check and fix the timing of downloaded subtitles automatically. `off` leaves them as downloaded; the player's **Fix timing** button still works. Needs ffmpeg. |

### Casting

| Variable | Default | Description |
| --- | --- | --- |
| `DLNA_DEVICES` | | Description URLs for TVs that aren't discovered automatically. |
| `CAST_APPLETV` | `on` | Set to `off` to disable Apple TV support. |
| `CAST_WHEN_AWAY` | `off` | Set to `on` to allow casting to home TVs from outside the home network. |
| `STREAM_SECRET` | generated | Key for signing `/play/` links. Generated into `.marquee-secret` on first run if empty. |
| `ATVSCRIPT` | `atvscript` | Full path to pyatv's `atvscript` if it isn't on `PATH`. |
| `ATV_HOSTS` | | Apple TV IP addresses to query directly if discovery fails. |

### Conversion

| Variable | Default | Description |
| --- | --- | --- |
| `CONVERT` | `on` | Set to `off` to disable automatic conversion. |
| `CONVERT_DELETE_ORIGINAL` | `off` | Delete originals after conversion. Files owned by qBittorrent are never deleted. |
| `FFMPEG` / `FFPROBE` | on `PATH` | Full paths to the binaries if they aren't on `PATH`. |
| `AUDIO_FIX_DIR` | `./cache/audio` | Where audio-fixed copies of downloaded MP4s are stored. |

## Setting up integrations

### TMDB

1. Create a free account at [themoviedb.org](https://www.themoviedb.org).
2. Go to **Settings > API** and request an API key.
3. Copy the **API Read Access Token** into `TMDB_TOKEN`.

### qBittorrent

1. In qBittorrent, open **Tools > Options > Web UI** and enable the Web User Interface.
2. Choose a port other than Marquee's (for example `8081`) and set a username and password.
3. Set `QBIT_URL`, `QBIT_USER` and `QBIT_PASS` in `.env`.
4. Recommended: under **Options > Downloads**, set the default save path to your `MEDIA_DIR` so finished downloads appear in the library.

If Marquee signs in but is still refused, enable **Bypass authentication for clients on localhost** in the Web UI settings.

### OpenSubtitles

1. Create a free account at [opensubtitles.com](https://www.opensubtitles.com).
2. Open your profile, go to **API consumers**, and create a new consumer.
3. Copy its API key into `OPENSUBTITLES_API_KEY`. Add your username and password as well for the higher download limit.

Checking which languages are available doesn't count toward the limit; only downloads do. Each subtitle is saved beside its video as `<name>.<lang>.srt` and never downloaded twice.

### ffmpeg

```powershell
winget install Gyan.FFmpeg
```

On first run the converter processes existing files in the background at below-normal priority. NVENC is used automatically when an NVIDIA GPU is available.

### Away from home

TVs are only offered to visitors on the server's home network, since that's the only network the server can see. Direct visits are judged by their LAN address. Visits through Cloudflare Tunnel are compared with the home network's public IPv4 address and IPv6 /64, which the server looks up every 10 minutes through icanhazip.com, Cloudflare or ipify. If no lookup succeeds, casting stays available. Set `CAST_WHEN_AWAY=on` to allow casting from anywhere; `GET /api/network` shows how a request was classified.

### AirPlay and Chromecast from your phone

Wherever you are, the player and the **Play on TV** sheet offer your phone's own AirPlay (Safari) or Chromecast (Chrome on Android) list, so you can use TVs on the network you're on. The TV streams straight from the server at full quality while the phone acts as a remote. With AirPlay, the TV receives the version with the original surround audio.

The TV fetches the video itself and can't sign in to Cloudflare Access, so the player uses signed `/play/` links: each one works for a single file for 12 hours. If Marquee is behind Cloudflare Access, add a second Access application for the path `<your-hostname>/play` with a **Bypass** policy (Include: Everyone). Everything else stays behind your login.

### Smart TVs (DLNA)

Each phone or browser only sees the remote for the TVs it started, so several people can cast to different TVs at once. The TV list shows when someone else is watching a TV, has a button for that TV's remote, and asks for a second tap before taking the TV over.

Most DLNA TVs are discovered automatically; no setup is needed. If yours doesn't appear, add its device description URL (the `LOCATION` it advertises over UPnP) to `DLNA_DEVICES`.

Subtitle support over DLNA varies by manufacturer. Marquee advertises subtitles in the formats used by Samsung, LG and Sony.

### Apple TV

```bash
pip install pyatv
atvremote wizard      # pair once with each Apple TV
```

If the server runs as a scheduled task and can't find `atvscript`, set its full path in `ATVSCRIPT`. AirPlay can't display external subtitle files, so subtitles are available on Apple TV only through the phone or browser player.

### FlareSolverr

1337x sometimes places its pages behind a Cloudflare check. Marquee first tries each mirror in turn; if all of them are blocked, it can route the request through FlareSolverr.

1. Download the latest release from the [FlareSolverr releases page](https://github.com/FlareSolverr/FlareSolverr/releases) and run it.
2. Set `FLARESOLVERR_URL=http://localhost:8191`.

The first search after a while takes a few seconds while the check is solved; later requests reuse the clearance.

## Running at startup (Windows)

`setup-autostart.ps1` registers a scheduled task that starts Marquee at boot, before anyone signs in, and restarts it if it exits.

```powershell
# From the project folder, in an elevated PowerShell
powershell -ExecutionPolicy Bypass -File .\setup-autostart.ps1
```

| Script | Purpose |
| --- | --- |
| `setup-autostart.ps1` | Registers and starts the `Marquee` scheduled task. |
| `restart-marquee.ps1` | Restarts the task and prints which features are enabled. |
| `start-marquee.cmd` | Runs the server in a restart loop; used by the task. |

Output is written to `logs/marquee.log`.

Restarting is safe at any time. Downloads run in qBittorrent and carry on regardless. A conversion in progress is stopped together with the server (`restart-marquee.ps1` also stops any ffmpeg Marquee started) and starts again from the beginning shortly after the server is back; the MP4 is written under a temporary name and only renamed once complete, so an interrupted conversion never leaves a broken file, and leftover temporary files are cleaned up automatically. Subtitles waiting for downloads and subtitle timing checks also pick up where they left off.

To remove the task:

```powershell
Unregister-ScheduledTask -TaskName Marquee -Confirm:$false
```

## How it works

### Playback

Videos are streamed with HTTP range requests, so seeking works in every browser and on iOS. Watch progress is stored in the browser, and playback resumes where you left off.

### Conversion

The converter scans the library and finished downloads every two minutes. Any MKV, AVI, WebM, WMV, FLV, TS or MPEG file gets an MP4 copy next to it; once that exists, the library lists the copy instead. H.264 and HEVC video are copied without re-encoding; other codecs are re-encoded. Text subtitles are saved beside the copy as `.srt` files (some TVs refuse MP4s with many subtitle tracks) and image-based subtitles are dropped.

### Browser audio

Output files start with a stereo AAC track, followed by the original tracks, so browsers play them with sound and receivers still get surround. MP4 files downloaded as-is are never modified because qBittorrent may be seeding them; if their audio isn't browser-compatible, a fixed copy is written to `AUDIO_FIX_DIR` and served only to browsers. When you open such a file, it moves to the front of the queue and the player switches to the fixed copy when it's ready.

### Subtitle timing

Subtitles from OpenSubtitles are often made for a different release of the same film, so they can start a few seconds early or late, or slowly drift when the release runs at a different frame rate (23.976 vs 25 fps). After a download, Marquee lines the file up in the background against the first of these it finds:

1. a text subtitle track inside the video (or the MKV it was converted from),
2. a subtitle file Marquee extracted from such a track,
3. the film's audio, by finding where people are talking.

Both subtitle files are turned into on/off signals and compared at every offset up to ten minutes and for the common frame-rate ratios; the best match is applied only when it clearly beats every alternative, otherwise the file is left alone. Checking against a subtitle track takes a second; against the audio, roughly a minute for a feature film. Subtitles OpenSubtitles matched to your exact file are skipped.

The subtitle menu in the player shows the result and has **Undo timing fix**; the original is kept in `cache/subsync/`. **Fix timing** runs the check on demand for subtitles that weren't checked automatically. A fix moves or stretches the whole file, so subtitles for a different cut of the film (extra or missing scenes) can't be fully corrected.

### Browser copies of MP4s

Downloaded MP4s are never modified, since qBittorrent may still be seeding them. When one won't play in browsers, a browser copy is made in `cache/audio/` and played instead; TVs still get the original. That happens when the audio isn't AAC or MP3 or starts out of sync, and when the video won't play in Safari: HEVC labelled `hev1` (relabelled to `hvc1`, which is quick and keeps the quality), 10-bit H.264, AV1 or other codecs (re-encoded to H.264). Opening such a file in the player moves it to the front of the queue, and playback switches to the copy by itself when it's ready.

### Activity

The **Activity** tab shows who has been using Marquee and what they did: downloads started, films watched in the browser, casts to TVs, subtitles fetched and deletions. People are identified by the email they log in to Cloudflare Access with, plus the device and browser; visits through the server's local address show up as "Home network". The tab is only shown to the emails listed in `ADMIN_EMAILS`, and only through the Cloudflare address, since local visits have no email. The last 2,000 entries are kept in `.marquee-activity.jsonl`. Logins themselves (who signed in, when, from where) are in the Cloudflare Zero Trust dashboard under **Logs → Access**.

### Deletion

Deleting a video that belongs to a torrent removes it through qBittorrent, so the torrent stops seeding and no "missing files" errors appear. For multi-file torrents you can delete a single episode (qBittorrent is told not to download it again) or the whole torrent. The MP4 copy, subtitles and audio-fixed copy are deleted too, as are any empty folders left behind.

## Project structure

```
marquee/
├── server.js             HTTP server, API routes, library, qBittorrent, streaming
├── env.js                Loads .env before other modules
├── torrents.js           The Pirate Bay and 1337x search
├── subtitles.js          OpenSubtitles client and local subtitle files
├── subsync.js            Automatic subtitle timing
├── convert.js            Background ffmpeg conversion and audio fixes
├── cast.js               DLNA and Apple TV casting
├── network.js            Home-network detection for casting
├── activity.js           Activity log
├── public/
│   ├── index.html
│   ├── app.js            Web client
│   └── style.css
├── .env.example          Configuration template
├── setup-autostart.ps1
├── restart-marquee.ps1
└── start-marquee.cmd
```

Created at runtime and excluded from Git:

| Path | Contents |
| --- | --- |
| `.env` | Your configuration and credentials |
| `.marquee-convert.json` | Conversion failures and audio checks |
| `.marquee-subs.json` | Subtitles waiting for downloads to finish |
| `.marquee-activity.jsonl` | Activity log |
| `.marquee-subsync.json` | Subtitle timing results |
| `cache/subsync/` | Subtitles as they were before a timing fix |
| `.marquee-secret` | Key for signed `/play/` links |
| `cache/audio/` | Audio-fixed copies of downloaded MP4s |
| `logs/` | Output from the auto-start task |

## API

The web client uses a JSON API that can also be scripted. `<kind>` is `lib` for library files or `dl` for downloads.

| Method | Route | Description |
| --- | --- | --- |
| `GET` | `/api/status` | Enabled features |
| `GET` | `/api/activity` | Recent activity and people (`ADMIN_EMAILS` only) |
| `GET` | `/api/trending`, `/api/search?q=` | TMDB titles |
| `GET` | `/api/library` | Library contents |
| `GET` | `/api/library/delete-info?id=` | What deleting an item would remove |
| `POST` | `/api/library/delete` | Delete a file or torrent (`{ id, scope: "file" \| "torrent" }`) |
| `GET` | `/api/downloads` | qBittorrent downloads |
| `POST` | `/api/downloads/add` | Add a magnet or `.torrent` URL (`{ link, subs? }`) |
| `GET` | `/api/torrents/search?q=&type=` | Torrent search (`type`: `movie`, `tv` or `all`) |
| `GET` | `/api/torrents/magnet?ref=` | Magnet link for a 1337x result |
| `GET` | `/api/convert` | Conversion progress |
| `GET` | `/api/subs/langs` | Subtitle languages for a file (`kind`, `id`) or title (`q`, `type`) |
| `POST` | `/api/subs/fetch` | Download subtitles (`{ kind, id, lang }`) |
| `GET` | `/api/subs/file/<kind>/<id>/<lang>.vtt` | Subtitles as WebVTT (`.srt` also available) |
| `GET` | `/api/subs/sync` | Timing check state for saved subtitles (`kind`, `id`, `lang`) |
| `POST` | `/api/subs/sync` | Fix or undo subtitle timing (`{ kind, id, lang, action: 'sync' \| 'undo' }`) |
| `GET` | `/api/stream/<kind>/<id>` | Video stream with range support |
| `GET` | `/api/play-link?kind=&id=&variant=` | Signed `/play/` link (`variant`: `browser` or `tv`) |
| `GET` | `/play/...` | Video stream through a signed link; works without signing in |
| `GET` | `/api/cast/devices`, `/api/cast/sessions` | TVs and what's playing |
| `GET` | `/api/network` | Whether the request is from the home network, for troubleshooting |
| `POST` | `/api/cast/play` | Start playback on a TV |

## Security

Marquee has no user accounts or authentication. Anyone who can reach the server can browse, download and **delete** files. Run it only on a trusted home network and do not expose its port to the internet. For remote access, use a VPN such as WireGuard or Tailscale.

Keep `.env` private: it contains your API keys and passwords, and it is excluded by `.gitignore`.

## Troubleshooting

| Problem | Solution |
| --- | --- |
| A feature shows as `off` at startup | Check the matching variable in `.env`, then restart. `GET /api/status` shows what's enabled. |
| No sound in the browser | The file uses Dolby or DTS audio. Keep the player open; it switches to a fixed copy once it's ready. Requires ffmpeg. |
| TV not listed | Make sure it's on the same network and has DLNA/media sharing enabled, or add it to `DLNA_DEVICES`. |
| TV plays but shows the wrong server address | Set `SERVER_IP` to the server's LAN address. |
| "Every 1337x mirror is showing a Cloudflare check" | Set up FlareSolverr. The Pirate Bay results keep working meanwhile. |
| "Today's subtitle download limit is used up" | Add `OPENSUBTITLES_USER` and `OPENSUBTITLES_PASS`, or wait for the daily reset. |
| Apple TV asks for pairing | Run `atvremote wizard` on the server. |
| Delete fails with "file is in use" | Stop playback in the browser and on any TV, then try again. |

## Disclaimer

Marquee is a media management tool. The torrent search queries third-party sites and does not host, index or distribute any content. Downloading copyrighted material without permission is illegal in many countries. You are responsible for how you use this software and for complying with the laws that apply to you.
