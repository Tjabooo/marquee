# Marquee

A self-hosted media server for your home network. Browse and search films and shows, find and download torrents, fetch subtitles, and play anything on your phone, in a browser, or on a smart TV or Apple TV.

Marquee is a single Node.js process with no dependencies, served as a mobile-first web app that can be added to your phone's home screen.

## Features

- **Accounts**: everyone who signs in through Cloudflare Access gets their own Marquee, with no extra login: their own library, watch progress that follows them between devices, colours and preferences. See [Accounts](#accounts).
- **Discover**: trending titles, search, posters and descriptions from TMDB. Titles in your library are marked **In your library**; titles someone else already has on the server are marked **On server** and can be added to your library with one tap instead of being downloaded again.
- **Film identity**: availability follows the film's TMDB ID. If two films share a title and year, the owner can open **Library → film → Identify film** and choose by poster, release date and description. That choice is saved for that file alone. Downloads started from a film's details remember the selected identity, too. Discover carousels have previous/next arrows as well as touch scrolling.
- **Library**: poster covers for films and shows, with **Continue watching** and **Leaving soon** shelves, then your downloads, titles added from the server and your collection. Filter by films or shows. Open a title to play, resume or **Keep 7 more days**; shows have a keep-all button above their seasons as well as individual episode controls.
- **Watch Together**: open a library title in the player, press **Watch together**, then **Room → Copy invite**. Family members sign in normally, join and press **Play** to enable playback. The host controls play, pause and seek; subtitle language, size, visibility, offsets and volume stay personal. Rooms wait for buffering viewers and correct small playback drift. Room details stay collapsed beside the subtitle/volume controls; **Hide**, Escape or a click outside closes them.
- **Torrent search**: searches The Pirate Bay and 1337x in parallel, ranked by seeders, with quality filters (4K, 1080p, 720p) and cinema recordings flagged. One tap sends a result to qBittorrent. Searching for a season (“South Park S18”) adds **Get all episodes**: Marquee finds the best torrent for every aired episode and downloads them all, for when there's no good complete-season torrent.
- **Recommended downloads**: the best-download card on a film or show's details has a Quality selector: Auto, 4K, 1080p or 720p. Auto keeps the normal ranking; a specific quality only recommends that resolution. Episode-by-episode fallback from this card also respects the selected resolution, leaving unavailable episodes out.
- **Downloads**: live qBittorrent progress, speed and time remaining, for your own downloads (the owner can switch to everyone's).
- **Auto-delete**: downloads are deleted 7 days after they finish (the owner can change this), counted per person; a video someone else still has in their library stays.
- **Settings**: colour themes (nine presets, or pick your own four colours), default subtitles, preferred torrent quality, start page and library order. The owner also sets the auto-delete rules, who may download, and sees everyone's library size.
- **Subtitles**: pick a language in the player or TV remote and Marquee fetches the best match from OpenSubtitles, preferring subtitles timed for your exact file. Downloaded subtitles that weren't made for your exact file have their timing checked and fixed automatically. Subtitles can also be requested when starting a download and are fetched automatically when it finishes.
- **Casting**: play on DLNA smart TVs (Samsung, LG, Sony and others) and Apple TV, with a full-screen remote for play/pause, seeking, volume and subtitles.
- **Automatic conversion**: MKV, AVI, WebM and similar files get an MP4 copy that plays on iPhone and Apple TV. Streams are copied where possible; video is re-encoded on an NVIDIA GPU (NVENC) or CPU only when needed.
- **Browser audio fix**: Chrome and Firefox can't decode Dolby (AC3/E-AC3) or DTS. Marquee adds a stereo AAC track so these files play with sound, while TVs still receive the original surround audio.
- **House** (owner only): the server's disks, qBittorrent, FlareSolverr and AdGuard Home at a glance, plus the Linux machines at home (disk space, failed services, updates, battery, Secure Boot, backups), with anything that needs a look listed at the top. **Power** turns a dual-boot PC on (Wake-on-LAN) into the system you pick, or restarts it into another one.
- **Clips** (owner only): game clips synced from a PC, grouped by game. **Share** gives a clip a public link that embeds and plays in Discord; sharing makes a Discord-friendly H.264 copy (all audio tracks mixed into one) and unsharing kills the link. **Delete** (two taps) removes a clip: it waits 30 days in a hidden `.deleted` folder before it's gone for good. **Trim** cuts a clip without re-encoding (ffmpeg stream copy: identical quality, every audio track kept, no GPU needed); the start snaps to the nearest keyframe before the chosen point, which the trimmer shows, and the result goes to `Trimmed Clips/<Game>/`.
- **Notes** (admins only): a shared message-style inbox for information and reminders. Enter sends a note (Shift+Enter adds a line); search finds keywords across the entire history. Edit messages, pin important ones, add reminder dates, mark them done, or move notes to recoverable Trash. Dates stay unchanged when editing. Conflicting edits are rejected instead of overwriting someone else's changes. Notes refresh while idle and are hidden from ordinary members, including direct API and attachment access.
- **Invites** (owner only): make a one-time link, send it, and the person enters their email and is added to the Cloudflare email list your Access policy allows, so they can sign in from then on (Google, a one-time email code, whatever you've enabled). Who has access is listed in the Activity tab, with a Remove button.
- **Discord embeds**: shared clips show up as playable videos, and `/c/` is an invite card for Marquee itself.
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
| `ADMIN_EMAILS` | | Cloudflare Access emails that see the Activity, House and Clips tabs and the owner's settings, comma-separated. The first one is the owner: files added outside Marquee go into their library. |
| `PUBLIC_URL` | from the request | Public address used in share links and Discord embeds, e.g. `https://marquee.example.com`. |

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
| `QBIT_REMOVE_FINISHED` | `on` | Remove finished downloads from qBittorrent (files kept) so nothing seeds. Set to `off` to seed as usual. A torrent tagged `seed` in qBittorrent is never touched. |
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

### House, clips and invites

| Variable | Default | Description |
| --- | --- | --- |
| `HOUSE_TOKEN` | | Shared secret for `agents/marquee-house`. Leave empty to turn machine reports off; the House tab still shows the server. |
| `ADGUARD_URL` | | AdGuard Home's web address, e.g. `http://localhost:3000`, for protection state and query stats. Without it House only checks that something answers DNS on port 53. |
| `ADGUARD_USER` / `ADGUARD_PASS` | | AdGuard Home login. |
| `CF_API_TOKEN` | | Cloudflare API token for invites, permission *Account · Zero Trust → Edit*. |
| `CF_ACCOUNT_ID` / `CF_ACCESS_LIST_ID` | | The Cloudflare account and the email list your Marquee policy allows. |
| `INVITE_DAYS` | `7` | How long an unused invite link works. |
| `WOL_BROADCAST` | | Extra addresses for Wake-on-LAN packets, comma-separated. Only needed if waking doesn't work: the server already sends to its own network's broadcast address and `255.255.255.255`. |
| `CLIPS_DIR` | | Folder the clips are synced to, e.g. `D:\Clips` (the share behind the desktop's `/mnt/magi-clips`). Leave empty to hide the Clips tab. |

### Conversion

| Variable | Default | Description |
| --- | --- | --- |
| `CONVERT` | `on` | Set to `off` to disable automatic conversion. |
| `CONVERT_DELETE_ORIGINAL` | `off` | Delete originals after conversion. Files owned by qBittorrent are never deleted. |
| `FFMPEG` / `FFPROBE` | on `PATH` | Full paths to the binaries if they aren't on `PATH`. |
| `AUDIO_FIX_DIR` | `./cache/audio` | Where audio-fixed copies of downloaded MP4s are stored. |
| `PREPARE_NEXT_EPISODES` | `2` | When an episode needs a browser copy (HEVC in a browser without HEVC), this many following episodes get theirs made in the background. `0` turns it off. |

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

### Shared admin notes and Discord imports

The Notes toolbar is a compact filter selector and overflow menu; Refresh and
Import Discord live in that menu. The single-row composer grows while typing,
and reminder options open from its three-dot menu. On phones, the timeline gets
the remaining screen space rather than being squeezed by permanent controls.

Use **+** to attach photos, videos, audio or documents from your phone or computer.
Multiple files and media-only notes work. Uploads show progress and use 8 MiB
chunks (up to 1 GB per file), retry interrupted chunks, and stay private to
admins. Photos, videos and audio have inline previews where the browser supports
the original format; the original file is always available to download.

Set `NOTES_FILES_DIR=D:\Marquee\Notes` in `.env` to keep all Notes media on D:.
Copy the contents of the old media folder to the new location before restarting
when changing this setting. Include that directory and `.marquee.db` in private
backups. File names are metadata; stored media uses generated IDs.

Everyone listed in `ADMIN_EMAILS` shares the **Notes** inbox. Ordinary accounts
and the unauthenticated Home network account cannot read or change notes or
fetch their archived files. Notes live in `.marquee.db`; archived attachments
live in `NOTES_FILES_DIR` (default `.marquee-notes-files/`). Include both in private server backups.
Neither the note text nor imported message contents go into the Activity log.

Use the search field for words or word prefixes; several words must all match.
**Pinned**, **Due**, and **Trash** narrow the view. Reminder dates are shown in
local time, with due reminders highlighted when Notes is open; these are not
background push notifications. Deleted notes can be restored from Trash.

**Import Discord** accepts the MEE6 conversation's `messages.json` or
`messages.csv` from Discord's data package, or a common JSON conversation
export. Preview the count and choose your own author when the file includes
other people or bot replies. Original message IDs and UTC dates are retained;
retrying an import skips existing IDs and never resurrects trashed notes.
Browser uploads preserve attachment links. Those links may expire on Discord.

For an archive that also keeps actual Discord attachments on the server, run:

```powershell
node tools/import-discord-notes.mjs C:\path\to\mee6.json --dry-run
node tools/import-discord-notes.mjs C:\path\to\mee6.json
```

The command uses the first configured admin as the importing account. If a
conversation export has multiple human authors, pass `--author-id YOUR_ID`.
It downloads only HTTPS files from Discord's attachment CDN and image/video
files from Tenor/Giphy, follows only approved-CDN redirects, and limits each file
to 100 MB. Successful files are served
through an admin-only download route with `no-store` and `nosniff`; originals
stay unchanged in Discord. Unavailable files retain their original links and
are counted in a private import report under `.marquee-notes-imports/`.
Do not commit exports, reports, database files, or archived attachments.

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

### House: reports from your Linux machines

`agents/marquee-house` is a small bash script for each Linux machine at home (needs `curl` and `jq`). It reports disk space, failed services, pending updates (from the waybar update counter's cache), battery, Secure Boot state and the last backup, and only talks to the server on the home network: setup remembers the router's MAC address and nothing is sent anywhere else. On the server, the reports are only accepted with `HOUSE_TOKEN` **and** straight from the LAN; requests through Cloudflare are refused even with the token.

```bash
# on each machine, at home (HOUSE_TOKEN = the same value as in the server's .env)
install -m755 agents/marquee-house ~/.local/bin/
install -m644 agents/marquee-house.{service,timer} ~/.config/systemd/user/
marquee-house setup http://<server-ip>:8080 <HOUSE_TOKEN>
systemctl --user enable --now marquee-house.timer
```

For a status-bar dot, `marquee-house status` prints waybar JSON (`"return-type": "json"`); it hides itself away from home.

### House: turn the PC on, and pick Linux or Windows

The **Power** section of the House tab wakes a dual-boot (GRUB) PC with Wake-on-LAN and boots it into the system you tap, or restarts it into another one while it's on.

A PC that's off can't be told what to boot, so Linux decides on the way up. GRUB always starts Linux. `marquee-house boot`, a root timer on the PC, asks the server right after boot (and every 30 s after that) whether a different system was picked. If one was, it sets GRUB's one-shot next entry with `grub-reboot`, the same thing a "reboot to Windows" menu does, and restarts. Waking into Windows therefore passes through Linux for a few seconds. The same check carries **Restart into…** while the PC is on, tells the server the PC's MAC address and boot menu, and switches Wake-on-LAN on for the wired network card on every boot.

On the PC (Arch, at home, with the user agent above already set up):

```bash
sudo pacman -S --needed ethtool
sudo install -m755 agents/marquee-house /usr/local/bin/
sudo install -m600 ~/.config/marquee-house.env /etc/marquee-house.env
sudo install -m644 agents/marquee-house-boot.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now marquee-house-boot.timer
```

The PC shows up under **Power** within 30 seconds. It also needs:

- **A network cable.** Wake-on-LAN almost never works over Wi-Fi from a powered-off PC.
- **Wake-on-LAN on in the BIOS/UEFI**, often called *Wake on LAN*, *Power On By PCI-E* or *Resume by PCI-E device*. Turn off *ErP Ready* / *Deep Sleep*: it cuts power to the network card when the PC is off.
- **GRUB starting Linux by default** (`GRUB_DEFAULT=0`, or `saved` with Linux saved). The card warns you if it doesn't.
- **On Windows:** Fast Startup off (*Control Panel → Power Options → Choose what the power buttons do*), and in *Device Manager → network adapter → Properties*: *Advanced → Wake on Magic Packet* (and *Shutdown Wake-On-Lan*, if present) enabled, *Power Management → Allow this device to wake the computer* ticked. Windows sets up the card for the next wake whenever it's the one that shuts down.

While the PC is in Windows, Marquee sees it as "Off, or in Windows": Windows doesn't run the agent, so it can't be restarted from Marquee.

### Clips and Discord share links

Set `CLIPS_DIR` and the owner gets a **Clips** tab. Shared clips live under `/c/<token>`: a page with the video, the video itself and a thumbnail. For those links to work for everyone (and for Discord to embed them), let `/c/` past Cloudflare Access, the same way as `/play/`:

Hover over a clip's name to reveal its outline and pencil, then click to rename it.
On touchscreens the pencil stays visible. Enter saves, Escape cancels, and Save
and Cancel buttons are also available. Names persist across restarts and appear
in search and shared pages. Original files, clip IDs and existing share links
stay unchanged. Include `.marquee-clip-titles.json` in server backups.

1. Cloudflare Zero Trust → **Access → Applications → Add an application → Self-hosted**.
2. Application domain: your Marquee hostname, path `c`.
3. Policy: action **Bypass**, include **Everyone**. Access applies the most specific path, so the rest of Marquee stays behind your login.

Invite links (`/c/i/<token>`) are covered by the same rule. Only shared clips, open invites and the invite card are reachable there. Links are 96-bit random tokens, unknown or unshared tokens get a 404, and unsharing deletes the shared copy. `https://<your-host>/c/` on its own is an invite card for Marquee: paste that in Discord to get an embed of the site itself, and anyone who clicks it is sent on to the normal (protected) app.

### Invites (Zero Trust email list)

Invites add people to a Zero Trust **email list**; your Marquee application's policy allows everyone in it.

1. Zero Trust → **Reusable components → Lists → Create list**: name *Marquee users*, type **Emails**, and add everyone who already has access (yourself included). Save, and copy the list's **ID** (its details page / URL).
2. Zero Trust → **Access controls → Applications** → your Marquee app → its **Allow** policy → Include → **Emails in list** (the selector may be called *Email list*) → *Marquee users*. Your existing email rules can stay.
3. Cloudflare dashboard → **My Profile → API Tokens → Create Token → Custom token**: permission **Account · Zero Trust · Edit**, limited to your account.
4. `.env`: `CF_API_TOKEN`, `CF_ACCOUNT_ID` (dashboard → any domain → Overview, right column) and `CF_ACCESS_LIST_ID`. Restart Marquee.
5. The `/c/` bypass above must be in place: the invite page has to open for someone who can't sign in yet.

In the Activity tab: **Invite someone** (optionally with a note such as "for Leo") copies a link. It works once and expires after `INVITE_DAYS`. The person opens it, enters the email they'll sign in with and is sent to Marquee, where Cloudflare's login page lets them pick a login method; with *One-time PIN* enabled anyone with an email address can sign in, and Google etc. work when the account uses that same address. Everyone with access is listed with a **Remove** button; owners (`ADMIN_EMAILS`) can't be removed there. Only the one address is added or removed; nothing else in the list or the policy changes.

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

1. a subtitle track inside the video (or the MKV it was converted from), including the display/clear timings of PGS/DVD bitmap captions,
2. a subtitle file Marquee extracted from such a track,
3. the film's audio, by finding where people are talking.

Both subtitle files are turned into on/off signals and compared at every offset up to ten minutes and for the common frame-rate ratios; the best match is applied only when it clearly beats every alternative, otherwise the file is left alone. Checking against a subtitle track takes a second; against the audio, roughly a minute for a feature film. Subtitles OpenSubtitles matched to your exact file are skipped.

The subtitle menu in the player shows the result and has **Undo timing fix**; the original is kept in `cache/subsync/`. **Fix timing** runs the check on demand for subtitles that weren't checked automatically. The **Subtitle offset** buttons (−1 s, −¼ s, +¼ s, +1 s) in the player's subtitle menu and in the TV remote move every line by hand; on a TV the new timing is sent over a moment after the last tap, restarting at the same spot. **Reset offset** puts the lines back. A fix moves or stretches the whole file, so subtitles for a different cut of the film (extra or missing scenes) can't be fully corrected.

Subtitle selection uses the original release's file hash when a converted copy is being played, prefers the matching BluRay/WEB/TV source, and checks episode numbers when choosing a file from a multi-file upload. Identified films are searched by TMDB ID. Existing automatic results are revisited once with the bitmap-aware engine when subtitles are opened; manual offsets and undone fixes are preserved. **Check timing again** is also available after an uncertain result. Bitmap timing requires the original file to still exist; it aligns text subtitles but does not turn subtitle pictures into text. A weak match is left unchanged.

### Browser copies of MP4s

Downloaded MP4s are never modified, since qBittorrent may still be seeding them. When one won't play in browsers, a browser copy is made in `cache/audio/` and played instead; TVs still get the original. That happens when the audio isn't AAC or MP3 or starts out of sync, and when the video won't play in Safari: HEVC labelled `hev1` (relabelled to `hvc1`, which is quick and keeps the quality), 10-bit H.264, AV1 or other codecs (re-encoded to H.264). Opening such a file in the player moves it to the front of the queue, and playback switches to the copy by itself when it's ready.

HEVC episodes keep their HEVC video in the MP4 copy: that's lossless and quick, and TVs, iPhones, Safari and Chrome play it. Firefox (and browsers built on it, like Zen) can't, so those get an H.264 copy, which takes a minute or two per episode. When that happens, the next episodes of the show (`PREPARE_NEXT_EPISODES`, default 2) get their copies made in the background, so the next one starts right away.

### A whole season, episode by episode

When a torrent search looks like a season (`South Park S18`, `South Park season 18`), the results start with **Get all episodes**. It's highlighted when no complete-season torrent has at least 10 seeders, and a quiet extra otherwise. One tap starts a background job: TMDB says which episodes have aired, episodes already in the library or in qBittorrent (singly or in a season pack) are skipped, and every other episode is searched on its own. The pick for each episode is a release of the same show (loose name match, as in the library) for exactly that season and episode, never a cinema recording, with at least one seeder; among those with 5+ seeders, the quality filter you chose wins (otherwise 1080p, then 720p, 4K, SD), then the most seeders. Multi-episode releases (`S18E03E04`) count for every episode they hold. The card shows progress and finishes with what was added, what was already there and what couldn't be found. Without TMDB, episodes are tried in order until two in a row aren't found. The subtitle language picked above the results is requested for every episode.

### Shows in the library

Films and shows appear as poster cards, separated into Films and Shows inside each library section. A card shows the next deletion countdown; the Leaving soon shelf collects titles with less than 48 hours left and offers a keep button directly on the card. Opening a film or show puts its countdown and keep controls above the synopsis and seasons. Titles without a countdown say that no automatic deletion is scheduled. Film posters, backdrops and descriptions come from TMDB, matched by title and year and cached in `.marquee-shows.json` (30 days for matches, one day for misses); unavailable artwork falls back to the title.

Episodes are recognised from `S01E05`, `S01E01E02`, `1x05` and `Season 1 Episode 5` in the file name. A file named only `S02E05.mkv` takes the show's name from its folder (`The Bear (2022)/Season 2/`). Episodes are grouped into one show when their names match loosely (case, punctuation and a leading "The" are ignored) or when TMDB resolves them to the same show, so episodes from different releases end up together. TMDB supplies the show's and each season's poster and the episode names; lookups are cached in `.marquee-shows.json` (found shows for 30 days, refreshed weekly for new seasons; unknown names are retried daily). Without TMDB, shows are still grouped by name.

### Finished downloads

With `QBIT_REMOVE_FINISHED=on` (the default), a finished download is removed from qBittorrent within a minute, with its files kept, so it never seeds. Downloads go into `MEDIA_DIR`, so the video stays in the Library and gets its MP4 copy as usual. A download still waiting for subtitles requested with it is stopped first and removed once they're fetched (at most 2 hours later). Downloads saved outside `MEDIA_DIR` are only stopped, so they stay playable from the Downloads tab. Give a torrent the tag `seed` in qBittorrent to keep it seeding. Once a download is removed, its files count as ordinary library files, so `CONVERT_DELETE_ORIGINAL=on` applies to them.

### Accounts

There's no separate login. Cloudflare Access adds the signed-in email to every request (`Cf-Access-Authenticated-User-Email`) and that email is the account; one is created the first time someone opens Marquee. Visits through the server's local address carry no email and share a "Home network" account. Accounts live in `.marquee.db`, a SQLite database (Node's built-in `node:sqlite`, so still no dependencies): people and their settings, what's in each library, who started each download, and watch progress.

- **One file, many libraries.** A video exists once on disk. "Add to my library" adds it to your list; nothing is copied or downloaded again. A video's identity is its path in `MEDIA_DIR` without the extension, so the MP4 copy and the original count as the same video.
- **Whose download.** Torrents added through Marquee get the qBittorrent tag `marquee-u<id>` (and a magnet's infohash is recorded). When one finishes, its videos go into that person's library, before the no-seeding cleanup removes the torrent. Torrents added straight in qBittorrent count as the owner's (the first address in `ADMIN_EMAILS`). A whole-season download puts episodes that are already on the server into your library instead of downloading them again.
- **Already there.** On the first start with accounts, every video already on the server goes into the owner's library as **kept** (no countdown), so nothing that was there gets auto-deleted. Videos copied into `MEDIA_DIR` by hand later are treated the same way.
- **Auto-delete.** Each video in someone's library has a date it goes: by default 7 days after the download finished (or after it was added from the server). **Keep 7 more days** pushes it back. When the date passes it leaves that person's library, and once it's in nobody's library the file is deleted (with its MP4 copy and subtitles), checked every 10 minutes. A file that's playing is retried later. The owner can change the period (or turn it off), the extension, and how many times a video can be extended, and can exempt someone (**Never auto-delete**) in Settings.
- **Deleting** takes a video out of your library; the file is only deleted when nobody else has it. The owner can also delete it for everyone.
- **Privacy.** People only see their own library and downloads. Search tells them a title is on the server, not whose it is. The owner's Settings tab lists everyone with how much they have.
- **Staying signed in.** How long a sign-in lasts is Cloudflare's setting: Zero Trust → Access → Applications → your Marquee app → **Session duration** (24 hours by default; up to a month). If a sign-in runs out while Marquee is open, it says so and signs back in with one tap.

### Activity

The name chosen in **Settings → Profile** is the default person label in Activity, the access list, download ownership and Watch Together. Activity resolves names when read, so a profile rename also updates older events; email addresses remain searchable and are shown secondarily in the owner's People/access lists. Active watch rooms receive profile-name changes immediately and refresh them on heartbeat/rejoin.

City and country appear beside the OS/browser for people and events, using Cloudflare's `CF-IPCity` and `CF-IPCountry` headers. In the domain's Cloudflare dashboard, go to **Rules → Settings → Managed Transforms** and enable **Add visitor location headers**. Location is approximate (VPNs and mobile carriers can change it), not GPS. No external IP lookup service is called. Old events and direct LAN visits have no inferred location; country-only headers still show the country.

The **Activity** tab shows who has been using Marquee and what they did: downloads started, films watched in the browser, casts to TVs, subtitles fetched and deletions. People are identified by the email they log in to Cloudflare Access with, plus the device and browser; visits through the server's local address show up as "Home network". The tab is only shown to the emails listed in `ADMIN_EMAILS`, and only through the Cloudflare address, since local visits have no email. The last 2,000 entries are kept in `.marquee-activity.jsonl`. Logins themselves (who signed in, when, from where) are in the Cloudflare Zero Trust dashboard under **Logs → Access**.

### Deletion

Deleting a video that belongs to a torrent removes it through qBittorrent, so the torrent stops seeding and no "missing files" errors appear. For multi-file torrents you can delete a single episode (qBittorrent is told not to download it again) or the whole torrent. The MP4 copy, subtitles and audio-fixed copy are deleted too, as are any empty folders left behind.

### Watch Together

Rooms work in the browser player, including fullscreen. Invite URLs are `/?watch=<random token>` and stay behind the existing Cloudflare sign-in. The room grants access to that title without adding it to each guest's library. Up to 12 viewers can join. Casting is outside synchronized playback: leave the room before using a TV receiver.

The server publishes a shared timeline over Server-Sent Events, with heartbeats to keep Cloudflare Tunnel from buffering or closing the connection. Each browser estimates clock offset from low-round-trip-time samples, starts at a shared future time and compensates for message arrival delay. Small drift is corrected with a bounded playback-rate adjustment; larger drift seeks to the shared position. The group pauses when a member buffers or needs an autoplay gesture and resumes when everyone is ready. This reduces skew but does not promise frame-perfect playback on every device or connection. Each viewer streams separately, so server upload bandwidth must cover all viewers.

Only play/pause/seek and readiness enter room state. Caption tracks and manual offsets remain in each viewer's player; party offset buttons do not edit the shared SRT file. The host's departure pauses playback and hands control to a remaining viewer. Dropped viewers have a 20-second reconnect grace period. Rooms are in memory, expire within 24 hours and end when Marquee restarts. Active rooms protect their media against file deletion; normal retention cleanup retries later.

## Project structure

```
marquee/
├── server.js             HTTP server, API routes, library, qBittorrent, streaming
├── env.js                Loads .env before other modules
├── torrents.js           The Pirate Bay and 1337x search
├── subtitles.js          OpenSubtitles client and local subtitle files
├── subsync.js            Automatic subtitle timing
├── convert.js            Background ffmpeg conversion and audio fixes
├── shows.js              Groups episodes into shows and seasons (TMDB posters, episode names)
├── season.js             Whole-season downloads, one episode at a time
├── cast.js               DLNA and Apple TV casting
├── network.js            Home-network detection for casting
├── activity.js           Activity log
├── house.js              House tab: server health + reports from home machines
├── clips.js              Clips tab, share links and their public pages (/c/)
├── invites.js            Invite links → Zero Trust email list (/c/i/)
├── accounts.js           Accounts (SQLite): people, settings, libraries, auto-delete, watch progress
├── watch.js              Watch rooms, participants, readiness and the shared playback clock
├── agents/
│   ├── marquee-house     Health reporter for Linux machines (+ systemd service/timer)
│   └── marquee-house-boot.{service,timer}   Root timer for `marquee-house boot` (wake / restart into)
├── public/
│   ├── index.html
│   ├── app.js            Web client
│   ├── watch-sync.js     Clock compensation, player synchronization and personal subtitle offsets
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
| `.marquee-house.json` | Latest report from each home machine |
| `.marquee-shows.json` | TMDB lookups for grouping shows: show and season posters, episode names |
| `.marquee-power.json` | Each dual-boot machine's MAC address and boot menu, for waking it |
| `.marquee-shares.json` | Shared clips (token → clip) |
| `.marquee-invites.json` | Invite links and who used them |
| `.marquee.db` | Accounts: people and their settings, each library, who started each download, watch progress, server rules |
| `cache/clips/` | Clip thumbnails and the Discord-friendly copies of shared clips |
| `CLIPS_DIR/.deleted/` | Deleted clips, erased automatically after 30 days (move a file back out to restore it) |

## API

The web client uses a JSON API that can also be scripted. `<kind>` is `lib` for library files or `dl` for downloads.

| Method | Route | Description |
| --- | --- | --- |
| `GET` | `/api/status` | Enabled features |
| `GET` | `/api/activity` | Recent activity and people (`ADMIN_EMAILS` only) |
| `POST` | `/api/watch` | Host a library title (`{ id, clientId, position }`), returns a private room token |
| `GET` | `/api/watch/clock` | Server clock sample for latency compensation |
| `GET` | `/api/watch/<token>/preview` | Title and host for the join screen (normal sign-in required) |
| `POST` | `/api/watch/<token>/join`, `/heartbeat`, `/control`, `/leave` | Room membership and playback; all use `clientId`, control adds `{ action, position }`, heartbeat adds `{ ready, buffering, blocked, rtt }` |
| `GET` | `/api/watch/<token>/events?clientId=` | Immediate timeline updates over SSE (joined viewers only) |
| `GET` | `/api/watch/<token>/play-link?clientId=` | Browser stream for the room's title (joined viewers only) |
| `GET` | `/api/trending`, `/api/search?q=` | TMDB titles |
| `GET` | `/api/library` | Your library (`items`, with `expiresAt`), and what else is on the server (`server`) |
| `POST` | `/api/library/add` | Add videos already on the server to your library (`{ ids }`) |
| `POST` | `/api/library/extend` | Keep videos longer (`{ ids }`) |
| `GET`, `POST` | `/api/library/identify` | Owner only: search film candidates (`?id=&q=`) or assign a TMDB identity to one file (`{ id, tmdbId }`) |
| `GET` | `/api/library/delete-info?id=` | What deleting an item would remove, and how many others have it |
| `POST` | `/api/library/delete` | Remove from your library; deletes the file or torrent when nobody else has it (`{ id, scope: "file" \| "torrent", everyone? }`) |
| `GET`, `POST` | `/api/me` | You and your settings (`{ name?, theme?, subLang?, quality?, startView?, librarySort? }`) |
| `GET`, `POST` | `/api/me/progress` | Where you stopped watching (`{ ref, time, duration }`; `time: null` = finished) |
| `GET`, `POST` | `/api/admin/settings` | Auto-delete rules and defaults (`ADMIN_EMAILS` only) |
| `GET` | `/api/admin/users` | Everyone who has used Marquee, with their library size (`ADMIN_EMAILS` only) |
| `POST` | `/api/admin/users/<id>` | `{ canDownload?, keep? }` (`ADMIN_EMAILS` only) |
| `GET` | `/api/downloads` | Your qBittorrent downloads (`?all=1`: everyone's, owner only) |
| `POST` | `/api/downloads/add` | Add a magnet or `.torrent` URL (`{ link, subs?, movieId? }`); `movieId` carries the selected TMDB film identity |
| `POST` | `/api/downloads/season` | Get a whole season episode by episode (`{ query: "South Park S18", quality?, exactQuality?, subs? }`), returns `{ id }` |
| `GET` | `/api/downloads/season/:id` | That job's progress: added, already here, not found |
| `GET` | `/api/torrents/search?q=&type=` | Torrent search (`type`: `movie`, `tv` or `all`) |
| `GET` | `/api/torrents/magnet?ref=` | Magnet link for a 1337x result |
| `GET` | `/api/torrents/recommend?title=&type=&year=&season=&quality=` | Recommended film or season pack; quality is `all` (Auto), `2160p`, `1080p` or `720p` |
| `GET` | `/api/convert` | Conversion progress |
| `GET` | `/api/subs/langs` | Subtitle languages for a file (`kind`, `id`) or title (`q`, `type`) |
| `POST` | `/api/subs/fetch` | Download subtitles (`{ kind, id, lang }`) |
| `GET` | `/api/subs/file/<kind>/<id>/<lang>.vtt` | Subtitles as WebVTT (`.srt` also available) |
| `GET` | `/api/subs/sync` | Timing check state for saved subtitles (`kind`, `id`, `lang`) |
| `POST` | `/api/subs/sync` | Fix, undo or shift subtitle timing (`{ kind, id, lang, action: 'sync' \| 'undo' \| 'shift', seconds }`) |
| `GET` | `/api/stream/<kind>/<id>` | Video stream with range support |
| `GET` | `/api/play-link?kind=&id=&variant=` | Signed `/play/` link (`variant`: `browser` or `tv`) |
| `GET` | `/play/...` | Video stream through a signed link; works without signing in |
| `GET` | `/api/cast/devices`, `/api/cast/sessions` | TVs and what's playing |
| `GET` | `/api/network` | Whether the request is from the home network, for troubleshooting |
| `POST` | `/api/cast/play` | Start playback on a TV |
| `GET` | `/api/house` | Server health and home machines (`ADMIN_EMAILS` only) |
| `POST` | `/api/house/report` | A machine's report (`X-Marquee-Token`, home network only) |
| `GET` | `/api/house/summary` | Issues, machines at home and the server's uptime, free space and services, for status bars and the MAGI panel (`X-Marquee-Token`, home network only) |
| `POST` | `/api/house/boot` | A dual-boot machine's boot menu and network card; the reply says whether to restart, and into what (`X-Marquee-Token`, home network only) |
| `POST` | `/api/house/power` | `{ host, action: "wake" \| "restart", entry? }`: wake a machine into a boot entry, or restart it (`ADMIN_EMAILS` only) |
| `GET` | `/api/clips` | Clips and their share state (`ADMIN_EMAILS` only) |
| `POST` | `/api/clips/<id>/rename` | Set a display name (`{ title, previousTitle? }`); keeps files and share links unchanged (`ADMIN_EMAILS` only) |
| `GET` | `/api/clips/<id>/thumb.jpg`, `/api/clips/<id>/video` | Thumbnail and video (`ADMIN_EMAILS` only) |
| `POST` | `/api/clips/<id>/share`, `/api/clips/<id>/unshare` | Create or remove a public link (`ADMIN_EMAILS` only) |
| `GET` | `/api/clips/<id>/keyframes` | Duration and keyframe times, for the trimmer (`ADMIN_EMAILS` only) |
| `POST` | `/api/clips/<id>/trim` | Lossless trim (`{ start, end, deleteOriginal? }`) into `Trimmed Clips/<Game>/` (`ADMIN_EMAILS` only) |
| `POST` | `/api/clips/<id>/delete` | Delete a clip: link and copies removed, file moved to `CLIPS_DIR/.deleted/` for 30 days (`ADMIN_EMAILS` only) |
| `GET` | `/api/access` | Who can sign in + invite links (`ADMIN_EMAILS` only) |
| `POST` | `/api/access/invite`, `/api/access/invite/<id>/revoke`, `/api/access/remove` | Make or cancel an invite, remove someone's access (`ADMIN_EMAILS` only) |
| `GET`, `POST` | `/c/i/<token>` | Public: the invite page and its email form |
| `GET` | `/c/`, `/c/<token>`, `/c/<token>/video.mp4`, `/c/<token>/thumb.jpg` | Public: invite card and shared clips, with OpenGraph tags for Discord |

## Security

Marquee has no user accounts or authentication. Anyone who can reach the server can browse, download and **delete** files. Run it only on a trusted home network and do not expose its port to the internet. For remote access, use a VPN such as WireGuard or Tailscale.

Keep `.env` private: it contains your API keys and passwords, and it is excluded by `.gitignore`.

`/c/` is public by design (see *Clips and Discord share links*): it serves only clips you shared, open invite links and the invite card, nothing else. An invite link lets whoever has it add one email to your access list, once; send it privately. House reports and boot checks need `HOUSE_TOKEN` and are refused when they arrive through Cloudflare. A boot check only ever restarts into an entry from the PC's own GRUB menu.

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
