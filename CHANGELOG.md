# Changelog

All notable changes to Marquee. Versions follow [Semantic Versioning](https://semver.org).

## [Unreleased]

### Added

- **Update notifications.** Each new update in `whats-new.json` is pushed once to everyone who hasn't read it, with
  its title, a short summary and "Tap to read more", which opens its notes (`/?update=<id>`). New setting
  **Settings → Notifications → Marquee updates** (`pushUpdate`, on by default). Only updates dated today or yesterday
  go out, after the file has been unchanged for 90 s; sent ids are kept in `DATA_DIR/.marquee-update-pushes.json`.

### Changed

- **Skip intro finds titles after very long cold opens.** When the first eight minutes hold no shared theme song, the search reaches fifteen minutes, and both neighbouring episodes must agree on what it finds. Results from the normal search are unchanged.
- **Play now stutters less.** It starts with up to 45 s in order when the download brings that within 20 s of the old minimum of 20 s.
  In hls.js browsers a stall now holds the picture until a useful amount is buffered (8, then 16, then 32 s when stalls repeat) instead of
  stopping after every 4 s piece. Episodes in season packs now really download in order: top file priority, which libtorrent
  fetches rarest-first even in sequential mode, is used only when many earlier files are missing. HDR streams decode on the GPU
  (13 % faster). The server log says how often a Play now stream had to wait for the download.

### Added

- **Watch Together on Play now.** A room can be started on a video that is still downloading; guests need no access to the
  download, the room is their access. The server holds the room until the download is far enough ahead (30 s that it
  keeps, or a lead that lets the rest arrive in time, or 5 minutes buffered) and stops it at 8 s left, so nobody's player
  runs dry mid-scene; the room says it's waiting for the download, with an estimate. When the download finishes, the host's
  Switch now moves everyone to the library file from the same spot; a room whose download has left qBittorrent moves by
  itself. In a room, Play now's own stall hold and buffering popup stay out of the way.

- **Preview switch (`PREVIEW_DIR`).** Point it at a second `public/` folder (for example a worktree of a redesign
  branch) and `/preview` switches one browser to it, with the live API, sign-in and permissions; `/preview/off`
  switches back. Missing files fall back to `public/`, the path guard is the same, preview pages get their own build
  id (so they offer a reload when the preview is updated) and `/api/status` says `preview: true`. Server-drawn pages
  (sign-in, share pages) get the preview's `pages.css`. Off by default; see docs/configuration.md.
- **Title page data.** `GET /api/title/:type/:id/page` (TMDB logo art, tagline, runtime, genres, age rating, cast
  with photos, recommendations; one cached TMDB call) and `GET /api/tv/:id/season/:n` (episode descriptions,
  running times, air dates and stills). Not used by the current web app yet.
- **`GET /api/art?path=/t/p/w300/…`.** Small TMDB pictures through the server (TMDB's host and sizes up to w300 only, kept in
  memory for a day), so the web app can read their colours: TMDB's CDN sometimes serves a copy cached without CORS headers.

- **Play now.** Watch a film or episode while it downloads, in any browser and on iPhones, whatever its format. qBittorrent downloads
  it in order, and ffmpeg reads it through a loopback server that holds each read until those pieces are verified
  (`src/partial-stream.js`), making the usual live HLS stream of up to 1080p. A popup explains when the video stops to wait for the
  download, and another offers the full-quality file when it's finished. Subtitles, audio choices, casting and Watch Together
  wait for the finished file. Browsers without HLS use hls.js 1.7.4 (Apache-2.0), vendored in `public/vendor`.
  `PARTIAL_STREAMS=off` turns it off.
- **Documentaries.** A Documentaries tab in Discover and on the TV's home screen, with over 30 categories built from TMDB's genre,
  keyword and country filters (`src/documentaries.js`) and SVT Play's own.
- **SVT Play.** Its free catalogue in Documentaries and search; Add copies the streams into the library without re-encoding, with
  Swedish subtitles (`src/svtplay.js`, `src/svt-queue.js`). Smart Download uses it first for Swedish originals and otherwise when no
  torrent can be found. `SVT_PLAY=off` leaves it out.
- **Knaben as a torrent source** (`KNABEN_URL`), 1337x's Documentaries category for documentaries, and searches with å, ä and ö
  also try the plain spelling that release names use.

### Changed

- **Notifications stay with your library.** Someone else's download no longer notifies people who only follow a show;
  it reaches those with an episode of it in their library. Your own downloads and auto-downloads still notify you.
- **One TV app, in Swedish.** The Samsung TV Preview replaced the old TV app: `public/tv` and `tv/tizen` now hold it
  under the original package `MrqTvApp01.Marquee`, and `tv-preview`/`tizen-preview` are gone. It's in Swedish, with
  å, ä and ö on the on-screen keyboard. Remove an installed Marquee Preview with `tizen uninstall -p MrqTvPrv01.MarqueePreview`.

### Added

- **Downloads on the TV.** Titles on their way show in an On its way row in the TV library with live progress, and a
  Go to library button appears after adding a title. Smart-download messages and House warnings are translated too.
- **Languages.** Settings → Language switches all of Marquee between English and Svenska: the web app, player,
  What's new, server messages, notifications, sign-in and share pages. The choice follows the account across
  devices; a browser set to Swedish starts in Swedish. TMDB descriptions and genre names follow it, titles don't,
  because the library and release search go by them. Add a line in the code and tests/i18n.test.mjs asks for its
  Swedish (public/i18n-sv.js, src/i18n-sv.json, whats-new.sv.json).
- **Jellyfin.** The [Marquee plugin for Jellyfin](https://github.com/Tjabooo/jellyfin-plugin-marquee)
  shows someone's library in their own Jellyfin server. It pairs with a code entered under
  Settings → Jellyfin, reads `/c/jf/v1/library`, streams through per-video HMAC-signed links,
  copies saved subtitles and reports progress to Continue watching. Keys are stored hashed in
  `jellyfin_links` (`.marquee.db`); disconnecting there, removing the person, or from the plugin
  revokes the key and every link made with it. See docs/jellyfin.md.

- **Agents can ask for your attention.** `POST /api/agent/notify` (House token, home network only) sends the
  owner one notification; switch it off under Settings › Notifications › Agents.

### Changed

- **MarqueeSetup.exe installs the newest release.** It looks up the latest release on GitHub when it
  runs (and uses that release's `install.ps1`), so an older copy of the exe no longer installs an
  older Marquee. Offline, it falls back to the release it was built for.

### Fixed

- **Watch Together links for films open again.** The link page (`/c/w/…`) crashed with a server error for films, because the artwork lookup treated a film's missing episode still as text.

## [1.2.0] - 2026-11-05

### Security

- **Marquee's own sign-in.** Accounts are created on the server (`node setup.js user add EMAIL
  [--owner]`, also `passwd`, `remove`, `signout`, `list`); people sign in at `/signin` and can change
  their password or sign out in Settings. scrypt password hashes, random session tokens stored only
  as hashes, `HttpOnly; SameSite=Lax` cookies, per-account backoff and per-address lockout.
- **Visitors from the internet must sign in.** The shared Home network account is given only to
  visitors connecting directly from a private, loopback or Tailscale address, so a port forwarded by
  mistake (or a tunnel without Access) shows a sign-in page instead of the library.
  `HOME_NETWORK_ACCESS=signin` makes everyone sign in.
- **Unwanted requests are refused:** changes from other websites (CSRF, `Origin`/`Sec-Fetch-Site`),
  requests for unknown host names (DNS rebinding; `ALLOWED_HOSTS` adds names), and framing by other
  sites. Security headers on every response.
- **Windows autostart without SYSTEM.** The `Marquee Watchdog` task ran a script from the Marquee
  folder as SYSTEM, so anyone able to change that script could take over the PC. The `Marquee` task
  now restarts itself every 2 minutes as your account, without elevation; re-running
  `install-service.ps1` removes the old task and limits write access to the Marquee folder.
  `node setup.js doctor` warns about both.
- **Clipper is pinned.** `node setup.js clipper` installs one reviewed commit and checks its SHA-256
  tree hash before running anything, lists what Clipper installs, and no longer defaults to yes.
  The commands for another PC check the installer's checksum instead of piping `main` into a shell.

### Added

- **Windows setup wizard.** `MarqueeSetup.exe` (a release asset) is a normal Windows window that
  installs Node.js and Marquee, then walks through library, network, sign-in, services, game clips
  and start at boot, with folder pickers, a live port check and connection tests. The **Clipper
  add-on** page installs the pinned Clipper on this PC, or gives the command for another PC and can
  share the clips folder. It runs the same commands as the terminal setup (nothing of its own writes
  `.env`), adds **Marquee Setup** to the Start menu for later changes, and `node setup.js gui` opens
  it. New `node setup.js wizard info|check|clipper` print JSON for graphical front ends (read-only,
  secrets reported only as set or not); `install-service.ps1 -CredentialFile` takes the Windows
  password from the wizard (DPAPI-encrypted for your account, deleted once read).
- **Download to phone.** **To phone** on a film, a phone button on each episode and **Season to
  phone** make small offline copies: Small (480p) or Standard (720p) H.264/AAC MP4s with the saved
  subtitles as tracks and HDR tone-mapped to SDR, made one at a time (NVENC or x264), listed under
  **For your phone** in the Library and announced by notification when ready. **Full quality**
  downloads the file as it is. `TRAVEL_DIR`, `TRAVEL_KEEP_DAYS` (7), `TRAVEL_MAX_GB` (50).
- **Skip intro**: a button (or **S**) during an episode's opening titles, found from an
  Intro/Opening chapter or the theme song shared with neighbouring episodes of the season (audio
  fingerprint of the first eight minutes, cached with the credits). Settings → Watching → **Intros**
  can skip them automatically. `GET /api/media/<lib|dl>/<id>/intro`.
- **Notifications** through Web Push with no dependencies (`src/push.js`: VAPID ES256 signing and
  RFC 8291 aes128gcm encryption on `node:crypto`, checked against the RFC's test vector). Settings →
  Notifications turns them on per device and switches **downloads ready**, **new episodes** (a show
  you follow or have in your library got a new episode) and **Watch Together invites** (new **Invite** button in the
  room bar) on or off. A service worker (`public/sw.js`), web app manifest and icons; iPhone needs
  Marquee on the Home Screen. Keys and devices live in `.marquee-push.json`; endpoints must belong to
  a known push service.
- **Bedtime menu** in the player (moon button). **Night mode** (also **N**) evens out loud and
  quiet scenes and lifts voices through Web Audio; the **sleep timer** pauses after 15–90 minutes
  with a short fade, or at the end of the episode without starting the next one.
- **Subtitle look**: style (Box, Shadow, Outline) and height (Low, Mid, High) next to the size,
  and a **second subtitle language** shown above the first.
- **What's new**: after an update, everyone sees its notes once in a sheet (written in `whats-new.json`,
  newest first; items can be marked `"audience": "owner"`). Settings → What's new lists past updates,
  and a page left open through an update offers a reload. A **What's new** button in the header opens
  the full history any time and lights up while an update is unseen; older updates back to the first
  version are listed there too (`"announce": false` keeps an entry out of the popup).
- Stats for nerds in the player: press `I` (or right-click / long-press the picture) for a live
  panel with everything about the stream. From the server's ffprobe of the exact file being
  played: container, size, overall and per-stream bitrate, codec with profile and level, frame
  rate, pixel format, colour primaries/transfer/matrix/range, HDR10/HLG/Dolby Vision with mastering
  and light levels, every audio and subtitle stream, and the original release when a browser copy
  is playing (`GET /api/stream-info?src=`). From the browser: codec string and whether it decodes
  in hardware and smoothly, decoded and drawn size, presented frame rate and jitter, dropped
  frames, startup and seek times, stalls, buffer ahead and download rate with one-minute graphs,
  the active audio and subtitle choice, Watch Together clock and casting state. **Copy** puts the
  whole report on the clipboard.
- `node setup.js clipper`: sets up game clips in one go. It creates `CLIPS_DIR` (next to
  `MEDIA_DIR` by default) and either downloads and installs [Clipper](https://github.com/Tjabooo/clipper),
  the replay-buffer recorder, on this computer, or prints what to run on your gaming PC (Windows
  or Linux) with the share path, Marquee's address and the quality filled in, plus how to share
  the folder. Quality is a preset (`compact`, `balanced`, `high`, `max`, `smooth`) or
  `bench:quality|smooth|balanced|small`, which has Clipper measure the PC and pick.

## [1.1.0] - 2026-11-05

The first public release meant for installing on your own machine: a setup wizard, installers,
Docker images, autostart on every major platform, and a security fix for how accounts are identified.

### Security

- **Identity headers are no longer trusted from every client.** Earlier versions took the account
  from `Cf-Access-Authenticated-User-Email` on any request, so a device that could reach Marquee's
  port directly could act as any account, including the owner. Proxy and identity headers are now
  removed unless the connection comes from `TRUSTED_PROXIES` (default: this machine, where
  cloudflared or a local proxy connects from), or the request carries a Cloudflare Access token that
  Marquee verifies itself (`CF_ACCESS_TEAM_DOMAIN` + `CF_ACCESS_AUD`).

### Added

- `node setup.js`: interactive or unattended (`--yes`, `--config`) setup that detects the system,
  edits `.env` in place without losing comments or unknown keys, generates `HOUSE_TOKEN` and
  `SCREENTIME_TOKEN`, checks integrations, can install ffmpeg/Tesseract and set qBittorrent's save
  path, and registers autostart. Privileged or system-changing steps always ask first; unattended
  runs need explicit `--allow-*` flags. `--dry-run` shows changes without making them.
- `node setup.js doctor`: read-only health check of runtime, settings, data, disk space, ffmpeg
  (with real test encodes), OCR, Apple TV, port, autostart and integrations.
- `node setup.js backup` (consistent SQLite copy plus state) and `migrate-data` (move state to a new
  `DATA_DIR`, keeping the originals aside).
- `node setup.js service install|status|restart|uninstall` for Windows Task Scheduler, systemd (user
  or system; waits for network and the media mount), launchd and OpenRC.
- `install.sh` and `install.ps1`: install or update from a release archive verified against its
  SHA-256 checksum; updates replace application files only and keep the previous version.
- Docker image `ghcr.io/tjabooo/marquee` for linux/amd64 and linux/arm64 (non-root, healthcheck,
  ffmpeg and Tesseract included) and a Compose file with qBittorrent, VPN (Gluetun, fails closed) and
  FlareSolverr profiles, plus an NVIDIA override.
- `DATA_DIR`, `HOST`, `TRUSTED_PROXIES`, `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`, `TESSERACT` and
  `MARQUEE_ENV_FILE` settings; `GET /api/health`.
- Windows: a "Marquee Watchdog" task that starts Marquee if Windows skipped its boot trigger.
- Notes image search on Linux and macOS through Tesseract.
- Startup warnings for broken settings; clean shutdown on SIGTERM.
- Documentation: install guides per platform, configuration reference (checked against the code by
  a test), remote access, hardware acceleration, upgrading and backups, troubleshooting.
- CI on Ubuntu, Windows and macOS with Node.js 22.16 and 24, Docker build and Compose start-up; a
  release workflow with build provenance attestations.

### Changed

- **Node.js 22.16 or later is required.** Notes search uses SQLite FTS5, which `node:sqlite` in
  Node.js 22.13-22.15 lacks; 1.0 documented Node.js 20, which never worked.
- Server code moved into `src/`; `node server.js` still starts Marquee. Windows scripts moved to
  `scripts/windows/` (`setup-autostart.ps1` is now `install-service.ps1`); `start-marquee.cmd` stays
  at the root so existing scheduled tasks keep working.
- `.env.example` lists every setting with integrations off by default; the README is now a short
  landing page with details under `docs/`.

### Fixed

- Nine tests that no longer matched the app.

### Upgrading from 1.0

See [docs/upgrading-and-backups.md](docs/upgrading-and-backups.md#upgrading-to-11-from-10). If
cloudflared or your reverse proxy runs on a different machine than Marquee, set `TRUSTED_PROXIES` or
the Access token settings, or everyone will appear as the Home network account.

## [1.0.0]

Initial version, developed in the open on `master` without tagged releases.
