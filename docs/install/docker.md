# Docker

The image `ghcr.io/tjabooo/lilin` is published for `linux/amd64` and `linux/arm64` with the tags
`2.0.0`, `2.0`, `2` and `latest`. It contains Node.js, ffmpeg and Tesseract, runs as an unprivileged
user, and has a health check. Common background is in [README.md](README.md); the NAS guides
([Unraid](unraid.md), [Synology](synology.md), [TrueNAS](truenas.md)) build on this page.

## 1. Prerequisites

- Docker Engine with Compose v2 (`docker compose version`). The Compose file uses the
  `env_file: required:` form, which needs Compose 2.24 or later.
- A data folder and the media folder, writable by the user ID the container runs as (`PUID`/`PGID`,
  default `1000:1000`; find yours with `id`).

## 2. Install

```sh
mkdir -p ~/lilin && cd ~/lilin
curl -fsSLO https://raw.githubusercontent.com/Tjabooo/lilin/v2.0.0/docker-compose.yml
curl -fsSL https://raw.githubusercontent.com/Tjabooo/lilin/v2.0.0/.env.example -o lilin.env
mkdir -p data
sudo chown 1000:1000 data        # your PUID:PGID
```

The same files are in the release archive and the git repository. Create `data` before the first
start: if Docker creates it, it belongs to root and Lilin can't write to it.

Compose reads the variables below from the shell or from a file named `.env` next to
`docker-compose.yml` (Compose's file, not Lilin's):

```sh
# ~/lilin/.env
MEDIA_PATH=/srv/media
PUID=1000
PGID=1000
TZ=Europe/London
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `MEDIA_PATH` | `./media` | Host folder mounted at `/media` |
| `LILIN_DATA` | `./data` | Host folder mounted at `/data` (database, state, cache) |
| `LILIN_PORT` | `8080` | Host port |
| `LILIN_VERSION` | `2.0.0` | Image tag |
| `PUID`, `PGID` | `1000` | User and group Lilin (and qBittorrent) run as |
| `TZ` | `UTC` | Time zone |
| `TRUSTED_PROXIES` | `127.0.0.1,::1` | See [../remote-access.md](../remote-access.md) |
| `COMPOSE_PROFILES` | | Optional services to include, e.g. `qbittorrent,flaresolverr` |

## 3. Configure

Edit `lilin.env` ([../configuration.md](../configuration.md)). Leave `MEDIA_DIR`, `DATA_DIR`,
`HOST` and `PORT` alone: Compose sets them for the container and they always win.

Set **`SERVER_IP`** to the host's LAN address, for example `SERVER_IP=192.168.1.20`. Inside the
container Lilin only sees its container address, and TVs stream from `SERVER_IP`.

`node setup.js` isn't used in Docker, so `HOUSE_TOKEN` and `SCREENTIME_TOKEN` aren't generated; set
them yourself (`openssl rand -hex 32`) if you use the House agents or screentime.

Instead of `lilin.env`, settings can also live in `.env` inside the data folder: the image reads
`/data/.env`. Container environment variables override it.

## 4. Start

```sh
docker compose up -d
docker compose ps                  # STATUS shows (healthy) after up to 30 s
docker compose logs -f lilin
```

Open `http://192.168.1.20:8080` (your host's address).

### Optional services

Enable them with `--profile NAME` on every `docker compose` command, or once with `COMPOSE_PROFILES`
in Compose's `.env`.

**qBittorrent** (`qbittorrent` profile): Web UI on port 8081, configuration in `./qbittorrent`. The
image prints a temporary Web UI password in `docker compose logs qbittorrent`; sign in at
`http://192.168.1.20:8081`, set a password, and set the default save path to `/media/Downloads`
(qBittorrent sees the media folder at the same path as Lilin). In `lilin.env`:

```sh
QBIT_URL=http://qbittorrent:8081
QBIT_USER=admin
QBIT_PASS=your-password
```

**qBittorrent through a VPN** (`vpn` profile, instead of `qbittorrent`; both use port 8081 and
`./qbittorrent`). Gluetun connects to your VPN provider, and qBittorrent shares Gluetun's network
namespace, so its traffic can only leave through the tunnel: if the VPN is down, qBittorrent has no
connectivity rather than falling back to your normal connection.

