// House: the health of the home server itself, plus the machines that report in (laptop, desktop).
// Shown in the House tab, which only the server's owner sees (ADMIN_EMAILS, like Activity).
//
// Machines report with `agents/marquee-house` (a systemd timer on each Arch machine): a POST to
// /api/house/report carrying HOUSE_TOKEN. Reports are only accepted straight from the home network,
// never through Cloudflare, so the endpoint can't be written to from the internet even if the
// token leaked. The same token lets those machines read a short summary (/api/house/summary) for
// their status bar.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import dgram from 'node:dgram';

const TOKEN = process.env.HOUSE_TOKEN || '';
const ADGUARD_URL = (process.env.ADGUARD_URL || '').replace(/\/+$/, '');
const ADGUARD_USER = process.env.ADGUARD_USER || '';
const ADGUARD_PASS = process.env.ADGUARD_PASS || '';
const FLARESOLVERR_URL = (process.env.FLARESOLVERR_URL || '').replace(/\/+$/, '');
const DISK_WARN = 0.9;                       // a disk this full is an issue
const QUIET_MS = 20 * 60 * 1000;             // a machine that hasn't reported for this long is "away"
const FORGET_MS = 30 * 24 * 3600 * 1000;     // and after this long it's dropped from the list
const BACKUP_WARN_MS = 7 * 24 * 3600 * 1000;

let file = null;
let machines = {};
let dirs = [];          // [{ label, dir }]
let qbitAlive = null;   // async () => boolean, or null when qBittorrent isn't configured

export function initHouse({ dataDir, mediaDir, clipsDir, qbitCheck }) {
  file = path.join(dataDir, '.marquee-house.json');
  try { machines = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { machines = {}; }
  powerFile = path.join(dataDir, '.marquee-power.json');
  try { power = JSON.parse(fs.readFileSync(powerFile, 'utf8')); } catch { power = {}; }
  dirs = [mediaDir && { label: 'Media', dir: mediaDir }, clipsDir && { label: 'Clips', dir: clipsDir }].filter(Boolean);
  qbitAlive = qbitCheck;
}

export const houseConfigured = () => Boolean(TOKEN);

// ---------- who may report ----------
const clean = (ip) => String(ip || '').replace(/^::ffff:/i, '').replace(/%.*$/, '').trim();
function privateIp(ip) {
  ip = clean(ip);
  if (net.isIPv4(ip)) return /^(10\.|192\.168\.|127\.)/.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
  if (net.isIPv6(ip)) return ip === '::1' || /^f[cd]/i.test(ip) || /^fe[89ab]/i.test(ip);
  return false;
}
// Straight from the LAN: Cloudflare Tunnel traffic also arrives from a local address (cloudflared),
// but it always carries CF-Ray / CF-Connecting-IP, so those requests are refused.
const directFromLan = (req) => !req.headers['cf-ray'] && !req.headers['cf-connecting-ip'] && privateIp(req.socket.remoteAddress);
export function agentAllowed(req) {
  if (!TOKEN || !directFromLan(req)) return false;
  const given = Buffer.from(String(req.headers['x-marquee-token'] || ''));
  const want = Buffer.from(TOKEN);
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}

// ---------- reports from machines ----------
const str = (v, n = 120) => (typeof v === 'string' ? v.slice(0, n) : null);
const num = (v, max = Number.MAX_SAFE_INTEGER) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Math.max(0, Math.min(max, Number(v))) : null);

