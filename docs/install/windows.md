# Windows

Windows 10 (1803 or later) and Windows 11. Windows 11 is Lilin's main production host. Common
steps are in [README.md](README.md).

## Easiest: the setup wizard

Download **LilinSetup.exe** from the [latest release](https://github.com/Tjabooo/lilin/releases/latest)
and double-click it. It's a normal Windows window, no terminal:

1. **Install:** installs Node.js LTS with winget if it's missing, then downloads the release, checks it
   against `SHA256SUMS` and unpacks it (`%USERPROFILE%\lilin` unless you pick another folder; an
   existing installation is updated and keeps its settings and data). It also adds the release's
   Android TV app, which Lilin offers at `/android`.
2. **Library, Network, Sign-in, Services:** the same questions as `node setup.js`, with folder
   pickers, a live port check, **Test connections** for TMDB, OpenSubtitles and qBittorrent, and your
   owner password. FFmpeg can be installed from the Library page, and a new installation can keep its
   cache (browser copies and previews, which can grow to hundreds of GB) on another drive. Services
   also asks whether to hide adult content. With **Cloudflare Tunnel and Access** and a team domain,
   *People sign in to Access with their Lilin password* sets Lilin up as Access's login, and the
   last page shows what to enter in Cloudflare (with a Copy button).
3. **Game clips (add-on):** turn on Clipper to set up the Clips tab. *On this PC* downloads the pinned,
   hash-checked Clipper and installs it; *another Windows or Linux PC* gives you one command to paste
   there and can share the clips folder on the network for you.
4. **Startup:** registers the `Lilin` task (start at boot, as you, no admin rights at run time).
   Your Windows password goes straight to Task Scheduler; Windows asks for admin permission once.
5. **Finish:** the address to open, a Start-menu entry (**Lilin Setup**, to change settings later)
   and anything left to do.

The wizard only drives the documented commands (`install.ps1`, `node setup.js --config`,
`setup.js user add`, `setup.js clipper`, `install-service.ps1`), so the rest of this page still applies.
Already installed? Open **Lilin Setup** from the Start menu, run `LilinSetup.exe` in the Lilin
folder, or `node setup.js gui`. Windows SmartScreen may warn about the unsigned exe: **More info → Run
anyway**, or check it against `SHA256SUMS` first.

## 1. Prerequisites

In PowerShell:

```powershell
winget install OpenJS.NodeJS.LTS
winget install --id Gyan.FFmpeg -e                 # optional: conversion, previews, clips
winget install --id qBittorrent.qBittorrent -e     # optional: downloads
```

Open a new PowerShell afterwards so `node` is on PATH, and check `node --version` (22.16 or later).

- **qBittorrent:** enable Tools → Options → Web UI, set its port to `8081` (8080 is Lilin's), and
  set a username and password.
- **Apple TV:** install Python and pipx, then `pipx install pyatv` and pair once with `atvremote wizard`.
- **Notes OCR** uses the OCR built into Windows; nothing to install.

## 2. Install

Use an **elevated PowerShell** (Run as administrator) if you want setup to register autostart in
the same run.

```powershell
Invoke-WebRequest https://raw.githubusercontent.com/Tjabooo/lilin/v2.0.1/install.ps1 -OutFile install.ps1
notepad install.ps1
powershell -ExecutionPolicy Bypass -File install.ps1
```

This installs to `%USERPROFILE%\lilin`. Use `-Dir D:\Apps\Lilin` for another folder, `-Version v2.0.1`
to pin a release, `-DryRun` to preview. The script verifies the archive against `SHA256SUMS` and runs
`node setup.js`.

By hand: download `lilin-v2.0.1.tar.gz` and `SHA256SUMS` from the release, compare
`(Get-FileHash lilin-v2.0.1.tar.gz).Hash` with the value in `SHA256SUMS`, then
`tar -xzf lilin-v2.0.1.tar.gz -C D:\Apps\Lilin --strip-components=1` and run `node setup.js` there.

## 3. Configure

Setup suggests `%USERPROFILE%\Videos\Lilin` as the media folder; a folder such as `D:\Media` on a
large drive is more typical. Settings are in `.env` in the Lilin folder (`notepad .env`); see
[../configuration.md](../configuration.md).

## 4. Start

From the Lilin folder: `npm start`. `start-lilin.cmd` does the same in a loop that restarts
Lilin if it exits, appending output to `logs\lilin.log`; the scheduled task runs it.

## 5. Autostart

From an elevated PowerShell in the Lilin folder:

```powershell
node setup.js service install
```

This runs `scripts\windows\install-service.ps1`, which asks for your Windows password (for a
Microsoft account, the account password, not the PIN) and registers one task:

| Task | Runs as | What it does |
| --- | --- | --- |
| `Lilin` | Your account, not elevated | At boot (after 30 seconds, before anyone signs in) runs `start-lilin.cmd`; every 2 minutes starts it again if it isn't running, since Windows occasionally skips a boot trigger |

Nothing runs as SYSTEM or with admin rights. If every user of the PC can change files in the Lilin
folder (the default for new folders directly under `C:\`), the installer limits write access to
you, SYSTEM and administrators, so no other account can change what your task runs
(`-KeepFolderAcl` skips this). Versions before 1.2 also registered a `Lilin Watchdog` task that
ran a script from the Lilin folder as SYSTEM: re-running the installer removes it, and
`node setup.js doctor` reports it while it's there.

```powershell
node setup.js service status
node setup.js service restart      # stops Lilin and the ffmpeg helpers it started, then starts it
node setup.js service uninstall    # elevated
```

To keep Lilin stopped on purpose, create an empty file named `.lilin-stopped` in the Lilin
folder (the 2-minute trigger then leaves it alone) and run `Stop-ScheduledTask -TaskName Lilin`; if
`node.exe` keeps running, end it in Task Manager. Delete the file to let it start again.

Run `node setup.js service install` again after changing your Windows password or moving Node.js.

## 6. Update

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1
node "$env:USERPROFILE\lilin\setup.js" service restart
```

The previous version is kept in `.backup-<version>\`. See [README.md](README.md#updating).

## 7. Troubleshooting

- **Other devices can't connect.** Make sure the network profile is Private, then allow the port:
  `New-NetFirewallRule -DisplayName "Lilin" -Direction Inbound -Protocol TCP -LocalPort 8080 -Action Allow -Profile Private`
  (elevated).
- **Tools work in a terminal but not under the task.** `install-service.ps1` prints whether it can
  find `ffmpeg`, `ffprobe` and `atvscript`. Set `FFMPEG`, `FFPROBE` or `ATVSCRIPT` in `.env` to full
  paths if not.
- **"Run this from an elevated PowerShell".** Installing or removing the tasks needs administrator
  rights; status and restart don't.
- **The task doesn't start after a password change.** Run `node setup.js service install` again.
- Logs: `logs\lilin.log`. Run `node setup.js doctor`.

More in [../troubleshooting.md](../troubleshooting.md).

## 8. Limitations

None specific to Windows. These features exist only here: House → Sharing CPU/GPU history
(performance counters and `nvidia-smi`), [tools/torrent-vpn](../../tools/torrent-vpn/README.md),
and Notes OCR without Tesseract. Hardware encoding uses NVIDIA NVENC when ffmpeg has a working
`h264_nvenc`; see [../hardware-acceleration.md](../hardware-acceleration.md). For an always-on server,
turn off sleep in Settings → System → Power.
