# Hardware acceleration

Marquee re-encodes video only when it has to: an MP4 copy whose video can't simply be copied
(stream copy is used whenever possible), an H.264 copy of HEVC for browsers that can't play HEVC,
and shared clip copies. Everything else (audio fixes, remuxing, previews from keyframes) runs
without a video encoder.

## What Marquee uses

| Encoder | Used for | When |
| --- | --- | --- |
| NVIDIA NVENC (`h264_nvenc`) | Conversions, browser copies, clip shares | ffmpeg lists `h264_nvenc`. If an NVENC encode fails, Marquee switches to libx264 for the rest of the run. |
| libx264 (CPU) | Everything else | Always available in standard ffmpeg builds. |

Other hardware encoders (Intel Quick Sync, VAAPI, AMD AMF, Apple VideoToolbox) are **not used yet**,
even when ffmpeg supports them. `node setup.js doctor` runs a one-second test encode with each
encoder ffmpeg lists and reports which work, so you can see what a future version could use.

## Checking

```sh
node setup.js doctor --offline
```

The **Media tools** section shows the ffmpeg version, the encoder Marquee will use, and whether a
listed NVENC actually works (a driver, a missing `libcuda`, or a session limit makes it fail even
when the GPU is present). House → Sharing (Windows) shows GPU encoder sessions while Marquee runs;
`NVENC_SESSION_LIMIT` (default 8) is how many it assumes the card allows.

## NVIDIA

- **Windows**: a current NVIDIA driver and an ffmpeg build with NVENC (the `Gyan.FFmpeg` winget
  package and the gyan.dev/BtbN builds include it).
- **Linux**: the proprietary driver (`nvidia-smi` works) and an ffmpeg with NVENC: Arch's and
  Debian/Ubuntu's `ffmpeg` packages include it; Fedora needs RPM Fusion's `ffmpeg`, not `ffmpeg-free`.
- **Docker**: install the NVIDIA Container Toolkit on the host, then start with the override:

  ```sh
  docker compose -f docker-compose.yml -f docker/compose.nvidia.yml up -d
  docker compose exec marquee node setup.js doctor --offline
  ```

  The image's Debian ffmpeg includes NVENC; the toolkit provides the driver libraries at runtime.

## Without a supported GPU

libx264 on the CPU works everywhere, at `-preset veryfast`. On small machines (Raspberry Pi, low-end
NAS) a full film conversion can take longer than the film. Options:

- Prefer releases that are already MP4/H.264 when choosing one yourself (Advanced options).
- Set `BROWSER_H264_DAYS=0` and `PREPARE_NEXT_EPISODES=0` so browser copies are only made on demand.
- Set `CONVERT=off` if every device you use plays MKV/HEVC directly.
