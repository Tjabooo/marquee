# Playback stress test

Checks that streams keep playing while the server is busy. It plays a few files from a running
Lilin the way players do (4 MB range requests, a 10 s buffer, the odd seek) while background work
runs, and reports per stream how long each request took, whether the buffer ran dry and how long a
seek took to play again. On Windows it also records disk latency, queue length and idle time per
disk, CPU per process and GPU encode/decode use (typeperf, nvidia-smi).

```sh
node tools/playback-stress/stress.mjs my-test.json --label before            # everything in the config
node tools/playback-stress/stress.mjs my-test.json --label writer --only writer   # one load
node tools/playback-stress/stress.mjs my-test.json --label idle --no-load     # streams only
```

Results go to `tools/playback-stress/results/<label>.json` (gitignored), with the raw counters as
`<label>-counters.csv`. Run it on the server itself, against `http://127.0.0.1:<PORT>`: that keeps
the network out of the measurement, and an `email` from `ADMIN_EMAILS` is then believed (requests
from this machine are a trusted proxy), which the storyboard and browser copy loads need.

Real viewers come first: if anyone streaming over the internet, or anyone who was already
streaming when the test began, falls behind, the test stops all load at once and says so.

## Loads

| Key | What runs | Like |
| --- | --- | --- |
| `writer` | a sparse file written in 16 KiB blocks into 16 random 4 MiB pieces at a time, capped at `rateMBps` | qBittorrent downloading without preallocation |
| `convert` | ffmpeg repackaging an MKV the way Lilin's converter does (video copied, AAC stereo + E-AC-3 640k), again and again | MKV → MP4 conversion |
| `storyboard` | Lilin's own timeline preview job for that file (its old previews are removed first) | first play of a video |
| `browserCopy` | Lilin's own browser copy for an HEVC file (the old copy is removed first) | a Firefox viewer opening an HEVC film |
| `libraryScanSeconds` | `GET /api/library` every n seconds | library scans |

`convert.apply` can name a module whose default export receives the ffmpeg child process, to test a
scheduling policy on it (`apply-background.mjs` applies Lilin's background priority).

With `"purgeStandby": true` (Windows, as administrator) every run starts with an empty file cache,
so files read in an earlier run aren't served from RAM.

## Config

```json
{
  "lilin": "http://127.0.0.1:8080",
  "email": "owner@example.com",
  "mediaDir": "/path/to/media",
  "cacheDir": "/path/to/lilin/cache",
  "seconds": 180,
  "purgeStandby": false,
  "streams": [
    { "name": "remux", "file": "TV/Show/Show.S01E01.1080p.REMUX.mp4", "bufferSeconds": 10, "seekEverySeconds": 45 },
    { "name": "browser copy", "file": "TV/Other/Other.S01E01.2160p.HEVC.mp4", "browser": true }
  ],
  "load": {
    "writer": { "file": "/path/on/media/drive/stress-writer.bin", "sizeGB": 16, "rateMBps": 110 },
    "convert": { "input": "/path/to/media/Film.mkv", "outDir": "/path/on/media/drive/stress-out", "apply": "apply-background.mjs" },
    "storyboard": "Films/Some Film (2020).mp4",
    "browserCopy": "TV/Other/Other.S01E02.2160p.HEVC.mp4",
    "libraryScanSeconds": 5
  }
}
```

`file` paths are relative to `mediaDir` (as Lilin lists them); `writer.file` and `convert.outDir`
are scratch space on the drive you want to load, and are deleted afterwards.

## Reading the result

- `chunkMs` — how long a 4 MB range request took (p50/p95/max). At 25 Mbit/s a 4 MB request
  holds 1.3 s of video, so anything near that is trouble.
- `playingPct`, `waitingSeconds`, `stalls` — the player's view: share of time playing after the
  first start, time spent waiting (start, stalls and seeks), and how often the buffer ran dry.
- `seekToPlayMs` — from a seek to 2 s of buffer.
- `counters.disks` — `readMs`/`writeMs` (average time per I/O), `queue`, `idle` (%).
