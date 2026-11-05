// Reads text out of Notes images in the background and stores it as hidden search keywords.
// Windows uses its built-in OCR engine through notes-ocr.ps1, so there's nothing to install.
// Elsewhere Tesseract is used when it's installed (TESSERACT sets its path); otherwise OCR is off.
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { trackChild } from './load.js';
import { background } from './priority.js';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'notes-ocr.ps1');
const BATCH = 20, RETRY = 10 * 60000, MAX_TEXT = 20000;

// Runs the PowerShell OCR script on a list of files and resolves to [{ text } | { error }] in the same order.
export function windowsOcr(files) {
  return new Promise((resolve, reject) => {
    const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = spawn(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT], { windowsHide: true });
    trackChild(child, exe, [`${files.length} image${files.length === 1 ? '' : 's'}`], 'ocr');
    background(child);
    let out = '', err = '';
    const timer = setTimeout(() => child.kill(), 60000 + files.length * 30000);
    child.stdout.setEncoding('utf8').on('data', (c) => { out += c; });
    child.stderr.setEncoding('utf8').on('data', (c) => { err += c; });
    child.once('error', (e) => { clearTimeout(timer); reject(e); });
    child.once('close', (code) => {
      clearTimeout(timer);
      const results = [];
      for (const line of out.split(/\r?\n/)) {
        try { const r = JSON.parse(line); if (Number.isInteger(r.i)) results[r.i] = r; } catch { /* not a result line */ }
      }
      // A crashed run is retried later; only files that got an answer are marked as read.
      if (code !== 0 && !results.length) return reject(Error(err.trim() || `OCR exited with code ${code}`));
      resolve(files.map((_, i) => results[i] || null));
    });
    child.stdin.end(JSON.stringify(files));
  });
}

const TESSERACT = process.env.TESSERACT || 'tesseract';

// One file at a time; Tesseract is single-image per run and quick on screenshots.
export async function tesseractOcr(files) {
  const results = [];
  for (const file of files) {
    results.push(await new Promise((resolve) => {
      const child = spawn(TESSERACT, [file, 'stdout'], { windowsHide: true });
      trackChild(child, TESSERACT, [path.basename(file)], 'ocr');
      background(child);
      let out = '', err = '';
      const timer = setTimeout(() => child.kill(), 60000);
      child.stdout.setEncoding('utf8').on('data', (c) => { out += c; });
      child.stderr.setEncoding('utf8').on('data', (c) => { err += c; });
      child.once('error', (e) => { clearTimeout(timer); resolve({ error: e.message }); });
      child.once('close', (code) => {
        clearTimeout(timer);
        resolve(code === 0 ? { text: out.replace(/\s+/g, ' ').trim() } : { error: err.trim().split(/\r?\n/).pop() || `exit ${code}` });
      });
    }));
  }
  return results;
}

export const tesseractAvailable = () => spawnSync(TESSERACT, ['--version'], { windowsHide: true, timeout: 5000 }).status === 0;

// Windows OCR on Windows, Tesseract elsewhere, nothing when neither is available or NOTES_OCR=off.
export function defaultOcr() {
  if (process.env.NOTES_OCR === 'off') return null;
  if (process.platform === 'win32') return windowsOcr;
  return tesseractAvailable() ? tesseractOcr : null;
}

export class NotesOcr {
  constructor(store, { run = defaultOcr(), enabled = Boolean(run), log = console } = {}) {
    Object.assign(this, { store, run, enabled, log, busy: null, again: false, retryTimer: null });
  }
  // Call whenever an image may need reading. Repeated calls while busy fold into one more pass.
  kick() {
    if (!this.enabled) return Promise.resolve();
    if (this.busy) { this.again = true; return this.busy; }
    this.busy = this.drain().catch((e) => this.log.warn?.(`Notes OCR stopped: ${e.message}`)).finally(() => { this.busy = null; });
    return this.busy;
  }
  async drain() {
    do {
      this.again = false;
      for (let files; (files = this.store.pendingOcr(BATCH)).length;) {
        let results;
        try { results = await this.run(files.map((f) => f.full)); }
        catch (e) {
          this.log.warn?.(`Notes OCR failed, retrying in 10 minutes: ${e.message}`);
          clearTimeout(this.retryTimer);
          this.retryTimer = setTimeout(() => this.kick(), RETRY); this.retryTimer.unref?.();
          return;
        }
        let answered = 0;
        files.forEach((f, i) => {
          const r = results[i]; if (!r) return;
          answered++;
          // Unreadable images get empty text so they aren't retried forever.
          this.store.setFileText(f.id, typeof r.text === 'string' ? r.text.slice(0, MAX_TEXT) : '');
        });
        // Never get stuck on one file that keeps killing the reader.
        if (!answered) this.store.setFileText(files[0].id, '');
      }
    } while (this.again);
  }
}
