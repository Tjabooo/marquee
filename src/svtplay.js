// SVT Play: Swedish public service TV, free to watch in Sweden and a large part of its catalogue is
// documentaries and true crime that torrent sites hardly have. Three things are read from it:
//
//   - category, title and search pages from www.svtplay.se: each page carries the data it was drawn from
//     in `window.URQL_DATA` (the GraphQL API behind them only takes SVT's own persisted queries).
//   - api.svt.se/video/<id>: a video's streams, Swedish subtitles and rights.
//   - the HLS master playlist: which picture and sound to save.
//
// Pages change without notice, so everything here fails soft: a page that can't be read is an empty
// list and a log line, never a broken Discover. Videos SVT marks as copy protected are refused.
// SVT_PLAY=off leaves it out. It only works from a Swedish address (SVT's geoblock).

import crypto from 'node:crypto';

const SITE = 'https://www.svtplay.se';
const VIDEO_API = 'https://api.svt.se/video';
const IMAGES = 'https://www.svtstatic.se/image/custom';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
const PAGE_TTL = 30 * 60 * 1000;

export const svtEnabled = () => !/^(off|no|false|0)$/i.test(process.env.SVT_PLAY || '');

// Paths come from the browser, so only SVT's two shapes of title address are ever fetched.
const TITLE_PATH = /^\/(?:video\/[A-Za-z0-9]+\/[a-z0-9-]+(?:\/[a-z0-9-]+)?|[a-z0-9][a-z0-9-]*)$/;
export const validPath = (p) => TITLE_PATH.test(String(p || '')) && p.length < 200;
const CATEGORY = /^[a-z0-9-]{2,60}$/;
const VIDEO_ID = /^[A-Za-z0-9]{4,20}$/;

const stripTags = (s) => String(s || '').replace(/<[^>]+>/g, '').trim();
export const imageUrl = (image, width = 780) => (image?.id
  ? `${IMAGES}/${width}/${encodeURIComponent(image.id)}/${encodeURIComponent(image.changed || 0)}?format=auto&quality=70`
  : null);

// The JSON in `window.URQL_DATA = {...}`: { key: { data: "<json>" } }, parsed one level further.
// Scans for the closing brace, because the data itself contains "};" and "</script>"-free text.
export function pageData(html) {
  const text = String(html || '');
  const start = text.indexOf('window.URQL_DATA');
  if (start < 0) return [];
  const open = text.indexOf('{', start);
  if (open < 0) return [];
  let depth = 0, quoted = false, end = -1;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '\\') i++;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) { end = i; break; }
  }
  if (end < 0) return [];
  let outer;
  try { outer = JSON.parse(text.slice(open, end + 1)); } catch { return []; }
  return Object.values(outer).map((v) => {
    try { return typeof v?.data === 'string' ? JSON.parse(v.data) : null; } catch { return null; }
  }).filter(Boolean);
}

// Every selection (a row of teasers) anywhere in a page, in page order.
const teasersOf = (sel) => sel?.items || sel?.itemsAdult || [];
function selections(node, out = []) {
  if (Array.isArray(node)) { for (const x of node) selections(x, out); return out; }
  if (!node || typeof node !== 'object') return out;
  if (node.__typename === 'Selection') out.push(node);
  for (const value of Object.values(node)) if (value && typeof value === 'object') selections(value, out);
  return out;
}

// A teaser as a card. Only whole titles: clips and stray episodes of other programmes aren't things to add.
export function mapTeaser(teaser) {
  const item = teaser?.item;
  const path = item?.urls?.svtplay;
  const kind = item?.__typename === 'TvSeries' ? 'series' : item?.__typename === 'Single' ? 'film' : null;
  if (!kind || !validPath(path)) return null;
  const title = stripTags(teaser.heading);
  if (!title) return null;
  const description = teaser.images?.wide?.description || '';
  const year = Number(/\b((?:19|20)\d{2})\b/.exec(description)?.[1]) || null;
  return {
    type: 'svt', id: path, path, kind, title, year,
    overview: stripTags(teaser.subHeading) || stripTags(teaser.byline),
    backdrop: imageUrl(teaser.images?.wide, 1280),
    wide: imageUrl(teaser.images?.wide, 640),
    poster: imageUrl(teaser.images?.portrait, 342),
    genres: [99],
  };
}

