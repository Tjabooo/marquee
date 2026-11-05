# Unraid

Marquee runs from the Docker image. Read [docker.md](docker.md) for settings, optional services and
limitations; this page covers the Unraid specifics.

## 1. Prerequisites

- Docker enabled (Settings → Docker).
- A share for media, for example `/mnt/user/media`.
- Unraid's convention is user `nobody` and group `users`: `PUID=99`, `PGID=100`.

From the Unraid terminal, create the data folder with that owner before the first start:

```sh
mkdir -p /mnt/user/appdata/marquee
chown 99:100 /mnt/user/appdata/marquee
```

## 2. Install

**Docker tab → Add Container** (switch to Advanced View):

| Field | Value |
| --- | --- |
| Name | `marquee` |
| Repository | `ghcr.io/tjabooo/marquee:1.2.0` |
| Network Type | `Bridge` |
| Extra Parameters | `--user 99:100` |
| Port | Container `8080` → Host `8080` |
| Path | Container `/data` → Host `/mnt/user/appdata/marquee` |
| Path | Container `/media` → Host `/mnt/user/media` (read/write) |
| Variable | `TZ` = your time zone |
| Variable | `SERVER_IP` = the server's LAN address, e.g. `192.168.1.20` |

The image already sets `DATA_DIR=/data`, `MEDIA_DIR=/media`, `HOST` and `PORT`.

**Or with the Compose Manager plugin:** create a stack from `docker-compose.yml` and set
`PUID=99`, `PGID=100`, `MEDIA_PATH=/mnt/user/media` and `MARQUEE_DATA=/mnt/user/appdata/marquee` as
described in [docker.md](docker.md#2-install).

## 3. Configure

Add settings as container variables (`TMDB_TOKEN`, `QBIT_URL`, ...), or copy `.env.example` to
`/mnt/user/appdata/marquee/.env` and edit it there; the image reads `/data/.env`. See
[../configuration.md](../configuration.md).

## 4. Start

Apply the template; Unraid starts the container. Open `http://192.168.1.20:8080`.

## 5. Autostart

Turn on **Autostart** for the container on the Docker tab.

## 6. Update

Back up first (`docker exec marquee node setup.js backup`). Edit the container, change the tag in
Repository (for example to `:1.2.0`), and apply.

## 7. Troubleshooting

- **Permission errors on `/data` or `/media`**: the folders must be writable by `99:100`.
  Tools → New Permissions resets a share to `nobody:users`.
- Health check: `docker exec marquee node setup.js doctor --offline`.

See also [docker.md](docker.md#7-troubleshooting).

## 8. Limitations

As in [docker.md](docker.md#8-limitations). For NVIDIA NVENC, install the Nvidia Driver plugin, then
add `--runtime=nvidia` to Extra Parameters and the variables `NVIDIA_VISIBLE_DEVICES` (your GPU's
UUID or `all`) and `NVIDIA_DRIVER_CAPABILITIES=compute,video,utility`.
