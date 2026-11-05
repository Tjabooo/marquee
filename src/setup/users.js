// `node setup.js user ...`: Marquee's own sign-ins (see src/auth.js). Run on the server, so only
// someone with access to the machine can create accounts; nothing here is reachable over the network.
//
//   user add EMAIL [--owner]   create a sign-in, or set a new password (signs out that person)
//   user passwd EMAIL          same as add, for an existing sign-in
//   user remove EMAIL          delete the sign-in and its sessions (their library stays)
//   user signout EMAIL         end every session of that person
//   user list                  who can sign in
//
// The password is read from the terminal without echo, or from MARQUEE_PASSWORD (for scripts).
import { openAuthStore, passwordProblem, validEmail } from '../auth.js';

export const USER_ACTIONS = ['add', 'passwd', 'remove', 'signout', 'list'];

// Reads a line from the terminal without showing it.
export function readHidden(question, { input = process.stdin, output = process.stdout } = {}) {
  if (!input.isTTY) throw new Error('No terminal to type a password in. Set MARQUEE_PASSWORD for scripts.');
  return new Promise((resolve, reject) => {
    output.write(question);
    let value = '';
    input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');
    const done = (err) => {
      input.setRawMode(false);
      input.pause();
      input.removeListener('data', onData);
      output.write('\n');
      if (err) reject(err); else resolve(value);
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done();
        if (ch === '\u0003') return done(new Error('Cancelled'));
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ') value += ch;
      }
    };
    input.on('data', onData);
  });
}

export async function askNewPassword(email, { env = process.env, read = readHidden } = {}) {
  if (env.MARQUEE_PASSWORD) {
    const problem = passwordProblem(env.MARQUEE_PASSWORD, email);
    if (problem) throw new Error(`MARQUEE_PASSWORD: ${problem}`);
    return env.MARQUEE_PASSWORD;
  }
  for (let tries = 0; ; tries++) {
    if (tries === 3) throw new Error('No password set.');
    const first = await read(`New password for ${email} (10+ characters): `);
    const problem = passwordProblem(first, email);
    if (problem) { console.log(`  ${problem}`); continue; }
    if ((await read('Same password again: ')) !== first) { console.log('  The two didn’t match. Try again.'); continue; }
    return first;
  }
}

// Returns an exit code. `addOwner(email)` puts the email in ADMIN_EMAILS (cli.js owns .env).
export async function userCommand({ action, email, owner = false, dataDir, addOwner, log = console.log, read }) {
  const store = openAuthStore(dataDir);
  try {
    if (action === 'list') {
      const rows = store.list();
      if (!rows.length) log('No Marquee sign-ins yet. Create one with: node setup.js user add you@example.com --owner');
      for (const r of rows) {
        const seen = r.lastSeen ? `last seen ${new Date(r.lastSeen).toISOString().slice(0, 16).replace('T', ' ')}` : 'never signed in';
        log(`  ${r.email}  (${r.sessions} active session${r.sessions === 1 ? '' : 's'}, ${seen})`);
      }
      return 0;
    }
    const e = String(email || '').trim().toLowerCase();
    if (!validEmail(e)) throw new Error(`Say whose sign-in: node setup.js user ${action} someone@example.com`);
    if (action === 'add' || action === 'passwd') {
      const exists = Boolean(store.login(e));
      if (action === 'passwd' && !exists) throw new Error(`${e} has no Marquee sign-in. Create it with: node setup.js user add ${e}`);
      await store.setPassword(e, await askNewPassword(e, read ? { read } : {}));
      log(exists ? `✓ New password set for ${e}; their other sessions were signed out.` : `✓ ${e} can now sign in to Marquee.`);
      if (owner) addOwner?.(e);
      return 0;
    }
    if (action === 'remove') {
      if (!store.remove(e)) { log(`${e} had no Marquee sign-in.`); return 1; }
      log(`✓ Removed ${e}'s sign-in and ended their sessions. Their library and settings are kept.`);
      return 0;
    }
    if (action === 'signout') {
      log(`✓ Ended ${store.revokeSessions(e)} session(s) of ${e}.`);
      return 0;
    }
    throw new Error(`Use: node setup.js user ${USER_ACTIONS.join('|')}`);
  } finally {
    store.close();
  }
}
