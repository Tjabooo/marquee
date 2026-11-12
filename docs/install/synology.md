# Synology DSM

Lilin runs from the Docker image in Container Manager. Read [docker.md](docker.md) for settings,
optional services and limitations; this page covers the Synology specifics.

## 1. Prerequisites

- DSM 7.2 or later with **Container Manager** (Package Center).
- A model with an x86-64 or 64-bit ARM CPU (the image is `linux/amd64` and `linux/arm64`).
- Shared folders for media and app data, for example `/volume1/video` and `/volume1/docker`.
- Your user and group IDs: enable SSH (Control Panel → Terminal & SNMP), sign in and run `id`, for
  example `uid=1026(you) gid=100(users)`. That user needs read/write permission on the media folder.

In File Station, create `/volume1/docker/lilin/data`.

## 2. Install

Container Manager → **Project** → **Create**:

- Project name: `lilin`
- Path: `/volume1/docker/lilin`
- Source: Create docker-compose.yml, and paste the
  [one-file Compose](docker.md#one-file-compose-for-nas-interfaces) with these changes:

```yaml
    user: "1026:100"
    volumes:
      - /volume1/docker/lilin/data:/data
      - /volume1/video:/media
```

Set `SERVER_IP` to the NAS's LAN address. Finish the wizard; it pulls the image and starts the
project.

## 3. Configure

Add settings under `environment` in the project's Compose file, or put a `.env` file (from
`.env.example`) in `/volume1/docker/lilin/data`; the image reads `/data/.env`. See
[../configuration.md](../configuration.md).

## 4. Start

Open `http://192.168.1.20:8080`. If DSM's firewall is on (Control Panel → Security → Firewall),
allow TCP 8080 from your LAN.

## 5. Autostart

`restart: unless-stopped` starts the project with Container Manager.

## 6. Update

Change the image tag in the project's Compose file, then over SSH:

```sh
cd /volume1/docker/lilin
sudo docker compose exec lilin node setup.js backup     # lands in data/backups/
sudo docker compose pull && sudo docker compose up -d
```

## 7. Troubleshooting

- **Permission errors on `/data` or `/media`**: the user in `user:` needs read/write on both shared
  folders (Control Panel → Shared Folder → Edit → Permissions).
- **The project fails to parse `env_file`** when using the full `docker-compose.yml`: the Compose
  version is older than 2.24. Use the one-file Compose, or the short form `env_file: [lilin.env]`.
- **The `vpn` profile can't start Gluetun**: it needs `/dev/net/tun`, which DSM may not provide by
  default; see the [Gluetun wiki](https://github.com/qdm12/gluetun-wiki).
- Health check, from `/volume1/docker/lilin`: `sudo docker compose exec lilin node setup.js doctor --offline`.

See also [docker.md](docker.md#7-troubleshooting).

## 8. Limitations

As in [docker.md](docker.md#8-limitations). Synology's own video hardware isn't used; encoding is
libx264 on the NAS CPU, which is slow on low-power models; the encoding settings in
[raspberry-pi.md](raspberry-pi.md#3-configure) apply here too.
