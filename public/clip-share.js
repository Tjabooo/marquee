// The player on a shared clip's public page (/c/<token>): Lilin's player, for one clip only.
// Same markup and styles as the app's player (style.css), with only what watching a clip needs:
// play, skip, seek, volume, fullscreen and picture in picture, plus the same keyboard shortcuts.
import { T } from './i18n.js';
import { createSeekPreview } from '/c/seek-preview.js';

const ICONS = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15l13-7.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 4.5h4v15h-4zM13.5 4.5h4v15h-4z"/></svg>',
  volume: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6"/></svg>',
  volumeHigh: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18.5 6.5a7.5 7.5 0 0 1 0 11"/></svg>',
  muted: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/></svg>',
  back10: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M6.5 3v3.9h3.9"/><text x="12.2" y="15.2" text-anchor="middle">10</text></svg>',
  fwd10: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M17.5 3v3.9h-3.9"/><text x="11.8" y="15.2" text-anchor="middle">10</text></svg>',
  fullscreen: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
  fullscreenExit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg>',
  pip: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><rect class="fill" x="12" y="11.5" width="6.5" height="5" rx="1"/></svg>',
};
const $ = (s) => document.querySelector(s);
const setIcon = (el, name) => { el.innerHTML = ICONS[name]; };
const fmtTime = (s) => {
  s = Math.max(0, Math.floor(s || 0));
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  return (hh ? `${hh}:${String(mm).padStart(2, '0')}` : `${mm}`) + `:${String(ss).padStart(2, '0')}`;
};
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* blocked */ } },
};

const player = $('#player');
const stage = $('#player-stage');
const video = $('#video');
const controls = $('#player-controls');
const seekEl = $('#seek');
const seekTip = $('#seek-tip');
// The frame at the hovered time (seek-preview.js), from this page's own storyboard.
let seekTipX = null;
const seekPreview = createSeekPreview(seekTip, () => { if (!seekTip.hidden && seekTipX != null) showSeekTip(seekTipX); });
{
  const here = location.pathname.replace(/\/+$/, '');
  seekPreview.load({ indexUrl: `${here}/preview.json`, sheetUrl: (n, key) => `${here}/preview/${n}.jpg?k=${key}` });
}
const timeEl = $('#pc-time');
const durEl = $('#pc-duration');
const muteBtn = $('#pc-mute');
const volInput = $('#pc-vol');
const fsBtn = $('#pc-fs');
const pipBtn = $('#pc-pip');
const osdEl = $('#player-osd');
const spinner = $('#player-spinner');
const errorEl = $('#player-error');
const playBtns = [$('#pc-play'), $('.pc-big-play')];

// ---- showing and hiding the controls ----
let lastPointer = 'mouse';
let overControls = false;
let uiTimer = null;
let seeking = null;
const setUi = (on) => player.classList.toggle('ui-visible', on);
function showUi() {
  setUi(true);
  clearTimeout(uiTimer);
  if (!video.paused) uiTimer = setTimeout(hideUi, 3000);
}
function hideUi() {
  if (video.paused) return;
  if (overControls || seeking != null) { showUi(); return; }
  setUi(false);
}
player.addEventListener('pointerdown', (e) => { lastPointer = e.pointerType; }, true);
player.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse') showUi(); });
controls.addEventListener('pointerenter', (e) => { overControls = e.pointerType === 'mouse'; });
controls.addEventListener('pointerleave', () => { overControls = false; });

