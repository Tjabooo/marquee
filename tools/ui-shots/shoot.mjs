#!/usr/bin/env node
// UI screenshots for design reviews: headless Chromium over the DevTools protocol, no dependencies.
//
//   node tools/ui-shots/shoot.mjs --base http://server:8080 --out shots/before \
//     [--scenes discover,library] [--sizes phone,tablet,desktop,tv] [--langs en,sv]
//     [--overlay public] [--preview] [--theme paper] [--reduced-motion] [--allow-writes]
//
// Every request that isn't GET/HEAD is refused unless --allow-writes is given, so pointing this at a
// live server changes nothing. --overlay serves static files from a local folder instead of the
// server's (the API stays the server's), which previews a UI branch against real data. --preview
// sets the marquee_preview cookie. Scenes live in scenes.mjs; each can mock API answers.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SCENES } from './scenes.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]);
  return acc;
}, []));
const BASE = String(args.base || 'http://localhost:8080').replace(/\/$/, '');
const OUT = path.resolve(String(args.out || 'shots'));
const SIZES = {
  phone: { width: 390, height: 844, mobile: true, scale: 1 },
  tablet: { width: 768, height: 1024, mobile: true, scale: 1 },
  desktop: { width: 1440, height: 900, mobile: false, scale: 1 },
  tv: { width: 1920, height: 1080, mobile: false, scale: 1 },
};
const sizes = String(args.sizes || 'phone,tablet,desktop,tv').split(',');
const langs = String(args.langs || 'en,sv').split(',');
const wanted = args.scenes ? new Set(String(args.scenes).split(',')) : null;
const scenes = SCENES.filter((s) => !wanted || wanted.has(s.name) || [...wanted].some((w) => w.endsWith('*') && s.name.startsWith(w.slice(0, -1))));
const overlay = args.overlay ? path.resolve(String(args.overlay)) : null;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2', '.jpg': 'image/jpeg', '.webp': 'image/webp' };

