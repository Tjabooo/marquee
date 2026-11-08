// Stats for nerds: a live panel over the player with everything about the stream. The file side
// (container, codecs, colour, HDR, every audio and subtitle stream, the original release) comes from
// the server's ffprobe (/api/stream-info); the playback side (decoder, dropped frames, buffer,
// throughput, stalls, display) is measured here in the browser.
import { T, locale } from './i18n.js';

// ---- pure helpers (tested in tests/player-stats.test.mjs) ----
const hex2 = (n) => Math.max(0, Math.min(255, n | 0)).toString(16).padStart(2, '0').toUpperCase();
const AVC_PROFILES = { 'constrained baseline': [66, 0xe0], baseline: [66, 0], main: [77, 0], extended: [88, 0], high: [100, 0],
  'high 10': [110, 0], 'high 4:2:2': [122, 0], 'high 4:4:4 predictive': [244, 0] };
const HEVC_PROFILES = { main: [1, 6], 'main 10': [2, 4], 'main still picture': [3, 0], rext: [4, 0] };

// RFC 6381 codec string for MediaCapabilities and canPlayType, from the ffprobe description.
export function videoCodecString(v) {
  if (!v?.codec) return null;
  const profile = String(v.profile || '').toLowerCase();
  const level = Number(v.level) > 0 ? Number(v.level) : null;
  if (v.codec === 'h264') {
    const [idc, constraint] = AVC_PROFILES[profile] || AVC_PROFILES.high;
    const tag = v.tag === 'avc3' ? 'avc3' : 'avc1';
    return `${tag}.${hex2(idc)}${hex2(constraint)}${hex2(level || 40)}`.toLowerCase();
  }
  if (v.codec === 'hevc') {
    const [idc, compat] = HEVC_PROFILES[profile] || HEVC_PROFILES[v.bitDepth > 8 ? 'main 10' : 'main'];
    return `${v.tag === 'hev1' ? 'hev1' : 'hvc1'}.${idc}.${compat}.L${level || 120}.B0`;
  }
  if (v.codec === 'av1') {
    const p = { main: 0, high: 1, professional: 2 }[profile] ?? 0;
    return `av01.${p}.${String(level ?? 8).padStart(2, '0')}M.${String(v.bitDepth || 8).padStart(2, '0')}`;
  }
  if (v.codec === 'vp9') {
    const p = Number((profile.match(/\d/) || [0])[0]);
    return `vp09.${String(p).padStart(2, '0')}.${String(level || 40).padStart(2, '0')}.${String(v.bitDepth || 8).padStart(2, '0')}`;
  }
  if (v.codec === 'vp8') return 'vp8';
  if (v.codec === 'mpeg4') return 'mp4v.20.9';
  return null;
}
export function audioCodecString(a) {
  if (!a?.codec) return null;
  const profile = String(a.profile || '').toLowerCase();
  if (a.codec === 'aac') return profile.includes('he-aacv2') ? 'mp4a.40.29' : profile.includes('he-aac') ? 'mp4a.40.5' : 'mp4a.40.2';
  return { mp3: 'mp4a.6B', ac3: 'ac-3', eac3: 'ec-3', opus: 'opus', flac: 'fLaC', vorbis: 'vorbis', alac: 'alac', dts: 'dtsc', truehd: 'mlpa' }[a.codec] || null;
}

const CODEC_NAMES = { h264: 'H.264', hevc: 'HEVC', av1: 'AV1', vp9: 'VP9', vp8: 'VP8', mpeg4: 'MPEG-4', mpeg2video: 'MPEG-2',
  aac: 'AAC', ac3: 'AC-3', eac3: 'E-AC-3', dts: 'DTS', truehd: 'TrueHD', opus: 'Opus', flac: 'FLAC', mp3: 'MP3', vorbis: 'Vorbis',
  subrip: 'SRT', ass: 'ASS', ssa: 'SSA', mov_text: 'MP4 text', webvtt: 'WebVTT', hdmv_pgs_subtitle: 'PGS', dvd_subtitle: 'VobSub', dvb_subtitle: 'DVB' };
