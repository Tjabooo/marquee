// Play now in the player: a video that is still downloading, streamed live by the server (partial-stream.js
// there). The stream is HLS: Safari plays it itself, other browsers through hls.js, loaded only when needed.
// When the video has to stop and wait for the download, a popup says why and what to do about it.
import { T } from './i18n.js';

// When the buffering popup may show. No DOM here, so it can be tested on its own.
export class BufferNotice {
  constructor({ delay = 2500, startDelay = 8000, snooze = 5 * 60_000 } = {}) {
    Object.assign(this, { delay, startDelay, snooze, started: false, snoozedUntil: 0 });
  }
  // The first pieces take a few seconds on any video, so the wait before the first frame gets longer.
  wait() { return this.started ? this.delay : this.startDelay; }
  allowed(now = Date.now()) { return now >= this.snoozedUntil; }
  playing() { this.started = true; }
  dismiss(now = Date.now()) { this.snoozedUntil = now + this.snooze; }
}

// A stall in the middle of a video: hold the picture until there's a useful amount buffered, instead of playing
// each piece the moment it arrives and stopping again (4 s of video, a freeze, 4 s of video...). Stalls close
// together mean the download is behind, so each one waits for more. No DOM here either.
export class RebufferHold {
  constructor({ goals = [8, 16, 32], floor = 4, maxHoldMs = 30_000, memoryMs = 90_000 } = {}) {
    Object.assign(this, { goals, floor, maxHoldMs, memoryMs, step: -1, since: null, lastEnd: -Infinity });
  }
  get holding() { return this.since != null; }
  get goal() { return this.goals[Math.max(0, this.step)]; }
  begin(now = Date.now()) {
    this.step = now - this.lastEnd < this.memoryMs ? Math.min(this.step + 1, this.goals.length - 1) : 0;
    this.since = now;
  }
  // `ahead` = seconds buffered past the playhead, `left` = seconds until the end of the video.
  ready(ahead, left = Infinity, now = Date.now()) {
    if (ahead >= this.goal || ahead + 0.5 >= left) return true;
    return now - this.since >= this.maxHoldMs && ahead >= this.floor;
  }
  end(now = Date.now()) { this.since = null; this.lastEnd = now; }
}

export function fmtEta(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return T('{0} min', minutes);
  return T('{0} h {1} min', Math.floor(minutes / 60), minutes % 60);
}

export function progressLine(status) {
  const pct = Math.floor((status?.progress || 0) * 100);
  if (status?.paused) return T('{0}% downloaded · paused', pct);
  if (Number.isFinite(status?.eta) && status.eta < 60) return T('{0}% downloaded · less than a minute left', pct);
  const eta = fmtEta(status?.eta);
  return eta ? T('{0}% downloaded · about {1} left', pct, eta) : T('{0}% downloaded · waiting for sources', pct);
}

// Past the download's reach? Then the wait lasts until the download gets there.
export const pastDownloaded = (time, status) => Boolean(status?.duration) && time > (status.inOrder || 0) * status.duration + 5;

let hlsLoading = null;
function loadHls() {
  hlsLoading ||= new Promise((resolve, reject) => {
    if (window.Hls) { resolve(window.Hls); return; }
    const script = document.createElement('script');
    script.src = '/vendor/hls.light.min.js';
    script.onload = () => resolve(window.Hls);
    script.onerror = () => { hlsLoading = null; reject(new Error('hls.js')); };
    document.head.append(script);
  });
  return hlsLoading;
}

// A piece can be minutes away when the download has to catch up, so nothing here may count that as a failure.
const HLS_CONFIG = {
  maxBufferLength: 30, maxMaxBufferLength: 120, backBufferLength: 60, startFragPrefetch: false,
  fragLoadPolicy: { default: { maxTimeToFirstByteMs: 30 * 60_000, maxLoadTimeMs: 60 * 60_000,
    timeoutRetry: { maxNumRetry: 20, retryDelayMs: 1000, maxRetryDelayMs: 5000 },
    errorRetry: { maxNumRetry: 60, retryDelayMs: 2000, maxRetryDelayMs: 8000 } } },
  manifestLoadPolicy: { default: { maxTimeToFirstByteMs: 60_000, maxLoadTimeMs: 90_000,
    timeoutRetry: { maxNumRetry: 5, retryDelayMs: 1000, maxRetryDelayMs: 5000 },
    errorRetry: { maxNumRetry: 10, retryDelayMs: 2000, maxRetryDelayMs: 8000 } } },
};
const NATIVE_RETRIES = 40;
const STATUS_MS = 3000;
const OPEN_MS = 1500;
const HOLD_TICK_MS = 500;
const HOLD_POPUP_MS = 10_000; // a short hold is explained well enough by the spinner

const sleep = (ms, signal) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
});

