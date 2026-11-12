import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as accounts from '../src/accounts.js';
import * as activity from '../src/activity.js';
import * as social from '../src/social.js';
import { WatchRooms } from '../src/watch.js';
import { firstLetter, tintOf, TINTS } from '../public/people.js';

const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(32)]);
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);

test('profile pictures: stored per person, versioned URL, validated, removable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lilin-avatars-'));
  accounts.initAccounts({ dataDir: dir, adminEmails: [], mediaDir: null });
  const anna = accounts.userFor({ headers: { 'cf-access-authenticated-user-email': 'anna@example.test' } });
  assert.equal(anna.avatar, null);
  assert.equal(accounts.imageKind(webp), 'webp');
  assert.equal(accounts.imageKind(png), 'png');
  assert.equal(accounts.imageKind(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), null);

  const withPic = accounts.setAvatar(anna.id, webp);
  assert.match(withPic.avatar, new RegExp(`^/api/avatar/${anna.id}\\?v=[a-z0-9]+$`));
  assert.equal(accounts.publicUser(withPic).avatar, withPic.avatar);
  assert.equal(accounts.avatarFile(anna.id).type, 'image/webp');
  assert.equal(accounts.avatarForEmail('anna@example.test'), withPic.avatar);

  const newer = accounts.setAvatar(anna.id, png);
  assert.notEqual(newer.avatar, withPic.avatar, 'a new picture gets a new URL, so caches never show the old one');
  assert.equal(accounts.avatarFile(anna.id).type, 'image/png', 'the old file is replaced, not kept beside it');
  assert.equal(fs.readdirSync(path.join(dir, '.lilin-avatars')).length, 1);

  // Settings saves keep the picture.
  assert.equal(accounts.updateMe(newer, { name: 'Anna B' }).avatar, newer.avatar);

  assert.throws(() => accounts.setAvatar(anna.id, Buffer.from('GIF89a......')), (e) => e.status === 415);
  assert.throws(() => accounts.setAvatar(anna.id, Buffer.concat([webp, Buffer.alloc(700 * 1024)])), (e) => e.status === 413);
  assert.throws(() => accounts.setAvatar(9999, webp), (e) => e.status === 404);

  const gone = accounts.setAvatar(anna.id, null);
  assert.equal(gone.avatar, null);
  assert.equal(accounts.avatarFile(anna.id), null);
});

test('faces travel with names: ratings, Activity, rooms, chat and reactions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lilin-faces-'));
  accounts.initAccounts({ dataDir: dir, adminEmails: [], mediaDir: null });
  activity.initActivity({ dataDir: dir, nameForUser: accounts.displayNameFor, avatarForUser: accounts.avatarForEmail });
  const req = (email) => ({ headers: { 'cf-access-authenticated-user-email': email } });
  const anna = accounts.setAvatar(accounts.userFor(req('anna@example.test')).id, webp);
  const ben = accounts.userFor(req('ben@example.test'));
  const nameOf = (id) => accounts.userById(id)?.name;
  const avatarOf = (id) => accounts.userById(id)?.avatar || null;

  social.rate(anna.id, 'movie:603', 1);
  const forBen = social.ratingFor(ben.id, 'movie:603', nameOf, avatarOf);
  assert.deepEqual(forBen.people, [{ name: anna.name, avatar: anna.avatar }]);
  assert.deepEqual(social.ratingFor(ben.id, 'movie:603', nameOf).people, [{ name: anna.name, avatar: null }], 'avatarOf is optional');

  activity.record(req('anna@example.test'), 'play', 'Movie');
  assert.equal(activity.report().events[0].avatar, anna.avatar);

  const rooms = new WatchRooms({ avatarOf });
  const created = rooms.create(anna, { kind: 'lib', id: 'movie', mediaKey: 'movie' }, 'anna-client-12345678', 0);
  rooms.join(created.token, ben, 'ben-client-123456789');
  const state = rooms.snapshot(rooms.room(created.token));
  assert.deepEqual(state.members.map((m) => m.avatar), [anna.avatar, null]);
  assert.equal(rooms.preview(created.token).hostAvatar, anna.avatar);
  assert.deepEqual(rooms.preview(created.token).faces.map((f) => f.name), [anna.name, ben.name]);
  assert.equal(rooms.chat(created.token, anna, 'anna-client-12345678', 'hi').avatar, anna.avatar);

  // A new picture reaches people already in the room.
  const benPic = accounts.setAvatar(ben.id, png);
  rooms.renameUser(benPic);
  assert.equal(rooms.snapshot(rooms.room(created.token)).members[1].avatar, benPic.avatar);
});

test('initials and colours are stable per name', () => {
  assert.equal(firstLetter('anna'), 'A');
  assert.equal(firstLetter('  '), '?');
  assert.equal(firstLetter('🎬 Club'), '🎬', 'emoji stay whole');
  assert.equal(tintOf('Anna'), tintOf('anna'));
  assert.ok(TINTS.includes(tintOf('Ben')));
});