// ---- play, pause, skip ----
let osdTimer = null;
function osd(content) {
  const span = document.createElement('span');
  if (ICONS[content]) span.innerHTML = ICONS[content]; else span.textContent = content;
  osdEl.classList.toggle('is-icon', !!ICONS[content]);
  osdEl.replaceChildren(span);
  osdEl.classList.remove('show');
  void osdEl.offsetWidth;
  osdEl.classList.add('show');
  clearTimeout(osdTimer);
  osdTimer = setTimeout(() => osdEl.classList.remove('show'), 700);
}
function togglePlay(feedback = false) {
  const play = video.paused || video.ended;
  if (play) video.play().catch(() => {}); else video.pause();
  if (feedback) osd(play ? 'play' : 'pause');
}
function updatePlayState() {
  const playing = !video.paused && !video.ended;
  for (const b of playBtns) {
    setIcon(b, playing ? 'pause' : 'play');
    b.setAttribute('aria-label', playing ? T('Pause (Space)') : T('Play (Space)'));
  }
  player.classList.toggle('is-paused', !playing);
  showUi();
}
for (const ev of ['play', 'pause', 'ended', 'emptied']) video.addEventListener(ev, updatePlayState);
for (const b of playBtns) b.addEventListener('click', () => togglePlay());

let skipTotal = 0, skipAt = 0;
function skip(seconds) {
  if (!isFinite(video.duration) || !video.duration) return;
  const now = Date.now();
  skipTotal = now - skipAt < 1000 && Math.sign(skipTotal) === Math.sign(seconds) ? skipTotal + seconds : seconds;
  skipAt = now;
  video.currentTime = Math.min(Math.max(video.currentTime + seconds, 0), video.duration - 0.05);
  osd(`${skipTotal < 0 ? '−' : '+'}${Math.abs(skipTotal)} s`);
  updateTime();
}
document.querySelectorAll('.pc-skip').forEach((b) => {
  setIcon(b, Number(b.dataset.skip) < 0 ? 'back10' : 'fwd10');
  b.addEventListener('click', () => { skip(Number(b.dataset.skip)); showUi(); });
});

// Mouse: click plays or pauses, double-click is fullscreen. Touch: a tap shows or hides the
// controls, a double tap on the left or right third skips 10 s.
let lastTap = { at: 0, side: 0, uiWas: false, skipped: false };
stage.addEventListener('click', (e) => {
  if (lastPointer === 'mouse') { togglePlay(true); showUi(); return; }
  const r = stage.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width;
  const side = x < 1 / 3 ? -1 : x > 2 / 3 ? 1 : 0;
  const now = Date.now();
  if (side && side === lastTap.side && now - lastTap.at < 350) {
    if (!lastTap.skipped) setUi(lastTap.uiWas);
    lastTap = { ...lastTap, at: now, skipped: true };
    skip(10 * side);
    return;
  }
  lastTap = { at: now, side, uiWas: player.classList.contains('ui-visible'), skipped: false };
  if (lastTap.uiWas && !video.paused) { clearTimeout(uiTimer); setUi(false); } else showUi();
});
stage.addEventListener('dblclick', () => { if (lastPointer === 'mouse') toggleFullscreen(); });

