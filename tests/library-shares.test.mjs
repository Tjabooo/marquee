import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as accounts from '../src/accounts.js';

const visit = (email) => accounts.userFor({ headers: email ? { 'cf-access-authenticated-user-email': email } : {} });

test('shared libraries: one merged library for the group, removals and keep-longer act on all', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lilin-shares-'));
  accounts.initAccounts({ dataDir: dir, adminEmails: ['owner@example.test'], mediaDir: null });
  accounts.updateServerSettings({ retentionDays: 7 });
  const owner = visit('owner@example.test');
  const home = visit(null); // the "Home network" account
  const dad = visit('dad@example.test');
  const mum = visit('mum@example.test');

  accounts.addEntry(dad.id, 'films/dune', 'added');
  accounts.addEntry(owner.id, 'films/dune', 'download');
  accounts.addEntry(home.id, 'tv/show/s01e01', 'added');
  assert.deepEqual([...accounts.libraryOf(mum.id).keys()], []);

  // joining someone pulls you into their group; joining a member of a group joins the whole group
  accounts.updateUser(dad.id, { libraryWith: home.id });
  accounts.updateUser(mum.id, { libraryWith: dad.id });
  assert.deepEqual(accounts.libraryMates(mum.id), [home.id, dad.id, mum.id].sort((a, b) => a - b));
  assert.deepEqual([...accounts.libraryOf(mum.id).keys()].sort(), ['films/dune', 'tv/show/s01e01']);
  assert.ok(accounts.hasEntry(home.id, 'films/dune'));
  assert.equal(accounts.publicUser(accounts.userById(home.id)).sharedWith.length, 2);
  assert.equal(accounts.libraryOf(owner.id).has('tv/show/s01e01'), false);

  // adding what the group already has does nothing
  assert.equal(accounts.addEntry(mum.id, 'films/dune', 'added'), false);
  assert.ok(accounts.libraryRows().some((r) => r.user_id === mum.id && r.media_key === 'tv/show/s01e01'));

  // the owner's copy is outside the group: removing keeps the file and leaves the owner's entry
  assert.ok(accounts.heldOutside('films/dune', mum.id));
  assert.equal(accounts.heldOutside('tv/show/s01e01', mum.id), false);
  assert.equal(accounts.removeEntry(mum.id, 'films/dune'), false);
  assert.equal(accounts.hasEntry(dad.id, 'films/dune'), false);
  assert.ok(accounts.hasEntry(owner.id, 'films/dune'));

  // keep longer moves the countdown for everyone in the group
  const before = accounts.libraryOf(home.id).get('tv/show/s01e01').expiresAt;
  const kept = accounts.extend(dad.id, 'tv/show/s01e01');
  assert.ok(kept.expiresAt > before);
  assert.equal(accounts.libraryOf(mum.id).get('tv/show/s01e01').expiresAt, kept.expiresAt);

  // the last removal frees the file
  assert.equal(accounts.removeEntry(dad.id, 'tv/show/s01e01'), true);

  // leaving: back to your own rows; a group of one dissolves
  accounts.addEntry(mum.id, 'films/arrival', 'added');
  accounts.updateUser(mum.id, { libraryWith: null });
  assert.deepEqual(accounts.libraryMates(mum.id), [mum.id]);
  assert.ok(accounts.hasEntry(mum.id, 'films/arrival'));
  assert.equal(accounts.hasEntry(dad.id, 'films/arrival'), false);
  accounts.updateUser(dad.id, { libraryWith: null });
  assert.deepEqual(accounts.libraryMates(home.id), [home.id]);
  assert.throws(() => accounts.updateUser(dad.id, { libraryWith: dad.id }), /someone else/);
});
