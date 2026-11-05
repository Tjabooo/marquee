# Raspberry Pi

Raspberry Pi 4 and 5. Common steps are in [README.md](README.md); the native install works as on
[Debian and Ubuntu](debian-ubuntu.md). [Docker](docker.md) works too: the image is published for
`linux/arm64`.

## 1. Prerequisites

- **64-bit Raspberry Pi OS (Bookworm).** This guide and the Docker image are for arm64. Check with
  `dpkg --print-architecture`: it must print `arm64`.
- Media on a USB drive rather than the SD card.
- Node.js from NodeSource, as on [Debian and Ubuntu](debian-ubuntu.md#1-prerequisites).
- `sudo apt-get install -y ffmpeg tesseract-ocr`

Mount the media drive at a fixed path through `/etc/fstab` (by `UUID=`, with `nofail`), for example
`/srv/media`. A Linux filesystem such as ext4 avoids the permission problems of exFAT and NTFS.

## 2. Install

```sh
curl -fsSL https://raw.githubusercontent.com/Tjabooo/marquee/v1.1.0/install.sh -o install.sh
less install.sh
sh install.sh
```

## 3. Configure

Set `MEDIA_DIR` to the mounted drive, for example `/srv/media`. Then consider the encoding settings
below.

**Encoding is slow on a Pi.** Marquee uses NVIDIA NVENC or libx264 on the CPU; it doesn't use the
Pi's video hardware. Converting an MKV whose video is already H.264 or HEVC only copies the streams
and is cheap, but a full re-encode takes far longer than on a desktop CPU and keeps the Pi busy.
The settings that cause re-encodes in the background:

| Setting | Default | On a Pi |
| --- | --- | --- |
| `BROWSER_H264_DAYS` | `14` | `0`: make H.264 copies of HEVC files only when a browser without HEVC plays one |
| `PREPARE_NEXT_EPISODES` | `2` | `0`: don't prepare browser copies ahead |
| `CONVERT` | `on` | Keep `on` (mostly remuxing); `off` if your library is already MP4 |

See [../configuration.md](../configuration.md#conversion).

## 4. Start

`npm start` in `~/marquee`, or let the service start it.

## 5. Autostart

systemd. Use a system unit so Marquee waits for the USB drive:

```sh
node ~/marquee/setup.js service install --scope system
```

It contains `RequiresMountsFor=` for the media and data folders. See
[Debian and Ubuntu](debian-ubuntu.md#5-autostart).

## 6. Update

As on [Debian and Ubuntu](debian-ubuntu.md#6-update).

## 7. Troubleshooting

- **`dpkg --print-architecture` prints `armhf`**: the system is 32-bit. Reinstall with 64-bit
  Raspberry Pi OS.
- **Playback stutters while a conversion runs**: the CPU is saturated. Apply the settings above.
- **Undervoltage warnings or USB drive disconnects**: use the official power supply, or a powered
  USB hub for the drive.

More in [../troubleshooting.md](../troubleshooting.md).

## 8. Limitations

- No hardware encoding; all encoding is libx264 on the CPU.
- House → Sharing CPU/GPU history and `tools/torrent-vpn` are Windows-only.
