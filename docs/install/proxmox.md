# Proxmox VE

Two ways to run Lilin on Proxmox:

- **An unprivileged Debian 12 LXC container** with Lilin installed natively. Light, and the
  approach this page describes.
- **A VM** running Debian or Ubuntu, with either a [native install](debian-ubuntu.md) or
  [Docker](docker.md). Proxmox recommends VMs rather than LXC for running Docker. Use a VM if you
  want Docker or need to pass a GPU through.

Common steps are in [README.md](README.md).

## 1. Prerequisites

On the Proxmox host, create the container from the Debian 12 template (Datacenter → node → local →
CT Templates), unprivileged, with enough disk for the database and cache. Then bind-mount the media
folder from the host (stop the container first; `101` is the container ID):

```sh
pct set 101 -mp0 /tank/media,mp=/srv/media
```

**User IDs in an unprivileged container are shifted by 100000.** A user with UID 1000 inside the
container is UID 101000 on the host, so the media folder must be writable by that host UID:

```sh
chown -R 101000:101000 /tank/media      # on the host
```

(Or map IDs with `lxc.idmap` entries in `/etc/pve/lxc/101.conf`, as described in the Proxmox
documentation.)

Inside the container (`pct enter 101`), as root:

```sh
apt-get update && apt-get install -y curl ca-certificates sudo ffmpeg tesseract-ocr
curl -fsSL https://deb.nodesource.com/setup_24.x -o nodesource_setup.sh
bash nodesource_setup.sh && apt-get install -y nodejs
adduser lilin                 # gets UID 1000 in a fresh container
usermod -aG sudo lilin
```

## 2. Install

As the `lilin` user (`su - lilin`):

```sh
curl -fsSL https://raw.githubusercontent.com/Tjabooo/lilin/v2.0.0/install.sh -o install.sh
less install.sh
sh install.sh
```

## 3. Configure

Set `MEDIA_DIR=/srv/media`. See [README.md](README.md#first-run).

## 4. Start

`npm start` in `~/lilin`, or let the service start it. Open `http://192.168.1.x:8080` with the
container's address (`hostname -I`).

## 5. Autostart

systemd, system scope, so the unit runs as `lilin` and waits for `/srv/media`:

```sh
node ~/lilin/setup.js service install --scope system
```

Enable "Start at boot" in the container's Options so the container itself starts with the host.

**Alpine LXC instead of Debian:** setup also supports OpenRC and writes `/etc/init.d/lilin`. Check
that Alpine's `nodejs` package is 22.16 or later (`node --version`).

## 6. Update

As on [Debian and Ubuntu](debian-ubuntu.md#6-update). A Proxmox snapshot or backup of the container
before updating is a convenient rollback.

## 7. Troubleshooting

- **`EACCES` writing to `/srv/media`**: the host folder isn't owned by the shifted UID (see above).
- **TVs aren't discovered**: the container must be on a bridge to your LAN (for example `vmbr0`), not
  a NAT network. `DLNA_DEVICES` lists TVs by hand.

More in [../troubleshooting.md](../troubleshooting.md).

## 8. Limitations

- Passing an NVIDIA GPU into an LXC container requires matching drivers on host and container and
  isn't covered here; use a VM with PCI passthrough for NVENC, or encode on the CPU.
- House → Sharing CPU/GPU history and `tools/torrent-vpn` are Windows-only.