function uniqueTeasers(lists) {
  const seen = new Set(), out = [];
  for (const teaser of lists.flat()) {
    const t = mapTeaser(teaser);
    if (!t || seen.has(t.path)) continue;
    seen.add(t.path);
    out.push(t);
  }
  return out;
}

export function parseCategory(html) {
  const page = pageData(html).find((d) => d.categoryPage)?.categoryPage;
  if (!page) return null;
  return { title: page.heading || null, items: uniqueTeasers(selections(page).map(teasersOf)) };
}

export function parseSearch(html) {
  const page = pageData(html).find((d) => d.searchPage)?.searchPage;
  if (!page) return null;
  return uniqueTeasers([(page.flat?.hits || []).map((h) => h.teaser).filter(Boolean)]);
}

const minutesIn = (text) => {
  const hours = Number(/(\d+)\s*tim/.exec(text || '')?.[1]) || 0;
  const minutes = Number(/(\d+)\s*min/.exec(text || '')?.[1]) || 0;
  return hours * 60 + minutes || null;
};

// SVT's numbered seasons, or (news-like programmes) periods such as "2026" and "Sommar 2026", newest first.
// Lilin numbers those from the oldest, and their episodes from the oldest too, so new ones never renumber old.
function seasonsOf(page) {
  const found = [];
  for (const mod of page.modules || []) {
    const sel = mod.defaultSelection || mod.gridSelection;
    if (!sel || !['season', 'productionPeriod'].includes(sel.selectionType)) continue;
    const teasers = teasersOf(sel).filter((t) => t?.item?.__typename === 'Episode' && t.item.videoSvtId);
    if (!teasers.length) continue;
    found.push({ name: sel.name || '', kind: sel.selectionType, teasers });
  }
  const dated = found.some((s) => s.kind === 'productionPeriod');
  if (dated) found.reverse();
  const used = new Set();
  return found.map((s, i) => {
    const named = !dated && Number(/(\d{1,2})\s*$/.exec(s.name)?.[1]);
    let number = named && !used.has(named) ? named : i + 1;
    while (used.has(number)) number++;
    used.add(number);
    const inOrder = dated ? [...s.teasers].reverse() : s.teasers;
    const taken = new Set();
    const episodes = inOrder.map((t, at) => {
      const heading = stripTags(t.heading);
      const m = /^(\d{1,3})\.\s*(.*)$/.exec(heading);
      let episode = m ? Number(m[1]) : at + 1;
      while (taken.has(episode)) episode++;
      taken.add(episode);
      return {
        number: episode,
        name: (m ? m[2] : heading) || `Avsnitt ${episode}`,
        overview: stripTags(t.description),
        still: imageUrl(t.images?.wide, 640),
        minutes: minutesIn(t.subHeading),
        videoId: t.item.videoSvtId,
      };
    }).sort((a, b) => a.number - b.number);
    return { number, name: s.name, dated, episodes };
  }).sort((a, b) => a.number - b.number);
}

export function parseTitle(html, path) {
  const page = pageData(html).find((d) => d.detailsPageByPath)?.detailsPageByPath;
  const item = page?.item;
  if (!item) return null;
  const kind = item.__typename === 'TvSeries' ? 'series' : item.__typename === 'Single' ? 'film' : null;
  if (!kind) return null;
  const title = {
    type: 'svt', id: path, path, kind,
    title: stripTags(item.name),
    overview: stripTags(page.description),
    year: page.moreDetails?.productionYear || null,
    backdrop: imageUrl(page.images?.wide, 1280),
    wide: imageUrl(page.images?.wide, 640),
    poster: imageUrl(page.images?.portrait, 342),
    categories: (page.categories || []).map((c) => c.id).filter(Boolean),
    validTo: item.validTo || null,
    genres: [99],
    seasons: [],
    minutes: null,
    videoId: null,
  };
  if (!title.title) return null;
  if (kind === 'film') {
    title.videoId = page.smartStart?.videoSvtId || item.videoSvtId || item.svtId || null;
    title.minutes = item.duration ? Math.round(item.duration / 60) : null;
    if (!title.videoId) return null;
  } else {
    title.seasons = seasonsOf(page);
    if (!title.seasons.length) return null;
  }
  if (title.categories.includes('true-crime')) title.genres = [99, 80];
  return title;
}

