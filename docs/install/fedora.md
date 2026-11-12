# Fedora

Common steps are in [README.md](README.md). Installation, autostart (systemd) and updates work as on
[Debian and Ubuntu](debian-ubuntu.md); this page covers the differences.

## 1. Prerequisites

```sh
sudo dnf install nodejs
node --version          # 22.16 or later
```

Recent Fedora releases ship a current Node.js; if `node --version` is older than 22.16, use
[nvm](https://github.com/nvm-sh/nvm) or the binaries from [nodejs.org](https://nodejs.org/en/download).

**ffmpeg:** Fedora's own `ffmpeg-free` has no H.264 or HEVC encoders, so conversions that need
re-encoding fail and `node setup.js doctor` reports no usable encoder. Use RPM Fusion's `ffmpeg`:

```sh
sudo dnf install https://mirrors.rpmfusion.org/free/fedora/rpmfusion-free-release-$(rpm -E %fedora).noarch.rpm
sudo dnf swap ffmpeg-free ffmpeg --allowerasing
```

Setup's own install offer for Fedora is `ffmpeg-free` and prints this note; do the swap yourself.

Optional: `sudo dnf install tesseract` (Notes OCR), `sudo dnf install qbittorrent-nox` (Web UI on
port `8081`), `sudo dnf install pipx && pipx install pyatv` (Apple TV).

## 2. Install

```sh
curl -fsSL https://raw.githubusercontent.com/Tjabooo/lilin/v2.0.2/install.sh -o install.sh
less install.sh
sh install.sh
```

## 3. Configure

As in [README.md](README.md#first-run).

## 4. Start

`npm start` in `~/lilin`, or let the service start it.

## 5. Autostart

systemd, as on [Debian and Ubuntu](debian-ubuntu.md#5-autostart).

## 6. Update

As on [Debian and Ubuntu](debian-ubuntu.md#6-update).

## 7. Troubleshooting

- **Doctor reports "none found (no libx264)"**: `ffmpeg-free` is installed; swap it as above.
- **Other devices can't connect** (Fedora Server, or a firewalld zone that doesn't allow the port):
  `sudo firewall-cmd --permanent --add-port=8080/tcp && sudo firewall-cmd --reload`.
- **TVs aren't discovered**: list them in `DLNA_DEVICES` ([../configuration.md](../configuration.md#casting)).

More in [../troubleshooting.md](../troubleshooting.md).

## 8. Limitations

As on [Debian and Ubuntu](debian-ubuntu.md#8-limitations).
