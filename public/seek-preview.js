// Timeline previews above the seek bar: the frame at the hovered (or dragged-to) time, cut from
// the storyboard sheets the server makes in the background (previews.js). Shared by the app's
// player and the shared clip page. Until part of a video's storyboard exists, only the time shows.
const POLL_MS = 4000;

// Index of the last frame at or before t (frames are keyframes, so a little before is right).
export function frameAt(times, t) {
  let lo = 0, hi = times.length - 1;
  if (hi < 0) return -1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (times[mid] <= t + 0.05) lo = mid; else hi = mid - 1;
  }
  return lo;
}

// Size the frame is shown at: up to 200 x 150 CSS px (160 x 120 on a phone), keeping its shape.
export function frameSize(w, h, narrow) {
  const maxW = narrow ? 160 : 200, maxH = narrow ? 120 : 150;
  const scale = Math.min(maxW / w, maxH / h);
  return { scale, width: Math.round(w * scale), height: Math.round(h * scale) };
}

// tip: the seek tip element. onResize: called when the tip changed size after a sheet loaded,
// so the caller can re-place it.
export function createSeekPreview(tip, onResize) {
  const frame = document.createElement('div');
  frame.className = 'seek-frame';
  frame.hidden = true;
  const time = document.createElement('span');
  time.className = 'seek-time';
  tip.replaceChildren(frame, time);

  let gen = 0;
  let source = null; // { indexUrl, sheetUrl }
  let index = null;
  let abort = null;
  let poll = null;
  let lastT = null;
  let shownKey = '';
  const sheets = new Map(); // url -> { img, ready }

  function stop() {
    gen++;
    abort?.abort();
    abort = null;
    clearTimeout(poll);
    poll = null;
  }

  async function fetchIndex(g) {
    if (g !== gen || !source) return;
    abort = new AbortController();
    try {
      const r = await fetch(source.indexUrl, { signal: abort.signal, credentials: 'same-origin' });
      if (g !== gen) return;
      if (!r.ok) return; // no previews for this video: the tip shows only the time
      const data = await r.json();
      if (g !== gen) return;
      if (data.failed) return;
      index = data;
      if (lastT != null && !tip.hidden) render(lastT);
      if (!data.done) poll = setTimeout(() => fetchIndex(g), POLL_MS);
    } catch { /* offline or aborted: keep what there is */ }
  }

  function sheet(n) {
    const url = source.sheetUrl(n, index.key);
    let s = sheets.get(url);
    if (!s) {
      const img = new Image();
      s = { img, ready: false };
      const g = gen;
      img.onload = () => { s.ready = true; if (g === gen && lastT != null && !tip.hidden) { render(lastT); onResize?.(); } };
      img.onerror = () => { sheets.delete(url); };
      img.src = url;
      sheets.set(url, s);
      if (sheets.size > 80) sheets.delete(sheets.keys().next().value);
    }
    return { url, ...s };
  }

  function render(t) {
    const times = index?.times || [];
    const i = index?.w && index?.h ? frameAt(times, t) : -1;
    if (i < 0) { frame.hidden = true; tip.classList.remove('has-frame'); return; }
    const per = index.cols * index.rows;
    const s = sheet(Math.floor(i / per));
    if (!s.ready) return; // keep the frame that is showing until this sheet arrives
    const narrow = window.matchMedia?.('(max-width: 600px)').matches;
    const { scale, width, height } = frameSize(index.w, index.h, narrow);
    const key = `${s.url}|${i}|${width}`;
    if (key !== shownKey) {
      shownKey = key;
      const cell = i % per;
      const col = cell % index.cols, row = Math.floor(cell / index.cols);
      frame.style.width = `${width}px`;
      frame.style.height = `${height}px`;
      frame.style.backgroundImage = `url("${s.url}")`;
      frame.style.backgroundSize = `${index.cols * index.w * scale}px ${index.rows * index.h * scale}px`;
      frame.style.backgroundPosition = `${-col * index.w * scale}px ${-row * index.h * scale}px`;
    }
    frame.hidden = false;
    tip.classList.add('has-frame');
  }

  return {
    // Start showing previews for a video (null: none). Fetches its index right away, which also
    // gets the server making the storyboard while the video plays.
    load(next) {
      stop();
      source = next;
      index = null;
      lastT = null;
      shownKey = '';
      sheets.clear();
      frame.hidden = true;
      frame.style.backgroundImage = '';
      tip.classList.remove('has-frame');
      if (next) fetchIndex(gen);
    },
    // Set the tip's time label and frame for time t (seconds).
    show(t, label) {
      lastT = t;
      time.textContent = label;
      render(t);
    },
  };
}
