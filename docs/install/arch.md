# Arch Linux

Common steps are in [README.md](README.md). Autostart and updates work as on
[Debian and Ubuntu](debian-ubuntu.md).

## 1. Prerequisites

```sh
sudo pacman -S nodejs ffmpeg
```

Optional:

```sh
sudo pacman -S tesseract tesseract-data-eng     # Notes OCR
sudo pacman -S qbittorrent-nox                  # downloads; set its Web UI port to 8081
sudo pacman -S python-pipx && pipx install pyatv   # Apple TV
```

## 2. Install

```sh
curl -fsSL https://raw.githubusercontent.com/Tjabooo/marquee/v1.1.0/install.sh -o install.sh
less install.sh
sh install.sh
```

## 3. Configure

As in [README.md](README.md#first-run).

## 4. Start

`npm start` in `~/marquee`, or let the service start it.

## 5. Autostart

systemd. Run from your desktop or an SSH login, setup proposes a user unit
(`~/.config/systemd/user/marquee.service`) and enables lingering so it starts at boot. For a
headless server, `node ~/marquee/setup.js service install --scope system`. Details:
[Debian and Ubuntu](debian-ubuntu.md#5-autostart).

## 6. Update

Run `sh install.sh` again, then `node ~/marquee/setup.js service restart` (it finds the installed unit). `pacman -Syu` can move Node.js to a new major version; Marquee needs no rebuild, and
`/usr/bin/node` stays the path the unit uses.

## 7. Troubleshooting

- **Other devices can't connect** with a firewall enabled (ufw, nftables, firewalld): allow TCP 8080.
- **Tesseract finds no text**: install a language pack such as `tesseract-data-eng`.

More in [../troubleshooting.md](../troubleshooting.md).

## 8. Limitations

As on [Debian and Ubuntu](debian-ubuntu.md#8-limitations).
