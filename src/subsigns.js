// Typeset signs in subtitles that ffmpeg turned from ASS into SRT.
//
// Fansubs translate text in the picture (a letter, a poster, a sign on a door) with "signs": lines in
// their own font, placed on the thing itself with \pos, often one cue per word or even per letter,
// drawn in layers (border + fill) and re-sent every few frames when the camera moves. SRT keeps the
// text but not the positions, so a player stacks every piece at the bottom: a sheet of paper became
// a 54-line column of single letters over the picture (K-ON! episode 1).
//
// tidySigns finds the dialogue font (the one most of the text is in) and treats cues in any other font as
// signs. Signs shown at the same moment become one cue at the top of the picture, pieces joined
// with " · "; letter-by-letter pieces are dropped (their spaces are gone, so they'd read as one long
// word), as are copies from extra layers. A sign repeated frame after frame becomes one cue.
// Files without font tags (OpenSubtitles downloads, OCR) come back unchanged.

const TIME = /^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{3})/;
const ms = (h, m, s, f) => ((Number(h) * 60 + Number(m)) * 60 + Number(s)) * 1000 + Number(f);
const stamp = (t) => {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(t / 3600000))}:${p(Math.floor(t / 60000) % 60)}:${p(Math.floor(t / 1000) % 60)},${p(t % 1000, 3)}`;
};
const faceOf = (text) => /<font\b[^>]*\bface="([^"]+)"/i.exec(text)?.[1] || null;
// What a viewer would read: no HTML or ASS tags, no {comments}, tidy spaces.
const visible = (text) => text.replace(/<[^>]*>/g, '').replace(/\{[^}]*\}/g, '').replace(/\\N/gi, ' ')
  .replace(/\s+/g, ' ').trim();

const SHORT = 2; // a piece this short, in a group with others like it, is one letter of a typeset word
const SHORT_RUN = 3; // ... when the group has at least this many
const FRAME_GAP = 60; // ms between two copies of a sign that still count as one (re-sent per frame)

export function tidySigns(srt) {
  const text = String(srt);
  if (!/<font\b[^>]*\bface=/i.test(text)) return text;
  const blocks = text.replace(/^﻿/, '').replace(/^\s+/, '').split(/\n\s*\n/);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    const at = lines.findIndex((l) => TIME.test(l));
    if (at < 0) {
      // A blank line inside a cue's text (ffmpeg keeps them from ASS): it belongs to the cue before.
      if (block.trim() && cues.length) cues[cues.length - 1].body += `\n${block.trim()}`;
      else if (block.trim()) return text; // not SRT: leave it alone
      continue;
    }
    const m = TIME.exec(lines[at]);
    const body = lines.slice(at + 1).join('\n');
    cues.push({ start: ms(m[1], m[2], m[3], m[4]), end: ms(m[5], m[6], m[7], m[8]), body, face: faceOf(body) });
  }

  const count = new Map();
  for (const c of cues) if (c.face) count.set(c.face, (count.get(c.face) || 0) + visible(c.body).length); // by text, not cues
  if (count.size < 2) return text;
  const dialogue = [...count].sort((a, b) => b[1] - a[1])[0][0];
  const isSign = (c) => c.face && c.face !== dialogue;
  if (!cues.some(isSign)) return text;

  // Signs on screen at the same moment → one cue.
  const groups = new Map();
  for (const c of cues) {
    if (!isSign(c)) continue;
    const key = `${c.start}-${c.end}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  const out = [];
  const placed = new Set();
  for (const c of cues) {
    if (!isSign(c)) { out.push(c); continue; }
    const key = `${c.start}-${c.end}`;
    if (placed.has(key)) continue;
    placed.add(key);
    const group = groups.get(key);
    let pieces = group.map((g) => visible(g.body)).filter(Boolean);
    if (pieces.filter((p) => [...p].length <= SHORT).length >= SHORT_RUN) pieces = pieces.filter((p) => [...p].length > SHORT);
    pieces = [...new Set(pieces)];
    if (!pieces.length) continue;
    out.push({ start: c.start, end: c.end, sign: pieces.join(' · ') });
  }

  // The same sign re-sent frame after frame (moving camera) → one cue for the whole run.
  const lastOf = new Map();
  const merged = [];
  for (const c of out) {
    if (c.sign) {
      const prev = lastOf.get(c.sign);
      if (prev && c.start <= prev.end + FRAME_GAP) { prev.end = Math.max(prev.end, c.end); continue; }
      lastOf.set(c.sign, c);
    }
    merged.push(c);
  }

  return merged.map((c, i) => `${i + 1}\n${stamp(c.start)} --> ${stamp(c.end)}\n${c.sign ? `{\\an8}${c.sign}` : c.body}`).join('\n\n') + '\n';
}