// A video's streams and rights: what the download needs, or `refused` with the reason.
export function parseVideo(json) {
  const refs = Array.isArray(json?.videoReferences) ? json.videoReferences : [];
  const rights = json?.rights || {};
  // H.264 only, so the saved file plays everywhere (TV, phones, browsers) without being converted.
  const order = ['hls-cmaf-avc', 'hls'];
  const best = order.map((f) => refs.find((r) => r.format === f && /^https:\/\//.test(r.url || ''))).find(Boolean);
  const subs = (Array.isArray(json?.subtitleReferences) ? json.subtitleReferences : [])
    .filter((s) => /^https:\/\//.test(s.url || '') && /vtt/i.test(s.format || s.url))
    .filter((s) => /svenska|swedish/i.test(s.label || 'svenska'));
  // Plain Swedish subtitles (for what isn't said in Swedish) first; else the full transcript.
  const subtitle = subs.find((s) => s.type === 'subtitle') || subs[0] || null;
  let refused = null;
  if (rights.drmCopyProtection) refused = 'SVT copy protects this video, so it can’t be saved.';
  else if (json?.live) refused = 'This is a live broadcast, so it can’t be saved.';
  else if (!best) refused = 'SVT Play has no playable stream for this right now.';
  return {
    refused,
    url: best?.url || null,
    format: best?.format || null,
    subtitleUrl: subtitle?.url || null,
    duration: Number(json?.contentDuration) || null,
    validTo: rights.validTo || null,
  };
}

const attr = (line, name) => {
  const m = new RegExp(`(?:^|[:,])${name}=(?:"([^"]*)"|([^,]*))`, 'i').exec(line);
  return m ? (m[1] ?? m[2]) : null;
};

// From an HLS master playlist: the best picture up to 1080p and its main sound (never the audio-described one).
export function pickVariant(master, baseUrl) {
  const lines = String(master || '').split(/\r?\n/).map((l) => l.trim());
  const abs = (u) => { try { return new URL(u, baseUrl).href; } catch { return null; } };
  const audio = [], video = [];
  lines.forEach((line, i) => {
    if (/^#EXT-X-MEDIA:/i.test(line) && /TYPE=AUDIO/i.test(line) && attr(line, 'URI')) {
      audio.push({ group: attr(line, 'GROUP-ID'), url: abs(attr(line, 'URI')), default: /DEFAULT=YES/i.test(line),
        described: /describes-video/i.test(attr(line, 'CHARACTERISTICS') || '') || /syntolk/i.test(attr(line, 'NAME') || ''),
        language: attr(line, 'LANGUAGE') });
    }
    if (/^#EXT-X-STREAM-INF:/i.test(line)) {
      const next = lines.slice(i + 1).find((l) => l && !l.startsWith('#'));
      if (!next) return;
      const height = Number(/x(\d+)/i.exec(attr(line, 'RESOLUTION') || '')?.[1]) || 0;
      video.push({ url: abs(next), height, bandwidth: Number(attr(line, 'BANDWIDTH')) || 0, audioGroup: attr(line, 'AUDIO') });
    }
  });
  const usable = video.filter((v) => v.height <= 1080);
  const best = (usable.length ? usable : video).sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth)[0];
  if (!best?.url) return null;
  const candidates = audio.filter((a) => a.url && !a.described && (!best.audioGroup || a.group === best.audioGroup));
  const sound = candidates.find((a) => a.default) || candidates[0] || null;
  return { videoUrl: best.url, audioUrl: sound?.url || null, height: best.height, bandwidth: best.bandwidth };
}

// WebVTT -> SRT: Lilin keeps subtitles as "<name>.sv.srt" beside the video.
export function vttToSrt(vtt) {
  const out = [];
  const blocks = String(vtt || '').replace(/^﻿/, '').replace(/\r/g, '').split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n').filter(Boolean);
    const at = lines.findIndex((l) => l.includes('-->'));
    if (at < 0) continue;
    const m = /((?:\d+:)?\d{2}:\d{2}[.,]\d{3})\s*-->\s*((?:\d+:)?\d{2}:\d{2}[.,]\d{3})/.exec(lines[at]);
    if (!m) continue;
    const stamp = (t) => (t.split(':').length === 2 ? `00:${t}` : t).replace('.', ',');
    const text = lines.slice(at + 1).map((l) => l.replace(/<\/?(?:c|v|lang|ruby|rt)(?:[.\s][^>]*)?>/gi, '')
      .replace(/&nbsp;/g, ' ').replace(/&lrm;|&rlm;/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim()).filter(Boolean);
    if (!text.length) continue;
    out.push(`${out.length + 1}\n${stamp(m[1])} --> ${stamp(m[2])}\n${text.join('\n')}\n`);
  }
  return out.join('\n');
}

// ---------- fetching ----------
const pages = new Map(); // url -> { at, promise }
async function fetchText(url, what) {
  const r = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'text/html,application/json;q=0.9,*/*;q=0.8', 'accept-language': 'sv-SE,sv;q=0.9' },
    signal: AbortSignal.timeout(12000),
  });
  if (!r.ok) throw Object.assign(new Error(`${what} responded with ${r.status}.`), { status: r.status });
  return r.text();
}
function cachedPage(url, what) {
  const hit = pages.get(url);
  if (hit && Date.now() - hit.at < PAGE_TTL) return hit.promise;
  const promise = fetchText(url, what);
  pages.set(url, { at: Date.now(), promise });
  promise.catch(() => pages.delete(url));
  if (pages.size > 200) pages.delete(pages.keys().next().value);
  return promise;
}

