# Configuration

Marquee reads its settings from `.env` in the Marquee folder. `node setup.js` creates and edits that
file for you; you can also edit it by hand. Restart Marquee after a change. Variables set in the real
environment (Docker, systemd, CI) override `.env`.

Every setting is optional. A feature whose settings are blank is off, and Marquee says so at startup.
`node setup.js doctor` checks the whole file.

Settings marked 🔒 are secrets: keep `.env` readable only by the account that runs Marquee
(`setup.js` creates it with mode `600` on Linux and macOS) and never commit it.

## Server

| Setting | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8080` | Port for the web app. |
| `HOST` | `0.0.0.0` | Address to listen on. `0.0.0.0` serves your home network; `127.0.0.1` only this computer, for use behind a reverse proxy or tunnel on the same machine. |
| `SERVER_IP` | detected | LAN address TVs stream from. Set it if the address printed at startup is wrong (several network cards, VPN). |
| `PUBLIC_URL` | from the request | Public address used in share links and link previews, e.g. `https://marquee.example.com`. |
| `DATA_DIR` | the Marquee folder | Where the database, state files, Notes attachments and `cache/` live. Marquee refuses to start if `DATA_DIR` points at an empty folder while the Marquee folder still has a database; move it with `node setup.js migrate-data --to <folder>`. |
| `CACHE_DIR` | `cache` in `DATA_DIR` | Where copies Marquee can always make again are kept: browser copies, timeline previews, share copies. They can take hundreds of GB, so put this on a big drive rather than a small system disk. To move it, stop Marquee and move the folder's contents. |
| `STREAM_SECRET` 🔒 | generated | Key that signs stream links. Blank: generated once and stored in `.marquee-secret`. Changing it invalidates links that are already open on TVs. |
| `MARQUEE_ENV_FILE` | `.env` in the Marquee folder | Environment only (not read from `.env`): load settings from another file. |

## Accounts and remote access

See [remote-access.md](remote-access.md) for how accounts work and how to publish Marquee safely.