// ---- time and seek bar ----
let showRemaining = store.get('player:remaining') === '1';
function updateTime() {
  const d = isFinite(video.duration) ? video.duration : 0;
  const t = seeking ?? video.currentTime;
  seekEl.style.setProperty('--pos', `${d ? (t / d) * 100 : 0}%`);
  timeEl.textContent = fmtTime(t);
  durEl.textContent = !d ? '–:––' : showRemaining ? `−${fmtTime(d - t)}` : fmtTime(d);
  seekEl.setAttribute('aria-valuemax', String(Math.floor(d)));
  seekEl.setAttribute('aria-valuenow', String(Math.floor(t)));
  seekEl.setAttribute('aria-valuetext', d ? `${fmtTime(t)} of ${fmtTime(d)}` : fmtTime(t));
}
function updateBuffer() {
  const d = video.duration;
  let end = 0;
  for (let i = 0; i < video.buffered.length; i++) if (video.buffered.start(i) <= video.currentTime + 1) end = Math.max(end, video.buffered.end(i));
  seekEl.style.setProperty('--buf', d && isFinite(d) ? `${(end / d) * 100}%` : '0%');
}
for (const ev of ['timeupdate', 'durationchange', 'loadedmetadata', 'seeking']) video.addEventListener(ev, updateTime);
for (const ev of ['progress', 'timeupdate']) video.addEventListener(ev, updateBuffer);
durEl.addEventListener('click', () => {
  showRemaining = !showRemaining;
  store.set('player:remaining', showRemaining ? '1' : '');
  durEl.title = showRemaining ? T('Show duration') : T('Show time remaining');
  updateTime();
});
const seekTimeAt = (x) => {
  const r = seekEl.getBoundingClientRect();
  return Math.min(Math.max((x - r.left) / r.width, 0), 1) * (video.duration || 0);
};
function showSeekTip(x) {
  seekTipX = x;
  const r = seekEl.getBoundingClientRect();
  const t = seekTimeAt(x);
  seekPreview.show(t, fmtTime(t));
  seekTip.hidden = false;
  seekPreview.place(x - r.left, r.width);
}
seekEl.addEventListener('pointerdown', (e) => {
  if (!isFinite(video.duration) || !video.duration) return;
  seekEl.setPointerCapture(e.pointerId);
  seeking = seekTimeAt(e.clientX);
  seekEl.classList.add('is-dragging');
  showSeekTip(e.clientX);
  updateTime();
});
seekEl.addEventListener('pointermove', (e) => {
  if (seeking != null) { seeking = seekTimeAt(e.clientX); updateTime(); }
  if (seeking != null || e.pointerType === 'mouse') showSeekTip(e.clientX);
});
function endSeek(apply) {
  if (seeking == null) return;
  if (apply) video.currentTime = seeking;
  seeking = null;
  seekEl.classList.remove('is-dragging');
  seekTip.hidden = true;
  updateTime();
  showUi();
}
seekEl.addEventListener('pointerup', () => endSeek(true));
seekEl.addEventListener('pointercancel', () => endSeek(false));
seekEl.addEventListener('pointerleave', () => { if (seeking == null) seekTip.hidden = true; });

// ---- volume (iOS only allows mute) ----
const canSetVolume = (() => { const v = document.createElement('video'); v.volume = 0.5; return v.volume === 0.5; })();
volInput.hidden = !canSetVolume;
{
  const v = Number(store.get('player:volume'));
  if (canSetVolume && store.get('player:volume') !== null && v >= 0 && v <= 1) video.volume = v;
  video.muted = store.get('player:muted') === '1';
}
function updateVolume() {
  const level = video.muted ? 0 : video.volume;
  setIcon(muteBtn, level === 0 ? 'muted' : level < 0.5 ? 'volume' : 'volumeHigh');
  muteBtn.setAttribute('aria-label', video.muted ? T('Unmute (M)') : T('Mute (M)'));
  if (document.activeElement !== volInput) volInput.value = String(level);
  volInput.style.setProperty('--val', `${level * 100}%`);
  store.set('player:volume', String(video.volume));
  store.set('player:muted', video.muted ? '1' : '');
}
video.addEventListener('volumechange', updateVolume);
updateVolume();
function setVolume(v) {
  video.volume = Math.round(Math.min(Math.max(v, 0), 1) * 100) / 100;
  video.muted = video.volume === 0;
}
function toggleMute() {
  if (video.muted && video.volume === 0) video.volume = 0.5;
  video.muted = !video.muted;
  osd(video.muted ? T('Muted') : T('Volume {0}%', Math.round(video.volume * 100)));
}
muteBtn.addEventListener('click', toggleMute);
volInput.addEventListener('input', () => setVolume(Number(volInput.value)));