export const codecName = (c) => CODEC_NAMES[c] || (c ? String(c).toUpperCase() : '');
export function formatBytes(n) {
  if (!(n >= 0)) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1000 && i < units.length - 1) { n /= 1000; i++; }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(n >= 10 ? 1 : 2)} ${units[i]}`;
}
export function formatBitrate(bps) {
  if (!(bps > 0)) return '';
  return bps >= 1e6 ? T('{0} Mbps', (bps / 1e6).toFixed(bps >= 1e8 ? 0 : bps >= 1e7 ? 1 : 2)) : T('{0} kbps', Math.round(bps / 1e3));
}
export function formatDuration(s) {
  if (!(s >= 0) || !isFinite(s)) return '';
  const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); const sec = s % 60;
  return `${h ? `${h}:${String(m).padStart(2, '0')}` : m}:${sec.toFixed(3).padStart(6, '0')}`;
}
// ffprobe names every ISO-BMFF file "QuickTime / MOV"; the brand and extension say what it really is.
export function containerName(f) {
  const ext = String(f.name || '').split('.').pop().toLowerCase();
  if (/mp4/.test(f.format || '') && !/^qt/.test(String(f.brand || '').trim())) return ext === 'm4v' ? 'M4V (MPEG-4)' : 'MP4 (MPEG-4 Part 14)';
  if (/matroska/.test(f.format || '')) return ext === 'webm' ? 'WebM' : 'Matroska (MKV)';
  return f.container || f.format || '';
}
const LEVEL_TEXT = (v) => {
  const l = Number(v.level);
  if (!(l > 0)) return '';
  if (v.codec === 'h264') return `@L${(l / 10).toFixed(1)}`;
  if (v.codec === 'hevc') return `@L${(l / 30).toFixed(1)}`;
  if (v.codec === 'av1') return `@L${2 + (l >> 2)}.${l & 3}`;
  return '';
};
const COLOR_NAMES = { bt709: 'BT.709', bt2020nc: 'BT.2020 NCL', bt2020c: 'BT.2020 CL', bt2020: 'BT.2020', smpte170m: 'BT.601', bt470bg: 'BT.601 PAL',
  smpte2084: 'PQ (ST 2084)', 'arib-std-b67': 'HLG', 'iec61966-2-1': 'sRGB', tv: T('limited'), pc: 'full' };
const colorName = (c) => COLOR_NAMES[c] || c || '';
export function describeVideo(v) {
  if (!v) return {};
  const fps = v.fps ? T('{0} fps', Number(v.fps.toFixed(3))) : '';
  const scan = v.fieldOrder && v.fieldOrder !== 'progressive' ? T(' · interlaced ({0})', v.fieldOrder) : '';
  const colour = [v.primaries && T('primaries {0}', colorName(v.primaries)), v.transfer && T('transfer {0}', colorName(v.transfer)),
    v.space && T('matrix {0}', colorName(v.space)), v.range && T('{0} range', colorName(v.range))].filter(Boolean).join(' · ');
  const hdrExtra = [v.mastering?.maxLum && T('mastered {0}/{1} nits', Math.round(v.mastering.maxLum), Number((v.mastering.minLum || 0).toFixed(4))),
    v.light?.maxCll && T('MaxCLL {0} · MaxFALL {1}', v.light.maxCll, v.light.maxFall ?? '?')].filter(Boolean).join(' · ');
  return {
    codec: [`${codecName(v.codec)}${v.profile ? ` ${v.profile}` : ''}${LEVEL_TEXT(v)}`, v.tag].filter(Boolean).join(' · '),
    picture: [`${v.width}×${v.height}`, v.dar && T('DAR {0}', v.dar), v.sar && T('SAR {0}', v.sar), v.rotation && T('rotated {0}°', v.rotation)].filter(Boolean).join(' · '),
    frames: `${fps}${scan}${v.frames ? T(' · {0} frames', v.frames.toLocaleString(locale)) : ''}`,
    format: [v.pixFmt, v.bitDepth && `${v.bitDepth}-bit`, v.chroma && T('chroma {0}', v.chroma)].filter(Boolean).join(' · '),
    colour,
    hdr: [v.hdr, hdrExtra].filter(Boolean).join(' · '),
    bitrate: formatBitrate(v.bitrate),
    structure: [v.refs != null && T('{0} ref frames', v.refs), v.bFrames != null && T('B-frame delay {0}', v.bFrames)].filter(Boolean).join(' · '),
  };
}
export function describeAudio(a) {
  const layout = a.layout ? a.layout.replace(/\(.*\)/, (m) => ` ${m}`) : a.channels ? T('{0} ch', a.channels) : '';
  return [codecName(a.codec) + (a.profile && !/^lc$/i.test(a.profile) ? ` ${a.profile}` : ''), layout,
    a.sampleRate && T('{0} kHz', (a.sampleRate / 1000).toFixed(a.sampleRate % 1000 ? 1 : 0)), a.bitDepth && `${a.bitDepth}-bit`,
    formatBitrate(a.bitrate), a.language && a.language !== 'und' && a.language, a.title && `“${a.title}”`,
    a.default && 'default', a.forced && 'forced'].filter(Boolean).join(' · ');
}

// ---- the panel ----
const SAMPLE_MS = 500;
const HISTORY = 120; // one minute of samples for the graphs

export function createStreamStats({ video, host, api, context }) {
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const panel = el('section', 'stats-panel');
  panel.hidden = true;
  panel.setAttribute('aria-label', T('Stats for nerds'));
  const head = el('div', 'stats-head');
  const title = el('p', 'stats-title', T('Stats for nerds'));
  const copyBtn = el('button', 'stats-btn', T('Copy'));
  copyBtn.type = 'button';
  const closeBtn = el('button', 'stats-btn stats-close', '×');
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', T('Close stats'));
  head.append(title, copyBtn, closeBtn);
  const graphs = el('div', 'stats-graphs');
  const makeGraph = (label) => {
    const wrap = el('figure', 'stats-graph');
    const canvas = el('canvas');
    const cap = el('figcaption', null, label);
    const val = el('span', 'stats-graph-value');
    cap.append(val);
    wrap.append(cap, canvas);
    graphs.append(wrap);
    return { canvas, val, data: [] };
  };
  const bufferGraph = makeGraph(T('Buffer ahead '));
  const netGraph = makeGraph(T('Download '));
  const body = el('div', 'stats-body');
  panel.append(head, graphs, body);
  host.append(panel);
  // Keep clicks and wheel inside the panel from reaching the player (play/pause, seek).
  for (const type of ['click', 'dblclick', 'pointerdown', 'contextmenu']) panel.addEventListener(type, (e) => e.stopPropagation());

  // Counters that run whether or not the panel is open, reset per source.
  let live = null;
  const resetLive = () => {
    live = { loadStart: performance.now(), firstFrame: null, metadataAt: null, stalls: 0, stallMs: 0, waitingSince: null,
      seeks: 0, seekStart: null, lastSeekMs: null, errors: [], resizes: 0, lastBuffered: null, rate: null, rateIdle: false,
      lastDropped: 0, droppedRecent: 0, frameTimes: [], presented: null, lastMediaTime: null };
  };
  resetLive();
  const now = () => performance.now();
  video.addEventListener('loadstart', () => { resetLive(); info = null; infoFor = null; bufferGraph.data = []; netGraph.data = []; if (!panel.hidden) refreshInfo(); });
  video.addEventListener('loadedmetadata', () => { live.metadataAt ??= now() - live.loadStart; });
  video.addEventListener('playing', () => {
    live.firstFrame ??= now() - live.loadStart;
    if (live.waitingSince != null) { live.stallMs += now() - live.waitingSince; live.waitingSince = null; }
  });
  video.addEventListener('waiting', () => {
    if (video.seeking || live.firstFrame == null) return; // seeks and startup are counted on their own
    live.stalls++; live.waitingSince = now();
  });
  video.addEventListener('seeking', () => { live.seeks++; live.seekStart = now(); });
  video.addEventListener('canplay', () => {
    if (live.seekStart != null) { live.lastSeekMs = now() - live.seekStart; live.seekStart = null; }
    if (live.waitingSince != null && !video.paused) { live.stallMs += now() - live.waitingSince; live.waitingSince = null; }
  });
  video.addEventListener('resize', () => { live.resizes++; });
  video.addEventListener('error', () => {
    const e = video.error;
    if (e) live.errors.push(`${['', 'aborted', 'network', 'decode', 'unsupported'][e.code] || e.code}${e.message ? `: ${e.message}` : ''}`);
  });

  // Frames the browser actually put on screen, from requestVideoFrameCallback where it exists.
  let frameCallback = null;
  const watchFrames = () => {
    if (!video.requestVideoFrameCallback || frameCallback != null || panel.hidden) return;
    const onFrame = (t, meta) => {
      frameCallback = null;
      if (panel.hidden) return;
      live.frameTimes.push(t);
      if (live.frameTimes.length > 240) live.frameTimes.splice(0, live.frameTimes.length - 240);
      live.presented = meta;
      frameCallback = video.requestVideoFrameCallback(onFrame);
    };
    frameCallback = video.requestVideoFrameCallback(onFrame);
  };
  const stopFrames = () => { if (frameCallback != null) video.cancelVideoFrameCallback?.(frameCallback); frameCallback = null; };

  // ---- file details from the server, and decoder support from the browser ----
  let info = null;
  let infoFor = null;
  let infoError = '';
  let decoding = null;
  const srcPath = () => { try { const u = new URL(video.currentSrc || video.src, location.href); return u.origin === location.origin ? u.pathname : null; } catch { return null; } };
  async function refreshInfo() {
    const src = srcPath();
    if (!src || src === infoFor) return;
    infoFor = src; info = null; infoError = ''; decoding = null;
    try {
      const data = await api(`/api/stream-info?src=${encodeURIComponent(src)}`);
      if (infoFor !== src) return;
      info = data;
      if (!data.known) infoError = data.reason || T('No file details.');
      else checkDecoding(data.file);
    } catch (e) { if (infoFor === src) infoError = e.message || T('File details unavailable.'); }
    render();
  }
  async function checkDecoding(file) {
    const v = file?.video;
    const vc = videoCodecString(v);
    const audio = file?.audio || [];
    const ac = audioCodecString(audio.find((a) => a.default) || audio[0]);
    const mime = /mp4|mov/.test(file.format || '') ? 'video/mp4' : /webm|matroska/.test(file.format || '') ? (/webm/.test(file.name || '') ? 'video/webm' : 'video/x-matroska') : 'video/mp4';
    const type = `${mime}; codecs="${[vc, ac].filter(Boolean).join(', ')}"`;
    const result = { type, canPlay: vc ? video.canPlayType(type) || 'no' : '' };
    if (vc && navigator.mediaCapabilities?.decodingInfo && v.width) {
      const config = { contentType: `${mime}; codecs="${vc}"`, width: v.width, height: v.height,
        bitrate: Math.round(v.bitrate || file.bitrate || 5e6), framerate: v.fps || 24 };
      if (v.transfer === 'smpte2084' || v.transfer === 'arib-std-b67') {
        config.transferFunction = v.transfer === 'smpte2084' ? 'pq' : 'hlg';
        config.colorGamut = v.primaries === 'bt2020' ? 'rec2020' : 'srgb';
        if (v.transfer === 'smpte2084') config.hdrMetadataType = 'smpteSt2086';
      }
      const ask = (cfg) => navigator.mediaCapabilities.decodingInfo({ type: 'file', video: cfg });
      try { result.caps = await ask(config); }
      catch { try { const { transferFunction, colorGamut, hdrMetadataType, ...plain } = config; result.caps = await ask(plain); } catch { /* unknown */ } }
    }
    if (infoFor === srcPath()) { decoding = result; render(); }
  }

  // ---- sampling ----
  function bufferedState() {
    const b = video.buffered;
    const t = video.currentTime;
    let ahead = 0; let total = 0; const ranges = [];
    for (let i = 0; i < b.length; i++) {
      const s = b.start(i); const e = b.end(i);
      total += e - s;
      ranges.push([s, e]);
      if (t >= s - 0.25 && t <= e) ahead = e - t;
    }
    return { ahead, total, ranges };
  }
  function sample() {
    const buf = bufferedState();
    const t = now();
    const fileBitrate = info?.file?.bitrate || (info?.file?.size && info.file.duration ? (info.file.size * 8) / info.file.duration : null);
    if (live.lastBuffered) {
      const dt = (t - live.lastBuffered.t) / 1000;
      const grown = buf.total - live.lastBuffered.total;
      if (dt > 0 && fileBitrate) {
        const instant = grown > 0 ? (grown * fileBitrate) / dt : 0;
        // Smooth over a few seconds; a buffer that stops growing means the browser is idle, not slow.
        live.rate = live.rate == null ? instant : live.rate * 0.7 + instant * 0.3;
        live.rateIdle = grown <= 0;
      }
    }
    live.lastBuffered = { t, total: buf.total };
    const q = video.getVideoPlaybackQuality?.();
    const dropped = q ? q.droppedVideoFrames : video.webkitDroppedFrameCount;
    if (dropped != null) { live.droppedRecent = Math.max(0, dropped - live.lastDropped); live.lastDropped = dropped; }
    push(bufferGraph, buf.ahead);
    push(netGraph, live.rate ?? 0);
    return { buf, q };
  }
  const push = (g, v) => { g.data.push(v); if (g.data.length > HISTORY) g.data.shift(); };

  // ---- rendering ----
  const rows = new Map(); // key → { row, value }
  const sections = new Map();
  function section(name) {
    if (!sections.has(name)) {
      const wrap = el('div', 'stats-section');
      wrap.append(el('p', 'stats-section-title', name));
      const dl = el('dl');
      wrap.append(dl);
      body.append(wrap);
      sections.set(name, { wrap, dl, used: false });
    }
    return sections.get(name);
  }
  let report = [];
  function set(sectionName, label, value, cls = '') {
    const key = `${sectionName}|${label}`;
    const s = section(sectionName);
    let r = rows.get(key);
    if (!r) {
      const row = el('div'); const dt = el('dt', null, label); const dd = el('dd');
      row.append(dt, dd); s.dl.append(row);
      r = { row, value: dd, section: s };
      rows.set(key, r);
    }
    const text = value == null ? '' : String(value);
    r.row.hidden = !text;
    if (r.value.textContent !== text) r.value.textContent = text;
    if (r.value.className !== cls) r.value.className = cls;
    r.seen = true;
    if (text) { s.used = true; report.push([sectionName, label, text]); }
  }

  function render() {
    if (panel.hidden) return;
    const { buf, q } = sample();
    report = [];
    for (const r of rows.values()) r.seen = false;
    for (const s of sections.values()) s.used = false;
    const ctx = context() || {};
    const file = info?.file;
    const v = file?.video;

    // What's playing and how it gets here
    set(T('Stream'), T('Title'), ctx.title);
    set(T('Stream'), T('Delivery'), [ctx.delivery || T('Direct play · HTTP byte ranges'), info?.served].filter(Boolean).join(' · '));
    set(T('Stream'), T('File'), file ? `${file.name}` : infoError || (srcPath() ? T('Asking the server…') : ''), file ? 'mono wrap' : '');
    if (file) {
      set(T('Stream'), T('Container'), [containerName(file), file.brand && T('brand {0}', file.brand.trim())].filter(Boolean).join(' · '));
      set(T('Stream'), T('Size'), [formatBytes(file.size), formatBitrate(file.bitrate) && T('{0} overall', formatBitrate(file.bitrate))].filter(Boolean).join(' · '));
      set(T('Stream'), T('Duration'), [formatDuration(file.duration), file.start ? T('starts at {0} s', file.start.toFixed(3)) : '', file.chapters ? T('{0} chapters', file.chapters) : ''].filter(Boolean).join(' · '));
      set(T('Stream'), T('Encoder'), file.encoder);
      set(T('Stream'), T('Modified'), file.modified ? new Date(file.modified).toLocaleString(locale) : '');
    }
    if (info?.original) {
      const o = info.original;
      set(T('Stream'), T('Original'), o.name, 'mono wrap');
      set(T('Stream'), T('Original file'), [containerName(o), formatBytes(o.size), formatBitrate(o.bitrate)].filter(Boolean).join(' · '));
      set(T('Stream'), T('Original streams'), [o.video && describeVideo(o.video).codec, o.video?.hdr && o.video.hdr !== 'SDR' && o.video.hdr,
        T('{0} audio', o.audio.length), o.subtitles.length && T('{0} subtitles', o.subtitles.length)].filter(Boolean).join(' · '));
    }
    if (info?.expires) set(T('Stream'), T('Link expires'), new Date(info.expires).toLocaleTimeString(locale));
    set(T('Stream'), T('Watch Together'), ctx.party);
    set(T('Stream'), T('Casting'), ctx.casting);

    // Video: the file's description, then what the browser decodes and draws
    const dv = describeVideo(v);
    set(T('Video'), T('Codec'), dv.codec);
    set(T('Video'), T('Codec string'), decoding?.type, 'mono wrap');
    set(T('Video'), T('Coded size'), dv.picture);
    set(T('Video'), T('Frame rate'), dv.frames);
    set(T('Video'), T('Pixel format'), dv.format);
    set(T('Video'), T('Colour'), dv.colour);
    set(T('Video'), T('Dynamic range'), dv.hdr);
    set(T('Video'), T('Bitrate'), dv.bitrate);
    set(T('Video'), T('Structure'), dv.structure);
    const caps = decoding?.caps;
    set(T('Video'), T('Decoder'), caps ? (caps.supported ? [caps.powerEfficient ? T('hardware (power efficient)') : T('software (not power efficient)'), caps.smooth ? 'smooth' : T('may not be smooth')].join(' · ') : T('reported unsupported'))
      : decoding?.canPlay ? `canPlayType: ${decoding.canPlay}` : '', caps && (!caps.supported || !caps.smooth) ? 'warn' : '');
    set(T('Video'), T('Decoded'), video.videoWidth ? `${video.videoWidth}×${video.videoHeight}${live.resizes > 1 ? T(' · {0} size changes', live.resizes - 1) : ''}` : '');

    // Display: how big the picture is drawn, and whether the screen can show HDR
    const rect = video.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    if (video.videoWidth && rect.width) {
      const scale = Math.min(rect.width / video.videoWidth, rect.height / video.videoHeight);
      const w = video.videoWidth * scale; const hgt = video.videoHeight * scale;
      set(T('Display'), T('Viewport'), T('{0}×{1} CSS px · ×{2}', Math.round(rect.width), Math.round(rect.height), Number(dpr.toFixed(2))));
      set(T('Display'), T('Picture drawn'), T('{0}×{1} device px · {2}× of source', Math.round(w * dpr), Math.round(hgt * dpr), (scale * dpr).toFixed(2)));
    }
    set(T('Display'), T('Screen'), T('{0}×{1} · {2}', screen.width, screen.height, [matchMedia('(dynamic-range: high)').matches ? T('HDR capable') : 'SDR',
      matchMedia('(color-gamut: rec2020)').matches ? T('Rec.2020 gamut') : matchMedia('(color-gamut: p3)').matches ? T('P3 gamut') : T('sRGB gamut')].join(' · ')));
    const times = live.frameTimes;
    if (times.length > 10) {
      const recent = times.slice(-Math.min(times.length, 120));
      const span = recent[recent.length - 1] - recent[0];
      const gaps = recent.slice(1).map((t, i) => t - recent[i]);
      const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      const jitter = Math.sqrt(gaps.reduce((a, g) => a + (g - mean) ** 2, 0) / gaps.length);
      set(T('Display'), T('Presented'), !video.paused && span > 0 ? T('{0} fps · frame gap {1} ms ± {2}', ((recent.length - 1) / span * 1000).toFixed(2), mean.toFixed(1), jitter.toFixed(1)) : 'paused');
    }
    if (live.presented?.processingDuration != null) set(T('Display'), T('Decode time'), T('{0} ms per frame', (live.presented.processingDuration * 1000).toFixed(1)));

    // Frames
    if (q || video.webkitDecodedFrameCount != null) {
      const total = q ? q.totalVideoFrames : video.webkitDecodedFrameCount;
      const dropped = q ? q.droppedVideoFrames : video.webkitDroppedFrameCount;
      const pct = total ? (dropped / total) * 100 : 0;
      set(T('Playback'), T('Frames'), T('{0} dropped of {1} ({2}%){3}', dropped.toLocaleString(locale), total.toLocaleString(locale), pct.toFixed(2), live.droppedRecent ? ` · +${live.droppedRecent} just now` : ''), pct > 1 || live.droppedRecent ? 'warn' : '');
      if (q?.corruptedVideoFrames) set(T('Playback'), T('Corrupted'), String(q.corruptedVideoFrames), 'warn');
    }
    set(T('Playback'), T('Position'), T('{0} / {1}{2}', formatDuration(video.currentTime), formatDuration(video.duration), video.playbackRate !== 1 ? ` · ${video.playbackRate}× speed` : ''));
    set(T('Playback'), T('State'), [video.paused ? 'paused' : video.ended ? 'ended' : 'playing', video.seeking && 'seeking',
      ['HAVE_NOTHING', 'HAVE_METADATA', 'HAVE_CURRENT_DATA', 'HAVE_FUTURE_DATA', 'HAVE_ENOUGH_DATA'][video.readyState],
      ['NETWORK_EMPTY', 'NETWORK_IDLE', 'NETWORK_LOADING', 'NETWORK_NO_SOURCE'][video.networkState]].filter(Boolean).join(' · '));
    set(T('Playback'), T('Volume'), video.muted ? 'muted' : `${Math.round(video.volume * 100)}%`);
    set(T('Playback'), T('Startup'), [live.metadataAt != null && T('metadata {0} ms', Math.round(live.metadataAt)), live.firstFrame != null && T('playing after {0} ms', Math.round(live.firstFrame))].filter(Boolean).join(' · '));
    const stallNow = live.waitingSince != null ? now() - live.waitingSince : 0;
    set(T('Playback'), T('Stalls'), T('{0}{1}{2}', live.stalls, live.stalls ? ` · ${((live.stallMs + stallNow) / 1000).toFixed(1)} s waiting` : '', stallNow ? ' · waiting now' : ''), live.stalls ? 'warn' : '');
    set(T('Playback'), T('Seeks'), live.seeks ? `${live.seeks}${live.lastSeekMs != null ? T(' · last ready in {0} ms', Math.round(live.lastSeekMs)) : ''}` : '');
    set(T('Playback'), T('Errors'), live.errors.slice(-3).join(' | '), 'warn');

    // Buffer and network
    set(T('Network'), T('Buffer'), T('{0} s ahead · {1} s held in {2} range{3}', buf.ahead.toFixed(1), buf.total.toFixed(0), buf.ranges.length, buf.ranges.length === 1 ? '' : 's'), buf.ahead < 2 && !video.paused && !video.ended ? 'warn' : '');
    set(T('Network'), T('Ranges'), buf.ranges.length > 1 || (buf.ranges[0] && buf.ranges[0][0] > 0.5) ? buf.ranges.slice(0, 4).map(([s, e]) => `${formatDuration(s).replace(/\.\d+$/, '')}–${formatDuration(e).replace(/\.\d+$/, '')}`).join(', ') + (buf.ranges.length > 4 ? T(' …') : '') : '', 'mono');
    set(T('Network'), T('Download'), live.rate == null ? (file ? T('measuring…') : '') : live.rateIdle && live.rate < 1e5 ? T('idle (buffer full or paused)') : T('≈ {0} (from buffer growth)', formatBitrate(live.rate)));
    const fileRate = file?.bitrate;
    if (fileRate && live.rate && !live.rateIdle) set(T('Network'), T('Headroom'), T('{0}× the file’s bitrate', (live.rate / fileRate).toFixed(1)), live.rate < fileRate * 1.2 ? 'warn' : '');
    else set(T('Network'), T('Headroom'), '');
    const c = navigator.connection;
    set(T('Network'), T('Connection'), c ? [c.type && c.type !== 'unknown' && c.type, c.effectiveType && T('{0} class', c.effectiveType), c.downlink && T('~{0} Mbps reported', c.downlink), c.rtt != null && T('rtt {0} ms', c.rtt), c.saveData && T('data saver')].filter(Boolean).join(' · ') : '');
    set(T('Network'), T('Server probe'), file?.probeMs != null ? `${file.probeMs} ms${file.probeMs < 5 ? ' (cached)' : ''}` : '');

    // Audio: the active choice, then every stream in the file
    set(T('Audio'), T('Active'), ctx.audio || (video.audioTracks ? [...video.audioTracks].find((t) => t.enabled)?.label : '') || (file?.audio?.length === 1 ? T('the only track') : ''));
    (file?.audio || []).forEach((a, i) => set(T('Audio'), T('#{0}', i + 1), describeAudio(a)));
    if (decoding?.type) set(T('Audio'), T('Browser says'), decoding.canPlay ? `canPlayType “${decoding.canPlay}”` : '');

    // Subtitles
    set(T('Subtitles'), T('Showing'), ctx.subtitles || 'off');
    const subs = (info?.original || file)?.subtitles || [];
    subs.slice(0, 12).forEach((s, i) => set(T('Subtitles'), T('In file #{0}', i + 1), [codecName(s.codec), s.language, s.title && `“${s.title}”`, s.default && 'default', s.forced && 'forced', s.hearingImpaired && 'SDH'].filter(Boolean).join(' · ')));
    if (subs.length > 12) set(T('Subtitles'), T('More'), T('{0} more', subs.length - 12));

    // Browser
    set(T('Browser'), T('User agent'), navigator.userAgent, 'mono wrap');

    for (const r of rows.values()) if (!r.seen) r.row.hidden = true;
    for (const s of sections.values()) s.wrap.hidden = !s.used;
    bufferGraph.val.textContent = `${buf.ahead.toFixed(1)} s`;
    netGraph.val.textContent = live.rate == null ? '–' : live.rateIdle && live.rate < 1e5 ? T('idle') : formatBitrate(live.rate);
    draw(bufferGraph, Math.max(30, ...bufferGraph.data));
    draw(netGraph, Math.max(fileRate ? fileRate * 2 : 1e6, ...netGraph.data), fileRate);
  }

  function draw(g, max, marker) {
    const c = g.canvas;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth; const hgt = c.clientHeight;
    if (!w || !hgt) return;
    if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(hgt * dpr); }
    const x = c.getContext('2d');
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    x.clearRect(0, 0, w, hgt);
    const css = getComputedStyle(panel);
    const accent = css.getPropertyValue('--bulb').trim() || '#F4C152';
    const dim = css.getPropertyValue('--dust').trim() || '#999';
    if (marker) { // the file's bitrate: the download line must stay above it
      const y = hgt - (marker / max) * (hgt - 2) - 1;
      x.strokeStyle = dim; x.globalAlpha = 0.6; x.setLineDash([3, 3]); x.lineWidth = 1;
      x.beginPath(); x.moveTo(0, y); x.lineTo(w, y); x.stroke(); x.setLineDash([]); x.globalAlpha = 1;
    }
    const d = g.data;
    if (d.length < 2) return;
    const step = w / (HISTORY - 1);
    const off = (HISTORY - d.length) * step;
    x.beginPath();
    d.forEach((v, i) => { const px = off + i * step; const py = hgt - (v / max) * (hgt - 2) - 1; i ? x.lineTo(px, py) : x.moveTo(px, py); });
    x.strokeStyle = accent; x.lineWidth = 1.5; x.lineJoin = 'round'; x.stroke();
    x.lineTo(off + (d.length - 1) * step, hgt); x.lineTo(off, hgt); x.closePath();
    x.globalAlpha = 0.15; x.fillStyle = accent; x.fill(); x.globalAlpha = 1;
  }

  let timer = null;
  function open() {
    if (!panel.hidden) return;
    panel.hidden = false;
    live.lastBuffered = null;
    refreshInfo();
    watchFrames();
    render();
    timer = setInterval(() => { if (host.hidden) close(); else { if (srcPath() !== infoFor) refreshInfo(); render(); } }, SAMPLE_MS);
  }
  function close() {
    panel.hidden = true;
    clearInterval(timer); timer = null;
    stopFrames();
  }
  closeBtn.addEventListener('click', close);
  copyBtn.addEventListener('click', async () => {
    let last = '';
    const text = report.map(([s, label, value]) => { const head = s !== last ? `\n[${s}]\n` : ''; last = s; return `${head}${label}: ${value}`; }).join('\n').trim();
    try { await navigator.clipboard.writeText(text); copyBtn.textContent = T('Copied'); }
    catch { copyBtn.textContent = T('Copy failed'); }
    setTimeout(() => { copyBtn.textContent = T('Copy'); }, 1500);
  });
  return { open, close, toggle: () => (panel.hidden ? open() : close()), isOpen: () => !panel.hidden, element: panel };
}
