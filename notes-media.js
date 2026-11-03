import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
export const UPLOAD_CHUNK = 8 * 1024 * 1024;
export const UPLOAD_LIMIT = 1024 * 1024 * 1024;
const DAY = 86400000;

// Only recognized media formats can render inline. Everything else stays a download.
export function mediaType(file, hint = '') {
  const head = Buffer.alloc(64), fd = fs.openSync(file, 'r');
  let size; try { size = fs.readSync(fd, head); } finally { fs.closeSync(fd); }
  const b = head.subarray(0, size), ascii = (start, end) => b.toString('ascii', start, end);
  if (b[0] === 255 && b[1] === 216 && b[2] === 255) return 'image/jpeg';
  if (b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (/^GIF8[79]a/.test(ascii(0,6))) return 'image/gif';
  if (ascii(0,4) === 'RIFF' && ascii(8,12) === 'WEBP') return 'image/webp';
  if (ascii(4,8) === 'ftyp') {
    if (/avif|avis/.test(ascii(8,40))) return 'image/avif';
    if (/heic|heix|hevc|heif|mif1|msf1/.test(ascii(8,40))) return 'image/heic';
    if (/M4A |M4B /.test(ascii(8,16))) return 'audio/mp4';
    return ascii(8,12) === 'qt  ' ? 'video/quicktime' : 'video/mp4';
  }
  if (ascii(0,4) === 'RIFF' && ascii(8,12) === 'WAVE') return 'audio/wav';
  if (ascii(0,4) === 'OggS') return 'audio/ogg';
  if (ascii(0,3) === 'ID3' || b[0] === 255 && (b[1] & 0xe0) === 0xe0) return 'audio/mpeg';
  if (b.subarray(0,4).equals(Buffer.from([26,69,223,163]))) return hint === 'audio/webm' ? hint : 'video/webm';
  return null;
}

export class NotesUploads {
  constructor(store) { this.store = store; this.dir = path.join(store.fileDir, '.uploads'); this.sessions = new Map(); }
  prune() {
    const cutoff = Date.now() - DAY;
    for (const [id, s] of this.sessions) if (!s.busy && s.updated < cutoff) { fs.rmSync(s.temp, { force:true }); this.sessions.delete(id); }
    // Interrupted uploads from an earlier server process are removed after a day.
    if (fs.existsSync(this.dir)) for (const name of fs.readdirSync(this.dir)) if (/^[a-f0-9]{32}\.part$/.test(name)) {
      const file = path.join(this.dir,name);
      if (fs.statSync(file).mtimeMs < cutoff && !this.sessions.has(name.slice(0,-5))) fs.rmSync(file,{force:true});
    }
  }
  get(id, actor) {
    const s = this.sessions.get(id);
    if (!s || s.actor !== actor) fail(404, 'That upload is no longer available. Choose the file again.');
    return s;
  }
  status(id, actor) { const s = this.get(id,actor); return { id, offset:s.received, size:s.size, chunkSize:UPLOAD_CHUNK, attachment:s.attachment || null }; }
  start(body, actor) {
    this.prune();
    if (!body || typeof body.name !== 'string' || !body.name.trim() || body.name.length > 255 || /[\u0000-\u001f\u007f]/.test(body.name)) fail(400, 'Choose a file with a valid name.');
    if (!Number.isSafeInteger(body.size) || body.size < 1 || body.size > UPLOAD_LIMIT) fail(413, 'Choose a file between 1 byte and 1 GB.');
    if ([...this.sessions.values()].filter((s) => s.actor === actor && !s.attachment).length >= 8) fail(429, 'Finish your current uploads first.');
    const id = crypto.randomBytes(16).toString('hex'); fs.mkdirSync(this.dir,{recursive:true});
    const temp = path.join(this.dir,`${id}.part`); fs.closeSync(fs.openSync(temp,'wx'));
    this.sessions.set(id,{ actor, temp, name:body.name.trim(), size:body.size, hint:String(body.type || ''), received:0, updated:Date.now(), busy:false });
    return this.status(id,actor);
  }
  async append(id, actor, offset, req) {
    const s = this.get(id,actor);
    if (s.busy || s.attachment || !Number.isSafeInteger(offset) || offset !== s.received) fail(409, 'Upload position changed. Retry this file.');
    if (Number(req.headers['content-length']) > UPLOAD_CHUNK) fail(413, 'Upload chunk is too large.');
    s.busy = true; let file, written = 0;
    try {
      file = await fs.promises.open(s.temp,'r+');
      await file.truncate(s.received);
      for await (const chunk of req) {
        if (written + chunk.length > UPLOAD_CHUNK || s.received + written + chunk.length > s.size) fail(413, 'Upload chunk is too large.');
        let at = 0;
        while (at < chunk.length) {
          const {bytesWritten} = await file.write(chunk,at,chunk.length-at,s.received+written+at);
          if (!bytesWritten) throw Error('The media drive stopped accepting data.');
          at += bytesWritten;
        }
        written += chunk.length;
      }
      if (!written) fail(400, 'The upload chunk is empty.');
      s.received += written;
    } finally {
      try { if (file) await file.truncate(s.received); }
      finally { try { if (file) await file.close(); } finally { s.busy = false; s.updated = Date.now(); } }
    }
    return this.status(id,actor);
  }
  finish(id, actor) {
    const s = this.get(id,actor);
    if (s.attachment) return { attachment:s.attachment };
    if (s.busy || s.received !== s.size) fail(409,'Wait for the file to finish uploading.');
    const fileId = crypto.randomBytes(32).toString('hex'), target = path.join(this.store.fileDir,`${fileId}.bin`);
    const mime = mediaType(s.temp,s.hint) || 'application/octet-stream';
    fs.renameSync(s.temp,target);
    try { this.store.registerFile(fileId,{name:s.name,mime,size:s.size}); }
    catch (e) { fs.renameSync(target,s.temp); throw e; }
    s.attachment = {fileId,name:s.name,mime,size:s.size}; s.updated = Date.now();
    return {attachment:s.attachment};
  }
  cancel(id, actor) {
    const s = this.get(id,actor); if (s.busy) fail(409,'Wait for this upload chunk to finish.');
    fs.rmSync(s.temp,{force:true}); this.sessions.delete(id); return {ok:true};
  }
}
