#!/usr/bin/env node
// Contact sheet: lays screenshots out in a labelled grid and renders it to one PNG with headless Chromium.
//   node tools/ui-shots/contact.mjs <dir> <out.png> [--match regex] [--cols 4] [--width 300] [--pair otherDir]
// --pair puts each shot next to the same-named shot from another folder (before | after).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const [dir, out, ...rest] = process.argv.slice(2);
const opt = Object.fromEntries(rest.reduce((a, x, i, all) => (x.startsWith('--') ? [...a, [x.slice(2), all[i + 1]]] : a), []));
const cols = Number(opt.cols || 4), width = Number(opt.width || 300);
const match = new RegExp(opt.match || '.');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.png') && match.test(f)).sort();
const pair = opt.pair ? path.resolve(opt.pair) : null;
const cell = (file, label) => `<figure><img src="file://${file}" style="width:${width}px"><figcaption>${label}</figcaption></figure>`;
const cells = files.map((f) => pair
  ? `<div class="pair">${cell(path.resolve(dir, f), 'before · ' + f.replace('.png', ''))}${fs.existsSync(path.join(pair, f)) ? cell(path.join(pair, f), 'after') : '<figure class="missing">no after shot</figure>'}</div>`
  : cell(path.resolve(dir, f), f.replace('.png', '')));
const html = `<!doctype html><meta charset="utf-8"><style>
body{margin:0;padding:16px;background:#111;color:#ddd;font:12px system-ui}
main{display:grid;grid-template-columns:repeat(${cols},max-content);gap:14px;align-items:start}
figure{margin:0}img{display:block;border:1px solid #333}figcaption{padding:4px 0}
.pair{display:flex;gap:6px;padding:6px;background:#1b1b1b;border-radius:6px}.missing{width:${width}px;color:#f88}
</style><main>${cells.join('')}</main>`;
const tmp = path.join(os.tmpdir(), `lil-contact-${process.pid}.html`);
fs.writeFileSync(tmp, html);
// Tall enough for everything: estimate from the tallest image per row.
const sizeOf = (f) => { const b = fs.readFileSync(f); return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }; };
const per = pair ? cols : cols;
let height = 40;
for (let i = 0; i < files.length; i += per) {
  const row = files.slice(i, i + per).map((f) => { const s = sizeOf(path.resolve(dir, f)); return s.h * width / s.w + 40; });
  height += Math.max(...row) + 14;
}
const totalWidth = 32 + cols * ((pair ? 2 * width + 18 : width) + 14);
execFileSync('chromium', ['--headless=new', '--hide-scrollbars', `--screenshot=${path.resolve(out)}`, `--window-size=${totalWidth},${Math.ceil(height)}`, '--allow-file-access-from-files', `file://${tmp}`], { stdio: 'ignore' });
fs.rmSync(tmp);
console.log(`${out}: ${files.length} shots, ${totalWidth}x${Math.ceil(height)}`);