export async function svtCategory(slug) {
  if (!svtEnabled() || !CATEGORY.test(String(slug))) return { title: null, items: [] };
  try {
    const parsed = parseCategory(await cachedPage(`${SITE}/kategori/${slug}`, 'SVT Play'));
    if (!parsed) console.warn(`[svt] couldn't read the category page ${slug}`);
    return parsed || { title: null, items: [] };
  } catch (e) {
    console.warn(`[svt] category ${slug}: ${e.message}`);
    return { title: null, items: [] };
  }
}

export async function svtSearch(q) {
  const query = String(q || '').trim().slice(0, 100);
  if (!svtEnabled() || query.length < 2) return [];
  try {
    return parseSearch(await cachedPage(`${SITE}/sok?q=${encodeURIComponent(query)}`, 'SVT Play')) || [];
  } catch (e) {
    console.warn(`[svt] search: ${e.message}`);
    return [];
  }
}

export async function svtTitle(path) {
  if (!svtEnabled() || !validPath(path)) return null;
  const parsed = parseTitle(await cachedPage(`${SITE}${path}`, 'SVT Play'), path);
  if (!parsed) console.warn(`[svt] couldn't read the title page ${path}`);
  return parsed;
}

export async function svtVideo(id) {
  if (!VIDEO_ID.test(String(id))) throw new Error('Not an SVT Play video.');
  return parseVideo(JSON.parse(await fetchText(`${VIDEO_API}/${id}`, 'SVT Play')));
}

export async function svtStreams(video) {
  const master = await fetchText(video.url, 'SVT Play');
  const picked = pickVariant(master, video.url);
  if (!picked) throw new Error('SVT Play’s stream list couldn’t be read.');
  return picked;
}

// The queue's key for a video (src/svt-queue.js): looks like a torrent hash, so download routes accept it.
export const svtHashOf = (videoId) => crypto.createHash('sha1').update(`svt:${videoId}`).digest('hex');

export const svtSubtitles = async (url) => vttToSrt(await fetchText(url, 'SVT Play'));
