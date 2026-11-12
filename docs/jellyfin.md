# Jellyfin

People who run their own [Jellyfin](https://jellyfin.org) can watch their Lilin library in it with the
[Lilin plugin for Jellyfin](https://github.com/Tjabooo/jellyfin-plugin-lilin). Their films and shows
become normal Jellyfin libraries, so every Jellyfin app (TVs, phones, Kodi, the web) can play them. The
video streams from the Lilin server; their own Jellyfin server converts it if a device needs that.

## Connecting a Jellyfin server

1. In Jellyfin: **Dashboard → Plugins → Repositories**, add
   `https://raw.githubusercontent.com/Tjabooo/jellyfin-plugin-lilin/main/manifest.json`, install
   **Lilin** from the Catalog and restart Jellyfin.
2. **Dashboard → Plugins → Lilin**: enter the address they open Lilin at (the `PUBLIC_URL`, or the
   home-network address when the Jellyfin server is in the same house) and press **Get a code**.
3. In Lilin: **Settings → Jellyfin**, enter the code.

The plugin syncs straight away and then every 15 minutes. **Settings → Jellyfin** lists the connected
servers with when each last synced; **Disconnect** cuts one off. Up to ten servers per person.

## What the Jellyfin server gets

- The person's library as Lilin shows it (shared libraries included), but not titles still converting.
- One link per video, signed for that video and that connection. A leaked `.strm` file opens one video;
  it can't list the library or reach anything else.
- Subtitles saved beside each video.
- Whatever it reports as watched goes to that person's Continue watching (everyone on that Jellyfin
  counts as them).

Streams count in House → Sharing like any other playback.

## API

Everything is under `/c/jf/v1`, the `/c/` path Cloudflare Access already bypasses (see
[remote-access.md](remote-access.md#what-stays-public)), because a Jellyfin server can't sign in to
Cloudflare. Lilin checks a key or a signature on every call.

| Call | Auth | What it does |
| --- | --- | --- |
| `POST /pair/start` `{ name }` | none (10 a minute per address) | Starts pairing: `{ code, poll, expiresIn }`. The code is shown in Jellyfin; `poll` stays secret there. |
| `GET /pair/poll?id=` | the poll id | `{ state: waiting \| approved \| expired }`; on approval the key, once. |
| `GET /me` | key | The account and connection names. |
| `GET /library` | key | `{ films, shows: [{ episodes }] }` with TMDB ids, media keys, signed `stream` and subtitle paths, and Continue watching positions. |
| `POST /progress` `{ key, position, duration }` or `{ key, finished: true }` | key | Saves progress as `m:<media key>`. |
| `POST /disconnect` | key | Deletes the key. |
| `GET /s/<link>/<sig>/<id>/<name>` | signature | The video, with range requests. |
| `GET /t/<link>/<sig>/<id>/<lang>.srt` | signature | Saved subtitles. |

The key goes in `Authorization: Bearer liljf_…`. Approving a code is `POST /api/jellyfin/approve { code }`
from a signed-in session, with the same wrong-code limits as signing in a TV; `GET /api/jellyfin` lists
connections and `POST /api/jellyfin/<id>/remove` removes one.

Keys are stored as SHA-256 hashes in the `jellyfin_links` table of `.lilin.db`, next to a per-connection
secret that signs the links (HMAC-SHA256, 128 bits). Removing the connection deletes both, so every link
made with it stops working at once. Removing someone from the access list removes their connections too.

A signed link names the video by its library id. If the video was converted to MP4 since the plugin's last
sync, the link finds it again by its media key, so it keeps working until the next sync rewrites it.
