// Reads text out of Notes images in the background and stores it as hidden search keywords.
// Uses Windows' built-in OCR engine through notes-ocr.ps1, so there's nothing to install.
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'notes-ocr.ps1');
const BATCH = 20, RETRY = 10 * 60000, MAX_TEXT = 20000;

// Runs the PowerShell OCR script on a list of files and resolves to [{ text } | { error }] in the same order.
export function windowsOcr(files) {
  return new Promise((resolve, reject) => {
    const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = spawn(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT], { windowsHide: true });
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

export class NotesOcr {
  constructor(store, { run = windowsOcr, enabled = process.platform === 'win32' && process.env.NOTES_OCR !== 'off', log = console } = {}) {
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