```sh
curl -fsSL https://raw.githubusercontent.com/Tjabooo/lilin/v2.0.0/docker/vpn.env.example -o vpn.env
# fill in vpn.env (provider options: https://github.com/qdm12/gluetun-wiki)
docker compose --profile vpn up -d
```

Set `QBIT_URL=http://gluetun:8081` in `lilin.env`; the Web UI is at port 8081 on the host as above.
The host needs `/dev/net/tun`.

**FlareSolverr** (`flaresolverr` profile): set `FLARESOLVERR_URL=http://flaresolverr:8191` in
`lilin.env`. It isn't published on a host port.

### NVIDIA GPU encoding

Install the NVIDIA driver and the
[NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/) on the
host, then:

```sh
mkdir -p docker
curl -fsSL https://raw.githubusercontent.com/Tjabooo/lilin/v2.0.0/docker/compose.nvidia.yml -o docker/compose.nvidia.yml
docker compose -f docker-compose.yml -f docker/compose.nvidia.yml up -d
docker compose exec lilin node setup.js doctor --offline
```

Doctor's "Encoder Lilin will use" line should say NVIDIA NVENC. Pass both `-f` options to every
later `docker compose` command. See [../hardware-acceleration.md](../hardware-acceleration.md).

### One-file Compose for NAS interfaces

Some NAS interfaces take a single Compose file without the extra files. This is the `lilin`
service from `docker-compose.yml` with paths and settings written in; adjust the paths, user and
address:

```yaml
services:
  lilin:
    image: ghcr.io/tjabooo/lilin:2.0.0
    restart: unless-stopped
    user: "1000:1000"
    ports:
      - "8080:8080"
    environment:
      DATA_DIR: /data
      MEDIA_DIR: /media
      HOST: 0.0.0.0
      PORT: "8080"
      TZ: Europe/London
      SERVER_IP: 192.168.1.20
      TMDB_TOKEN: ""
    volumes:
      - /srv/lilin/data:/data
      - /srv/media:/media
    stop_grace_period: 20s
```

Add other settings under `environment`, or put them in `.env` in the data folder.

## 5. Autostart

`restart: unless-stopped`: the container starts with the Docker daemon. No service is needed;
`node setup.js service` doesn't apply.

## 6. Update

`docker-compose.yml` pins the image to `2.0.0`, so set the new version first:

```sh
docker compose exec lilin node setup.js backup     # lands in data/backups/
# set LILIN_VERSION=2.0.0 in Compose's .env (or download the new docker-compose.yml)
docker compose pull && docker compose up -d
```

See [../upgrading-and-backups.md](../upgrading-and-backups.md).

## 7. Troubleshooting

```sh
docker compose exec lilin node setup.js doctor --offline
```

- **`EACCES` in the log, or doctor reports "Data folder /data: EACCES"**: the data or media folder
  isn't writable by `PUID:PGID`. `sudo chown -R 1000:1000 data` (your IDs), and give that user write access to the media.
- **TVs show an error or can't load the video**: `SERVER_IP` is missing or wrong.
- **Port 8080 is taken**: set `LILIN_PORT` to another host port.
- **`env_file` or `required` rejected**: Compose is older than 2.24. Update it, or change the
  `env_file` entry to the short form `env_file: [lilin.env]` and create the file.

More in [../troubleshooting.md](../troubleshooting.md).

## 8. Limitations

- **Casting is limited.** The image doesn't include pyatv, so Apple TV casting is unavailable. On the
  default bridge network, DLNA TVs and AirPlay devices aren't discovered (multicast doesn't reach
  the container); list DLNA TVs in `DLNA_DEVICES`. On a Linux host, `network_mode: host` on the
  `lilin` service (and no `ports:`) lets discovery work; Lilin then listens on port 8080 of the
  host directly, and reaches qBittorrent at `http://localhost:8081` instead of by service name.
  The player's own AirPlay (Safari) and Chromecast (Chrome on Android) buttons work either way,
  since the phone does the discovery.
- Hardware encoding is NVIDIA NVENC only, through the NVIDIA Container Toolkit.
- House → Sharing CPU/GPU history and `tools/torrent-vpn` are Windows-only; use the `vpn` profile for
  torrent traffic.
