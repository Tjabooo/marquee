# How Marquee works

## Playback

The Library refreshes automatically while open and after downloads complete or leave the download list. Returning to the page on a phone refreshes it too; unchanged responses preserve the current cards, focus and scroll position.

Videos are streamed with HTTP range requests, so seeking works in every browser and on iOS. Watch progress is stored in the browser, and playback resumes where you left off.

## Conversion

The converter scans the library and finished downloads every two minutes. Any MKV, AVI, WebM, WMV, FLV, TS or MPEG file gets an MP4 copy next to it; once that exists, the library lists the copy instead. H.264 and HEVC video are copied without re-encoding; other codecs are re-encoded. Text subtitles are saved beside the copy as `.srt` files (some TVs refuse MP4s with many subtitle tracks) and image-based subtitles are dropped.

## Browser audio

The player’s **Audio** menu uses the tracks from the browser version actually being played, including any stereo copy conversion added. Browsers that expose a verifiable native audio-track mapping switch directly. Other browsers prepare a separate copy with the chosen audio in AAC and copied video, then switch at the current position while preserving pause, subtitles, volume and fullscreen. Failed preparation keeps the current audio available and offers **Retry**. Audio choices reset for each video. Automatic audio compatibility and timing fixes continue to work; the old manual **Audio out of sync** menu has been replaced.

Output files start with a stereo AAC track, followed by the original tracks, so browsers play them with sound and receivers still get surround. MP4 files downloaded as-is are never modified because qBittorrent may be seeding them; if their audio isn't browser-compatible, a fixed copy is written to `AUDIO_FIX_DIR` and served only to browsers. When you open such a file, it moves to the front of the queue and the player switches to the fixed copy when it's ready.

## Subtitle timing

Subtitles from OpenSubtitles are often made for a different release of the same film, so they can start a few seconds early or late, slowly drift when the release runs at a different frame rate (23.976 vs 25 fps), or be right only in parts because the other release is cut differently (a recap, a longer intro, ad breaks, an extra or missing scene). After a download, Marquee lines the file up in the background against the first of these it finds:

1. a subtitle track inside the video (or the MKV it was converted from), including the display/clear timings of PGS/DVD bitmap captions,
2. a subtitle file Marquee extracted from such a track,
3. subtitles that came with the release (`Subs/<video name>/*.srt`, or `Subs/*.srt` next to a single film),
4. the film's audio, by finding where people are talking.

For the audio, every 10 ms of the main track (the centre channel of a surround mix) is scored for how speech-like it is: loudness inside and outside the voice band, how much it flickers at syllable rate, how strongly it has a voice pitch, and how these change. The weights were fitted to when subtitles are on screen in English and Japanese films and series, and each measure is standardised within the film, so the language, the mix and the loudness don't matter.

The alignment then works in three steps:

