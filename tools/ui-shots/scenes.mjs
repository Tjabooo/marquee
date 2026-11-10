// Screens for shoot.mjs. Each scene: path, a selector that means "ready", steps run in the page
// (async JS with the __click/__clickText/__waitFor helpers), optional API mocks/patches, sizes, full page.
// Steps go by selectors and English|Swedish text so one list covers both languages.

const shelfCard = (re, nth = 0) => `
  const shelf = [...document.querySelectorAll('#discover-body .shelf, #library-body .shelf')].find((s) => /${re}/i.test(s.querySelector('h3')?.textContent || ''));
  if (!shelf) throw new Error('no shelf ${re}');
  const card = shelf.querySelectorAll('.title-card')[${nth}];
  card.scrollIntoView({ block: 'center' }); card.click();`;
const sheetOpen = "await __waitFor('#sheet.open #sheet-title'); await __sleep(700);";
const libraryCard = (type) => `
  await __waitFor('.unified-library .lib-group .title-card');
  const groups = [...document.querySelectorAll('.unified-library .lib-group')].filter((g) => !g.hidden);
  const group = groups.find((g) => /${type === 'tv' ? 'shows|serier' : 'films|filmer'}/i.test(g.querySelector('h3')?.textContent || '')) || groups[0];
  const card = group.querySelector('.title-card'); card.scrollIntoView({ block: 'center' }); card.click();`;
const typeSearch = (q) => `const i = document.querySelector('#q'); i.focus(); i.value = ${JSON.stringify(q)}; i.dispatchEvent(new Event('input')); await __sleep(400);`;
const filmPage = [libraryCard('movie'), sheetOpen];
const openPlayer = ["await __click('#sheet .library-film-actions .play-btn'); await __waitFor('#player:not([hidden])'); await __sleep(5000); const v = document.querySelector('#video'); v.pause(); await __sleep(500);"];
const menu = (sel) => `const b = document.querySelector('${sel}'); if (b && !b.hidden) { b.click(); await __sleep(700); } else return 'no ${sel}';`;

const MOCK_SESSION = { id: 'mock-session', deviceId: 'living-room', title: 'Arrival', deviceName: 'Living room TV', state: 'playing', position: 1260, duration: 6960, mine: true, kind: 'dlna' };
const dl = (o) => ({ mediaType: 'movie', tmdbId: null, showKey: null, showId: null, poster: null, backdrop: null, added: Date.now() - 3600e3,
  ready: false, hasVideo: true, episodes: [], canPlayNow: false, packFiles: 1, skippedFiles: 0, dualAudio: false, others: false,
  libraryIds: [], mine: true, canManage: true, speed: 0, eta: null, seeds: 0, swarmSeeds: 0, size: 4.2e9, transferComplete: false,
  done: false, converting: false, convertPercent: null, subs: [], ...o,
  files: [{ name: `${o.name}.mkv`, size: 4.2e9, progress: o.progress, available: false, index: 0, mediaKey: null, libraryId: null }] });
const DOWNLOADS_ON = { '^/api/status$': (j) => { j.downloads = true; return j; } };
const MOCK_DOWNLOADS = [
  dl({ hash: 'a'.repeat(40), name: 'Dune.Part.Two.2024.2160p.WEB-DL', title: 'Dune: Part Two', canonicalTitle: 'Dune: Part Two', year: 2024, progress: 0.42, speed: 6.4e6, eta: 380, seeds: 41, swarmSeeds: 380, state: 'downloading', canPlayNow: true }),
  dl({ hash: 'b'.repeat(40), name: 'Oppenheimer.2023.1080p.BluRay', title: 'Oppenheimer', canonicalTitle: 'Oppenheimer', year: 2023, progress: 0.07, state: 'stalledDL', seeds: 0, swarmSeeds: 0 }),
  dl({ hash: 'c'.repeat(40), name: 'Past.Lives.2023.1080p', title: 'Past Lives', canonicalTitle: 'Past Lives', year: 2023, progress: 0.63, state: 'error' }),
  dl({ hash: 'd'.repeat(40), name: 'Severance.S02.1080p.ATVP.WEB-DL', title: 'Severance', canonicalTitle: 'Severance', mediaType: 'tv', showKey: 'severance', showId: 'name-severance', season: 2, progress: 0.18, speed: 2.1e6, eta: 2400, seeds: 12, state: 'queuedDL' }),
];

