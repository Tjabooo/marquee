import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Readable } from 'node:stream';
import { NotesStore } from '../src/notes.js';
import { NotesUploads, UPLOAD_LIMIT, UPLOAD_CHUNK, mediaType } from '../src/notes-media.js';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1cAAAAASUVORK5CYII=','base64');
const request = (chunks) => Object.assign(Readable.from(chunks),{headers:{}});

test('chunked media uploads use the configured drive and attach without text', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'notes-upload-'));
  const fileDir = await fs.mkdtemp(path.join(os.tmpdir(),'notes-external-'));
  const store = new NotesStore(root,{fileDir}), uploads = new NotesUploads(store);
  try {
    const session = uploads.start({name:'Phone photo.png',size:png.length,type:'image/png'},'owner');
    await assert.rejects(uploads.append(session.id,'other',0,request([png])),{status:404});
    await uploads.append(session.id,'owner',0,request([png.subarray(0,20)]));
    assert.equal(uploads.status(session.id,'owner').offset,20);
    assert.throws(()=>uploads.finish(session.id,'owner'),{status:409});
    await assert.rejects(uploads.append(session.id,'owner',0,request([png])),{status:409});
    await uploads.append(session.id,'owner',20,request([png.subarray(20)]));
    const {attachment} = uploads.finish(session.id,'owner');
    assert.equal(attachment.mime,'image/png'); assert.deepEqual(uploads.finish(session.id,'owner').attachment,attachment);
    const file = store.file(attachment.fileId); assert.equal(path.dirname(file.full),fileDir);
    assert.deepEqual(await fs.readFile(file.full),png);
    const note = store.create({attachments:[attachment]},'owner');
    assert.equal(note.text,''); assert.equal(note.attachments[0].fileId,attachment.fileId);
    assert.equal(note.attachments[0].mime,'image/png');
    assert.throws(()=>uploads.start({name:'huge.mov',size:UPLOAD_LIMIT+1},'owner'),{status:413});
    assert.equal(await fs.stat(path.join(root,'.lilin-notes-files')).catch(()=>null),null);
  } finally { store.close(); await fs.rm(root,{recursive:true,force:true}); await fs.rm(fileDir,{recursive:true,force:true}); }
});

test('failed chunks roll back and media types are sniffed rather than trusted', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'notes-upload-failure-'));
  const store = new NotesStore(root), uploads = new NotesUploads(store);
  try {
    const bytes=Buffer.from('<html><script>alert(1)</script></html>');
    const s=uploads.start({name:'fake.png',size:bytes.length,type:'image/png'},'owner');
    async function* broken() { yield bytes.subarray(0,8); throw Error('disconnected'); }
    await assert.rejects(uploads.append(s.id,'owner',0,request(broken())),/disconnected/);
    assert.equal(uploads.status(s.id,'owner').offset,0);
    await assert.rejects(uploads.append(s.id,'owner',0,request([Buffer.alloc(UPLOAD_CHUNK+1)])),{status:413});
    assert.equal(uploads.status(s.id,'owner').offset,0);
    await uploads.append(s.id,'owner',0,request([bytes]));
    const {attachment}=uploads.finish(s.id,'owner');
    assert.equal(attachment.mime,'application/octet-stream'); assert.equal(mediaType(store.file(attachment.fileId).full),null);
    const cancel=uploads.start({name:'cancel.png',size:10},'owner');
    uploads.cancel(cancel.id,'owner'); assert.throws(()=>uploads.status(cancel.id,'owner'),{status:404});
  } finally { store.close(); await fs.rm(root,{recursive:true,force:true}); }
});
