# Debian and Ubuntu

Debian 12 and Ubuntu 22.04/24.04 and derivatives. Common steps are in [README.md](README.md).

## 1. Prerequisites

The distribution's `nodejs` package is too old: Debian 12 and Ubuntu 24.04 ship Node.js 18, Ubuntu
22.04 ships 12. Install a current LTS from NodeSource:

```sh
sudo apt-get update && sudo apt-get install -y curl ca-certificates
curl -fsSL https://deb.nodesource.com/setup_24.x -o nodesource_setup.sh
less nodesource_setup.sh
sudo bash nodesource_setup.sh
sudo apt-get install -y nodejs
node --version          # 22.16 or later
```

`setup_22.x` works too. Alternatives: [nvm](https://github.com/nvm-sh/nvm) (`nvm install --lts`) or
the official binaries from [nodejs.org](https://nodejs.org/en/download).

Optional tools (setup offers the first two):

```sh
sudo apt-get install -y ffmpeg tesseract-ocr
sudo apt-get install -y qbittorrent-nox                 # downloads
sudo apt-get install -y pipx && pipx install pyatv      # Apple TV
```

Ubuntu and Debian's `ffmpeg` includes libx264. Set `qbittorrent-nox`'s Web UI port to `8081`.

## 2. Install

```sh
curl -fsSL https://raw.githubusercontent.com/Tjabooo/lilin/v2.0.2/install.sh -o install.sh
less install.sh
sh install.sh
```

Or use the release archive or git: [README.md](README.md#install-methods).

## 3. Configure

Answer setup's questions; a media folder such as `/srv/media` must be readable and writable by the
account that runs Lilin. See [../configuration.md](../configuration.md).

## 4. Start

`npm start` in `~/lilin`, or let the service start it.

## 5. Autostart

systemd. Run as a normal user, setup proposes a user unit plus `loginctl enable-linger`. On a
server, prefer a system unit: setup uses sudo to write `/etc/systemd/system/lilin.service`, which
runs as your user and waits for the media mount.

```sh
node ~/lilin/setup.js service install --scope system
systemctl status lilin
journalctl -u lilin -f
```

For a user unit, use `--scope user`, `systemctl --user status lilin` and
`journalctl --user -u lilin`. Pass the same `--scope` to `service status`, `restart` and
`uninstall`.

If you installed Node.js with nvm, run `service install` again after switching Node versions: the
unit contains the full path of the `node` binary.

## 6. Update

Run `sh install.sh` again, then `node ~/lilin/setup.js service restart` (it finds the installed unit). See
[README.md](README.md#updating).

## 7. Troubleshooting

- **Setup says Node.js is too old** although you installed NodeSource: an older `node` earlier on
  PATH. Check `which -a node`.
- **Other devices can't connect** with ufw enabled: `sudo ufw allow 8080/tcp`.
- **Lilin starts with an empty library** after boot: the system unit waits for the media mount
  (`RequiresMountsFor=`). If `MEDIA_DIR` changed since the service was installed, run
  `service install` again.

More in [../troubleshooting.md](../troubleshooting.md).

## 8. Limitations

House → Sharing CPU/GPU history and `tools/torrent-vpn` are Windows-only. Hardware encoding is
NVIDIA NVENC only; other systems encode with libx264 on the CPU
([../hardware-acceleration.md](../hardware-acceleration.md)).