fs.mkdirSync(OUT, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mq-shots-'));
const chrome = spawn(String(args.chrome || 'chromium'), ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--mute-audio', '--autoplay-policy=no-user-gesture-required',
  '--disable-features=Translate,MediaRouter', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const wsUrl = await new Promise((ok, fail) => {
  let buf = '';
  chrome.stderr.on('data', (d) => { buf += d; const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) ok(m[1]); });
  chrome.on('exit', () => fail(new Error('Chromium exited: ' + buf.slice(-500))));
  setTimeout(() => fail(new Error('Chromium did not start')), 15000);
});

const ws = new WebSocket(wsUrl);
await new Promise((ok) => ws.addEventListener('open', ok, { once: true }));
let nextId = 1;
const pending = new Map();
const listeners = new Set();
ws.addEventListener('message', (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) {
    const { ok, fail } = pending.get(msg.id); pending.delete(msg.id);
    msg.error ? fail(new Error(msg.error.message)) : ok(msg.result);
  } else for (const l of listeners) l(msg);
});
const send = (method, params = {}, sessionId) => new Promise((ok, fail) => {
  const id = nextId++;
  pending.set(id, { ok, fail });
  ws.send(JSON.stringify({ id, method, params, sessionId }));
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// In-page helpers the scene steps use (window.$q, clickText, waitFor, …).
const HELPERS = `
window.__sleep = (ms) => new Promise((r) => setTimeout(r, ms));
window.__waitFor = async (sel, ms = 12000) => { const end = Date.now() + ms; while (Date.now() < end) { const el = document.querySelector(sel); if (el && (el.offsetParent || el.getClientRects().length)) return el; await __sleep(100); } throw new Error('timeout waiting for ' + sel); };
window.__click = async (sel, ms) => { const el = await __waitFor(sel, ms); el.scrollIntoView({ block: 'center' }); el.click(); return el; };
window.__clickText = async (re, sel = 'button, a, [role=button], summary', ms = 12000) => { const rx = new RegExp(re, 'i'); const end = Date.now() + ms;
  while (Date.now() < end) { const el = [...document.querySelectorAll(sel)].find((e) => rx.test(e.textContent.trim()) && (e.offsetParent || e.getClientRects().length)); if (el) { el.scrollIntoView({ block: 'center' }); el.click(); return el; } await __sleep(150); }
  throw new Error('no element matching ' + re); };
window.__settle = async (ms = 600) => { await document.fonts?.ready; const imgs = [...document.images].filter((i) => !i.complete && i.loading !== 'lazy'); await Promise.race([Promise.all(imgs.map((i) => new Promise((r) => { i.onload = i.onerror = r; }))), __sleep(4000)]); await __sleep(ms); };
`;

async function newPage(size, lang, scene) {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const s = (m, p) => send(m, p, sessionId);
  const errors = [];
  const quiet = new Set(); // URLs the harness refused or mocked: their failures aren't the app's
  const mocks = scene.mocks || {};
  const patches = { ...(scene.patch || {}) };
  { // the What's new sheet pops up on its own for accounts with unseen notes: only where a scene asks for it
    const prev = patches['^/api/status$'];
    patches['^/api/status$'] = (j) => { j = prev ? prev(j) ?? j : j; if (!scene.whatsNew && j.whatsNew) j.whatsNew.unseen = []; return j; };
  }
  if (args.theme && args.theme !== 'marquee') {
    const preset = String(args.theme);
    const prev = patches['^/api/status$'];
    patches['^/api/status$'] = (j) => { j = prev ? prev(j) ?? j : j; j.me.settings.theme = { preset }; return j; };
  }
  const onMsg = async (msg) => {
    if (msg.sessionId !== sessionId) return;
    if (msg.method === 'Runtime.exceptionThrown') errors.push('exception: ' + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text).split('\n')[0]);
    if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'assert'].includes(msg.params.type)) errors.push('console: ' + msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300));
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error' && !/blocked by the harness|Cross-Origin-Opener-Policy header has been ignored/.test(msg.params.entry.text)) errors.push('log: ' + msg.params.entry.text.slice(0, 300) + (msg.params.entry.url ? ' ' + msg.params.entry.url : ''));
    if (errors.length && msg.method === 'Log.entryAdded' && quiet.has(msg.params.entry.url)) errors.pop();
    if (msg.method === 'Fetch.requestPaused') {
      const { requestId, request, responseStatusCode } = msg.params;
      const u = new URL(request.url);
      try {
        if (responseStatusCode != null) { // response stage: patch a JSON answer from the server
          const fns = Object.entries(patches).filter(([re]) => new RegExp(re).test(u.pathname)).map(([, f]) => f);
          const { body, base64Encoded } = await s('Fetch.getResponseBody', { requestId });
          let json = JSON.parse(base64Encoded ? Buffer.from(body, 'base64').toString() : body);
          for (const f of fns) json = f(json, u) ?? json;
          return await s('Fetch.fulfillRequest', { requestId, responseCode: responseStatusCode, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(JSON.stringify(json)).toString('base64') });
        }
        if (u.origin === new URL(BASE).origin) {
          const mock = Object.entries(mocks).find(([re]) => new RegExp(re).test(u.pathname + u.search));
          if (mock) {
            const v = typeof mock[1] === 'function' ? mock[1](u, request) : mock[1];
            const status = v?.__status || 200;
            quiet.add(request.url);
            const body = typeof v === 'string' ? v : JSON.stringify(v?.__status ? { error: 'Mocked failure' } : v);
            return await s('Fetch.fulfillRequest', { requestId, responseCode: status, responseHeaders: [{ name: 'Content-Type', value: typeof v === 'string' ? 'text/plain' : 'application/json' }], body: Buffer.from(body).toString('base64') });
          }
          if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && !args['allow-writes']) {
            quiet.add(request.url);
            return await s('Fetch.fulfillRequest', { requestId, responseCode: 403, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(JSON.stringify({ error: 'Blocked by the screenshot harness.' })).toString('base64') });
          }
          if (overlay && !u.pathname.startsWith('/api/') && !u.pathname.startsWith('/play/') && !u.pathname.startsWith('/c/')) {
            const rel = u.pathname === '/' || !path.extname(u.pathname) ? '/index.html' : decodeURIComponent(u.pathname);
            const file = path.join(overlay, rel);
            if (file.startsWith(overlay) && fs.existsSync(file) && fs.statSync(file).isFile()) {
              return await s('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: MIME[path.extname(file)] || 'application/octet-stream' }, { name: 'Cache-Control', value: 'no-store' }], body: fs.readFileSync(file).toString('base64') });
            }
          }
        }
        await s('Fetch.continueRequest', { requestId });
      } catch { /* target closed */ }
    }
  };
  listeners.add(onMsg);
  await s('Runtime.enable'); await s('Log.enable'); await s('Page.enable');
  await s('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' },
    ...Object.keys(patches).map((re) => ({ urlPattern: `*${re.replace(/[\^$]/g, '').replace(/\\/g, '')}*`, requestStage: 'Response' }))] });
  await s('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: size.scale, mobile: size.mobile });
  if (size.mobile) await s('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await s('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: args['reduced-motion'] ? 'reduce' : 'no-preference' }] });
  if (size.mobile) await s('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Mobile Safari/537.36' });
  if (args.preview) await s('Network.setCookie', { name: 'marquee_preview', value: '1', url: BASE });
  // --as owner@x: an identity header (servers trust them from loopback), for owner screens on a local server
  if (args.as && scene.signedOut !== true) { await s('Network.enable'); await s('Network.setExtraHTTPHeaders', { headers: { 'Cf-Access-Authenticated-User-Email': String(args.as) } }); }
  await s('Page.addScriptToEvaluateOnNewDocument', { source: `try { localStorage.setItem('marquee:lang', ${JSON.stringify(lang)}); ${scene.storage ? `for (const [k, v] of Object.entries(${JSON.stringify(scene.storage)})) localStorage.setItem(k, v);` : ''} } catch {}\n${HELPERS}` });
  return { s, targetId, errors, close: async () => { listeners.delete(onMsg); await send('Target.closeTarget', { targetId }); } };
}