export function acceptReport(req, body) {
  const host = str(body.host, 40);
  if (!host || !/^[\w.-]+$/.test(host)) throw Object.assign(new Error('Report needs a host name.'), { status: 400 });
  const disks = (Array.isArray(body.disks) ? body.disks : []).slice(0, 8).map((d) => ({
    mount: str(d?.mount, 60), size: num(d?.size), used: num(d?.used),
  })).filter((d) => d.mount && d.size);
  machines[host] = {
    host,
    kind: ['laptop', 'desktop', 'server'].includes(body.kind) ? body.kind : 'desktop',
    os: str(body.os, 60),
    kernel: str(body.kernel, 60),
    uptime: num(body.uptime),
    load: num(body.load, 1000),
    cpus: num(body.cpus, 1024),
    mem: { total: num(body.mem?.total), avail: num(body.mem?.avail) },
    disks,
    failed: (Array.isArray(body.failed) ? body.failed : []).slice(0, 20).map((u) => str(u, 80)).filter(Boolean),
    updates: num(body.updates, 100000),
    lastBackup: num(body.last_backup),
    battery: body.battery && num(body.battery.pct, 100) !== null
      ? { pct: num(body.battery.pct, 100), status: str(body.battery.status, 20) } : null,
    secureBoot: typeof body.secure_boot === 'boolean' ? body.secure_boot : null,
    ip: clean(req.socket.remoteAddress),
    at: Date.now(),
  };
  for (const [h, m] of Object.entries(machines)) if (Date.now() - m.at > FORGET_MS) delete machines[h];
  try { fs.writeFileSync(file, JSON.stringify(machines)); } catch { /* kept in memory */ }
}

// ---------- power: wake a machine and choose what it boots ----------
// A machine that's off can't be told which OS to start, so the choice is made on the way up: GRUB
// always starts Linux first, and `marquee-house boot` (a root systemd timer on that machine: right
// after boot, then every 30 s) asks the server what to do. If another system was picked it sets
// GRUB's one-shot next entry (grub-reboot) and restarts into it. The same poll carries "restart
// into…" while the machine is on, and tells the server the MAC address and boot menu for next time.
const POWER_ON_MS = 90 * 1000;      // the boot poll runs every 30 s: silent this long = off (or in Windows)
const WAKE_MS = 5 * 60 * 1000;      // a boot choice made when waking is honoured this long
const RESTART_MS = 2 * 60 * 1000;   // a restart that isn't picked up in this time is dropped
const POWER_FORGET_MS = 90 * 24 * 3600 * 1000;
const WOL_EXTRA = (process.env.WOL_BROADCAST || '').split(',').map((s) => s.trim()).filter((s) => net.isIPv4(s));
const MAC_RE = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/;

let powerFile = null;
let power = {};               // host -> what its last boot poll said, plus `last` (what Marquee last made it do)
const pending = new Map();    // host -> { action: 'wake' | 'restart', entry: GRUB title or null, at }

const savePower = () => { try { fs.writeFileSync(powerFile, JSON.stringify(power)); } catch { /* kept in memory */ } };
// "Windows Boot Manager (on /dev/nvme0n1p1)" -> "Windows"
const osLabel = (title) => String(title || '').replace(/\s*\(on \/dev\/[^)]*\)\s*$/, '').replace(/^Windows Boot Manager$/, 'Windows');
const httpErr = (status, message) => Object.assign(new Error(message), { status });

export function bootPoll(req, body) {
  const host = str(body.host, 40);
  if (!host || !/^[\w.-]+$/.test(host)) throw httpErr(400, 'Boot poll needs a host name.');
  const entries = (Array.isArray(body.entries) ? body.entries : []).slice(0, 16).map((e) => ({
    title: str(e?.title, 160),
    os: ['linux', 'windows', 'other'].includes(e?.os) ? e.os : 'other',
    current: e?.current === true,
  })).filter((e) => e.title);
  const mac = String(body.mac || '').toLowerCase();
  const prev = power[host] || {};
  const m = power[host] = {
    host,
    mac: MAC_RE.test(mac) ? mac : prev.mac || null,
    iface: str(body.iface, 20),
    wired: body.wired === true,
    wol: str(body.wol, 12),           // ethtool's Wake-on flags: "g" = magic packet; null = unknown
    entries: entries.length ? entries : prev.entries || [],
    default: str(body.default, 160),  // the entry GRUB starts when nobody picks one
    ip: clean(req.socket.remoteAddress),
    uptime: num(body.uptime),
    at: Date.now(),
    last: prev.last || null,
  };
  for (const [h, x] of Object.entries(power)) if (Date.now() - x.at > POWER_FORGET_MS) delete power[h];

  let todo = null;
  const p = pending.get(host);
  if (p) {
    const current = m.entries.find((e) => e.current);
    const other = p.entry && p.entry !== current?.title ? p.entry : null;
    if (p.action === 'restart') {
      pending.delete(host);
      if (Date.now() - p.at < RESTART_MS) todo = { reboot: true, entry: other };
    } else if (Date.now() - p.at > WAKE_MS) {
      pending.delete(host);
    } else if (Date.now() - (m.uptime ?? 0) * 1000 >= p.at - 60 * 1000) {
      // came up after the wake (a minute of slack for clocks): boot on into the system that was picked
      pending.delete(host);
      if (other) todo = { reboot: true, entry: other };
    }
  }
  if (todo) m.last = { action: 'restart', entry: todo.entry, at: Date.now() };
  savePower();
  return { ok: true, ...todo };
}

