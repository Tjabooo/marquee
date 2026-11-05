# Windows

Windows 10 (1803 or later) and Windows 11. Windows 11 is Marquee's main production host. Common
steps are in [README.md](README.md).

## 1. Prerequisites

In PowerShell:

```powershell
winget install OpenJS.NodeJS.LTS
winget install --id Gyan.FFmpeg -e                 # optional: conversion, previews, clips
winget install --id qBittorrent.qBittorrent -e     # optional: downloads
```

Open a new PowerShell afterwards so `node` is on PATH, and check `node --version` (22.16 or later).

- **qBittorrent:** enable Tools → Options → Web UI, set its port to `8081` (8080 is Marquee's), and
  set a username and password.
- **Apple TV:** install Python and pipx, then `pipx install pyatv` and pair once with `atvremote wizard`.
- **Notes OCR** uses the OCR built into Windows; nothing to install.

## 2. Install

Use an **elevated PowerShell** (Run as administrator) if you want setup to register autostart in
the same run.

```powershell
Invoke-WebRequest https://raw.githubusercontent.com/Tjabooo/marquee/v1.1.0/install.ps1 -OutFile install.ps1
notepad install.ps1
powershell -ExecutionPolicy Bypass -File install.ps1
```

This installs to `%USERPROFILE%\marquee`. Use `-Dir D:\Apps\Marquee` for another folder, `-Version v1.1.0`
to pin a release, `-DryRun` to preview. The script verifies the archive against `SHA256SUMS` and runs
`node setup.js`.

By hand: download `marquee-v1.1.0.tar.gz` and `SHA256SUMS` from the release, compare
`(Get-FileHash marquee-v1.1.0.tar.gz).Hash` with the value in `SHA256SUMS`, then
`tar -xzf marquee-v1.1.0.tar.gz -C D:\Apps\Marquee --strip-components=1` and run `node setup.js` there.

## 3. Configure

Setup suggests `%USERPROFILE%\Videos\Marquee` as the media folder; a folder such as `D:\Media` on a
large drive is more typical. Settings are in `.env` in the Marquee folder (`notepad .env`); see
[../configuration.md](../configuration.md).

## 4. Start

From the Marquee folder: `npm start`. `start-marquee.cmd` does the same in a loop that restarts
Marquee if it exits, appending output to `logs\marquee.log`; the scheduled task runs it.

## 5. Autostart

From an elevated PowerShell in the Marquee folder:

```powershell
node setup.js service install
```

This runs `scripts\windows\install-service.ps1`, which asks for your Windows password (for a
Microsoft account, the account password, not the PIN) and registers two tasks:

| Task | Runs as | What it does |
| --- | --- | --- |
| `Marquee` | Your account | At boot, 30 seconds after startup, before anyone signs in: runs `start-marquee.cmd` |
| `Marquee Watchdog` | SYSTEM | At boot and every 2 minutes: starts `Marquee` if it isn't running |

```powershell
node setup.js service status
node setup.js service restart      # stops Marquee and the ffmpeg helpers it started, then starts it
node setup.js service uninstall    # elevated
```

To keep Marquee stopped on purpose, create an empty file named `.marquee-stopped` in the Marquee
folder (the watchdog then leaves it alone) and run `Stop-ScheduledTask -TaskName Marquee`; if
`node.exe` keeps running, end it in Task Manager. Delete the file to let the watchdog start it again. The watchdog logs to `logs\watchdog.log`.

Run `node setup.js service install` again after changing your Windows password or moving Node.js.

## 6. Update

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1
node "$env:USERPROFILE\marquee\setup.js" service restart
```

The previous version is kept in `.backup-<version>\`. See [README.md](README.md#updating).

## 7. Troubleshooting

- **Other devices can't connect.** Make sure the network profile is Private, then allow the port:
  `New-NetFirewallRule -DisplayName "Marquee" -Direction Inbound -Protocol TCP -LocalPort 8080 -Action Allow -Profile Private`
  (elevated).
- **Tools work in a terminal but not under the task.** `install-service.ps1` prints whether it can
  find `ffmpeg`, `ffprobe` and `atvscript`. Set `FFMPEG`, `FFPROBE` or `ATVSCRIPT` in `.env` to full
  paths if not.
- **"Run this from an elevated PowerShell".** Installing or removing the tasks needs administrator
  rights; status and restart don't.
- **The task doesn't start after a password change.** Run `node setup.js service install` again.
- Logs: `logs\marquee.log` and `logs\watchdog.log`. Run `node setup.js doctor`.

More in [../troubleshooting.md](../troubleshooting.md).

## 8. Limitations

None specific to Windows. These features exist only here: House → Sharing CPU/GPU history
(performance counters and `nvidia-smi`), [tools/torrent-vpn](../../tools/torrent-vpn/README.md),
and Notes OCR without Tesseract. Hardware encoding uses NVIDIA NVENC when ffmpeg has a working
`h264_nvenc`; see [../hardware-acceleration.md](../hardware-acceleration.md). For an always-on server,
turn off sleep in Settings → System → Power.
