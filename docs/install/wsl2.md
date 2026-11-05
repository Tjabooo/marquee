# WSL2

Marquee runs in WSL2 (for example the Ubuntu distribution) and is fine for trying it out or
developing. For an always-on server, install it [natively on Windows](windows.md): WSL shuts its VM
down when idle, its network sits behind NAT by default, and Windows-only features aren't available
from Linux.

Common steps are in [README.md](README.md).

## 1. Prerequisites

Inside the WSL distribution, follow [Debian and Ubuntu](debian-ubuntu.md#1-prerequisites) for
Node.js and ffmpeg.

**Networking.** By default WSL2 uses NAT: Marquee is reachable from Windows at `localhost:8080`, but
not from phones or TVs on your network, and TV discovery doesn't work. Two options:

- **Mirrored networking** (Windows 11 22H2 or later). In `%UserProfile%\.wslconfig`:

  ```ini
  [wsl2]
  networkingMode=mirrored
  ```

  Run `wsl --shutdown`, then allow inbound connections through the Hyper-V firewall from an elevated
  PowerShell:

  ```powershell
  New-NetFirewallHyperVRule -Name Marquee -DisplayName "Marquee" -Direction Inbound -VMCreatorId '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}' -Protocol TCP -LocalPorts 8080
  ```

- **Port forwarding** (NAT). From an elevated PowerShell, with the address from `wsl hostname -I`:

  ```powershell
  netsh interface portproxy add v4tov4 listenport=8080 listenaddress=0.0.0.0 connectport=8080 connectaddress=172.x.x.x
  ```

  The WSL address changes when WSL restarts. Set `SERVER_IP` to the Windows machine's LAN address
  (for example `192.168.1.20`) so TVs stream from an address they can reach, and list TVs in
  `DLNA_DEVICES`.

## 2. Install

Inside WSL:

```sh
curl -fsSL https://raw.githubusercontent.com/Tjabooo/marquee/v1.2.0/install.sh -o install.sh
less install.sh
sh install.sh
```

Setup reports the system as WSL.

## 3. Configure

Media on Windows drives is reachable as `/mnt/d/Media`, but file access across the boundary is
slower than from the Linux filesystem. See [README.md](README.md#first-run).

## 4. Start

`npm start` in `~/marquee`.

## 5. Autostart

If systemd is enabled in the distribution (`systemd=true` under `[boot]` in `/etc/wsl.conf`), the systemd
service works as on [Debian and Ubuntu](debian-ubuntu.md#5-autostart). It starts when WSL starts, not
when Windows boots.

## 6. Update

As on [Debian and Ubuntu](debian-ubuntu.md#6-update).

## 7. Troubleshooting

- **Works from Windows but not from a phone**: networking, see above.
- **TVs can't play**: `SERVER_IP` is the WSL address instead of the Windows machine's LAN address.

More in [../troubleshooting.md](../troubleshooting.md).

## 8. Limitations

- Not suited to always-on use: WSL stops when idle and starts only on demand.
- DLNA discovery and Apple TV casting need mirrored networking.
- House → Sharing CPU/GPU history, Windows OCR and `tools/torrent-vpn` need the native Windows
  install.
