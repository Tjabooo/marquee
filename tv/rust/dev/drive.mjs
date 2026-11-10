// Drives the TV app in headless Chromium (WebGL through SwiftShader) and saves screenshots.
//   node tv/rust/dev/drive.mjs http://localhost:8099/ out-dir "wait:4000 shot:home down right shot:card enter wait:1500 shot:title"
// Steps: wait:MS, shot:NAME, a key (left right up down enter back), type:TEXT, eval:JS.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [url, out, script] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tvdrive-'));
const chrome = spawn(process.env.CHROME || 'chromium', ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--window-size=1920,1080', '--hide-scrollbars',
  '--force-device-scale-factor=1', '--disable-web-security', // the TV app may read any host (Tizen <access origin="*">)
   'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const ws = await new Promise((ok, fail) => {
  let buf = '';
  chrome.stderr.on('data', (d) => { buf += d; const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) ok(m[1]); });
  chrome.on('exit', () => fail(new Error(buf.slice(-400))));
});
const port = new URL(ws).port;
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find((t) => t.type === 'page');
const sock = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => sock.addEventListener('open', r));
let id = 0; const wait = new Map();
sock.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && wait.has(m.id)) { wait.get(m.id)(m); wait.delete(m.id); }
  if (m.method === 'Runtime.consoleAPICalled') console.log('[console]', m.params.args.map((a) => a.value ?? a.description).join(' '));
  if (m.method === 'Runtime.exceptionThrown') console.log('[exception]', m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
});
const send = (method, params = {}) => new Promise((r) => { const i = ++id; wait.set(i, r); sock.send(JSON.stringify({ id: i, method, params })); });
await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url });
const KEYS = { left: 37, up: 38, right: 39, down: 40, enter: 13, back: 27, bksp: 8 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function key(code, text) {
  const base = { windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, key: text || '', code: '' };
  await send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...base, text: text || undefined });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  await sleep(350);
}
for (const step of (script || 'wait:5000 shot:start').split(/\s+/).filter(Boolean)) {
  const [cmd, arg] = [step.split(':')[0], step.slice(step.indexOf(':') + 1)];
  if (cmd === 'wait') await sleep(Number(arg));
  else if (cmd === 'shot') {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(out, arg + '.png'), Buffer.from(r.result.data, 'base64'));
    console.log('shot', arg);
  } else if (cmd === 'type') { for (const ch of arg) await key(ch.toUpperCase().charCodeAt(0), ch); }
  else if (cmd === 'eval') { const r = await send('Runtime.evaluate', { expression: arg, returnByValue: true }); console.log('eval', JSON.stringify(r.result.result.value)); }
  else if (KEYS[cmd] != null) { const n = Number(arg) > 0 && step.includes(':') ? Number(arg) : 1; for (let i = 0; i < n; i++) await key(KEYS[cmd]); }
  else console.log('unknown step', step);
}
sock.close(); chrome.kill();
await new Promise((r) => chrome.once("exit", r)); try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* still closing */ }
