# Marquee revamp: design brief

What the web app should feel like after the revamp, and the rules every screen follows. The tokens and
components named here live in `public/style.css` (top of the file); screens are built from them. The
audit that led here is in [audit.md](audit.md).

## Direction

**The house lights go down.** Marquee is a picture palace in your pocket. The room is dark velvet, the
pictures are as big as the screen allows, and the only warm light is the marquee's bulbs, used the way a
theatre uses its lights: to show you where to look. Art comes first and fills the screen edge to edge;
everything else (chrome, text, controls) is quiet, set in confident type, and steps back into darkness.
Bulb light is spent sparingly: the one primary action on a surface, focus, progress, and things that are
new or live. Motion is calm and physical (a curtain, not a slot machine), and the app should feel alive
without asking for attention: the billboard drifts, cards lift toward you, the new-episode bulb glows.
It is Marquee's own: the velvet, the gold bulb, the Bricolage Grotesque wordmark and the row of marquee
bulbs carry the identity; no other service's logos, names or signature layouts.

## Type

Display: **Bricolage Grotesque** (variable, self-hosted in `public/fonts/`, latin + latin-ext, so
Swedish and accented names render without a network request). Body: the system UI font, for speed and
native feel. Sizes are fluid between a 390 px phone and a 1920 px TV (`clamp()`), so TVs get bigger type
without separate breakpoints.

