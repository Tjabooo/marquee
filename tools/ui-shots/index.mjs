#!/usr/bin/env node
// A browsable before/after page for a shots folder laid out as <root>/{before,after}/<run>/<name>.png.
//   node tools/ui-shots/index.mjs ~/marquee-shots  →  ~/marquee-shots/index.html
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] || 'shots');
const collect = (side) => {
  const map = new Map();
  const base = path.join(root, side);
  if (!fs.existsSync(base)) return map;
  for (const run of fs.readdirSync(base)) {
    const dir = path.join(base, run);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) if (f.endsWith('.png')) map.set(f.replace('.png', ''), path.relative(root, path.join(dir, f)));
  }
  return map;
};
const before = collect('before'), after = collect('after');
const names = [...new Set([...before.keys(), ...after.keys()])].sort();
const [missingAfter, missingBefore] = [names.filter((n) => !after.has(n)), names.filter((n) => !before.has(n))];
const cell = (src) => (src ? `<a href="${src}"><img loading="lazy" src="${src}"></a>` : '<div class="none">none</div>');
const html = `<!doctype html><meta charset="utf-8"><title>Marquee revamp: before and after</title><style>
body{margin:0;padding:24px;background:#140a10;color:#f6eadf;font:14px system-ui}h1{font-size:22px}
.filters{position:sticky;top:0;background:#140a10;padding:8px 0;z-index:1}input{padding:8px 12px;border-radius:8px;border:1px solid #4b2c3f;background:#2b1724;color:inherit;width:320px}
section{margin:18px 0;padding:12px;background:#1f1019;border-radius:12px}h2{margin:0 0 8px;font-size:14px;color:#f4c152}
.pair{display:grid;grid-template-columns:1fr 1fr;gap:10px;align-items:start}img{width:100%;border-radius:6px;border:1px solid #3a2031}.none{color:#ba9dad;padding:40px;text-align:center;border:1px dashed #4b2c3f;border-radius:6px}
small{color:#ba9dad}</style>
<h1>Marquee revamp: before and after</h1>
<p><small>${names.length} screens · ${before.size} before · ${after.size} after · new screens with no before: ${missingBefore.length} · before shots with no after: ${missingAfter.length}${missingAfter.length ? ` (${missingAfter.join(', ')})` : ''}</small></p>
<div class="filters"><input placeholder="Filter: e.g. phone--sv, title-film, tv" oninput="for(const s of document.querySelectorAll('section'))s.hidden=!s.id.includes(this.value)"></div>
${names.map((n) => `<section id="${n}"><h2>${n}</h2><div class="pair">${cell(before.get(n))}${cell(after.get(n))}</div></section>`).join('\n')}`;
fs.writeFileSync(path.join(root, 'index.html'), html);
console.log(`${path.join(root, 'index.html')}: ${names.length} screens, no after: ${missingAfter.length}, no before: ${missingBefore.length}`);
if (missingAfter.length) console.log('missing after:', missingAfter.join(' '));