export const SCENES = [
  // ---- Discover ----
  { name: 'discover', path: '/', ready: '#discover-body .shelf' },
  { name: 'discover-rows', path: '/', ready: '#discover-body .shelf', steps: ['window.scrollTo(0, innerHeight * 1.5); await __sleep(500);'] },
  { name: 'discover-films', path: '/', ready: '#discover-body .shelf', steps: ["await __click('.discover-filters .segmented button:nth-child(2)'); await __waitFor('#discover-body .shelf');"] },
  { name: 'discover-genres-open', path: '/', ready: '#discover-body .shelf', steps: ["await __click('.genres-toggle'); await __sleep(500);"] },
  { name: 'discover-genre', path: '/', ready: '#discover-body .shelf', steps: ["const t = document.querySelector('.genres-toggle'); if (t) { t.click(); await __sleep(300); } await __click('.genre-chips .chip:nth-child(4)'); await __waitFor('#discover-body .grid .title-card');"] },
  { name: 'discover-see-all', path: '/', ready: '#discover-body .shelf', steps: ["await __click('.see-all'); await __waitFor('#discover-body .grid .title-card');"] },
  { name: 'discover-docs', path: '/', ready: '#discover-body .shelf', steps: ["await __click('.discover-filters .segmented button:nth-child(4)'); await __sleep(3500);"] },
  { name: 'search', path: '/', ready: '#discover-body .shelf', steps: [typeSearch('house'), "await __waitFor('#discover-body .grid .title-card');"] },
  { name: 'search-empty', path: '/', ready: '#discover-body .shelf', steps: [typeSearch('zzqxjvwq'), "await __waitFor('#discover-body .notice');"] },
  { name: 'title-film', path: '/', ready: '#discover-body .shelf', steps: [shelfCard('popular films|populära filmer'), sheetOpen] },
  { name: 'title-film-more', path: '/', ready: '#discover-body .shelf', steps: [shelfCard('popular films|populära filmer'), sheetOpen, "const s = document.querySelector('#sheet'); s.scrollTo(0, s.scrollHeight); await __sleep(400);"] },
  { name: 'title-show', path: '/', ready: '#discover-body .shelf', steps: [shelfCard('popular shows|populära serier'), sheetOpen] },
  { name: 'title-show-add', path: '/', ready: '#discover-body .shelf', steps: [shelfCard('popular shows|populära serier', 3), sheetOpen,
    "const b = document.querySelector('#sheet .action-row button'); if (b) { b.click(); await __sleep(1500); }"] },

  { name: 'peek-hover', path: '/', ready: '#discover-body .shelf .title-card', sizes: ['desktop', 'tv'], steps: [
    "const c = [...document.querySelectorAll('#discover-body .shelf-items .title-card')].filter((b) => b._title)[2]; c.scrollIntoView({ block: 'center' }); await __sleep(400);",
    { mouse: 'peek card', fallback: "[...document.querySelectorAll('#discover-body .shelf-items .title-card')].filter((b) => b._title)[2]" }, "await __sleep(1400);"],
    probe: "return JSON.stringify({ hover: matchMedia('(hover: hover)').matches, fine: matchMedia('(pointer: fine)').matches, hovered: !!document.querySelector('.title-card:hover'), peek: document.querySelector('.peek')?.className });" },
  { name: 'peek-press', path: '/', ready: '#discover-body .shelf .title-card', sizes: ['phone', 'tablet'], steps: [
    "const c = [...document.querySelectorAll('#discover-body .shelf-items .title-card')].filter((b) => b._title)[1]; c.scrollIntoView({ block: 'center' }); await __sleep(300); const r = c.getBoundingClientRect(); c.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', bubbles: true, clientX: r.x + 20, clientY: r.y + 20 })); await __sleep(900);"],
    probe: "const p = document.querySelector('.peek'); return JSON.stringify({ hidden: p?.hidden, cls: p?.className, title: !!document.querySelector('#discover-body .shelf-items .title-card')?._title, n: document.querySelectorAll('.peek').length });" },

  // ---- Library ----
  { name: 'library', path: '/#library', ready: '.unified-library' , after: 1500 },
  { name: 'library-grid', path: '/#library', ready: '.unified-library .lib-group .title-card', steps: ["document.querySelector('.unified-library .lib-group:not([hidden])').scrollIntoView(); window.scrollBy(0, -80); await __sleep(400);"] },
  { name: 'library-film', path: '/#library', ready: '.unified-library .lib-group .title-card', steps: filmPage },
  { name: 'library-show', path: '/#library', ready: '.unified-library .lib-group .title-card', steps: [libraryCard('tv'), sheetOpen] },
  { name: 'library-season', path: '/#library', ready: '.unified-library .lib-group .title-card', steps: [libraryCard('tv'), sheetOpen,
    "const se = document.querySelector('#sheet .season-grid .title-card'); if (se) { se.click(); await __sleep(900); } const r = document.querySelector('#sheet .episode-row'); r?.scrollIntoView({ block: 'center' }); await __sleep(500);"] },
  { name: 'picker', path: '/#library', ready: '.unified-library .lib-group .title-card', steps: [...filmPage, "await __clickText('^(Play on TV|Spela på TV)$'); await __waitFor('#picker.open'); await __sleep(1500);"] },
  { name: 'delete', path: '/#library', ready: '.unified-library .lib-group .title-card', steps: [...filmPage, "await __clickText('^(Delete|Radera)$'); await __waitFor('#picker.open'); await __sleep(1200);"] },
  { name: 'travel', path: '/#library', ready: '.unified-library .lib-group .title-card', steps: [...filmPage, "await __clickText('^(To phone|Till telefonen)$'); await __waitFor('#picker.open'); await __sleep(1500);"] },

  // ---- Player (paused, so the controls stay up) ----
  { name: 'player', path: '/#library', ready: '.unified-library .lib-group .title-card', steps: [...filmPage, ...openPlayer] },
  { name: 'player-subs', path: '/#library', ready: '.unified-library .lib-group .title-card', steps: [...filmPage, ...openPlayer, menu('#cc-btn')] },
  { name: 'player-quality', path: '/#library', ready: '.unified-library .lib-group .title-card', steps: [...filmPage, ...openPlayer, menu('#quality-btn')] },
  { name: 'player-bedtime', path: '/#library', ready: '.unified-library .lib-group .title-card', steps: [...filmPage, ...openPlayer, menu('#night-btn')] },
  { name: 'player-audio', path: '/#library', ready: '.unified-library .lib-group .title-card', steps: [...filmPage, ...openPlayer, menu('#sync-btn')] },
  { name: 'player-help', path: '/#library', ready: '.unified-library .lib-group .title-card', sizes: ['desktop', 'tv'], steps: [...filmPage, ...openPlayer,
    "document.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true })); await __sleep(500);"] },

  // ---- Settings ----
  { name: 'settings', path: '/#settings', ready: '#settings-body .settings-group, #settings-body section, #settings-body h3', full: true, after: 1200 },
  { name: 'whats-new', path: '/', ready: '#discover-body .shelf', whatsNew: true, after: 2500 },

  // ---- States ----
  { name: 'offline', path: '/', ready: '#discover-body .notice', mocks: { '^/api/status$': { __status: 503 } } },

  // ---- Owner screens and edge cases: a throwaway local server (--as owner@…, see README) ----
  { name: 'owner-library', path: '/#library', ready: '.unified-library .lib-group .title-card', after: 1500 },
  { name: 'owner-season-46', path: '/#library', ready: '.unified-library .lib-group .title-card', steps: [
    "const c = [...document.querySelectorAll('.unified-library .title-card')].find((b) => /One Piece/.test(b.textContent)); c.click();", sheetOpen,
    "const r = document.querySelectorAll('#sheet .episode-row'); r[Math.min(30, r.length - 1)]?.scrollIntoView({ block: 'center' }); await __sleep(600);"] },
  { name: 'owner-long-title', path: '/#library', ready: '.unified-library .lib-group .title-card', steps: [
    "const c = [...document.querySelectorAll('.unified-library .title-card')].find((b) => /Jesse James/.test(b.textContent)); c.scrollIntoView({ block: 'center' }); await __sleep(400); c.click();", sheetOpen] },
  { name: 'owner-long-title-card', path: '/#library', ready: '.unified-library .lib-group .title-card', steps: [
    "const c = [...document.querySelectorAll('.unified-library .title-card')].find((b) => /Jesse James/.test(b.textContent)); c.scrollIntoView({ block: 'center' }); await __sleep(600);"] },
  { name: 'owner-downloads', path: '/#library', ready: '.unified-library', mocks: { '^/api/downloads': () => ({ items: MOCK_DOWNLOADS }) }, patch: DOWNLOADS_ON, after: 1500 },
  { name: 'owner-downloads-home', path: '/', ready: '#discover-body .shelf', mocks: { '^/api/downloads': () => ({ items: MOCK_DOWNLOADS }) }, patch: DOWNLOADS_ON, steps: ["document.querySelector('.home-shelf, .continue-shelf')?.scrollIntoView({ block: 'center' }); await __sleep(500);"] },
  { name: 'owner-downloads-only', path: '/#library', ready: '.unified-library', mocks: { '^/api/downloads': () => ({ items: MOCK_DOWNLOADS }) }, patch: DOWNLOADS_ON,
    steps: ["const s = document.querySelector('.library-availability select'); s.value = 'downloading'; s.dispatchEvent(new Event('change')); await __sleep(800);"] },
  { name: 'owner-library-empty', path: '/#library', ready: '.unified-library', mocks: { '^/api/library': { items: [], server: [], shows: [] }, '^/api/downloads': { items: [] } }, after: 1200 },
  { name: 'owner-settings', path: '/#settings', ready: '#settings-body h3', full: true, after: 1500 },
  { name: 'owner-activity', path: '/#activity', ready: '#activity-body', full: true, after: 1500 },
  { name: 'owner-house', path: '/#house', ready: '#house-body', full: true, after: 2000 },
  { name: 'owner-clips', path: '/#clips', ready: '#clips-body', after: 1500 },
  { name: 'owner-notes', path: '/#notes', ready: '#notes-body', after: 1500 },
  { name: 'owner-wrapped', path: '/#settings', ready: '#settings-body h3', steps: ["await __clickText('(Wrapped)', '#settings-body button, #settings-body a'); await __sleep(1800);"] },
  { name: 'owner-nowbar', path: '/', ready: '#discover-body .shelf', mocks: { '^/api/cast/sessions': { sessions: [MOCK_SESSION] } }, after: 1000 },
  { name: 'owner-remote', path: '/', ready: '#nowbar:not([hidden])', mocks: { '^/api/cast/sessions': { sessions: [MOCK_SESSION] }, '^/api/cast/living-room/status': { state: 'playing', position: 1260, duration: 6960, volume: 0.6 } }, steps: ["document.querySelector('#nowbar').click(); await __sleep(1500);"] },
  { name: 'owner-watch-room', path: '/#library', ready: '.unified-library .lib-group .title-card', steps: [
    "const c = [...document.querySelectorAll('.unified-library .title-card')].find((b) => /^Arrival/.test(b.querySelector('.name')?.textContent || '')); c.click();", sheetOpen,
    "await __click('#sheet .library-film-actions .play-btn'); await __waitFor('#player:not([hidden])'); await __sleep(2500); document.querySelector('#video').pause();",
    "document.querySelector('#player').dispatchEvent(new MouseEvent('mousemove', { bubbles: true })); await __sleep(300);",
    { mouse: '#watch-btn', click: true }, "await __sleep(2500);"],
    probe: "return 'status: ' + document.querySelector('#watch-status')?.textContent;" },
  { name: 'signin', path: '/signin', ready: 'form', signedOut: true },
  { name: 'signin-error', path: '/signin?error=wrong', ready: 'form', signedOut: true },
  { name: 'share-invite', path: `/c/i/${process.env.MQ_INVITE || 'x'}`, ready: 'body', signedOut: true },
  { name: 'share-clip', path: `/c/${process.env.MQ_CLIP || 'x'}`, ready: 'body', signedOut: true, after: 2500 },
  { name: 'share-watch', path: `/c/w/${process.env.MQ_ROOM || 'x'}`, ready: 'body', signedOut: true },

  // ---- End to end through the preview switch: /preview → Discover → a title → play → Watch Together → Settings → back to live.
  // Run without --preview (it goes through /preview itself) and with --allow-writes-to '^/api/watch' (the room is real, briefly).
  { name: 'e2e-preview', path: '/preview', ready: '#discover-body .billboard', sizes: ['phone', 'desktop'], steps: [
    "if (!document.querySelector('.preview-pill')) throw new Error('no preview pill after /preview');",
    "await __click('.bb-slide.is-active .btn-glass, .bb-slide .btn-glass'); await __waitFor('#sheet.open #sheet-title'); await __sleep(1200);",
    "history.back(); await __sleep(600);",
    "await __click('.tab[data-view=\"library\"]'); await __waitFor('.unified-library .lib-group .title-card');",
    libraryCard('movie'), sheetOpen,
    "await __click('#sheet .library-film-actions .play-btn'); await __waitFor('#player:not([hidden])'); await __sleep(4000); document.querySelector('#video').pause();",
    "await __click('#watch-btn'); await __waitFor('#watch-bar:not([hidden])'); await __sleep(1500);",
    "await __click('#watch-leave'); await __sleep(1200);",
    "await __click('#player-close'); await __sleep(800);",
    "await __click('.tab[data-view=\"settings\"]'); await __waitFor('#settings-body .set-group'); await __sleep(800);",
    "setTimeout(() => document.querySelector('.preview-pill').click(), 50); return 'leaving';",
    { wait: 5000 },
    "await __waitFor('#discover-body', 20000); await __sleep(2000); if (document.querySelector('.preview-pill') || document.querySelector('script[src=\"/billboard.js\"]') || document.querySelector('.billboard')) throw new Error('still in the preview'); if (document.cookie.includes('marquee_preview')) throw new Error('cookie still readable');",
  ], probe: "return 'back on live: ' + (document.querySelector('link[rel=icon]')?.getAttribute('href') || '').slice(0, 24);" },
];