| Token | Phone → TV | Use |
| --- | --- | --- |
| `--t-display` | 34 → 76 px, 800, −0.03 em | billboard and title-page titles (when there's no logo art) |
| `--t-h1` | 26 → 44 px, 800 | view titles (My library, Settings) |
| `--t-h2` | 18 → 26 px, 700 | row and section titles |
| `--t-h3` | 16 → 20 px, 700 | card groups, sheet titles |
| `--t-body` | 15 → 18 px | text, overviews (16 px minimum in inputs: iOS zoom) |
| `--t-small` | 13 → 15 px | meta lines, card subtitles |
| `--t-kicker` | 11 → 13 px, 700, uppercase, +0.14 em | labels above titles ("Now showing", "New in Marquee") |

Numbers use tabular figures. Lines of prose stop at 68 characters.

## Colour and light

The nine Appearance themes still set the same nine base colours (`--velvet --curtain --seat --line
--paper --dust --bulb --alert --on-bulb`); every new token is mixed from them with `color-mix()`, so
each theme gets the whole new look for free. Nothing in a component uses a literal colour except
fixed-over-picture surfaces (scrims, player chrome), which are always dark whatever the theme.

- **Velvet room:** the page is `--velvet` with a soft stage light from the top (`--room`): a radial
  wash of `--seat` and a hint of `--bulb`, darker toward the bottom.
- **Surfaces** climb in three steps: `--surface-1` (cards, panels: curtain), `--surface-2`
  (raised, pressed: seat), `--surface-glass` (header, tab bar, menus over pictures: velvet at 72 %
  with blur, only on small fixed areas, never on big scrolling ones).
- **Text:** `--text` (paper), `--text-2` (dust), `--text-3` (dust mixed into velvet; captions only).
- **Bulb light:** `--bulb` is reserved for the primary action, focus rings, progress and "new/live"
  bulbs. `--glow` is the bulb's halo (focus, the billboard Play button, lit bulbs). Secondary buttons are
  paper-on-glass, not yellow.
- **Colour wash:** a title page samples its backdrop (a 32 px canvas read of TMDB's image) and uses the
  colour as `--wash`, a gradient behind the page so every title has its own room tone. Falls back to
  `--seat`.
- **Over pictures:** `--scrim-*` gradients (always dark) keep text legible; text over art is
  `--on-image`.

## Space, shape, depth

- Spacing on a 4 px grid: `--s1` 4 · `--s2` 8 · `--s3` 12 · `--s4` 16 · `--s5` 24 · `--s6` 32 ·
  `--s7` 48 · `--s8` 64. Page gutter `--gutter`: 16 px on phones, growing to 64 px on a TV (plus safe
  areas).
- Radii: `--r-xs` 6 (badges) · `--r-sm` 10 (inputs, small buttons) · `--r-md` 14 (cards, rows) ·
  `--r-lg` 22 (panels, sheets) · pills 999.
- Elevation: `--e1` resting cards (hairline + soft shadow) · `--e2` lifted/hovered · `--e3` sheets and
  menus. On light themes shadows are lighter and warmer.
- Cards have a 1 px inner highlight (paper at 6 %), so art reads as a framed print on velvet.

## Motion

| Token | Value | Used for |
| --- | --- | --- |
| `--d-1` | 120 ms | press feedback, colour changes |
| `--d-2` | 220 ms | hover lift, menus, small reveals |
| `--d-3` | 380 ms | sheets, pages, view changes |
| `--d-4` | 900 ms | billboard cross-fades |
| `--ease-out` | `cubic-bezier(.2,.8,.2,1)` | everything entering |
| `--ease-in-out` | `cubic-bezier(.65,0,.35,1)` | cross-fades, scroll-linked |
| `--ease-pop` | `cubic-bezier(.34,1.4,.64,1)` | badges and bulbs appearing |

What moves: what you touch (press scales to .97), what you point at (cards lift 4 % with a glow),
sheets and pages (slide and fade), the billboard (slow cross-fade and a gentle zoom on wide screens),
tab changes (View Transitions cross-fade where supported, nothing elsewhere), progress, and lit bulbs.
What doesn't: text never moves on scroll, no parallax on phones, nothing loops except loading and live
indicators, and the billboard stops while you hover or focus it. With `prefers-reduced-motion` every
movement becomes an instant change or a short fade, autoplaying trailers and slide advancing stop.

## Components

- **Header:** wordmark, then (≥ 900 px) the sections as text links, search, What's new and your face.
  Transparent over the billboard; past 24 px of scroll it turns to glass with a hairline. Phones keep
  the search as an icon that opens a full-width field; the sections stay in the thumb-friendly tab bar.
- **Tab bar (phones, tablets):** glass, icons with labels, the current tab lit with a bulb above it.
- **Billboard (Discover):** full-bleed backdrop (phones 4:5 crop, wide screens up to 82 vh), TMDB logo
  art or the title in display type, one line of meta, two buttons (Play/Add as the lit primary, More
  info as glass), and the slides as a row of marquee bulbs. Swipes on phones, advances every 9 s on
  wide screens, and plays a muted trailer after a few seconds on desktop (never on phones, metered
  connections, Save-Data or reduced motion).
- **Row:** title (`--t-h2`) with an optional kicker and a See all chevron; cards scroll with
  snap and peek past the edge. Arrows are overlays at the row ends on pointer devices only. Rows are
  keyboard friendly (each card is a button, the list scrolls focus into view).
- **Poster card:** 2:3, `--r-md`, lifts and glows on hover/focus. One status badge (top left: In your
  library ✓, On server, New, On its way) that shrinks to an icon on narrow cards; the rating moves
  under the title, so nothing on the art overlaps. Progress is a slim bulb-coloured bar along the
  bottom edge.
- **Landscape card:** 16:9 still for Continue watching, episodes and On its way; progress bar, a play
  glyph on hover, time left in the caption.
- **Peek:** on desktop, resting on a card for half a second opens a larger floating preview (backdrop,
  logo, meta, overview, Play/Add and More info); on phones a long press opens the same preview as a
  sheet. Never on the first tap.
- **Title page:** the sheet becomes a page: full-screen on phones, a wide panel (up to 1180 px) on
  desktop and TV. Backdrop with the colour wash, logo art, meta (year · age rating · runtime or seasons
  · genres · ★), the primary action, secondary actions as icon+label buttons, overview and tagline, a
  cast rail with faces, seasons as tabs with episode rows (still, number, title, runtime, description,
  progress), versions, and More like this.
- **Sheet:** small dialogs (Play on TV, Delete, Download to phone, Watch party…): bottom sheet with a
  handle on phones, a centred dialog (max 520 px) on wide screens; one title, one primary action.
- **Menu:** player menus and pop-overs: glass panel, 44 px rows, the chosen item marked with a lit
  bulb.
- **Buttons:** primary (bulb, one per surface), secondary (glass or surface), quiet (text), icon (44 px
  round). Chips for filters. All have visible `:focus-visible` rings with the bulb glow.
- **States:** skeletons shaped like what's coming (billboard, rows, cards, page), a row of chasing
  bulbs instead of spinners, empty states with an unlit marquee sign and one way forward.

## From phone to TV

| Width | Layout |
| --- | --- |
| < 600 px (phones) | one column, 16 px gutter, tab bar at the bottom, 4:5 billboard, posters ~118 px, title pages full-screen |
| 600–899 px (tablets) | 24–32 px gutter, tab bar, 16:9 billboard, posters ~150 px, title pages full-screen with a two-column header |
| 900–1599 px (desktop) | sections in the header, no tab bar, content to the full width (rows run edge to edge with a 48 px gutter), grids up to 8 columns, title pages as a wide panel, peek on hover |
| ≥ 1600 px (big screens, TVs) | the same layout scaled up with the fluid type and gutters; posters ~220 px, focus rings thicker so a remote's D-pad focus is easy to follow |

Mobile-first CSS: phone styles are the default; wider screens are `min-width` media queries and
container queries on cards. Safe areas (`env(safe-area-inset-*)`) pad the header, tab bar, sheets and
player for installed iPhone apps.
