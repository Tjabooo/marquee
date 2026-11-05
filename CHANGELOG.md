# Changelog

All notable changes to Marquee. Versions follow [Semantic Versioning](https://semver.org).

## [Unreleased]

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