// ---- fullscreen and picture in picture ----
const fsElement = () => document.fullscreenElement || document.webkitFullscreenElement;
fsBtn.hidden = !player.requestFullscreen && !player.webkitRequestFullscreen && !video.webkitEnterFullscreen;
function toggleFullscreen() {
  if (fsElement()) { (document.exitFullscreen || document.webkitExitFullscreen).call(document); return; }
  if (player.requestFullscreen) {
    player.requestFullscreen({ navigationUI: 'hide' }).then(() => {
      if (lastPointer !== 'mouse' && video.videoWidth > video.videoHeight) screen.orientation?.lock?.('landscape').catch(() => {});
    }, () => {});
  } else if (player.webkitRequestFullscreen) player.webkitRequestFullscreen();
  else try { video.webkitEnterFullscreen(); } catch { /* not ready yet */ }
}
function updateFullscreen() {
  const on = Boolean(fsElement());
  setIcon(fsBtn, on ? 'fullscreenExit' : 'fullscreen');
  fsBtn.setAttribute('aria-label', on ? T('Exit fullscreen (F)') : T('Fullscreen (F)'));
}
document.addEventListener('fullscreenchange', updateFullscreen);
document.addEventListener('webkitfullscreenchange', updateFullscreen);
updateFullscreen();
fsBtn.addEventListener('click', toggleFullscreen);
// iPhones only offer Safari's own presentation mode, not the standard API.
const webkitPip = () => typeof video.webkitSetPresentationMode === 'function' && video.webkitSupportsPresentationMode?.('picture-in-picture') === true;
pipBtn.hidden = !document.pictureInPictureEnabled && !webkitPip();
setIcon(pipBtn, 'pip');
function togglePip() {
  if (!video.currentSrc) return;
  if (webkitPip()) {
    try { video.webkitSetPresentationMode(video.webkitPresentationMode === 'picture-in-picture' ? 'inline' : 'picture-in-picture'); } catch { /* not ready */ }
    return;
  }
  if (!document.pictureInPictureEnabled) return;
  (document.pictureInPictureElement ? document.exitPictureInPicture() : video.requestPictureInPicture()).catch(() => {});
}
pipBtn.addEventListener('click', togglePip);

// ---- buffering and errors ----
let spinTimer = null;
function setSpinner(on) {
  clearTimeout(spinTimer);
  if (on) spinTimer = setTimeout(() => { spinner.hidden = false; }, 300);
  else spinner.hidden = true;
}
video.addEventListener('waiting', () => setSpinner(true));
for (const ev of ['playing', 'canplay', 'pause', 'error']) video.addEventListener(ev, () => setSpinner(false));
video.addEventListener('error', () => {
  errorEl.textContent = T('This clip couldn’t be loaded. Check your connection and reload the page.');
  errorEl.hidden = false;
});

// ---- keyboard ----
const seekToFraction = (f) => { if (isFinite(video.duration)) { video.currentTime = video.duration * f; updateTime(); } };
const nudgeVolume = (d) => { if (canSetVolume) { setVolume((video.muted ? 0 : video.volume) + d); osd(T('Volume {0}%', Math.round(video.volume * 100))); } };
const KEYS = {
  ' ': () => togglePlay(true), k: () => togglePlay(true),
  ArrowLeft: () => skip(-5), ArrowRight: () => skip(5), j: () => skip(-10), l: () => skip(10),
  ArrowUp: () => nudgeVolume(0.05), ArrowDown: () => nudgeVolume(-0.05),
  m: toggleMute, f: toggleFullscreen, p: togglePip,
  Home: () => seekToFraction(0), End: () => seekToFraction(0.999),
};
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || e.target.matches?.('input:not([type="range"])')) return;
  if (e.key === 'Tab') { showUi(); return; }
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const run = KEYS[key] ?? (/^[0-9]$/.test(key) ? () => seekToFraction(Number(key) / 10) : null);
  if (!run) return;
  e.preventDefault();
  run();
  showUi();
});
document.addEventListener('keyup', (e) => { if (e.key === ' ') e.preventDefault(); });

updatePlayState();
updateTime();
// Starts by itself where the browser allows it (with sound only after a tap or click elsewhere).
video.play().catch(() => {});