// ctx: video, playerEl, seekEl, api, $, isCurrent(session), setSource(url, session, onMetadata),
// setHlsSource(hls, url, session, onMetadata), onMetadata(session), setSpinner(on), showNote(text), hideNote(),
// showError(text), fullItem(libraryId), switchToFull(item), leave(), toast(text)
export async function playPartial(session, ctx) {
  const { video, playerEl, seekEl, api, $ } = ctx;
  const signal = session.abort.signal;
  const query = `id=${encodeURIComponent(session.key)}`;
  const popup = $('#part-popup');
  const notice = new BufferNotice();
  const hold = new RebufferHold();
  let holdTimer = null, holdRate = 1;
  let popupKind = null, bufferTimer = null, buffering = false, statusTimer = null, fullOffered = false;
  session.part = null;

  const hidePopup = () => {
    popup.hidden = true;
    popupKind = null;
    playerEl.classList.remove('has-part-popup');
  };
  const paintStatus = (status) => {
    session.part = status;
    seekEl.style.setProperty('--dl', `${Math.max(0, Math.min(1, status.inOrder || 0)) * 100}%`);
    $('#seek-downloaded').hidden = false;
    if (popupKind === 'buffer') {
      $('#part-popup-bar').style.setProperty('--p', `${Math.floor((status.progress || 0) * 100)}%`);
      $('#part-popup-progress').textContent = progressLine(status);
    }
  };
  const showBufferPopup = () => {
    if (!ctx.isCurrent(session) || popupKind) return;
    popupKind = 'buffer';
    const ahead = pastDownloaded(video.currentTime, session.part);
    $('#part-popup-label').textContent = T('Buffering');
    $('#part-popup-title').textContent = ahead ? T('This part hasn’t downloaded yet') : T('This video is still downloading');
    $('#part-popup-body').textContent = ahead
      ? T('It will play when the download gets here. If you want it to stop buffering and play in full quality, wait for the download to finish.')
      : T('It’s playing while it downloads, so it has to stop now and then to catch up. If you want it to stop buffering and play in full quality, wait for the download to finish.');
    $('#part-popup-bar').hidden = false;
    $('#part-popup-progress').hidden = false;
    $('#part-popup-bar').style.setProperty('--p', `${Math.floor((session.part?.progress || 0) * 100)}%`);
    $('#part-popup-progress').textContent = progressLine(session.part);
    const primary = $('#part-popup-primary'), secondary = $('#part-popup-secondary');
    primary.textContent = T('Keep watching');
    secondary.textContent = T('Wait for the download');
    primary.onclick = () => { notice.dismiss(); hidePopup(); };
    secondary.onclick = () => { hidePopup(); ctx.leave(); ctx.toast(T('Still downloading. It will be ready to watch in your library.')); };
    popup.hidden = false;
    playerEl.classList.add('has-part-popup');
  };
  const showFullPopup = (item) => {
    if (!ctx.isCurrent(session)) return;
    hidePopup();
    popupKind = 'full';
    $('#part-popup-label').textContent = T('Download finished');
    $('#part-popup-title').textContent = T('Full quality is ready');
    $('#part-popup-body').textContent = T('Switch now to carry on from this spot in full quality, with subtitles and every audio track.');
    $('#part-popup-bar').hidden = true;
    $('#part-popup-progress').hidden = true;
    const primary = $('#part-popup-primary'), secondary = $('#part-popup-secondary');
    primary.textContent = T('Switch now');
    secondary.textContent = T('Keep watching');
    primary.onclick = () => { hidePopup(); ctx.switchToFull(item); };
    secondary.onclick = hidePopup;
    popup.hidden = false;
    playerEl.classList.add('has-part-popup');
  };

  const bufferedAhead = () => {
    const at = video.currentTime, ranges = video.buffered;
    for (let i = 0; i < ranges.length; i++) if (ranges.start(i) <= at + 0.3 && at < ranges.end(i)) return ranges.end(i) - at;
    return 0;
  };
  // Playback rate 0 stops the picture without counting as paused to the controls, and hls.js leaves it alone.
  const releaseHold = () => {
    if (!hold.holding) return;
    clearInterval(holdTimer);
    hold.end();
    if (video.playbackRate === 0) video.playbackRate = holdRate;
    ctx.setSpinner(false);
  };
  const beginHold = () => {
    // Safari's own HLS keeps its behaviour; the first frame and seeks have their own waits.
    if (hold.holding || !session.hlsPlayer || !notice.started || video.seeking || video.paused || video.ended) return;
    holdRate = video.playbackRate || 1;
    hold.begin();
    video.playbackRate = 0;
    holdTimer = setInterval(() => {
      if (!ctx.isCurrent(session)) { releaseHold(); return; }
      const left = Number.isFinite(video.duration) ? video.duration - video.currentTime : Infinity;
      if (!hold.ready(bufferedAhead(), left)) { ctx.setSpinner(true); return; }
      buffering = false;
      clearTimeout(bufferTimer);
      releaseHold();
      if (popupKind === 'buffer') hidePopup();
    }, HOLD_TICK_MS);
  };

  const stalled = () => hold.holding || (!video.paused && !video.ended && (video.seeking || video.readyState < 3));
  const onStalled = () => {
    buffering = true;
    clearTimeout(bufferTimer);
    bufferTimer = setTimeout(() => { if (buffering && stalled() && notice.allowed() && !session.part?.done) showBufferPopup(); }, hold.holding ? HOLD_POPUP_MS : notice.wait());
  };
  const onWaiting = () => {
    if (bufferedAhead() < 1) beginHold();
    onStalled();
  };
  const onPlaying = () => {
    if (hold.holding) return; // data arrived, but the hold decides when the picture moves again
    buffering = false;
    notice.playing();
    clearTimeout(bufferTimer);
    if (popupKind === 'buffer') hidePopup();
  };
  const onPause = () => { buffering = false; clearTimeout(bufferTimer); releaseHold(); };
  const events = [['waiting', onWaiting], ['stalled', onStalled], ['playing', onPlaying], ['pause', onPause], ['seeking', releaseHold]];

  const pollStatus = async () => {
    if (signal.aborted) return;
    try {
      const status = await api(`/api/part/status?${query}`, { signal });
      if (!ctx.isCurrent(session)) return;
      paintStatus(status);
      if (status.done && status.libraryId && !fullOffered) {
        const item = ctx.fullItem(status.libraryId);
        if (item) { fullOffered = true; showFullPopup(item); }
      }
    } catch { /* the next round asks again */ }
    if (!signal.aborted) statusTimer = setTimeout(pollStatus, STATUS_MS);
  };

  signal.addEventListener('abort', () => {
    releaseHold();
    clearTimeout(bufferTimer);
    clearTimeout(statusTimer);
    for (const [name, fn] of events) video.removeEventListener(name, fn);
    video.removeEventListener('error', onNativeError);
    session.hlsPlayer?.destroy();
    hidePopup();
    $('#seek-downloaded').hidden = true;
    seekEl.style.setProperty('--dl', '0%');
    ctx.hideNote();
  }, { once: true });

  // Safari gives up on a piece that takes too long: start that spot again until the download has it.
  let nativeRetries = 0, sourceUrl = null, nativeLastTime = 0;
  function onNativeError() {
    if (!ctx.isCurrent(session) || session.hlsPlayer || !sourceUrl) return;
    if (++nativeRetries > NATIVE_RETRIES) {
      ctx.setSpinner(false);
      ctx.showError(T('This video can’t keep playing right now. Wait for the download to finish and play it from your library.'));
      return;
    }
    nativeLastTime = video.currentTime || nativeLastTime;
    setTimeout(() => {
      if (!ctx.isCurrent(session)) return;
      ctx.setSource(sourceUrl, session, () => { video.currentTime = nativeLastTime; video.play().catch(() => {}); });
    }, 3000);
  }

  // The download has to bring the start (and end) of the file first.
  let opened;
  ctx.showNote(T('Getting the start of the video from the download…'));
  try {
    for (;;) {
      opened = await api(`/api/part/open?${query}`, { signal });
      if (!ctx.isCurrent(session)) return;
      paintStatus(opened.status);
      if (opened.ready) break;
      ctx.showNote(`${T('Getting the start of the video from the download…')} ${progressLine(opened.status)}`);
      await sleep(OPEN_MS, signal);
      if (signal.aborted) return;
    }
  } catch (error) {
    if (signal.aborted || !ctx.isCurrent(session)) return;
    ctx.hideNote();
    ctx.setSpinner(false);
    ctx.showError(error.message);
    return;
  }
  ctx.hideNote();
  session.sourceHeight = opened.sourceHeight;
  for (const [name, fn] of events) video.addEventListener(name, fn);
  statusTimer = setTimeout(pollStatus, STATUS_MS);
  const onMetadata = () => ctx.onMetadata(session);
  sourceUrl = opened.url;
  const appleHls = Boolean(video.canPlayType('application/vnd.apple.mpegurl')) && 'webkitShowPlaybackTargetPicker' in video;
  let Hls = null;
  if (!appleHls) Hls = await loadHls().catch(() => null);
  if (signal.aborted || !ctx.isCurrent(session)) return;
  if (Hls?.isSupported()) {
    const hls = new Hls(HLS_CONFIG);
    session.hlsPlayer = hls;
    hls.on(Hls.Events.ERROR, (_, data) => {
      if (!data.fatal || !ctx.isCurrent(session)) return;
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
      else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
      else {
        ctx.setSpinner(false);
        ctx.showError(T('This video can’t keep playing right now. Wait for the download to finish and play it from your library.'));
      }
    });
    ctx.setHlsSource(hls, opened.url, session, onMetadata);
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.addEventListener('error', onNativeError);
    ctx.setSource(opened.url, session, onMetadata);
  } else {
    ctx.setSpinner(false);
    ctx.showError(T('This browser can’t play a video that’s still downloading. Wait for the download to finish and play it from your library.'));
    return;
  }
  video.play().catch(() => { /* autoplay blocked: the controls are there */ });
  ctx.toast(T('Playing while it downloads, at up to 1080p.'));
}
