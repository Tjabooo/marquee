# Troubleshooting

Start with the doctor. It checks the runtime, settings, data folder, disk space, ffmpeg, autostart and
every configured integration, and says how to fix what it finds:

```sh
node setup.js doctor             # add --offline to skip network checks
```

Lilin also prints warnings for broken settings when it starts. Where the log is:

| Running as | Log |
| --- | --- |
| Terminal (`npm start`) | the terminal |
| Windows scheduled task | `logs\lilin.log` in the Lilin folder |
| systemd | `journalctl -u lilin` (user service: `journalctl --user -u lilin`) |
| launchd | `logs/lilin.log` in the Lilin folder |
| Docker | `docker compose logs lilin` |

## Starting

| Problem | Fix |
| --- | --- |
| `Lilin needs Node.js 22.16 or later` / `no such module: fts5` | Install the current Node.js LTS. Distribution packages are often older; see your [platform guide](install/README.md). |
| `Port 8080 is already in use` | Another program has the port. Set `PORT` in `.env`, or stop the other program. |
| `DATA_DIR is ..., but the existing database is still in ...` | You set `DATA_DIR` without moving the data. Stop Lilin and run `node setup.js migrate-data`, or remove `DATA_DIR`. |
| Starts, but a feature shows `off` | Its settings are blank or wrong. The startup lines and `GET /api/status` show what's enabled. |
| Library empty after a reboot (Linux) | The media drive wasn't mounted yet. The systemd unit waits for `MEDIA_DIR`'s mount; re-run `node setup.js service install` after changing `MEDIA_DIR`. |
| Docker container restarts with permission errors | `./data` and the media folder must be writable by `PUID:PGID` (`sudo chown -R 1000:1000 data`). |

## Accounts and access

| Problem | Fix |
| --- | --- |
| Everyone shows as "Home network" through Cloudflare | Lilin doesn't trust the proxy's headers. If cloudflared runs on another machine or container, set `CF_ACCESS_TEAM_DOMAIN` + `CF_ACCESS_AUD`, or add its address to `TRUSTED_PROXIES`. See [remote-access.md](remote-access.md#how-accounts-work). |
| Owner tabs missing | Your Access email must be in `ADMIN_EMAILS` (same spelling, any case). The Home network account is never an owner. |
| Shared clip links ask for a sign-in | Add the Access **Bypass** application for `/c` ([remote-access.md](remote-access.md#cloudflare-tunnel-and-access)). |

## Playback and conversion

| Problem | Fix |
| --- | --- |
| No sound in the browser | The file has Dolby or DTS audio. Keep the player open; it switches to a fixed copy once ready. Needs ffmpeg. |
| A video won't play on iPhone / Apple TV | It's waiting for its MP4 copy. Check the Library's state, and that ffmpeg is found (`doctor`). |
| Conversions are slow | They run on the CPU unless NVENC works; see [hardware-acceleration.md](hardware-acceleration.md). |
| Firefox plays HEVC files late | Firefox can't play HEVC; Lilin makes an H.264 copy. Recent downloads get one right away (`BROWSER_H264_DAYS`). |

## Casting

| Problem | Fix |
| --- | --- |
| TV not listed | It must be on the same network with DLNA/media sharing on; or add it to `DLNA_DEVICES`. In Docker, discovery needs `network_mode: host`. |
| TV plays but can't reach the server | Set `SERVER_IP` to the server's LAN address. |
| Apple TV missing or asks for pairing | Install pyatv (`pipx install pyatv`) and run `atvremote wizard` once. If discovery fails, set `ATV_HOSTS`. |
| No TVs when away from home | Expected: TVs are only offered at home. `CAST_WHEN_AWAY=on` changes that; `GET /api/network` shows how a request was classified. |

## Downloads and subtitles

| Problem | Fix |
| --- | --- |
| qBittorrent sign-in refused | Check `QBIT_USER`/`QBIT_PASS`. After repeated failures qBittorrent blocks the address until it restarts. |
| Downloads finish but never appear | qBittorrent's save path must be inside `MEDIA_DIR` (`node setup.js` can set it). In Docker both containers must see the same `/media` path. |
| "Every 1337x mirror is showing a Cloudflare check" | Set up FlareSolverr (`FLARESOLVERR_URL`). The Pirate Bay keeps working meanwhile. |
| "Today's subtitle download limit is used up" | Add `OPENSUBTITLES_USER`/`OPENSUBTITLES_PASS`, or wait for the daily reset. |
| Delete fails with "file is in use" | Stop playback in browsers and on TVs, then try again. |

## Still stuck

Open an issue at <https://github.com/Tjabooo/lilin/issues> with the output of
`node setup.js doctor --offline` (it prints no secrets) and the relevant log lines.
