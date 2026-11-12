# macOS

Common steps are in [README.md](README.md).

## 1. Prerequisites

With [Homebrew](https://brew.sh):

```sh
brew install node ffmpeg
brew install tesseract                     # optional: Notes OCR
brew install pipx && pipx install pyatv    # optional: Apple TV
brew install --cask qbittorrent            # optional: downloads; enable its Web UI on port 8081
```

## 2. Install

```sh
curl -fsSL https://raw.githubusercontent.com/Tjabooo/lilin/v2.0.1/install.sh -o install.sh
less install.sh
sh install.sh
```

## 3. Configure

Setup suggests `~/Media` as the media folder. See [README.md](README.md#first-run).

## 4. Start

`npm start` in `~/lilin`. With the macOS firewall on, macOS asks once whether `node` may accept
incoming connections; allow it, or other devices can't connect.

## 5. Autostart

launchd. Setup writes the LaunchAgent `~/Library/LaunchAgents/io.github.tjabooo.lilin.plist`, which
starts Lilin at login and restarts it if it exits with an error. Output goes to
`~/lilin/logs/lilin.log`.

```sh
node ~/lilin/setup.js service install     # also: status, restart, uninstall
```

A LaunchAgent runs only while you are logged in. For an always-on Mac:

- turn on automatic login (System Settings → Users & Groups),
- stop the Mac from sleeping (System Settings → Energy, or `sudo pmset -a sleep 0`).

The agent records the full path of the `node` binary, which changes when Homebrew upgrades Node.js.
Run `node ~/lilin/setup.js service install` again after `brew upgrade node`.

## 6. Update

Run `sh install.sh` again, then `node ~/lilin/setup.js service restart`.

## 7. Troubleshooting

- **The agent can't read the media folder**, while `npm start` in Terminal can: macOS restricts
  background processes' access to Desktop, Documents, Downloads, external and network volumes. Add
  the `node` binary (`realpath "$(which node)"`) under System Settings → Privacy & Security → Full
  Disk Access, or keep media elsewhere.
- **The agent stopped after a Node.js upgrade**: re-run `service install` (see above).
- Log: `~/lilin/logs/lilin.log`. Run `node ~/lilin/setup.js doctor`.

More in [../troubleshooting.md](../troubleshooting.md).

## 8. Limitations

- Runs only while a user is logged in (LaunchAgent).
- Encoding uses libx264 on the CPU; Lilin doesn't use VideoToolbox
  ([../hardware-acceleration.md](../hardware-acceleration.md)).
- House → Sharing CPU/GPU history and `tools/torrent-vpn` are Windows-only.
