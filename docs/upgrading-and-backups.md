# Upgrading and backups

## What Marquee keeps

Everything Marquee needs to remember is in `DATA_DIR` (the Marquee folder unless you set it) and in `.env`:

| Path | What it is | Back it up? |
| --- | --- | --- |
| `.env` | Settings, API keys, passwords | Yes, privately |
| `.marquee.db` (+ `-wal`, `-shm` while running) | SQLite: accounts, libraries, watch progress, Notes | Yes, with `setup.js backup` |
| `.marquee-secret` | Key that signs stream links | Yes |
| `.marquee-*.json`, `.marquee-activity.jsonl` | Show/episode caches, invites, shares, subtitle and conversion registries, activity log | Yes |
| `.marquee-notes-files/` or `NOTES_FILES_DIR` | Notes attachments | Yes |
| `.marquee-notes-imports/` | Files from Discord imports | Yes |
| `cache/` | Audio-fixed and browser copies, previews, clip shares | No: rebuilt on demand (it can be large) |
| `logs/` | Windows launcher log | No |
| `MEDIA_DIR`, `CLIPS_DIR` | Your media | Your usual media backup |

## Backing up

```sh
node setup.js backup                      # into <DATA_DIR>/backups/marquee-<date>
node setup.js backup --to /mnt/backup/marquee-2026-11-05
```

The database is copied with SQLite's `VACUUM INTO`, which gives a consistent copy while Marquee is
running; copying `.marquee.db` by hand while it runs can produce a copy that doesn't match its
`-wal` file. The JSON state files and Notes attachments are copied alongside. `.env` is not included
because it holds secrets; copy it separately to somewhere private.

Docker: `docker compose exec marquee node setup.js backup --to /data/backups/now`, then copy
`./data/backups/now` off the host.

To back up by hand instead, stop Marquee first, then copy `.marquee.db*` together with the rest of
the table above.

## Restoring

1. Stop Marquee (`node setup.js service status` shows how it runs).
2. Copy the backup's files into `DATA_DIR` (the backup folder's layout matches it), and your `.env`
   into the Marquee folder. Remove any stale `.marquee.db-wal`/`-shm` left in `DATA_DIR`.
3. Start Marquee and run `node setup.js doctor`. Sign in and check your library and Continue
   watching.

## Upgrading

Read the [changelog](../CHANGELOG.md) first; it lists anything you need to do. Back up before
upgrading between minor versions.

| Installed with | Upgrade |
| --- | --- |
| `install.sh` / `install.ps1` | Run it again (optionally `--version vX.Y.Z`). Application files are replaced; `.env` and state are left alone; the previous version is kept in `.backup-<version>/`. Then `node setup.js service restart`. |
| git clone | `git pull --ff-only` (or `git fetch --tags && git checkout vX.Y.Z`), then `node setup.js service restart`. |
| Docker Compose | `docker compose pull && docker compose up -d`. Pin `MARQUEE_VERSION` to control when. |

After upgrading, `node setup.js` is safe to run again: it keeps your settings and only adds new ones.

### Rolling back

- Installer: stop Marquee, move the current application files aside and move the contents of
  `.backup-<previous version>/` back, then start it.
- git: `git checkout v<previous>` and restart.
- Docker: set `MARQUEE_VERSION` to the previous version and `docker compose up -d`.

If the newer version changed the database, restore the backup you made before upgrading as well.

## Upgrading to 1.1 from 1.0

- **Node.js 22.16 or later** is required (Notes search needs SQLite FTS5, which earlier 22.x builds lack).
- **Server code moved to `src/`.** `node server.js` and `npm start` work as before. On Windows,
  `start-marquee.cmd` stays where it was, so the existing scheduled task keeps working; the other
  scripts moved to `scripts\windows\` (`restart-marquee.ps1`, `install-service.ps1`, formerly
  `setup-autostart.ps1`). Re-run `scripts\windows\install-service.ps1` once to add the watchdog task.
- **Identity headers are only trusted from `TRUSTED_PROXIES`** (default: this machine). If
  cloudflared or your proxy runs on another machine, set `TRUSTED_PROXIES` or the Access token
  settings before upgrading, or everyone will appear as the Home network account. See
  [remote-access.md](remote-access.md#how-accounts-work).
- State stays where it is. `DATA_DIR` is new and optional; to move state to another folder later,
  stop Marquee and run `node setup.js migrate-data --to <folder>`.
