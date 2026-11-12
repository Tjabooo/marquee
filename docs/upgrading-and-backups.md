# Upgrading and backups

## What Lilin keeps

Everything Lilin needs to remember is in `DATA_DIR` (the Lilin folder unless you set it) and in `.env`:

| Path | What it is | Back it up? |
| --- | --- | --- |
| `.env` | Settings, API keys, passwords | Yes, privately |
| `.lilin.db` (+ `-wal`, `-shm` while running) | SQLite: accounts, libraries, watch progress, Notes | Yes, with `setup.js backup` |
| `.lilin-secret` | Key that signs stream links | Yes |
| `.lilin-*.json`, `.lilin-activity.jsonl` | Show/episode caches, invites, shares, subtitle and conversion registries, activity log | Yes |
| `.lilin-notes-files/` or `NOTES_FILES_DIR` | Notes attachments | Yes |
| `.lilin-notes-imports/` | Files from Discord imports | Yes |
| `.lilin-avatars/` | Profile pictures (256 px squares) | Yes |
| `cache/` | Audio-fixed and browser copies, previews, clip shares | No: rebuilt on demand (it can be large) |
| `logs/` | Windows launcher log | No |
| `MEDIA_DIR`, `CLIPS_DIR` | Your media | Your usual media backup |

## Backing up

```sh
node setup.js backup                      # into <DATA_DIR>/backups/lilin-<date>
node setup.js backup --to /mnt/backup/lilin-2026-11-05
```

The database is copied with SQLite's `VACUUM INTO`, which gives a consistent copy while Lilin is
running; copying `.lilin.db` by hand while it runs can produce a copy that doesn't match its
`-wal` file. The JSON state files and Notes attachments are copied alongside. `.env` is not included
because it holds secrets; copy it separately to somewhere private.

Docker: `docker compose exec lilin node setup.js backup --to /data/backups/now`, then copy
`./data/backups/now` off the host.

To back up by hand instead, stop Lilin first, then copy `.lilin.db*` together with the rest of
the table above.

## Restoring

1. Stop Lilin (`node setup.js service status` shows how it runs).
2. Copy the backup's files into `DATA_DIR` (the backup folder's layout matches it), and your `.env`
   into the Lilin folder. Remove any stale `.lilin.db-wal`/`-shm` left in `DATA_DIR`.
3. Start Lilin and run `node setup.js doctor`. Sign in and check your library and Continue
   watching.

## Upgrading

Read the [changelog](../CHANGELOG.md) first; it lists anything you need to do. Back up before
upgrading between minor versions.

| Installed with | Upgrade |
| --- | --- |
| `install.sh` / `install.ps1` | Run it again (optionally `--version vX.Y.Z`). Application files are replaced; `.env` and state are left alone; the previous version is kept in `.backup-<version>/`. Then `node setup.js service restart`. |
| git clone | `git pull --ff-only` (or `git fetch --tags && git checkout vX.Y.Z`), then `node setup.js service restart`. |
| Docker Compose | `docker compose pull && docker compose up -d`. Pin `LILIN_VERSION` to control when. |

After upgrading, `node setup.js` is safe to run again: it keeps your settings and only adds new ones.

### Upgrading from 1.1 to 1.2 (sign-in)

- **Windows:** run `node setup.js service install` (or `scripts\windows\install-service.ps1`) once
  in an elevated PowerShell. It removes the old `Lilin Watchdog` task, which ran a script from the
  Lilin folder as SYSTEM, and limits write access to the folder. Until then `node setup.js doctor`
  reports it as a problem. To remove just the old task: `Unregister-ScheduledTask "Lilin Watchdog"`.
- Visitors arriving through a proxy or tunnel **without** an identity (for example cloudflared
  without an Access application) now get the sign-in page instead of the Home network account.
  Cloudflare Access setups are unaffected. Create Lilin sign-ins with `node setup.js user add`.
- If you open Lilin by a host name that isn't an IP address, a single word, `.local`/`.lan`/
  `.home.arpa`/`.internal`/`.ts.net` or `PUBLIC_URL`'s host, add it to `ALLOWED_HOSTS`.

### Rolling back

- Installer: stop Lilin, move the current application files aside and move the contents of
  `.backup-<previous version>/` back, then start it.
- git: `git checkout v<previous>` and restart.
- Docker: set `LILIN_VERSION` to the previous version and `docker compose up -d`.

If the newer version changed the database, restore the backup you made before upgrading as well.

## Upgrading to 1.1 from 1.0

- **Node.js 22.16 or later** is required (Notes search needs SQLite FTS5, which earlier 22.x builds lack).
- **Server code moved to `src/`.** `node server.js` and `npm start` work as before. On Windows,
  `start-lilin.cmd` stays where it was, so the existing scheduled task keeps working; the other
  scripts moved to `scripts\windows\` (`restart-lilin.ps1`, `install-service.ps1`, formerly
  `setup-autostart.ps1`). Re-run `scripts\windows\install-service.ps1` once (from 1.2 it also removes the old SYSTEM watchdog task).
- **Identity headers are only trusted from `TRUSTED_PROXIES`** (default: this machine). If
  cloudflared or your proxy runs on another machine, set `TRUSTED_PROXIES` or the Access token
  settings before upgrading, or everyone will appear as the Home network account. See
  [remote-access.md](remote-access.md#how-accounts-work).
- State stays where it is. `DATA_DIR` is new and optional; to move state to another folder later,
  stop Lilin and run `node setup.js migrate-data --to <folder>`.
