// Episodes in order: a season Marquee downloads gets its episodes one after another, each at full
// speed, so episode 1 is watchable (and converted to MP4) while episode 2 downloads, and so on.
//
// A season pack: the next unfinished episode's file gets qBittorrent's highest file priority, the
// rest normal (never "skip": that would make the pack look finished). Separate episode torrents:
// only the earliest unfinished one runs; Marquee stops the later ones and starts each in turn.
// Stalled episodes (no peers) don't hold up the season: up to three of them keep trying, and the first
// healthy one runs alongside them. A torrent Marquee stopped after seeing it stall (wasStalled) still
// counts as stalled, so dead torrents can't take turns starving a healthy one. At the same episode a
// pack's file goes before a separate torrent. Torrents the person paused and failed ones are left alone.
import path from 'node:path';
import { episodesIn } from './season.js';

export const TOP = 7, NORMAL = 1;
const VIDEO = /\.(mkv|mp4|m4v|avi|mov|webm|ts|wmv)$/i;
const STALLED = /^(stalledDL|metaDL|forcedMetaDL)$/;
const PAUSED = /^(paused|stopped)/;
const FAILED = /^(error|missingFiles|unknown)$/;
const MAX_RUNNING = 3;

// group: { season, ctx? (anime context: names placed on TMDB's numbering), torrents: [{ hash, name, state, progress, wasStalled?, files: [{ index, name, progress, priority }] }] }
// held: Set of hashes Marquee stopped itself. Returns the changes to make:
// { priorities: [{ hash, ids, priority }], stop: [hash], start: [hash], running: [{ hash, episode }] }
export function planEpisodeOrder(group, held = new Set()) {
  const units = [];
  const packs = new Map();
  for (const t of group.torrents) {
    if (FAILED.test(t.state || '')) continue;
    if (PAUSED.test(t.state || '') && !held.has(t.hash)) continue; // paused by the person: theirs
    const stalled = STALLED.test(t.state || '') || (PAUSED.test(t.state || '') && Boolean(t.wasStalled));
    const videos = (t.files || []).filter((f) => f.priority !== 0 && VIDEO.test(f.name) && !/\bsample\b/i.test(f.name))
      .map((f) => ({ f, eps: episodesIn(path.basename(String(f.name).replace(/\\/g, '/')), group.season, group.ctx) }))
      .filter((v) => v.eps.length);
    if (videos.length > 1) {
      packs.set(t.hash, t);
      for (const { f, eps } of videos) units.push({ hash: t.hash, file: f, episode: Math.min(...eps), done: f.progress >= 1, stalled, pack: true });
    } else {
      const eps = videos[0]?.eps || episodesIn(t.name, group.season, group.ctx);
      if (!eps.length) continue;
      units.push({ hash: t.hash, episode: Math.min(...eps), done: t.progress >= 1, stalled, pack: false });
    }
  }
  units.sort((a, b) => a.episode - b.episode || b.pack - a.pack);
  const running = [];
  let stalledCount = 0;
  for (const u of units.filter((x) => !x.done)) {
    if (!u.stalled) { running.push(u); break; }
    if (stalledCount < MAX_RUNNING) { running.push(u); stalledCount++; }
  }
  const runningHashes = new Set(running.map((u) => u.hash));
  const plan = { priorities: [], stop: [], start: [], running: running.map(({ hash, episode }) => ({ hash, episode })) };
  for (const [hash] of packs) {
    const byPriority = new Map();
    for (const u of units.filter((x) => x.hash === hash && !x.done)) {
      const want = running.includes(u) ? TOP : NORMAL;
      if (u.file.priority !== want) byPriority.set(want, [...(byPriority.get(want) || []), u.file.index]);
    }
    for (const [priority, ids] of byPriority) plan.priorities.push({ hash, ids, priority });
  }
  for (const hash of new Set(units.filter((u) => !u.done).map((u) => u.hash))) {
    const t = group.torrents.find((x) => x.hash === hash);
    const paused = PAUSED.test(t.state || '');
    if (runningHashes.has(hash)) { if (paused) plan.start.push(hash); } else if (!paused) plan.stop.push(hash);
  }
  return plan;
}
