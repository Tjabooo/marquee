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
    const st = await (await fetch(`${ADGUARD_URL}/control/status`, { headers, signal: timeout(3000) })).json();
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
  return { checkedAt: Date.now(), server, machines: list, issues, agents: houseConfigured() };
}

export async function houseSummary() {
  const r = await houseReport();
  return { ok: r.issues.length === 0, issues: r.issues, machines: r.machines.filter((m) => !m.away).map((m) => m.host) };
}
