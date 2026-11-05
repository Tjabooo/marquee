# Installing Marquee

Marquee is one Node.js process with no npm dependencies. This page covers what every installation
shares. The platform guides below cover only what differs.

> **Tested.** CI runs the test suite and a setup/start/stop smoke test on Ubuntu, Windows and macOS
> with Node.js 22.16 and 24, and builds and starts the Docker image. Windows 11 is the main
> production host. The NAS, Raspberry Pi, Proxmox and WSL2 guides follow those platforms' standard
> Docker and Linux procedures and haven't been verified on that hardware.

## Platform guides

| Platform | Guide | Usual method |
| --- | --- | --- |
| Windows 10/11 | [windows.md](windows.md) | Installer, Task Scheduler |
| Debian, Ubuntu | [debian-ubuntu.md](debian-ubuntu.md) | Installer, systemd |
| Fedora | [fedora.md](fedora.md) | Installer, systemd |
| Arch Linux | [arch.md](arch.md) | Installer, systemd |
| macOS | [macos.md](macos.md) | Installer, launchd |
| Raspberry Pi 4/5 | [raspberry-pi.md](raspberry-pi.md) | Installer or Docker |
| Docker, Docker Compose | [docker.md](docker.md) | Compose |
| Unraid | [unraid.md](unraid.md) | Docker |
| Synology DSM | [synology.md](synology.md) | Container Manager |
| TrueNAS SCALE | [truenas.md](truenas.md) | Custom app (Docker) |
| Proxmox VE | [proxmox.md](proxmox.md) | LXC container or VM |
| WSL2 | [wsl2.md](wsl2.md) | Testing only |

## Requirements

| Component | Needed for | Notes |
| --- | --- | --- |
| Node.js **22.16 or later** | Everything | Marquee uses `node:sqlite` with FTS5. Node 22.13–22.15 have `node:sqlite` without FTS5 and are refused. No `npm install` is needed. |
| ffmpeg and ffprobe | Conversion, subtitle timing, previews, clips | Optional. Without them those features stay off. |
| qBittorrent (Web UI) | Downloads | Optional. Its Web UI defaults to port 8080, the same as Marquee: move it to 8081, the address setup suggests. |
| pyatv (`atvscript`) | Apple TV casting | Optional. `pipx install pyatv`, then pair once with `atvremote wizard`. DLNA casting needs nothing extra. |
| Tesseract | Notes image search (OCR) | Optional, Linux and macOS. Windows uses its built-in OCR. |

`node setup.js` detects what is missing and offers the install command for your package manager.
It never installs anything or uses sudo without asking.

## Install methods

All four end with the same folder layout and the same `node setup.js`.

### A. Installer script (recommended)

Linux and macOS (installs to `~/marquee`):

```sh
curl -fsSL https://raw.githubusercontent.com/Tjabooo/marquee/v1.1.0/install.sh -o install.sh
less install.sh
sh install.sh
```

