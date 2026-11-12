# Lilin web UI audit (before the revamp)

November 2026, master `6c28d20`. Screenshots: `tools/ui-shots` at 390×844, 768×1024, 1440×900 and
1920×1080, English and Swedish. The real library came over the LAN with every non-GET request blocked;
owner screens and edge cases (empty library, 46-episode season, very long titles, failed downloads)
came from a throwaway server with its own `DATA_DIR`. The Samsung TV app (`public/tv`) is out of scope.

## Screen inventory

| Area | Screens and states |
| --- | --- |
| Shell | header (wordmark, What's new, search), bottom tabs (+ owner tabs: Notes, Activity, House, Clips), toast, signed-out banner, "can't reach the server" |
| Discover | home (Trending carousel, Saved, Popular on Lilin, TMDB rows), type filter (All / Films / Shows / Documentaries), genre chips → genre grid + sort, See all grid + Load more, Documentaries (SVT Play rows, true crime), search results, no results, loading skeleton, error + retry, TMDB not set up |
| Title sheet | film (Add to library / Play / versions / Advanced options), show (season picker, quality, Add season, Dubbed), already on the server (Add / Add & play), trailer in the backdrop, thumbs, Save / Follow, cast line, transfer summary (On its way, Play now) |
| Library | toolbar (All / Films / Shows, availability), shared-library note, downloading summary, To phone summary, watch parties, Continue watching, Coming up, Leaving soon, Films / Shows / Unidentified grids, transfer cards (progress, paused, needs attention), convert banner, empty, no matches |
| Film / show pages | backdrop, facts, keep bar (auto-delete countdown), actions (Play/Resume, Play on TV, Watch party, To phone, Delete, Identify film), seasons grid, episode rows (still, Keep, Delete, To phone, TV, party, play), missing / pending episodes, season pack, version pickers, Upgrade |
| Sheets | Play on TV picker, TV remote + nowbar, delete one / many, identify film, Download to phone (one, season, list), plan a watch party, invite list, transfer details, release browser (Find torrents), What's new + history, Wrapped stories, profile picture editor |
| Player | controls, seek preview, subtitles (+ second language, timing), audio, quality / version, bedtime (night mode, sleep timer), keyboard help, stats for nerds, Skip intro, Up next, Play now popups (buffering, full quality ready), spinner, error, OSD |
| Watch Together | room panel (docked ≥1100 px, floating card, phone sheet), roster, host start/countdown, invite, chat, reactions, floats, join ticket, countdown overlay |
| Settings | You (picture, name), What's new, Wrapped, Language, Appearance (9 themes + custom), Watching, Sign in a TV, Jellyfin, Library order, Notifications, Downloads, Your library, account; owner: People, server rules, access + invites |
| Owner tabs | Activity (now, history folds, people), House (machines, VPN, power, sharing load chart, disks, Screen Time), Clips (+ trim editor), Notes |
| Server pages | `/signin`, share pages under `/c/` (clip player, note, invite card, Watch Together link) |

## Findings

**Everywhere**
- Desktop is a phone layout in a 1100 px column: on 1440/1920 screens two thirds of the width is empty,
  the bottom tab bar floats mid-screen, sheets are 640 px boxes. Nothing scales up for TVs.
- No hierarchy of light: the accent yellow is used for buttons, links, badges, meta text and borders
  alike, so nothing stands out. Velvet is a flat fill; there is no depth.
- Type is small and samey: row titles 18 px, card names 14 px, hero titles 24–30 px on any screen.
- Spinners and a pulsing grey block are the only loading states; most transitions are instant cuts.
- Fonts come from Google at runtime; the favicon is an emoji.

**Discover**
- The "hero" is a row of 16:10 cards, not a billboard; on desktop it is a strip of small cards.
- Genre chips are a 20-item horizontal strip that pushes content down; type and genre look alike.
- Small Popular cards: the "On server" badge and the rating collide and both truncate ("On serv ★ 8.6",
  Swedish "På serv"). Badges, rating and "Watched here" fight for the same corners.
- Rows only show TMDB lists; nothing personal (Continue watching, Because you watched, new in your
  library, On its way) is on the home screen.
- Arrow buttons sit beside each row title even on phones; See all is a small yellow text link.

**Title sheet / film and show pages**
- A short 16:9 backdrop, then a plain column: title, grey pill facts, thumbs, a big yellow button.
  No logo art, no runtime/genres, no cast faces, no More like this. Trailer is a small pill.
- On desktop the sheet is a narrow modal; on phones a 90 % bottom sheet that feels temporary.
- Episode rows carry five equal round icon buttons (delete, phone, TV, party, play) plus a keep link:
  noisy and easy to mis-tap. No episode descriptions or running times.
- Seasons are a poster grid you have to open before you see any episode.

**Library**
- Filters, an availability select and three notes stack before any title appears.
- Continue watching cards are small; the poster grid is identical to Discover's.
- Empty library is a grey box with one sentence.
- Transfer cards (progress bulbs, states) are good but visually detached from the cards above.

**Player**
- Phone control row overflows at 390 px: fullscreen is cut off (English and Swedish).
- Desktop controls are tiny (22 px icons on a 1440 px screen); menus are plain lists.
- Title bar text is small; no scrim gradient at the top, so titles can sit on bright video.

**Sheets, menus, dialogs**
- Every small dialog uses the same bottom sheet with a large ✕; on desktop they're centred boxes
  with no relation to what opened them.
- Download to phone sheet prints a stray `false` under the explanation, and two lines are English in
  Swedish ("For a phone screen", "Sharp on a tablet or laptop").

**Settings**
- A long single column of identical cards; on desktop it stays 1100 px wide with no way to jump
  between groups. Segmented controls, selects and code inputs all look different.

**Server pages**
- `/signin` uses its own grey/orange palette and no Lilin identity; share pages each have their own
  look.

**Swedish**
- No clipped labels in the main flows, but long compounds (`Tillgänglighet`, `Inställningar`,
  `Lägg till säsong 1`) already fill their buttons at 390 px: the new design must leave room.
