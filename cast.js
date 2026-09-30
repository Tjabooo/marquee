// Casting. TVs stream directly from this server; clients only send commands.
//   Smart TVs: DLNA / UPnP AV (built in).
//   Apple TV: AirPlay via pyatv's atvscript (pip install pyatv).
import dgram from 'node:dgram';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const fail = (status, message) => Object.assign(new Error(message), { status });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let LAN_IP = '127.0.0.1';
const ATVSCRIPT = process.env.ATVSCRIPT || 'atvscript';
const APPLE_TV_ENABLED = (process.env.CAST_APPLETV || 'on').toLowerCase() !== 'off';

const devices = new Map();   // id -> device
const sessions = new Map();  // deviceId -> { deviceId, deviceName, kind, title, subtitle, media, startedAt, proc? }

export function initCasting({ lanIp }) { LAN_IP = lanIp; }

// ---------- XML helpers ----------
const XML_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
const escapeXml = (s) => String(s).replace(/[&<>"']/g, (c) => XML_ESC[c]);
const decodeXml = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
function tag(xml, name) {
  const m = new RegExp(`<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`, 'i').exec(xml);
  return m ? decodeXml(m[1].trim()) : '';
}
const hms = (sec) => {
  sec = Math.max(0, Math.floor(sec));
  return `${Math.floor(sec / 3600)}:${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
};
const parseHms = (s) => {
  const m = /^(\d+):(\d{1,2}):(\d{1,2})(?:\.\d+)?$/.exec(s || '');
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
};

// ---------- DLNA / UPnP ----------
// SSDP discovery -> device description -> AVTransport control URL -> SOAP actions.
async function ssdpSearch(timeoutMs) {
  const locations = new Set();
  await new Promise((resolve) => {
    let sock;
    try { sock = dgram.createSocket({ type: 'udp4', reuseAddr: true }); } catch { return resolve(); }
    let finished = false;
    const done = () => { if (finished) return; finished = true; try { sock.close(); } catch { /* closed */ } resolve(); };
    sock.on('error', done);
    sock.on('message', (msg) => {
      const m = /^location:\s*(.+)$/im.exec(msg.toString());
      if (m) locations.add(m[1].trim());
    });
    const bindAddr = LAN_IP === '127.0.0.1' ? undefined : LAN_IP;
    sock.bind(0, bindAddr, () => {
      try { if (bindAddr) sock.setMulticastInterface(bindAddr); } catch { /* not supported */ }
      const search = (st) => sock.send(Buffer.from(
        `M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${st}\r\n\r\n`,
      ), 1900, '239.255.255.250', () => {});
      for (const st of ['urn:schemas-upnp-org:device:MediaRenderer:1', 'urn:schemas-upnp-org:service:AVTransport:1']) {
        search(st);
        setTimeout(() => !finished && search(st), 500); // UDP is lossy; send twice
      }
      setTimeout(done, timeoutMs);
    });
  });
  return locations;
}

async function describeDlna(location) {
  const r = await fetch(location, { signal: AbortSignal.timeout(3000) });
  if (!r.ok) return null;
  const xml = await r.text();
  const base = tag(xml, 'URLBase') || location;
  const services = [...xml.matchAll(/<(?:[\w-]+:)?service>([\s\S]*?)<\/(?:[\w-]+:)?service>/gi)].map((m) => ({
    type: tag(m[1], 'serviceType'),
    control: new URL(tag(m[1], 'controlURL'), base).href,
  }));
  const av = services.find((s) => /:AVTransport:\d/.test(s.type));
  if (!av) return null; // not a media renderer
  const rc = services.find((s) => /:RenderingControl:\d/.test(s.type)) || null;
  const udn = tag(xml, 'UDN') || location;
  return {
    id: `dlna-${crypto.createHash('sha1').update(udn).digest('hex').slice(0, 12)}`,
    kind: 'dlna',
    name: tag(xml, 'friendlyName') || 'Smart TV',
    model: [tag(xml, 'manufacturer'), tag(xml, 'modelName')].filter(Boolean).join(' '),
    av,
    rc,
  };
}

async function discoverDlna() {
  const locations = await ssdpSearch(2500);
  // Manual fallback for networks where multicast is blocked: DLNA_DEVICES=http://tv-ip:port/description.xml,...
  for (const loc of (process.env.DLNA_DEVICES || '').split(',').map((s) => s.trim()).filter(Boolean)) locations.add(loc);
  const found = await Promise.all([...locations].map((loc) => describeDlna(loc).catch(() => null)));
  const unique = new Map();
  for (const d of found) if (d) unique.set(d.id, d);
  return [...unique.values()];
}

async function soap(service, action, args = {}) {
  const inner = Object.entries(args).map(([k, v]) => `<${k}>${escapeXml(v)}</${k}>`).join('');
  const body = '<?xml version="1.0" encoding="utf-8"?>\n'
    + '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">'
    + `<s:Body><u:${action} xmlns:u="${service.type}">${inner}</u:${action}></s:Body></s:Envelope>`;
  let r;
  try {
    r = await fetch(service.control, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPACTION: `"${service.type}#${action}"` },
      body,
      signal: AbortSignal.timeout(6000),
    });
  } catch {
    throw fail(504, 'The TV didn’t answer. Is it switched on?');
  }
  const text = await r.text();
  if (!r.ok) {
    const code = /<errorCode>(\d+)<\/errorCode>/.exec(text)?.[1];
    const desc = /<errorDescription>([^<]*)</.exec(text)?.[1];
    const err = fail(502, `The TV refused “${action}”${code ? ` (error ${code}${desc ? `: ${desc}` : ''})` : ''}.`);
    err.upnpCode = Number(code) || null;
    throw err;
  }
  return (name) => { const v = tag(text, name); return v === '' ? null : v; };
}

// Subtitles (media.subUrl) are advertised in every common vendor format:
// Samsung (sec:CaptionInfoEx), PacketVideo/Sony (pv: attributes) and LG (text/srt res).
function didl(media) {
  const flags = 'DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000';
  const sub = media.subUrl ? escapeXml(media.subUrl) : null;
  return '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/"'
    + ' xmlns:sec="http://www.sec.co.kr/" xmlns:pv="http://www.pv.com/pvns/">'
    + '<item id="0" parentID="-1" restricted="1">'
    + `<dc:title>${escapeXml(media.title)}</dc:title><upnp:class>object.item.videoItem.movie</upnp:class>`
    + `<res protocolInfo="http-get:*:${media.mime}:${flags}" size="${media.size}"`
    + (sub ? ` pv:subtitleFileType="srt" pv:subtitleFileUri="${sub}"` : '')
    + `>${escapeXml(media.url)}</res>`
    + (sub ? `<res protocolInfo="http-get:*:text/srt:*">${sub}</res>`
      + `<sec:CaptionInfoEx sec:type="srt">${sub}</sec:CaptionInfoEx><sec:CaptionInfo sec:type="srt">${sub}</sec:CaptionInfo>` : '')
    + '</item></DIDL-Lite>';
}

const dlna = {
  async play(dev, media) {
    try { await soap(dev.av, 'Stop', { InstanceID: 0 }); } catch { /* nothing was playing */ }
    await soap(dev.av, 'SetAVTransportURI', { InstanceID: 0, CurrentURI: media.url, CurrentURIMetaData: didl(media) });
    // Some TVs reject Play until loading finishes (UPnP error 701).
    for (let attempt = 0; ; attempt++) {
      try { await soap(dev.av, 'Play', { InstanceID: 0, Speed: 1 }); return; } catch (e) {
        if (attempt >= 6) throw e;
        await sleep(700);
      }
    }
  },
  async control(dev, action, value) {
    if (action === 'play') return soap(dev.av, 'Play', { InstanceID: 0, Speed: 1 });
    if (action === 'pause') return soap(dev.av, 'Pause', { InstanceID: 0 });
    if (action === 'stop') return soap(dev.av, 'Stop', { InstanceID: 0 });
    if (action === 'seek') return soap(dev.av, 'Seek', { InstanceID: 0, Unit: 'REL_TIME', Target: hms(value) });
    if (action === 'volume') {
      if (!dev.rc) throw fail(400, 'This TV doesn’t allow volume control over the network.');
      return soap(dev.rc, 'SetVolume', { InstanceID: 0, Channel: 'Master', DesiredVolume: Math.round(value) });
    }
    throw fail(400, 'Unknown action.');
  },
  async status(dev) {
    const [pos, tr, vol] = await Promise.all([
      soap(dev.av, 'GetPositionInfo', { InstanceID: 0 }),
      soap(dev.av, 'GetTransportInfo', { InstanceID: 0 }),
      dev.rc ? soap(dev.rc, 'GetVolume', { InstanceID: 0, Channel: 'Master' }).catch(() => null) : null,
    ]);
    const map = { PLAYING: 'playing', PAUSED_PLAYBACK: 'paused', TRANSITIONING: 'loading', STOPPED: 'stopped', NO_MEDIA_PRESENT: 'stopped' };
    return {
      state: map[tr('CurrentTransportState')] || 'unknown',
      position: parseHms(pos('RelTime')),
      duration: parseHms(pos('TrackDuration')),
      volume: vol ? Number(vol('CurrentVolume')) : null,
    };
  },
};

// ---------- Apple TV (pyatv) ----------
function atvscript(args, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    let out = '';
    let child;
    try { child = spawn(ATVSCRIPT, args, { windowsHide: true }); } catch (e) { return reject(e); }
    const timer = setTimeout(() => { child.kill(); reject(fail(504, 'The Apple TV didn’t answer in time.')); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e.code === 'ENOENT'
        ? fail(503, 'Apple TV support needs pyatv. Run “pip install pyatv” on the server, then restart.')
        : e);
    });
    child.on('close', () => {
      clearTimeout(timer);
      const line = out.trim().split(/\r?\n/).reverse().find((l) => l.startsWith('{'));
      let json;
      try { json = JSON.parse(line); } catch { return reject(fail(502, 'Unexpected reply from the Apple TV helper.')); }
      if (json.result === 'failure') return reject(fail(502, atvError(json)));
      resolve(json);
    });
  });
}

function atvError(json) {
  const msg = json.error || json.exception || 'The Apple TV reported an error.';
  if (/auth|credential|pair/i.test(msg)) {
    return 'The Apple TV needs pairing first. On the server run: atvremote wizard (see the setup notes).';
  }
  return msg;
}

const atvArgs = (dev) => ['-s', dev.address, '--id', dev.identifier];

async function discoverAppleTv() {
  if (!APPLE_TV_ENABLED) return [];
  const hosts = (process.env.ATV_HOSTS || '').trim(); // used when multicast discovery fails
  const json = await atvscript(hosts ? ['-s', hosts, 'scan'] : ['scan'], 15000);
  return (json.devices || [])
    .filter((d) => (d.services || []).some((s) => s.protocol === 'airplay'))
    .filter((d) => !d.device_info?.operating_system || /tvos/i.test(d.device_info.operating_system))
    .map((d) => ({
      id: `atv-${crypto.createHash('sha1').update(d.identifier).digest('hex').slice(0, 12)}`,
      kind: 'airplay',
      name: d.name || 'Apple TV',
      model: 'Apple TV',
      address: d.address,
      identifier: d.identifier,
    }));
}

const appleTv = {
  async play(dev, media, session) {
    // AirPlay stops when the initiating connection closes, so play_url stays running for the session.
    const child = spawn(ATVSCRIPT, [...atvArgs(dev), `play_url=${media.url}`], { windowsHide: true });
    session.proc = child;
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    const exited = new Promise((resolve) => {
      child.on('close', () => resolve('closed'));
      child.on('error', (e) => resolve(e));
    });
    const result = await Promise.race([exited, sleep(4000).then(() => 'running')]);
    if (result instanceof Error) {
      throw result.code === 'ENOENT'
        ? fail(503, 'Apple TV support needs pyatv. Run “pip install pyatv” on the server, then restart.')
        : result;
    }
    if (result === 'closed') {
      const line = out.trim().split(/\r?\n/).reverse().find((l) => l.startsWith('{'));
      let json = null;
      try { json = JSON.parse(line); } catch { /* no JSON */ }
      if (!json || json.result === 'failure') throw fail(502, json ? atvError(json) : 'The Apple TV didn’t start playback.');
    }
  },
  async control(dev, action, value, session) {
    const cmd = { play: 'play', pause: 'pause', stop: 'stop', seek: `set_position=${Math.round(value)}`, volume: `set_volume=${Math.round(value)}` }[action];
    if (!cmd) throw fail(400, 'Unknown action.');
    try {
      await atvscript([...atvArgs(dev), cmd]);
    } finally {
      if (action === 'stop') session?.proc?.kill();
    }
  },
  async status(dev) {
    const j = await atvscript([...atvArgs(dev), 'playing']);
    const map = { playing: 'playing', paused: 'paused', loading: 'loading', seeking: 'loading', idle: 'stopped', stopped: 'stopped' };
    return {
      state: map[j.device_state] || 'unknown',
      position: Number.isFinite(j.position) ? j.position : null,
      duration: Number.isFinite(j.total_time) ? j.total_time : null,
      volume: null,
    };
  },
};

const drivers = { dlna, airplay: appleTv };

// ---------- public API ----------
export async function discover() {
  const [tvs, atvs] = await Promise.allSettled([discoverDlna(), discoverAppleTv()]);
  const notes = [];
  const list = [];
  if (tvs.status === 'fulfilled') list.push(...tvs.value); else notes.push(`Smart TV search failed: ${tvs.reason.message}`);
  if (atvs.status === 'fulfilled') list.push(...atvs.value); else notes.push(atvs.reason.message);
  for (const d of list) devices.set(d.id, d);
  return { devices: list.map(publicDevice), notes };
}

export function knownDevices() { return [...devices.values()].map(publicDevice); }

const publicDevice = (d) => ({ id: d.id, kind: d.kind, name: d.name, model: d.model, playing: sessions.has(d.id) });

function getDevice(id) {
  const dev = devices.get(id);
  if (!dev) throw fail(404, 'That TV isn’t in the list anymore. Search for TVs again.');
  return dev;
}

// media: { url, title, subtitle, mime, size, ext, ref }
export async function castTo(deviceId, media) {
  const dev = getDevice(deviceId);
  if (dev.kind === 'airplay' && !['mp4', 'm4v', 'mov'].includes(media.ext)) {
    throw fail(415, `Apple TV can only play MP4 or MOV files this way, and this one is ${media.ext.toUpperCase()}.`);
  }
  const old = sessions.get(deviceId);
  old?.proc?.kill();
  const session = {
    deviceId, deviceName: dev.name, kind: dev.kind,
    title: media.title, subtitle: media.subtitle, media: media.ref, startedAt: Date.now(),
    sub: media.subLang || null,
  };
  sessions.set(deviceId, session);
  try {
    await drivers[dev.kind].play(dev, media, session);
  } catch (e) {
    session.proc?.kill();
    sessions.delete(deviceId);
    throw e;
  }
  return publicSession(session);
}

export async function control(deviceId, action, value) {
  const dev = getDevice(deviceId);
  if (action === 'seek' && !(value >= 0)) throw fail(400, 'Seek needs a position in seconds.');
  if (action === 'volume' && !(value >= 0 && value <= 100)) throw fail(400, 'Volume must be 0–100.');
  const session = sessions.get(deviceId);
  await drivers[dev.kind].control(dev, action, value, session);
  if (action === 'stop') sessions.delete(deviceId);
  return { ok: true };
}

const statusCache = new Map(); // deviceId -> { at, promise }
export async function status(deviceId) {
  const dev = getDevice(deviceId);
  const cached = statusCache.get(deviceId);
  if (cached && Date.now() - cached.at < 1200) return cached.promise;
  const promise = drivers[dev.kind].status(dev).then((s) => ({ ...s, session: publicSession(sessions.get(deviceId)) }));
  statusCache.set(deviceId, { at: Date.now(), promise });
  promise.catch(() => statusCache.delete(deviceId));
  return promise;
}

const publicSession = (s) => (s ? {
  deviceId: s.deviceId, deviceName: s.deviceName, kind: s.kind,
  title: s.title, subtitle: s.subtitle, media: s.media, startedAt: s.startedAt, sub: s.sub || null,
} : null);

export const getSession = (deviceId) => publicSession(sessions.get(deviceId));

// Seeks back to a position after a restart. Retries because TVs reject Seek until playback has begun.
export async function resumeAt(deviceId, seconds) {
  if (!(seconds > 5)) return;
  const dev = getDevice(deviceId);
  for (let i = 0; i < 12; i++) {
    await sleep(1000);
    try {
      const st = await drivers[dev.kind].status(dev);
      if (st.state !== 'playing' && st.state !== 'paused') continue;
      await drivers[dev.kind].control(dev, 'seek', seconds, sessions.get(deviceId));
      return;
    } catch { /* not ready yet */ }
  }
}

export function listSessions() { return [...sessions.values()].map(publicSession); }