1. **Overall match.** The subtitle lines and the reference become on/off signals and are compared at every offset up to ten minutes, for each common frame-rate ratio.
2. **Parts.** Every line picks its own shift from a 0.1 s grid within five minutes of that match. Consecutive lines keep the same shift unless switching gains clearly more than it costs (about ten well-placed lines' worth). The best choice for all lines together is found exactly by dynamic programming, and lines stay in their original order. A part must have at least eight lines and its shift must stand out on its own, otherwise it joins a neighbour. Each part is then refined to 5 ms. The likeliest frame rates are each tried, and they compete on the same measure, so a slow drift isn't mistaken for a staircase of splits.
3. **Check.** The re-timed file is compared with the reference at every other offset again. The fix is applied only when it clearly beats every alternative, otherwise the file is left alone.

Checking against a subtitle track takes about a second. Against the audio it takes roughly 10–20 seconds for a feature film. Hash matches from OpenSubtitles are checked as well, because uploads are often tagged with the wrong release.

The subtitle menu in the player shows the result and has **Undo timing fix**; the original is kept in `cache/subsync/`. **Fix timing** runs the check on demand for subtitles that weren't checked automatically. The **Subtitle offset** buttons (−1 s, −¼ s, +¼ s, +1 s) in the player's subtitle menu and in the TV remote move every line by hand; on a TV the new timing is sent over a moment after the last tap, restarting at the same spot. **Reset offset** puts the lines back. When a file is fixed in parts, the menu says how many. Lines that exist only in the other cut stay near the part they belong to.

Subtitle selection uses the original release's file hash when a converted copy is being played, prefers the matching BluRay/WEB/TV source, and checks episode numbers when choosing a file from a multi-file upload. Identified films are searched by TMDB ID. Existing automatic results (and earlier hash matches) are revisited once with the current engine when subtitles are opened; manual offsets and undone fixes are preserved. **Check timing again** is also available after an uncertain result. Bitmap timing requires the original file to still exist; it aligns text subtitles but does not turn subtitle pictures into text. A weak match is left unchanged.

## Browser copies of MP4s

Downloaded MP4s are never modified, since qBittorrent may still be seeding them. When one won't play in browsers, a browser copy is made in `cache/audio/` and played instead; TVs still get the original. That happens when the audio isn't AAC or MP3 or starts out of sync, and when the video won't play in Safari: HEVC labelled `hev1` (relabelled to `hvc1`, which is quick and keeps the quality), 10-bit H.264, AV1 or other codecs (re-encoded to H.264). Opening such a file in the player moves it to the front of the queue, and playback switches to the copy by itself when it's ready.

HEVC episodes keep their HEVC video in the MP4 copy: that's lossless and quick, and TVs, iPhones, Safari and Chrome play it. Firefox (and browsers built on it, like Zen) can't, so those get an H.264 copy, which takes a minute or two per episode. When that happens, the next episodes of the show (`PREPARE_NEXT_EPISODES`, default 2) get their copies made in the background, so the next one starts right away.

## Download: what, not how

The details sheet of a film or show has one Download (smart-download.js, ranking in recommend.js). Preferences are set once in **Settings → Downloads**: a quality profile (Save Space: compact 1080p or 720p; Balanced, the default: good 1080p at sensible sizes; Best Quality: 4K when there is one), the largest download per film or episode, and an audio language. A fixed resolution chosen before profiles existed keeps working until a profile is picked.

- **Films**: already in your library, on the server (it joins your library) or downloading? Nothing new is queued. Otherwise the best match for the title and year is downloaded: 5+ seeders first, remuxes, burned-in subtitles, Dolby Vision without HDR10 and dubs in another language count against, and a release larger than your limit or the free space on the media disk (minus what queued downloads still need, minus 5 GB) is never chosen. No suitable release: the sheet says why, with Try again.
- **Seasons**: TMDB's aired episodes minus what's already in the library, on the server or in qBittorrent. With three or more missing, a pack of exactly that season (never a multi-season or complete-series bundle) is added; once its file list arrives the episodes you already have are switched off (priority 0), and episodes the pack turns out not to contain are fetched one by one. A pack with nothing new in it is removed again. Fewer missing, or no suitable pack: episode by episode (`SxxExx`, then `1x05` and known aliases like House / House MD, TV category then everywhere). A failed search is retried once; a release qBittorrent rejected isn't picked again for six hours. Episodes that can't be found are listed with **Retry unavailable**.
- **Episodes in order** (episode-order.js): for a season Marquee downloads, the next unfinished episode in a pack gets qBittorrent's top file priority, and separate episode torrents run one at a time (the rest show as Queued). A stalled episode lets the next one run alongside it (up to three). A finished episode is converted to MP4 straight away, even while the rest of its pack downloads. Pausing, resuming or removing one yourself takes it out of the order.
- **Advanced options** on a title: an exact resolution (finds nothing rather than another one) and the release list to pick from yourself.

## Save for later and Follow

Every title sheet has **Save** (films and shows) and **Follow** (shows) (watchlist.js on the server, public/watchlist.js on the page; tables `watchlist` and `follow_episodes` in `.marquee.db`). Saved titles are a row at the top of Discover. A background round every 10 minutes checks what's due, one title at a time, and downloads with the same Download command as the button, as that person and with their quality settings. Automatic downloads need download rights.

- **Films**: a saved film can wait for its release (*Download it when a good copy is out*). The expected date is the earliest digital or disc release on TMDB, else the first release date. Before that it's checked once a day; afterwards the Download command runs (it never takes a cam), and when nothing suitable is out yet it tries again after 1, 2, 4, 8 and 12 hours, then daily. Once a download starts (or the film is already here) it's done.
- **Shows**: following starts after the last episode that had aired when you followed (or switched automatic downloads on), so nothing older downloads by itself. Every 3 hours the show's newest aired episodes are added to a per-episode list and fetched with the Download command for exactly those episodes (it skips episodes in your library, on the server or already downloading). A missing episode is retried with the same pauses and reported as not found 14 days after it aired. Episodes that downloaded this way show a **New** badge on the show's Library card until you open the show.
- **Coming up** (Library): the next episode of each followed show and the release date of each saved film that isn't out yet, soonest first.

## Shows in the library

Films and shows appear as poster cards, separated into Films and Shows inside each library section. A card shows the next deletion countdown; the Leaving soon shelf collects titles with less than 48 hours left and offers a keep button directly on the card. Opening a film or show puts its countdown and keep controls above the synopsis and seasons. Titles without a countdown say that no automatic deletion is scheduled. Film posters, backdrops and descriptions come from TMDB, matched by title and year and cached in `.marquee-shows.json` (30 days for matches, one day for misses); unavailable artwork falls back to the title.

Episodes are recognised from `S01E05`, `S01E01E02`, `1x05` and `Season 1 Episode 5` in the file name. A file named only `S02E05.mkv` takes the show's name from its folder (`The Bear (2022)/Season 2/`). Episodes are grouped into one show when their names match loosely (case, punctuation and a leading "The" are ignored) or when TMDB resolves them to the same show, so episodes from different releases end up together. TMDB supplies the show's and each season's poster and the episode names; lookups are cached in `.marquee-shows.json` (found shows for 30 days, refreshed weekly for new seasons; unknown names are retried daily). Without TMDB, shows are still grouped by name.

## Finished downloads

With `QBIT_REMOVE_FINISHED=on` (the default), a finished download is removed from qBittorrent within a minute, with its files kept, so it never seeds. Categorized downloads go into `MEDIA_DIR/Movies` or `MEDIA_DIR/TV` (unclassified ones use qBittorrent's default, ideally `MEDIA_DIR/Downloads`), so the video stays in the Library and gets its MP4 copy as usual. A download still waiting for subtitles requested with it is stopped first and removed once they're fetched (at most 2 hours later). Downloads saved outside `MEDIA_DIR` are only stopped, so they stay accessible from Library transfer details. Give a torrent the tag `seed` in qBittorrent to keep it seeding. Once a download is removed, its files count as ordinary library files, so `CONVERT_DELETE_ORIGINAL=on` applies to them.

## Accounts

There's no separate login. Cloudflare Access adds the signed-in email to every request (`Cf-Access-Authenticated-User-Email`) and that email is the account; one is created the first time someone opens Marquee. The header is only believed from a trusted proxy or with a verified Access token (see [remote-access.md](remote-access.md#how-accounts-work)). Visits on the home network carry no email and share a "Home network" account. Accounts live in `.marquee.db`, a SQLite database (Node's built-in `node:sqlite`, so still no dependencies): people and their settings, what's in each library, who started each download, and watch progress.

- **One file, many libraries.** A video exists once on disk. "Add to my library" adds it to your list; nothing is copied or downloaded again. A video's identity is its path in `MEDIA_DIR` without the extension, so the MP4 copy and the original count as the same video.
- **Whose download.** Torrents added through Marquee get the qBittorrent tag `marquee-u<id>` (and a magnet's infohash is recorded). When one finishes, its videos go into that person's library, before the no-seeding cleanup removes the torrent. Torrents added straight in qBittorrent count as the owner's (the first address in `ADMIN_EMAILS`). A whole-season download puts episodes that are already on the server into your library instead of downloading them again.
- **Already there.** On the first start with accounts, every video already on the server goes into the owner's library as **kept** (no countdown), so nothing that was there gets auto-deleted. Videos copied into `MEDIA_DIR` by hand later are treated the same way.
- **Auto-delete.** Each video in someone's library has a date it goes: by default 7 days after the download finished (or after it was added from the server). **Keep 7 more days** pushes it back. When the date passes it leaves that person's library, and once it's in nobody's library the file is deleted (with its MP4 copy and subtitles), checked every 10 minutes. A file that's playing is retried later. The owner can change the period (or turn it off), the extension, and how many times a video can be extended, and can exempt someone (**Never auto-delete**) in Settings.
- **Deleting** takes a video out of your library; the file is only deleted when nobody else has it. The owner can also delete it for everyone.
- **Privacy.** People only see their own library and downloads. Search tells them a title is on the server, not whose it is. The owner's Settings tab lists everyone with how much they have.
- **Staying signed in.** How long a sign-in lasts is Cloudflare's setting: Zero Trust → Access → Applications → your Marquee app → **Session duration** (24 hours by default; up to a month). If a sign-in runs out while Marquee is open, it says so and signs back in with one tap.

## Activity

The name chosen in **Settings → Profile** is the default person label in Activity, the access list, download ownership and Watch Together. Activity resolves names when read, so a profile rename also updates older events; email addresses remain searchable and are shown secondarily in the owner's People/access lists. Active watch rooms receive profile-name changes immediately and refresh them on heartbeat/rejoin.

City and country appear beside the OS/browser for people and events, using Cloudflare's `CF-IPCity` and `CF-IPCountry` headers. In the domain's Cloudflare dashboard, go to **Rules → Settings → Managed Transforms** and enable **Add visitor location headers**. Location is approximate (VPNs and mobile carriers can change it), not GPS. No external IP lookup service is called. Old events and direct LAN visits have no inferred location; country-only headers still show the country.

The **Activity** tab shows who has been using Marquee and what they did: downloads started, films watched in the browser, casts to TVs, subtitles fetched and deletions. People are identified by the email they log in to Cloudflare Access with, plus the device and browser; visits through the server's local address show up as "Home network". The tab is only shown to the emails listed in `ADMIN_EMAILS`, and only through the Cloudflare address, since local visits have no email. The last 2,000 entries are kept in `.marquee-activity.jsonl`. Logins themselves (who signed in, when, from where) are in the Cloudflare Zero Trust dashboard under **Logs → Access**.

## Deletion

Deleting a video that belongs to a torrent removes it through qBittorrent, so the torrent stops seeding and no "missing files" errors appear. For multi-file torrents you can delete a single episode (qBittorrent is told not to download it again) or the whole torrent. The MP4 copy, subtitles and audio-fixed copy are deleted too, as are any empty folders left behind.

## What's new

After an update, everyone sees a short **What's new** sheet once, the next time they open Marquee or come back to an open page. The notes are written by hand in `whats-new.json` at the app root, newest first, in plain language for the people who use Marquee (CHANGELOG.md stays the technical record for whoever runs the server):

```json
[{ "id": "2026-11-05", "date": "2026-11-05", "title": "Fresh this week",
   "items": [{ "title": "Skip intro", "text": "A button skips the opening titles." },
             { "title": "Server tool", "text": "Only the owner sees this one.", "audience": "owner" }] }]
```

Each person's settings remember the newest update they've closed (`seenUpdate`). Someone who has never closed one sees only the updates dated on or after the day they joined, so newcomers aren't shown the whole history. At most the three newest unseen updates are shown. The sheet waits while a video is playing or another sheet is open. A page that was left open through an update (the web app's files changed since it loaded) offers **Reload to update**. Settings → What's new lists every update. The file is re-read when it changes, so a note can be fixed without a restart.

## Notifications

Marquee can notify people's phones and computers through **Web Push**, with no dependencies and no third-party account: the server signs each message with its own VAPID key (ES256, RFC 8292) and encrypts it for the device (aes128gcm, RFC 8291), all with `node:crypto`. The key pair is made on first start and kept with the devices in `.marquee-push.json` (mode 600) in `DATA_DIR`; deleting that file means everyone turns notifications on again. `public/sw.js` is a service worker that only shows notifications and opens Marquee when one is tapped (an open Marquee handles the link without reloading); it caches nothing. `manifest.webmanifest` and the icons let phones install Marquee to the Home Screen.

People turn it on per device in **Settings → Notifications** and switch each kind on or off for all their devices:

| Kind | Setting | Sent when |
| --- | --- | --- |
| Downloads ready | `pushDownload` | Something you downloaded (or asked for) landed in your library; a season pack's episodes replace each other's notification |
| New episodes | `pushEpisode` | A show you follow got an episode (downloaded for you, or by someone else), or an episode of a show in your library was downloaded by someone else; once per episode |
| Watch Together invites | `pushWatch` | Someone in a room taps **Invite** and picks you; opens the room's join screen. Off: you aren't offered as an invitee |

Push endpoints must belong to a known push service (Google FCM, Mozilla, Apple, Windows), so a subscription can't make the server POST to an address on your network. A device the push service reports as gone (404/410) is removed. On iPhone and iPad, Apple allows web notifications only for Home Screen apps (iOS 16.4+), which Settings explains. A server reached only over plain `http://` (not localhost) can't use notifications: browsers require https.

## Watch Together

Rooms work in the browser player, including fullscreen. Invite URLs are `/?watch=<random token>` and stay behind the existing Cloudflare sign-in. The room grants access to that title without adding it to each guest's library. Up to 12 viewers can join. Casting is outside synchronized playback: leave the room before using a TV receiver.

The server publishes a shared timeline over Server-Sent Events, with heartbeats to keep Cloudflare Tunnel from buffering or closing the connection. Each browser estimates clock offset from low-round-trip-time samples, starts at a shared future time and compensates for message arrival delay. Small drift is corrected with a bounded playback-rate adjustment; larger drift seeks to the shared position. The group pauses when a member buffers or needs an autoplay gesture and resumes when everyone is ready. This reduces skew but does not promise frame-perfect playback on every device or connection. Each viewer streams separately, so server upload bandwidth must cover all viewers.

Only play/pause/seek and readiness enter room state. Caption tracks and manual offsets remain in each viewer's player; party offset buttons do not edit the shared SRT file. The host's departure pauses playback and hands control to a remaining viewer. Dropped viewers have a 20-second reconnect grace period. Rooms are in memory, expire within 24 hours and end when Marquee restarts. Active rooms protect their media against file deletion; normal retention cleanup retries later.

# Project layout

```text
server.js            entry point (node server.js); the app is in src/
setup.js             setup wizard, doctor, backups, service management (src/setup/)
src/
  server.js          HTTP server, routes and the library
  env.js, paths.js   .env loading, APP_DIR/DATA_DIR and the list of state files
  trust.js           which proxy/identity headers are believed
  config-check.js    setting checks shared by startup and doctor
  accounts.js        people, libraries, progress (SQLite)
  convert.js         MP4 conversion, browser audio, browser copies
  torrents.js, smart-download.js, season.js, release-match.js, recommend.js, download-paths.js, torrent-fetch.js
  subtitles.js, subsync.js
  cast.js            DLNA and Apple TV
  watch.js, watch-page.js   Watch Together
  shows.js, episode-order.js, credits.js, previews.js
  notes*.js, note-share.js  Notes, attachments, OCR, shared previews
  house.js, load.js, screentime.js, clips.js, invites.js, activity.js, live.js, network.js
  setup/             wizard, detection, integrations, services, packages, backups
public/              the web app (plain JavaScript and CSS, no build step)
agents/              marquee-house reporter for Linux machines (bash + systemd units)
scripts/windows/     Task Scheduler service and restart scripts
start-marquee.cmd    Windows launcher the scheduled task runs
tools/               optional extras: torrent-vpn (Windows), Discord notes import
docker/, Dockerfile, docker-compose.yml
tests/               node --test suites
```

State lives in `DATA_DIR` (the Marquee folder unless set): `.marquee.db` (SQLite: accounts, libraries,
progress, Notes), `.marquee-*.json` (caches and small registries; `.marquee-push.json` holds the
notification key), `.marquee-secret`,
`.marquee-notes-files/` and `cache/` (rebuildable copies and previews).

# API

The web client uses a JSON API that can also be scripted. `<kind>` is `lib` for library files or `dl` for downloads.

| Method | Route | Description |
| --- | --- | --- |
| `GET` | `/api/status` | Enabled features |
| `GET` | `/api/activity` | Recent activity and people (`ADMIN_EMAILS` only) |
| `POST` | `/api/watch` | Host a library title (`{ id, clientId, position }`), returns a private room token |
| `GET` | `/api/watch/clock` | Server clock sample for latency compensation |
| `GET` | `/api/watch/<token>/preview` | Title and host for the join screen (normal sign-in required) |
| `POST` | `/api/watch/<token>/join`, `/heartbeat`, `/control`, `/leave` | Room membership and playback; all use `clientId`, control adds `{ action, position }`, heartbeat adds `{ ready, buffering, blocked, rtt }` |
| `GET` | `/api/watch/<token>/events?clientId=` | Immediate timeline updates over SSE (joined viewers only) |
| `GET` | `/api/watch/<token>/play-link?clientId=` | Browser stream for the room's title (joined viewers only) |
| `GET` | `/api/watch/<token>/invitees?clientId=` | People you can invite with a notification (`people: [{ id, name }]`; joined viewers only) |
| `POST` | `/api/watch/<token>/invite` | Notify people about the room (`{ clientId, userIds }`; each person once every two minutes) |
| `GET` | `/api/push` | The server's VAPID public key and your devices with notifications on |
| `POST` | `/api/push/subscribe` | Turn notifications on for a device (`{ subscription, label?, replaces? }`, the browser's `PushSubscription.toJSON()`) |
| `POST` | `/api/push/unsubscribe` | Turn them off (`{ endpoint }` for this device or `{ id }` from the list) |
| `POST` | `/api/push/test` | Send a test notification to your devices |
| `GET` | `/api/trending`, `/api/search?q=` | TMDB titles |
| `GET` | `/api/library` | Your library (`items`, with `expiresAt`), and what else is on the server (`server`) |
| `POST` | `/api/library/add` | Add videos already on the server to your library (`{ ids }`) |
| `POST` | `/api/library/extend` | Keep videos longer (`{ ids }`) |
| `GET`, `POST` | `/api/library/identify` | Owner only: search film candidates (`?id=&q=`) or assign a TMDB identity to one file (`{ id, tmdbId }`) |
| `GET` | `/api/library/delete-info?id=` | What deleting an item would remove, and how many others have it |
| `POST` | `/api/library/delete` | Remove from your library; deletes the file or torrent when nobody else has it (`{ id, scope: "file" \| "torrent", everyone? }`) |
| `GET` | `/signin` | Sign-in page (public; redirects home when already signed in) |
| `POST` | `/api/auth/login` | `{ email, password }` as JSON, or the sign-in form; sets the session cookie. Public |
| `POST` | `/api/auth/logout` | Ends this browser's session. Public |
| `POST` | `/api/auth/password` | `{ current, next }`: change your Marquee password (signs out other sessions) |
| `GET` | `/api/auth/status` | How this request is identified (`via`: proxy, session, home or null). Public |
| `GET`, `POST` | `/api/me` | You and your settings (`{ name?, theme?, subLang?, quality?, startView?, librarySort?, seenUpdate?, skipIntro?, pushDownload?, pushEpisode?, pushWatch? }`); `skipIntro`: `button` or `auto` |
| `GET` | `/api/media/<lib\|dl>/<id>/credits` | When the closing credits start (`{ creditsAt }`, seconds or `null`) |
| `GET` | `/api/media/<lib\|dl>/<id>/intro` | The opening titles to skip (`{ intro: { start, end } }` in seconds, or `intro: null`) |
| `GET` | `/api/whats-new` | Every update's notes (`updates`, newest first) and the newest one you've seen (`seen`); `/api/status` carries `whatsNew: { latest, unseen, build }` |
| `GET`, `POST` | `/api/me/progress` | Where you stopped watching (`{ ref, time, duration }`; `time: null` = finished) |
| `GET`, `POST` | `/api/admin/settings` | Auto-delete rules and defaults (`ADMIN_EMAILS` only) |
| `GET` | `/api/admin/users` | Everyone who has used Marquee, with their library size (`ADMIN_EMAILS` only) |
| `POST` | `/api/admin/users/<id>` | `{ canDownload?, keep? }` (`ADMIN_EMAILS` only) |
| `GET` | `/api/downloads` | Your qBittorrent downloads (`?all=1`: everyone's, owner only) |
| `POST` | `/api/downloads/add` | Add a magnet or `.torrent` URL (`{ link, subs?, movieId? }`); `movieId` carries the selected TMDB film identity |
| `POST` | `/api/downloads/smart` | Download a film or season (`{ type: "movie" \| "tv", tmdbId, season?, episodes?, profile?, quality? }`), returns `{ id }` |
| `GET` | `/api/downloads/smart/:id` | That command's state: `running`, then `outcome` (`started`, `partial`, `have`, `queued`, `none`) with a plain `message` and `unavailable` episodes |
| `GET` | `/api/watchlist` | Your saved and followed titles (`items`: `type`, `id`, `title`, `saved`, `follow`, `auto`, `release`, `nextEpisode`, `state`, `note`, `newEpisodes`, `waiting`, `missed`) and whether automatic downloads are open to you (`autoDownload`) |
| `POST` | `/api/watchlist` | Save, follow or switch automatic downloads (`{ type, tmdbId, saved?, follow?, auto? }`); returns the `item`, or `null` once it's neither saved nor followed |
| `POST` | `/api/watchlist/seen` | Clear a followed show's New badge (`{ tmdbId }`) |
| `GET` | `/api/torrents/search?q=&type=` | Torrent search (`type`: `movie`, `tv` or `all`) |
| `GET` | `/api/torrents/magnet?ref=` | Magnet link for a 1337x result |
| `GET` | `/api/convert` | Conversion progress |
| `GET` | `/api/subs/langs` | Subtitle languages for a file (`kind`, `id`) or title (`q`, `type`) |
| `POST` | `/api/subs/fetch` | Download subtitles (`{ kind, id, lang }`) |
| `GET` | `/api/subs/file/<kind>/<id>/<lang>.vtt` | Subtitles as WebVTT (`.srt` also available) |
| `GET` | `/api/subs/sync` | Timing check state for saved subtitles (`kind`, `id`, `lang`) |
| `POST` | `/api/subs/sync` | Fix, undo or shift subtitle timing (`{ kind, id, lang, action: 'sync' \| 'undo' \| 'shift', seconds }`) |
| `GET` | `/api/stream/<kind>/<id>` | Video stream with range support |
| `GET` | `/api/play-link?kind=&id=&variant=` | Signed `/play/` link (`variant`: `browser` or `tv`). Optional `audio` stream index + `audioSource` fingerprint prepares a selected-audio browser variant; 202 while preparing, 200 when ready. |
| `GET` | `/play/...` | Video stream through a signed link; works without signing in |
| `GET` | `/api/cast/devices`, `/api/cast/sessions` | TVs and what's playing |
| `GET` | `/api/network` | Whether the request is from the home network, for troubleshooting |
| `POST` | `/api/cast/play` | Start playback on a TV |
| `GET` | `/api/house` | Server health and home machines (`ADMIN_EMAILS` only) |
| `POST` | `/api/house/report` | A machine's report (`X-Marquee-Token`, home network only) |
| `GET` | `/api/house/summary` | Issues, machines at home and the server's uptime, free space and services, for status bars and the MAGI panel (`X-Marquee-Token`, home network only) |
| `POST` | `/api/house/boot` | A dual-boot machine's boot menu and network card; the reply says whether to restart, and into what (`X-Marquee-Token`, home network only) |
| `POST` | `/api/house/power` | `{ host, action: "wake" \| "restart", entry? }`: wake a machine into a boot entry, or restart it (`ADMIN_EMAILS` only) |
| `GET` | `/api/clips` | Clips and their share state (`ADMIN_EMAILS` only) |
| `POST` | `/api/clips/<id>/rename` | Set a display name (`{ title, previousTitle? }`); keeps files and share links unchanged (`ADMIN_EMAILS` only) |
| `GET` | `/api/clips/<id>/thumb.jpg`, `/api/clips/<id>/video` | Thumbnail and video (`ADMIN_EMAILS` only) |
| `POST` | `/api/clips/<id>/share`, `/api/clips/<id>/unshare` | Create or remove a public link (`ADMIN_EMAILS` only) |
| `GET` | `/api/clips/<id>/keyframes` | Duration and keyframe times, for the editor (`ADMIN_EMAILS` only) |
| `POST` | `/api/clips/<id>/trim` | Lossless edit (`{ segments: [{ start, end }, …], deleteOriginal? }`, or a single `start`/`end`) into `Trimmed Clips/<Game>/` (`ADMIN_EMAILS` only) |
| `POST` | `/api/admin/notes/<id>/share`, `/api/admin/notes/<id>/unshare` | Make or remove a note's preview link; returns `{ note, url }` (`ADMIN_EMAILS` only) |
| `POST` | `/api/clips/<id>/delete` | Delete a clip: link and copies removed, file moved to `CLIPS_DIR/.deleted/` for 30 days (`ADMIN_EMAILS` only) |
| `GET` | `/api/access` | Who can sign in + invite links (`ADMIN_EMAILS` only) |
| `POST` | `/api/access/invite`, `/api/access/invite/<id>/revoke`, `/api/access/remove` | Make or cancel an invite, remove someone's access (`ADMIN_EMAILS` only) |
| `GET`, `POST` | `/c/i/<token>` | Public: the invite page and its email form |
| `GET` | `/c/`, `/c/<token>`, `/c/<token>/video.mp4`, `/c/<token>/thumb.jpg`, `/c/player.js`, `/c/style.css` | Public: invite card and shared clips (a player page for one clip), with OpenGraph tags for Discord |
| `GET` | `/c/n/<token>`, `/c/n/<token>/image` | Public: a shared note's preview for link-preview bots; people are redirected to `/?note=<id>` |