// The directed broadcast address of the server's network that `ip` is on (all private ones if
// unknown), plus 255.255.255.255 and anything in WOL_BROADCAST. Windows sends 255.255.255.255 out
// of one adapter only, so the directed one is what usually gets through.
function wakeTargets(ip) {
  const toInt = (s) => s.split('.').reduce((n, o) => ((n << 8) + Number(o)) >>> 0, 0);
  const out = new Set(WOL_EXTRA);
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal || !privateIp(a.address)) continue;
      const addr = toInt(a.address);
      const mask = toInt(a.netmask);
      if (net.isIPv4(ip) && ((toInt(ip) & mask) >>> 0) !== ((addr & mask) >>> 0)) continue;
      const b = (addr | ~mask) >>> 0;
      out.add([24, 16, 8, 0].map((s) => (b >>> s) & 255).join('.'));
    }
  }
  out.add('255.255.255.255');
  return [...out];
}

// Wake-on-LAN magic packet: 6 x 0xFF, then the MAC 16 times. Sent three times to ports 9 and 7.
async function sendWake(mac, ip) {
  const bytes = Buffer.from(mac.replace(/:/g, ''), 'hex');
  const packet = Buffer.concat([Buffer.alloc(6, 0xff), ...Array(16).fill(bytes)]);
  const sock = dgram.createSocket('udp4');
  let sent = 0;
  try {
    await new Promise((resolve, reject) => { sock.once('error', reject); sock.bind(0, () => { sock.off('error', reject); resolve(); }); });
    sock.on('error', () => { /* a failed send is counted below */ });
    sock.setBroadcast(true);
    const targets = wakeTargets(ip);
    for (let round = 0; round < 3; round++) {
      for (const addr of targets) {
        for (const port of [9, 7]) await new Promise((resolve) => sock.send(packet, port, addr, (err) => { if (!err) sent++; resolve(); }));
      }
      if (round < 2) await new Promise((r) => setTimeout(r, 150));
    }
  } finally { sock.close(); }
  if (!sent) throw httpErr(500, 'Couldn’t send the wake-up packet from the server.');
}

// action: 'wake' (it's off: send the magic packet; `entry` = what it should end up in) or
// 'restart' (it's on in Linux: restart, into `entry` if that's another system).
// Returns { message } for the toast and { detail } for the activity log.
export async function powerAction(host, action, entry) {
  const m = power[host];
  if (!m) throw httpErr(404, `${host} hasn’t checked in with marquee-house boot yet.`);
  const target = entry == null || entry === '' ? null : m.entries.find((e) => e.title === entry);
  if (entry && !target) throw httpErr(400, 'That isn’t on its boot menu.');
  const on = Date.now() - m.at < POWER_ON_MS;
  const name = target ? osLabel(target.title) : null;
  if (action === 'restart') {
    if (!on) throw httpErr(409, `${host} isn’t on in Linux, so Marquee can’t restart it.`);
    pending.set(host, { action, entry: target?.title || null, at: Date.now() });
    const into = target && !target.current;
    return { message: into ? `Restarting ${host} into ${name} (within 30 s)` : `Restarting ${host} (within 30 s)`, detail: into ? `${host} into ${name}` : host };
  }
  if (action === 'wake') {
    if (on) throw httpErr(409, `${host} is already on.`);
    if (!m.mac) throw httpErr(409, `Marquee doesn’t know ${host}’s network card yet: run marquee-house boot on it once.`);
    await sendWake(m.mac, m.ip);
    pending.set(host, { action, entry: target?.title || null, at: Date.now() });
    m.last = { action: 'wake', entry: target?.title || null, at: Date.now() };
    savePower();
    return {
      message: name && target.os !== 'linux' ? `Waking ${host}: it starts Linux first, then restarts into ${name}` : `Waking ${host}`,
      detail: name ? `${host} into ${name}` : host,
    };
  }
  throw httpErr(400, 'Unknown power action.');
}

