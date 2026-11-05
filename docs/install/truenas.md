# TrueNAS SCALE

TrueNAS SCALE 24.10 ("Electric Eel") and later run apps with Docker. Marquee installs as a custom
app from YAML. Read [docker.md](docker.md) for settings, optional services and limitations; this page
covers the TrueNAS specifics.

## 1. Prerequisites

- Apps configured with a pool (Apps → Configuration → Choose Pool).
- Datasets for Marquee's data and your media, for example `tank/apps/marquee` and `tank/media`.
- The user the container runs as. TrueNAS apps commonly run as the built-in `apps` user and group
  (`568:568`). Give it Modify permission on both datasets (Datasets → Permissions → Edit).

## 2. Install

Apps → Discover Apps → the three-dot menu → **Install via YAML**. Name it `marquee` and paste the
[one-file Compose](docker.md#one-file-compose-for-nas-interfaces) with these changes:

```yaml
    user: "568:568"
    volumes:
      - /mnt/tank/apps/marquee:/data
      - /mnt/tank/media:/media
```

Set `SERVER_IP` to the TrueNAS LAN address, then save.

## 3. Configure

Edit the app's YAML to add settings under `environment`, or put a `.env` file (from `.env.example`)
in `/mnt/tank/apps/marquee`; the image reads `/data/.env`. See
[../configuration.md](../configuration.md).

## 4. Start

Saving the YAML starts the app. Open `http://192.168.1.20:8080`. Make sure no other app uses port
8080, or change the host side of `ports`.

## 5. Autostart

The app starts with TrueNAS (`restart: unless-stopped`).

## 6. Update

Back up first (the app's shell: `node setup.js backup`). Edit the app's YAML, change the image tag,
and save.

## 7. Troubleshooting

- **Permission errors on `/data` or `/media`**: the dataset ACLs don't give `568` (or the user in
  `user:`) write access.
- Health check from the app's shell: `node setup.js doctor --offline`.

See also [docker.md](docker.md#7-troubleshooting).

## 8. Limitations

As in [docker.md](docker.md#8-limitations). For NVIDIA NVENC, enable the NVIDIA driver in the Apps
settings, then add the `NVIDIA_DRIVER_CAPABILITIES` variable and the `deploy` block from
`docker/compose.nvidia.yml` to the `marquee` service.