const evalIn = async (s, expr) => {
  const r = await s('Runtime.evaluate', { expression: `(async () => { ${expr}\n })()`, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description?.split('\n')[0] || r.exceptionDetails.text);
  return r.result.value;
};

const report = [];
for (const scene of scenes) {
  for (const sizeName of sizes) {
    if (scene.sizes && !scene.sizes.includes(sizeName)) continue;
    for (const lang of langs) {
      const size = SIZES[sizeName];
      const name = `${scene.name}--${sizeName}--${lang}${args.theme ? `--${args.theme}` : ''}${args['reduced-motion'] ? '--rm' : ''}`;
      const page = await newPage(size, lang, scene);
      let note = '';
      try {
        await page.s('Page.navigate', { url: BASE + (scene.path || '/') });
        await sleep(300);
        await evalIn(page.s, `await __waitFor(${JSON.stringify(scene.ready || 'main')}, 20000); await __settle(${scene.settle ?? 800});`);
        for (const step of scene.steps || []) await evalIn(page.s, step);
        await evalIn(page.s, `await __settle(${scene.after ?? 700});`);
        const shot = { format: 'png', captureBeyondViewport: Boolean(scene.full) };
        if (scene.full) {
          const { cssContentSize } = await page.s('Page.getLayoutMetrics');
          shot.clip = { x: 0, y: 0, width: size.width, height: Math.min(cssContentSize.height, 6000), scale: 1 };
        }
        const { data } = await page.s('Page.captureScreenshot', shot);
        fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
        // A half-size JPEG for quick looks (cheap to view).
        const small = await page.s('Page.captureScreenshot', { format: 'jpeg', quality: 70, captureBeyondViewport: Boolean(scene.full), clip: { ...(shot.clip || { x: 0, y: 0, width: size.width, height: size.height }), scale: 0.5 } });
        fs.mkdirSync(path.join(OUT, 'small'), { recursive: true });
        fs.writeFileSync(path.join(OUT, 'small', `${name}.jpg`), Buffer.from(small.data, 'base64'));
        if (scene.probe) note = await evalIn(page.s, scene.probe);
      } catch (err) { note = 'FAILED: ' + err.message; }
      report.push({ name, errors: page.errors, note });
      process.stdout.write(`${note?.startsWith?.('FAILED') ? '✗' : page.errors.length ? '!' : '✓'} ${name}${page.errors.length ? ` (${page.errors.length} console errors)` : ''}${note ? ` ${String(note).slice(0, 160)}` : ''}\n`);
      await page.close();
    }
  }
}
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
ws.close();
chrome.kill();
await new Promise((r) => chrome.once('exit', r));
fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