function powerView(m) {
  const on = Date.now() - m.at < POWER_ON_MS;
  const p = pending.get(m.host);
  const live = p && Date.now() - p.at < (p.action === 'wake' ? WAKE_MS : RESTART_MS) ? p : null;
  const current = on ? m.entries.find((e) => e.current) : null;
  const def = m.entries.find((e) => e.title === m.default);
  const notes = [];
  if (!m.mac) notes.push('Marquee doesn’t know its network card yet, so it can’t wake it.');
  else if (!m.wired) notes.push(`It’s on ${m.iface || 'Wi-Fi'}: Wake-on-LAN almost always needs a network cable.`);
  else if (m.wol != null && !m.wol.includes('g')) notes.push(`Wake-on-LAN is off on ${m.iface} and couldn’t be turned on (wol: ${m.wol || 'none'}).`);
  if (def && def.os !== 'linux') notes.push(`GRUB starts ${osLabel(def.title)} by default, so Marquee can only wake it into that. Set GRUB_DEFAULT to Linux.`);
  return {
    host: m.host,
    on,
    os: current ? osLabel(current.title) : null,
    seen: m.at,
    canWake: Boolean(m.mac),
    entries: m.entries.map((e) => ({ title: e.title, label: osLabel(e.title), os: e.os, current: Boolean(on && e.current) })),
    pending: live && { action: live.action, label: live.entry ? osLabel(live.entry) : null, at: live.at },
    last: m.last && { ...m.last, label: m.last.entry ? osLabel(m.last.entry) : null },
    notes,
  };
}

// ---------- the server's own health ----------
async function disk(dir) {
  try {
    const s = await fs.promises.statfs(dir);
    const size = s.blocks * s.bsize;
    return { size, used: size - s.bavail * s.bsize };
  } catch { return null; }
}

// CPU busy % over a short window (os.loadavg() is always 0 on Windows).
async function cpuBusy(ms = 400) {
  const snap = () => os.cpus().reduce((a, c) => {
    const t = c.times;
    a.idle += t.idle; a.total += t.user + t.nice + t.sys + t.idle + t.irq;
    return a;
  }, { idle: 0, total: 0 });
  const a = snap();
  await new Promise((r) => setTimeout(r, ms));
  const b = snap();
  const total = b.total - a.total;
  return total > 0 ? Math.round(100 * (1 - (b.idle - a.idle) / total)) : null;
}