| Option | Effect |
| --- | --- |
| `--version v1.1.0` | Install this release instead of the latest |
| `--dir /opt/marquee` | Install somewhere other than `~/marquee` (or set `MARQUEE_DIR`) |
| `--dry-run` | Show what would happen; change nothing |
| `--no-setup` | Don't run `node setup.js` afterwards |
| `--yes` | Run setup unattended (`node setup.js --yes`) |
| `--uninstall [--purge]` | See [Uninstalling](#uninstalling) |

The script downloads `marquee-<version>.tar.gz` and `SHA256SUMS` from the GitHub release, refuses to
install on a checksum mismatch, checks build provenance with `gh attestation verify` when `gh` is
installed, unpacks the archive and runs `node setup.js`. It never uses sudo.

Windows: see [windows.md](windows.md). `install.ps1` takes the same options as `-Version`, `-Dir`,
`-DryRun`, `-NoSetup`, `-Yes`, `-Uninstall` and `-Purge`.

### B. Release archive by hand

```sh
curl -fsSLO https://github.com/Tjabooo/marquee/releases/download/v1.1.0/marquee-v1.1.0.tar.gz
curl -fsSLO https://github.com/Tjabooo/marquee/releases/download/v1.1.0/SHA256SUMS
sha256sum -c SHA256SUMS            # macOS: shasum -a 256 -c SHA256SUMS
gh attestation verify marquee-v1.1.0.tar.gz --repo Tjabooo/marquee   # optional
mkdir -p ~/marquee
tar -xzf marquee-v1.1.0.tar.gz -C ~/marquee --strip-components=1
cd ~/marquee && node setup.js
```

### C. Git clone

```sh
git clone https://github.com/Tjabooo/marquee.git ~/marquee
cd ~/marquee
git checkout v1.1.0
node setup.js
```

`.env`, the database and other state are ignored by git. The installer script refuses to update a git
checkout; update it with git (see [Updating](#updating)).

### D. Docker

`ghcr.io/tjabooo/marquee:1.1.0` for `linux/amd64` and `linux/arm64`, with ffmpeg and Tesseract
included. See [docker.md](docker.md).

## First run

`node setup.js` asks for:

- the media folder (`MEDIA_DIR`), created if it doesn't exist;
- on a fresh install, an optional separate data folder (`DATA_DIR`; blank keeps state in the Marquee folder);
- the port (default `8080`) and who can connect (`HOST=0.0.0.0`, your home network, or `127.0.0.1`,
  this computer only, for use behind a local proxy or tunnel);
- optional TMDB, qBittorrent and OpenSubtitles credentials;
- remote access (none, Tailscale, Cloudflare Tunnel and Access, or your own proxy);
- whether to install missing tools and register autostart.

It writes `.env` (keeping a previous copy in `.env.bak`), generates `HOUSE_TOKEN` and
`SCREENTIME_TOKEN`, and ends with the address to open, for example `http://192.168.1.20:8080`.
It is safe to run again at any time: existing values, comments and unknown keys are kept.
Every setting is described in [../configuration.md](../configuration.md).

Open the address from a phone or browser on the same network. Visits through the local address share
one "Home network" account; personal accounts come with Cloudflare Access
([../remote-access.md](../remote-access.md)).

Check an installation at any time with `node setup.js doctor` (add `--offline` to skip network checks
of integrations).

### Unattended setup

`--yes` accepts defaults and detected values. It never says yes to a consent question by itself:
installing packages, using sudo, registering a service and changing qBittorrent's save path each need
their own flag.

```sh
node setup.js --yes --allow-install --allow-sudo     # defaults, and install missing ffmpeg/Tesseract
node setup.js --config answers.json --allow-service --allow-sudo
node setup.js --dry-run                              # show what would change
```

`--yes` alone never registers autostart; add `--allow-service` (and `--allow-sudo` for a system service), or use `--config` with `"autostart": true`. The answers file
holds `.env` keys plus `autostart`, `install`, `serviceScope`, `qbitSavePath` and `remoteAccess`:

```json
{
  "MEDIA_DIR": "/srv/media",
  "PORT": "8080",
  "HOST": "0.0.0.0",
  "TMDB_TOKEN": "...",
  "install": ["ffmpeg"],
  "autostart": true,
  "serviceScope": "system"
}
```

`install` needs `--allow-install` (and `--allow-sudo` for system package managers), `autostart` needs
`--allow-service` (and `--allow-sudo` for a system-wide service unless you are root), and
`"qbitSavePath": true` needs `--allow-qbit-config`.

## Autostart

Choose autostart during setup, or later:

```sh
node setup.js service install      # also: status, restart, uninstall
node setup.js service install --scope user      # systemd only: user or system
```

| Platform | Mechanism | Runs |
| --- | --- | --- |
| Windows | Task Scheduler: task `Marquee` (runs `start-marquee.cmd` as your account, not elevated; restarts it within 2 minutes if it stops) | At boot, before sign-in |
| Linux, systemd, system scope | `/etc/systemd/system/marquee.service`, running as your user, with `RequiresMountsFor=` on the media and data folders | At boot |
| Linux, systemd, user scope | `~/.config/systemd/user/marquee.service` plus `loginctl enable-linger` | At boot |
| Linux, OpenRC (Alpine and others) | `/etc/init.d/marquee`, added to the `default` runlevel | At boot |
| macOS | LaunchAgent `io.github.tjabooo.marquee` in `~/Library/LaunchAgents` | While you are logged in |
| Docker | `restart: unless-stopped` | With the Docker daemon |

On systemd the default scope is `user` when setup runs as a normal user in a login session
(`XDG_SESSION_TYPE` is set, as it is for most desktop and SSH logins), and `system` when it runs as
root or outside a login session. On a server, pass `--scope system`: a system unit waits for the
media and data mounts. A user unit relies on `loginctl enable-linger` to run without a login. The
`status`, `restart` and `uninstall` actions pick the scope the same way, so pass the `--scope` you
installed with, for example `node setup.js service restart --scope system`.

Re-running `service install` replaces the existing registration; it never creates a second one.
The service records the full path of the Node.js binary that ran setup and, for systemd system
units, the media and data folders. Run `node setup.js service install` again after upgrading Node.js
to a different path (nvm, Homebrew) or after changing `MEDIA_DIR` or `DATA_DIR`.

Without autostart, start Marquee from its folder with `npm start` (or `node server.js`) and stop it
with Ctrl+C.

Logs: `journalctl -u marquee` (system unit) or `journalctl --user -u marquee` (user unit) on systemd;
`logs/marquee.log` in the Marquee folder on Windows, macOS and OpenRC; `docker compose logs marquee`
in Docker.

## Updating

Back up first: `node setup.js backup` (see [../upgrading-and-backups.md](../upgrading-and-backups.md)).

| Installed with | Update |
| --- | --- |
| Installer script | Run it again (`sh install.sh`, optionally `--version vX.Y.Z`), then `node setup.js service restart` |
| Release archive | Prefer the installer script; it does the same with a rollback copy |
| Git | `git fetch --tags && git checkout vX.Y.Z`, then `node setup.js service restart` |
| Docker | Change the image tag, then `docker compose pull && docker compose up -d` ([docker.md](docker.md#6-update)) |

On systemd, add the `--scope` you installed with to `service restart`. The installer replaces
application files only. `.env`, the database, state files and `cache/` are
never touched, and the previous version is kept in `.backup-<version>/` until you delete it.

## Uninstalling

```sh
sh install.sh --uninstall           # add --dir if you installed elsewhere
```

This removes the autostart service and the application files and keeps `.env`, the database,
state files and `cache/`. With a systemd system unit, run
`node setup.js service uninstall --scope system` first, because the installer calls
`service uninstall` without a scope. `--uninstall --purge` deletes the whole Marquee folder after you
type its path to confirm. Media folders outside it are never touched. On Windows use `install.ps1 -Uninstall` from an
elevated PowerShell. For a git checkout, run `node setup.js service uninstall` and delete the folder.

## Where data lives

| What | Where |
| --- | --- |
| Settings (`.env`) | The Marquee folder, or the file in `MARQUEE_ENV_FILE` |
| Database (`.marquee.db`), state files (`.marquee-*.json`, `.marquee-secret`) | `DATA_DIR`; default the Marquee folder |
| Notes attachments | `.marquee-notes-files/` in `DATA_DIR`, or `NOTES_FILES_DIR` |
| Browser copies, audio fixes and other cache | `cache/` in `DATA_DIR` |
| Backups from `node setup.js backup` | `backups/marquee-<time>/` in `DATA_DIR`, or `--to DIR` |
| Your films and shows | `MEDIA_DIR` |

Backups don't include `.env` because it holds passwords; copy it separately. To move state out of
the application folder, stop Marquee and run `node setup.js migrate-data --to DIR`.

## Network exposure

The default `HOST=0.0.0.0` makes Marquee reachable from your home network. **Never forward
Marquee's port on your router.** For access from outside, use one of the methods in
[../remote-access.md](../remote-access.md).

## More

- [../configuration.md](../configuration.md): every setting
- [../hardware-acceleration.md](../hardware-acceleration.md): NVENC and CPU encoding
- [../upgrading-and-backups.md](../upgrading-and-backups.md): updates, backups and restores
- [../troubleshooting.md](../troubleshooting.md): common problems
- [../remote-access.md](../remote-access.md): Tailscale, Cloudflare Tunnel and Access, reverse proxies