| Setting | Default | Purpose |
| --- | --- | --- |
| `ADMIN_EMAILS` | | Owner accounts, as they sign in (Marquee's own sign-in or Cloudflare Access), comma-separated. The first is the owner: files added outside Marquee go to their library. Owners see Activity, House, Clips, Notes and the server settings. |
| `HOME_NETWORK_ACCESS` | `shared` | `shared`: visitors directly on the home network (private, loopback and Tailscale addresses) use the shared Home network account without signing in. `signin`: everyone signs in. Visitors from the internet must sign in either way. |
| `SESSION_DAYS` | `30` | How long a Marquee sign-in lasts unused. Renewed while in use, never longer than a year from signing in. |
| `ALLOWED_HOSTS` | | Extra host names Marquee answers to, comma-separated (`*.example.com` allowed). IP addresses, `localhost`, single-label names, home-network suffixes (`.local`, `.lan`, `.home.arpa`, `.internal`, `.ts.net`) and `PUBLIC_URL`'s host always work; any other name is refused (DNS-rebinding protection). |
| `TRUSTED_PROXIES` | `127.0.0.1,::1` | Addresses or CIDR ranges whose identity headers (`Cf-Access-Authenticated-User-Email`, `Cf-Connecting-IP`, `X-Forwarded-*`) are believed. Headers from anywhere else are removed. Set it to the address of a proxy on another machine; an empty value trusts nobody. |
| `CF_ACCESS_TEAM_DOMAIN` | | Your Cloudflare Access team domain, e.g. `myteam.cloudflareaccess.com`. With `CF_ACCESS_AUD`, Marquee verifies each request's Access token and takes the account from it, wherever the connection comes from. |
| `CF_ACCESS_AUD` 🔒 | | The Access application's Audience (AUD) tag. |

## Metadata

| Setting | Default | Purpose |
| --- | --- | --- |
| `TMDB_TOKEN` 🔒 | | TMDB "API Read Access Token" (themoviedb.org → Settings → API). Enables Discover, search, posters and episode details. |
| `TMDB_API_KEY` 🔒 | | The short TMDB v3 key; used when `TMDB_TOKEN` is blank. |
| `TMDB_LANG` | `en-US` | Language for titles, and for descriptions when the viewer's language has none. People who use Marquee in Swedish get TMDB's Swedish descriptions and genre names on top of this. |

## Library

| Setting | Default | Purpose |
| --- | --- | --- |
| `MEDIA_DIR` | | Folder with films and shows. Marquee needs read access to play and write access to convert, fetch subtitles, download and delete. Put qBittorrent's save path inside it. |

## qBittorrent

| Setting | Default | Purpose |
| --- | --- | --- |
| `QBIT_URL` | | qBittorrent Web UI address, e.g. `http://localhost:8081`. Enables downloads. |
| `QBIT_USER` | | Web UI user. |
| `QBIT_PASS` 🔒 | | Web UI password. |
| `QBIT_REMOVE_FINISHED` | `on` | Remove finished torrents from qBittorrent (files are kept) so nothing seeds. Tag a torrent `seed` to keep it. |

## Torrent search

| Setting | Default | Purpose |
| --- | --- | --- |
| `TORRENTS` | `on` | `off` hides torrent search. |
| `CONTENT_FILTER` | `on` | Keeps adult content off the server: porn is left out of torrent search, adult release names, `.torrent` files and TMDB titles are refused before they reach qBittorrent, and a download whose files turn out to be adult is removed with its files (logged under What happened). `members` exempts the owner, `off` turns it off. |
| `CONTENT_FILTER_WORDS` | | Extra words or phrases the filter blocks, comma-separated. |
| `TPB_API` | `https://apibay.org` | The Pirate Bay API base. |
| `X1337_URL` | built-in list | 1337x mirrors, comma-separated, tried in order. |
| `NYAA_URL` | `https://nyaa.si` | Nyaa, searched alongside the others for anime. `off` leaves it out. |
| `KNABEN_URL` | `https://api.knaben.org/v1` | Knaben, an index over many torrent sites with live seeder counts, searched alongside the others. The best at Swedish and documentary releases. `off` leaves it out. |
| `SVT_PLAY` | on | SVT Play in Discover → Documentaries, search and as a source when no torrent can be found. Works only from a Swedish address. `off` leaves it out. See [Integrations](integrations.md#svt-play). |
| `ANILIST_URL` | `https://graphql.anilist.co` | AniList API: anime names and how their seasons line up with TMDB's. |
| `FLARESOLVERR_URL` | | FlareSolverr address, e.g. `http://localhost:8191`, for when every 1337x mirror is behind a Cloudflare check. |

## Subtitles

| Setting | Default | Purpose |
| --- | --- | --- |
| `OPENSUBTITLES_API_KEY` 🔒 | | OpenSubtitles API key (opensubtitles.com → Profile → API consumers). Enables subtitle downloads. |
| `OPENSUBTITLES_USER` | | Optional account; raises the daily download limit. |
| `OPENSUBTITLES_PASS` 🔒 | | Its password. |
| `SUB_LANGS` | `en,sv,da,no,fi,de,nl,fr,es,pt-pt,pt-br,it,pl,ar,tr,ka,tl` | Languages offered, in order. |
| `SUBSYNC` | `on` | Fix the timing of downloaded subtitles automatically (needs ffmpeg). |
| `SUBTITLE_FIX` | `on` | Fix OCR mistakes in English subtitles as they're served: lowercase names and acronyms ("cuddy", "nicu"), I/l mix-ups ("l'm", "wiIl", "ls") and lowercase sentence starts. Learns how names are written from the library's other English subtitles (kept in `CACHE_DIR/subtitle-words.json`, refreshed daily). Files on disk are never changed. `off` serves them as they are. |

## Casting

| Setting | Default | Purpose |
| --- | --- | --- |
| `DLNA_DEVICES` | | DLNA description URLs for TVs that aren't discovered, comma-separated. |
| `CAST_APPLETV` | `on` | Apple TV support (needs pyatv). |
| `ATVSCRIPT` | `atvscript` on PATH | Full path to pyatv's `atvscript`. |
| `ATV_HOSTS` | | Apple TV addresses to query directly if discovery fails, comma-separated. |
| `CAST_WHEN_AWAY` | `off` | Offer TVs to visitors who aren't on the home network. |

## Playback first

Streams always come before background work. These are the knobs; the defaults suit a media drive
that is a hard disk shared with downloads and conversions.

| Setting | Default | Purpose |
| --- | --- | --- |
| `STREAM_READ_KB` | `4096` | How much of a file a stream reads at a time (64–65536). Large reads keep a busy hard drive from making a player wait in its queue once per 64 KB. |
| `PHONE_STREAMS_MAX` | `3` | Phone-quality streams (a live 1080p or 720p version of a big file, for phones) that may run at once. Each uses one GPU encoder session; a new one stops the one idle longest. |
| `MARQUEE_PRIORITY` | `above_normal` | CPU priority of the Marquee process: `above_normal`, `normal` or `high`. On Windows its I/O and memory priority are always set to normal, also when it runs as a scheduled task (whose default is low I/O priority, which made streams stall behind downloads). |
| `BACKGROUND_PRIORITY` | `below_normal` | CPU priority of background jobs (conversions, browser copies, timeline previews, credits, subtitle sync, clip and note copies, OCR): `below_normal`, `idle` or `normal`. |
| `BACKGROUND_IO` | `normal` | Windows: I/O and memory priority of those jobs: `normal`, `low` or `very_low`. `low` makes their disk reads wait for a stream's and their cached pages leave RAM first, but slows a conversion 3–4x while anyone watches; try it only if streams still stall during background work. |
| `QBIT_PLAYBACK_LIMITS` | `on` | While anyone is streaming, switch qBittorrent to its alternative speed limits (set them in qBittorrent: Options → Speed). Marquee turns them off again afterwards, unless they were already on. |
| `PLAYBACK_IDLE_SECONDS` | `60` | How long after the last stream downloads go back to full speed. |

## Conversion

| Setting | Default | Purpose |
| --- | --- | --- |
| `CONVERT` | `on` | Make MP4 copies of MKV, AVI, WebM and similar files so they play on iPhone and Apple TV (needs ffmpeg). |
| `CONVERT_DELETE_ORIGINAL` | `off` | Delete originals after conversion, including ones converted while qBittorrent still had them once it no longer does. Never applies to files qBittorrent owns. All subtitle tracks are first copied unchanged into `<name>.subtitles.mks` (MP4 can't hold Blu-ray/DVD image subtitles); if that fails, or the MP4 copy's length doesn't match, the original is kept. |
| `BROWSER_H264_DAYS` | `14` | HEVC files added within this many days get an H.264 copy for browsers without HEVC right away; older ones when first played. `0` = off. |
| `PREPARE_NEXT_EPISODES` | `2` | Browser copies prepared ahead for the next episodes. `0` = off. |
| `FFMPEG`, `FFPROBE` | on PATH | Full paths to ffmpeg and ffprobe. |
| `AUDIO_FIX_DIR` | `audio` in `CACHE_DIR` | Where browser copies (audio-fixed and H.264) are kept. |
| `BROWSER_COPIES_MAX_GB` | `150` | Size cap for browser copies. When a new one needs room, the ones watched longest ago are deleted (none watched in the last 3 hours). Copies made in the background never push others out; they wait. `0` = no cap. |
| `MIN_FREE_GB` | `20` | Free space conversions leave on every drive they write to. Browser copies on that drive are deleted first if that helps; otherwise the conversion waits. `0` = off. |

Video is encoded with NVIDIA NVENC when ffmpeg has a working `h264_nvenc`, otherwise with libx264 on
the CPU. See [hardware-acceleration.md](hardware-acceleration.md).

## Download to phone

| Setting | Default | Purpose |
| --- | --- | --- |
| `TRAVEL_DIR` | `travel` in `CACHE_DIR` | Where phone copies (Small 480p and Standard 720p MP4s) are kept. |
| `TRAVEL_KEEP_DAYS` | `7` | A phone copy is deleted this many days after anyone last asked for or downloaded it. |
| `TRAVEL_MAX_GB` | `50` | Size cap for phone copies. When a new one doesn't fit, copies everyone has already downloaded go first, oldest first. |

## Notes

| Setting | Default | Purpose |
| --- | --- | --- |
| `NOTES_FILES_DIR` | `.marquee-notes-files` in `DATA_DIR` | Where Notes attachments are stored. Copy existing files before changing it. |
| `NOTES_OCR` | on | Text in Notes images becomes searchable: Windows OCR on Windows, Tesseract elsewhere when installed. `off` disables it. |
| `TESSERACT` | `tesseract` on PATH | Full path to Tesseract. |

## House

| Setting | Default | Purpose |
| --- | --- | --- |
| `HOUSE_TOKEN` 🔒 | generated by setup | Shared secret for `agents/marquee-house` on your Linux machines. Reports are only accepted from the home network. |
| `SCREENTIME_TOKEN` 🔒 | generated by setup | Bearer token for `POST /api/screentime` from the [screentime](https://github.com/Tjabooo/screentime) daemon. |
| `ADGUARD_URL` | | AdGuard Home web UI, e.g. `http://localhost:3000`. |
| `ADGUARD_USER` | | AdGuard Home user. |
| `ADGUARD_PASS` 🔒 | | AdGuard Home password. |
| `WOL_BROADCAST` | | Extra Wake-on-LAN broadcast addresses, comma-separated. |
| `UPLOAD_MBPS` | | Your internet upload speed in Mbit/s, for the Sharing meter. |
| `NVENC_SESSION_LIMIT` | `8` | Hardware encodes the GPU runs at once. |
| `LOAD_SAMPLER` | on (Windows) | `off` stops sampling Windows performance counters and `nvidia-smi` every 5 seconds. Not available on other systems. |
| `NVIDIA_SMI` | `nvidia-smi` on PATH | Full path to `nvidia-smi`. |
| `TORRENT_VPN_STATUS` | `%ProgramData%\TorrentVpn-Status\status.json` on Windows | Status file written by [tools/torrent-vpn](../tools/torrent-vpn/README.md). |

## Clips

| Setting | Default | Purpose |
| --- | --- | --- |
| `CLIPS_DIR` | | Folder game clips are synced to (`Kept/<game>/`, `Trimmed Clips/`). Blank hides the Clips tab. |

## Invites

Invites add people to the email list your Cloudflare Access policy allows. See
[remote-access.md](remote-access.md#invites).

| Setting | Default | Purpose |
| --- | --- | --- |
| `CF_API_TOKEN` 🔒 | | Cloudflare API token with "Zero Trust: Edit" on the account. |
| `CF_ACCOUNT_ID` | | Cloudflare account ID. |
| `CF_ACCESS_LIST_ID` | | ID of the email list (Zero Trust → Reusable components → Lists). |
| `INVITE_DAYS` | `7` | How long an invite link stays valid. |