const timeout = (ms) => AbortSignal.timeout(ms);
function tcpOpen(host, port, ms = 1500) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (ok) => { s.destroy(); resolve(ok); };
    s.setTimeout(ms, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

async function adguard() {
  if (!ADGUARD_URL) {
    // Not configured: at least check that something answers DNS on this machine.
    const up = await tcpOpen('127.0.0.1', 53);
    return { name: 'AdGuard Home', ok: up, detail: up ? 'DNS answering (set ADGUARD_URL for stats)' : 'nothing on port 53' };
  }
  const headers = ADGUARD_USER ? { Authorization: `Basic ${Buffer.from(`${ADGUARD_USER}:${ADGUARD_PASS}`).toString('base64')}` } : {};
  try {
    const r = await fetch(`${ADGUARD_URL}/control/status`, { headers, signal: timeout(3000) });
    // A refused login is an answer: say so, rather than "no answer" (AdGuard always asks for one)
    if (r.status === 401 || r.status === 403) {
      return { name: 'AdGuard Home', ok: false, detail: ADGUARD_USER ? 'login refused: check ADGUARD_USER / ADGUARD_PASS' : 'needs its login: set ADGUARD_USER and ADGUARD_PASS in .env' };
    }
    const st = await r.json();
    let detail = st.protection_enabled ? 'protection on' : 'protection OFF';
    try {
      const s = await (await fetch(`${ADGUARD_URL}/control/stats`, { headers, signal: timeout(3000) })).json();
      const q = s.num_dns_queries || 0;
      const b = s.num_blocked_filtering || 0;
      detail += ` · ${q.toLocaleString('en')} queries, ${q ? Math.round((100 * b) / q) : 0} % blocked (${s.time_units === 'days' ? '30 d' : '24 h'})`;
    } catch { /* status is enough */ }
    return { name: 'AdGuard Home', ok: Boolean(st.running) && Boolean(st.protection_enabled), detail };
  } catch (e) {
    return { name: 'AdGuard Home', ok: false, detail: `no answer at ${ADGUARD_URL}` };
  }
}

async function services() {
  const out = [];
  if (qbitAlive) {
    let ok = false;
    try { ok = await qbitAlive(); } catch { /* down */ }
    out.push({ name: 'qBittorrent', ok, detail: ok ? 'Web UI answering' : 'Web UI not answering' });
  }
  if (FLARESOLVERR_URL) {
    let ok = false;
    try { ok = (await fetch(FLARESOLVERR_URL, { signal: timeout(3000) })).ok; } catch { /* down */ }
    out.push({ name: 'FlareSolverr', ok, detail: ok ? 'ready' : `no answer at ${FLARESOLVERR_URL}` });
  }
  out.push(await adguard());
  return out;
}

// ---------- the report the House tab shows ----------
const pct = (d) => (d.size ? d.used / d.size : 0);
const gb = (b) => `${Math.round(b / 1e9)} GB`;

function machineIssues(m) {
  const issues = [];
  for (const d of m.disks) if (pct(d) >= DISK_WARN) issues.push(`${m.host}: ${d.mount} is ${Math.round(pct(d) * 100)} % full (${gb(d.size - d.used)} free)`);
  if (m.failed.length) issues.push(`${m.host}: failed ${m.failed.length === 1 ? 'service' : 'services'} ${m.failed.join(', ')}`);
  if (m.lastBackup && Date.now() - m.lastBackup * 1000 > BACKUP_WARN_MS) issues.push(`${m.host}: last backup ${Math.round((Date.now() - m.lastBackup * 1000) / 86400000)} days ago`);
  if (m.battery && m.battery.pct <= 10 && m.battery.status !== 'Charging') issues.push(`${m.host}: battery at ${m.battery.pct} %`);
  if (m.secureBoot === false) issues.push(`${m.host}: Secure Boot is off`);
  return issues;
}

export async function houseReport() {
  const [cpu, svc, disks] = await Promise.all([cpuBusy(), services(), Promise.all(dirs.map(async (d) => ({ label: d.label, dir: d.dir, ...(await disk(d.dir)) })))]);
  const server = {
    name: os.hostname(),
    os: `${os.type()} ${os.release()}`,
    uptime: Math.round(os.uptime()),
    cpu,
    mem: { total: os.totalmem(), avail: os.freemem() },
    disks: disks.filter((d) => d.size),
    services: svc,
  };
  const issues = [];
  for (const d of server.disks) if (pct(d) >= DISK_WARN) issues.push(`Server: ${d.label} drive is ${Math.round(pct(d) * 100)} % full (${gb(d.size - d.used)} free)`);
  for (const s of svc) if (!s.ok) issues.push(`Server: ${s.name}: ${s.detail}`);
  const list = Object.values(machines).sort((a, b) => a.host.localeCompare(b.host)).map((m) => ({
    ...m, away: Date.now() - m.at > QUIET_MS, issues: machineIssues(m),
  }));
  for (const m of list) if (!m.away) issues.push(...m.issues); // an away laptop's last report is old news
  const powerList = Object.values(power).sort((a, b) => a.host.localeCompare(b.host)).map(powerView);
  return { checkedAt: Date.now(), server, machines: list, power: powerList, issues, agents: houseConfigured() };
}

// For the machines themselves (token + LAN only): waybar's house dot and the MAGI panel on the desktop.
export async function houseSummary() {
  const r = await houseReport();
  return {
    ok: r.issues.length === 0,
    issues: r.issues,
    machines: r.machines.filter((m) => !m.away).map((m) => m.host),
    away: r.machines.filter((m) => m.away).map((m) => m.host),
    server: {
      name: r.server.name,
      uptime: r.server.uptime,
      disks: r.server.disks.map((d) => ({ label: d.label, free: d.size - d.used, size: d.size })),
      services: r.server.services.map((x) => ({ name: x.name, ok: x.ok })),
    },
  };
}
