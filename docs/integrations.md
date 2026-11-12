# Integrations

How to connect the optional services. Each one is off until its settings are filled in; `node setup.js` asks for the common ones and `node setup.js doctor` checks them.

## TMDB

1. Create a free account at [themoviedb.org](https://www.themoviedb.org).
2. Go to **Settings > API** and request an API key.
3. Copy the **API Read Access Token** into `TMDB_TOKEN`.

## qBittorrent

1. In qBittorrent, open **Tools > Options > Web UI** and enable the Web User Interface.
2. Choose a port other than Lilin's (for example `8081`) and set a username and password.
3. Set `QBIT_URL`, `QBIT_USER` and `QBIT_PASS` in `.env`.
4. Recommended: under **Options > Downloads**, set the default save path to a `Downloads` subfolder inside `MEDIA_DIR` (for example `D:\Media\Downloads`). Lilin overrides this per torrent for recognized movies (`Movies`) and shows (`TV`). Unclassified torrents retain qBittorrent's default.

If Lilin signs in but is still refused, enable **Bypass authentication for clients on localhost** in the Web UI settings.

## Torrents through a VPN (Windows)

To keep your own IP out of torrent swarms, `tools/torrent-vpn` puts qBittorrent alone behind a WireGuard VPN (Mullvad, or any provider that gives out WireGuard configs). The rest of the server keeps its normal connection. It fails closed: qBittorrent is bound to the tunnel and fenced in by firewall rules, and a watchdog keeps it that way. See [tools/torrent-vpn/README.md](../tools/torrent-vpn/README.md).

## SVT Play

Sweden's public service broadcaster has a large, free catalogue of documentaries and true crime, much of it missing from torrent sites. No account or key is needed, but it only works from a Swedish address; set `SVT_PLAY=off` elsewhere.

- **Discover → Documentaries** and search show SVT's titles. **Add** saves them to the media folder (`TV/<title>/Season 01/…`, `Movies/<title>/…`) as H.264/AAC MP4 with Swedish subtitles as `.sv.srt`, without re-encoding, so they play everywhere the library does. Pause, resume and remove work as for torrents.
- **Smart Download** takes a title from SVT Play first when it's originally in Swedish and SVT has exactly that title, and otherwise when no torrent can be found.
- Videos SVT marks as copy protected and live broadcasts are refused. Saved copies follow your library's auto-delete rules like everything else; what you may keep and share is up to you and your local law.

Lilin reads SVT's public pages, which can change without notice. If they do, its rows disappear and `[svt]` lines appear in the log; the rest of Lilin carries on.

## OpenSubtitles

1. Create a free account at [opensubtitles.com](https://www.opensubtitles.com).
2. Open your profile, go to **API consumers**, and create a new consumer.
3. Copy its API key into `OPENSUBTITLES_API_KEY`. Add your username and password as well for the higher download limit.

Checking which languages are available doesn't count toward the limit; only downloads do. Each subtitle is saved beside its video as `<name>.<lang>.srt` and never downloaded twice.

## ffmpeg

```powershell
winget install Gyan.FFmpeg
```

On first run the converter processes existing files in the background at below-normal priority. NVENC is used automatically when an NVIDIA GPU is available.

## Shared admin notes and Discord imports

The Notes toolbar is a compact filter selector and overflow menu; Refresh and
Import Discord live in that menu. The single-row composer grows while typing,
and reminder options open from its three-dot menu. On phones, the timeline gets
the remaining screen space rather than being squeezed by permanent controls.

Use **+** to attach photos, videos, audio or documents from your phone or computer.
Multiple files and media-only notes work. Uploads show progress and use 8 MiB
chunks (up to 1 GB per file), retry interrupted chunks, and stay private to
admins. Photos, videos and audio have inline previews where the browser supports
the original format; the original file is always available to download.

Set `NOTES_FILES_DIR=D:\Notes` (or any folder on a data drive) to keep Notes media there.
Copy the contents of the old media folder to the new location before restarting
when changing this setting. Include that directory and `.lilin.db` in private
backups. File names are metadata; stored media uses generated IDs.

Everyone listed in `ADMIN_EMAILS` shares the **Notes** inbox. Ordinary accounts
and the unauthenticated Home network account cannot read or change notes or
fetch their archived files. Notes live in `.lilin.db`; archived attachments
live in `NOTES_FILES_DIR` (default `.lilin-notes-files/`). Include both in private server backups.
Neither the note text nor imported message contents go into the Activity log.

Use the search field for words or word prefixes; several words must all match.
Text inside attached images (screenshots, receipts, photos of signs) is searchable too:
Lilin reads it right after an upload and stores it as hidden keywords on the note; images
posted earlier are read in the background after startup. On Windows this uses the built-in OCR
engine (add languages in Settings › Time & language › Language). On Linux and macOS it uses
Tesseract when installed (`apt install tesseract-ocr`, `brew install tesseract`; `TESSERACT` sets
its path); without it, image text isn't searchable.
Set `NOTES_OCR=off` in `.env` to turn it off.
**Pinned**, **Due**, and **Trash** narrow the view. Reminder dates are shown in
local time, with due reminders highlighted when Notes is open; these are not
background push notifications. Deleted notes can be restored from Trash.

**Import Discord** accepts the MEE6 conversation's `messages.json` or
`messages.csv` from Discord's data package, or a common JSON conversation
export. Preview the count and choose your own author when the file includes
other people or bot replies. Original message IDs and UTC dates are retained;
retrying an import skips existing IDs and never resurrects trashed notes.
Browser uploads preserve attachment links. Those links may expire on Discord.

For an archive that also keeps actual Discord attachments on the server, run:

```powershell
node tools/import-discord-notes.mjs C:\path\to\mee6.json --dry-run
node tools/import-discord-notes.mjs C:\path\to\mee6.json
```

The command uses the first configured admin as the importing account. If a
conversation export has multiple human authors, pass `--author-id YOUR_ID`.
It downloads only HTTPS files from Discord's attachment CDN and image/video
files from Tenor/Giphy, follows only approved-CDN redirects, and limits each file
to 100 MB. Successful files are served
through an admin-only download route with `no-store` and `nosniff`; originals
stay unchanged in Discord. Unavailable files retain their original links and
are counted in a private import report under `.lilin-notes-imports/`.
Do not commit exports, reports, database files, or archived attachments.

## Away from home

TVs are only offered to visitors on the server's home network, since that's the only network the server can see. Direct visits are judged by their LAN address. Visits through Cloudflare Tunnel are compared with the home network's public IPv4 address and IPv6 /64, which the server looks up every 10 minutes through icanhazip.com, Cloudflare or ipify. If no lookup succeeds, casting stays available. Set `CAST_WHEN_AWAY=on` to allow casting from anywhere; `GET /api/network` shows how a request was classified.

## AirPlay and Chromecast from your phone

Wherever you are, the player and the **Play on TV** sheet offer your phone's own AirPlay (Safari) or Chromecast (Chrome on Android) list, so you can use TVs on the network you're on. The TV streams straight from the server at full quality while the phone acts as a remote. With AirPlay, the TV receives the version with the original surround audio.

The TV fetches the video itself and can't sign in to Cloudflare Access, so the player uses signed `/play/` links: each one works for a single file for 12 hours. If Lilin is behind Cloudflare Access, add a second Access application for the path `<your-hostname>/play` with a **Bypass** policy (Include: Everyone). Everything else stays behind your login.

## Smart TVs (DLNA)

Each phone or browser only sees the remote for the TVs it started, so several people can cast to different TVs at once. The TV list shows when someone else is watching a TV, has a button for that TV's remote, and asks for a second tap before taking the TV over.

Most DLNA TVs are discovered automatically; no setup is needed. If yours doesn't appear, add its device description URL (the `LOCATION` it advertises over UPnP) to `DLNA_DEVICES`.

Subtitle support over DLNA varies by manufacturer. Lilin advertises subtitles in the formats used by Samsung, LG and Sony.

## Apple TV

```bash
pip install pyatv
atvremote wizard      # pair once with each Apple TV
```

If the server runs as a scheduled task and can't find `atvscript`, set its full path in `ATVSCRIPT`. AirPlay can't display external subtitle files, so subtitles are available on Apple TV only through the phone or browser player.

## House: reports from your Linux machines

`agents/lilin-house` is a small bash script for each Linux machine at home (needs `curl` and `jq`). It reports disk space, failed services, pending updates (from the waybar update counter's cache), battery, Secure Boot state and the last backup, and only talks to the server on the home network: setup remembers the router's MAC address and nothing is sent anywhere else. On the server, the reports are only accepted with `HOUSE_TOKEN` **and** straight from the LAN; requests through Cloudflare are refused even with the token.

```bash
# on each machine, at home (HOUSE_TOKEN = the same value as in the server's .env)
install -m755 agents/lilin-house ~/.local/bin/
install -m644 agents/lilin-house.{service,timer} ~/.config/systemd/user/
lilin-house setup http://<server-ip>:8080 <HOUSE_TOKEN>
systemctl --user enable --now lilin-house.timer
```

For a status-bar dot, `lilin-house status` prints waybar JSON (`"return-type": "json"`); it hides itself away from home.

The same token reads House → Sharing as JSON from the home network: `curl -H "X-Lilin-Token: $HOUSE_TOKEN" http://<server-ip>:8080/api/house/load` (add `?hours=24` for a day of history). Archfleet's server view uses it.

## House: turn the PC on, and pick Linux or Windows

The **Power** section of the House tab wakes a dual-boot (GRUB) PC with Wake-on-LAN and boots it into the system you tap, or restarts it into another one while it's on.

A PC that's off can't be told what to boot, so Linux decides on the way up. GRUB always starts Linux. `lilin-house boot`, a root timer on the PC, asks the server right after boot (and every 30 s after that) whether a different system was picked. If one was, it sets GRUB's one-shot next entry with `grub-reboot`, the same thing a "reboot to Windows" menu does, and restarts. Waking into Windows therefore passes through Linux for a few seconds. The same check carries **Restart into…** while the PC is on, tells the server the PC's MAC address and boot menu, and switches Wake-on-LAN on for the wired network card on every boot.

On the PC (Arch, at home, with the user agent above already set up):

```bash
sudo pacman -S --needed ethtool
sudo install -m755 agents/lilin-house /usr/local/bin/
sudo install -m600 ~/.config/lilin-house.env /etc/lilin-house.env
sudo install -m644 agents/lilin-house-boot.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now lilin-house-boot.timer
```

The PC shows up under **Power** within 30 seconds. It also needs:

- **A network cable.** Wake-on-LAN almost never works over Wi-Fi from a powered-off PC.
- **Wake-on-LAN on in the BIOS/UEFI**, often called *Wake on LAN*, *Power On By PCI-E* or *Resume by PCI-E device*. Turn off *ErP Ready* / *Deep Sleep*: it cuts power to the network card when the PC is off.
- **GRUB starting Linux by default** (`GRUB_DEFAULT=0`, or `saved` with Linux saved). The card warns you if it doesn't.
- **On Windows:** Fast Startup off (*Control Panel → Power Options → Choose what the power buttons do*), and in *Device Manager → network adapter → Properties*: *Advanced → Wake on Magic Packet* (and *Shutdown Wake-On-Lan*, if present) enabled, *Power Management → Allow this device to wake the computer* ticked. Windows sets up the card for the next wake whenever it's the one that shuts down.

While the PC is in Windows, Lilin sees it as "Off, or in Windows": Windows doesn't run the agent, so it can't be restarted from Lilin.

## Clips and Discord share links

Set `CLIPS_DIR` and the owner gets a **Clips** tab. It shows game clips laid out as
`Kept/<game>/*.mp4` and `Trimmed Clips/`, the way [Clipper](https://github.com/Tjabooo/clipper)
writes them. Clipper is a replay buffer for Linux and Windows: it keeps the last 90 s of your
screen, a hotkey saves it, and kept clips are copied into this folder over your network (it writes
`.part` files first, which Lilin skips, so half-copied clips never show up).

`node setup.js clipper` sets this up:

- creates `CLIPS_DIR` (default: a `Clips` folder next to `MEDIA_DIR`) and sets it in `.env`;
- asks where you play. **This computer**: it downloads Clipper from GitHub and runs its installer
  pointed at `CLIPS_DIR`. **Another Windows or Linux PC**: it prints how to share the folder from
  this server and the one-line install to paste on that PC, with the share and Lilin's address
  filled in;
- asks for the clip quality: a preset (`compact`, `balanced`, `high`, `max`, `smooth`) or a
  benchmark (`bench:quality`, `bench:smooth`, `bench:small`), where Clipper records a few seconds
  of you playing, tries its encoder's settings on it and keeps the best for that goal.

Unattended: `node setup.js clipper --yes --remote windows --quality high --share '\\server\Clips'`,
or `--here --allow-install` to install on this computer. Restart Lilin after `CLIPS_DIR` changes.

Shared clips live under `/c/<token>`: a page with Lilin's player and only that clip (its script and the stylesheet are served at `/c/player.js` and `/c/style.css`), the video itself and a thumbnail. For those links to work for everyone (and for Discord to embed them), let `/c/` past Cloudflare Access, the same way as `/play/`:

Hover over a clip's name to reveal its outline and pencil, then click to rename it.
On touchscreens the pencil stays visible. Clicking outside the field or pressing
Enter saves; Escape cancels before a save starts. Errors keep the draft available
for correction and retry. Names persist across restarts and appear
in search and shared pages. Original files, clip IDs and existing share links
stay unchanged. Include `.lilin-clip-titles.json` in server backups.

1. Cloudflare Zero Trust → **Access → Applications → Add an application → Self-hosted**.
2. Application domain: your Lilin hostname, path `c`.
3. Policy: action **Bypass**, include **Everyone**. Access applies the most specific path, so the rest of Lilin stays behind your login.

Invite links (`/c/i/<token>`) are covered by the same rule. Shared note links (`/c/n/<token>`) are covered too: link-preview bots such as Discordbot get the note's preview (and its first image at `/c/n/<token>/image`); everyone else is redirected to `/?note=<id>` in the protected app. Only shared clips, shared note previews, open invites and the invite card are reachable there. Links are 96-bit random tokens, unknown or unshared tokens get a 404, and unsharing deletes the shared copy. `https://<your-host>/c/` on its own is an invite card for Lilin: paste that in Discord to get an embed of the site itself, and anyone who clicks it is sent on to the normal (protected) app.

## Invites (Zero Trust email list)

Invites add people to a Zero Trust **email list**; your Lilin application's policy allows everyone in it.

1. Zero Trust → **Reusable components → Lists → Create list**: name *Lilin users*, type **Emails**, and add everyone who already has access (yourself included). Save, and copy the list's **ID** (its details page / URL).
2. Zero Trust → **Access controls → Applications** → your Lilin app → its **Allow** policy → Include → **Emails in list** (the selector may be called *Email list*) → *Lilin users*. Your existing email rules can stay.
3. Cloudflare dashboard → **My Profile → API Tokens → Create Token → Custom token**: permission **Account · Zero Trust · Edit**, limited to your account.
4. `.env`: `CF_API_TOKEN`, `CF_ACCOUNT_ID` (dashboard → any domain → Overview, right column) and `CF_ACCESS_LIST_ID`. Restart Lilin.
5. The `/c/` bypass above must be in place: the invite page has to open for someone who can't sign in yet.

In the Activity tab: **Invite someone** (optionally with a note such as "for Leo") copies a link. It works once and expires after `INVITE_DAYS`. The person opens it, enters the email they'll sign in with and is sent to Lilin, where Cloudflare's login page lets them pick a login method; with *One-time PIN* enabled anyone with an email address can sign in, and Google etc. work when the account uses that same address. Everyone with access is listed with a **Remove** button; owners (`ADMIN_EMAILS`) can't be removed there. Only the one address is added or removed; nothing else in the list or the policy changes.

## FlareSolverr

1337x sometimes places its pages behind a Cloudflare check. Lilin first tries each mirror in turn; if all of them are blocked, it can route the request through FlareSolverr.

1. Download the latest release from the [FlareSolverr releases page](https://github.com/FlareSolverr/FlareSolverr/releases) and run it.
2. Set `FLARESOLVERR_URL=http://localhost:8191`.

The first search after a while takes a few seconds while the check is solved; later requests reuse the clearance.

## Keeping media on a separate drive

Set `MEDIA_DIR=D:\Media` in Lilin's `.env`, and set qBittorrent's default save path to `D:\Media\Downloads`. Restart Lilin. For **new** downloads, Lilin creates `D:\Media\Movies` and `D:\Media\TV` when needed and sends their absolute paths to qBittorrent's per-torrent `savepath` field. Episode-by-episode batches always use `TV`; downloads from an identified film or TV page use the corresponding folder; recognized episode/season filenames are also treated as TV. Generic magnets and unclassified torrents use qBittorrent's default save path. All three folders are scanned by the existing library scanner.

This change **does not move existing files**. For existing torrents still registered in qBittorrent, use its **Set Location** command to relocate them safely and preserve seeding. Move only torrents that are finished and not actively checking/downloading, and let qBittorrent complete any move before changing another setting. For older media no longer managed by qBittorrent, you may move files to `Movies` and `TV` manually; Lilin scans both. Moving existing files changes their paths/IDs and may affect watch progress and existing library ownership entries, so back up Lilin's application data first and test a few files before migrating the rest. Avoid making duplicate copies when storage is limited.
