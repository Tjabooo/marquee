// Downloads a .torrent file for qBittorrent. Lilin fetches it itself because qBittorrent's own
// web requests are blocked when it is fenced into a VPN tunnel (tools/torrent-vpn); its peer and
// tracker traffic still goes through the tunnel. Only public hosts are fetched, so a pasted link
// can't be used to probe the local network.
import dns from 'node:dns/promises';
import net from 'node:net';

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 5;

const blocked = new net.BlockList();
for (const [addr, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3]]) blocked.addSubnet(addr, bits, 'ipv4');
// (No ::ffff:0:0/96 rule: BlockList also matches plain IPv4 against it. Mapped addresses are unwrapped below.)
for (const [addr, bits] of [['::', 127], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) blocked.addSubnet(addr, bits, 'ipv6');

export function isPublicAddress(ip) {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(String(ip));
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(String(ip));   // how URL() writes [::ffff:127.0.0.1]
  if (mapped) ip = mapped[1];
  else if (hex) { const a = parseInt(hex[1], 16), b = parseInt(hex[2], 16); ip = `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`; }
  const family = net.isIPv4(ip) ? 'ipv4' : net.isIPv6(ip) ? 'ipv6' : null;
  return !!family && !blocked.check(ip, family);
}

export class TorrentFetchError extends Error {}

async function assertPublicHost(hostname, lookup) {
  const host = hostname.replace(/^\[|\]$/g, '');
  const addresses = net.isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
  if (!addresses.length) throw new TorrentFetchError('Couldn’t find that website.');
  if (!addresses.every((a) => isPublicAddress(a.address))) throw new TorrentFetchError('That link points into a private network.');
}

// A .torrent is a bencoded dictionary with an info dictionary in it.
export const looksLikeTorrent = (buf) => buf.length > 10 && buf[0] === 0x64 /* d */ && buf.includes('4:info');

export async function fetchTorrentFile(link, { fetchImpl = fetch, lookup = dns.lookup, maxBytes = MAX_BYTES, timeoutMs = 15000 } = {}) {
  let url;
  try { url = new URL(link); } catch { throw new TorrentFetchError('That isn’t a valid link.'); }
  for (let hop = 0; ; hop++) {
    if (!/^https?:$/.test(url.protocol)) throw new TorrentFetchError('Only http and https links work.');
    await assertPublicHost(url.hostname, lookup);
    let r;
    try {
      r = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/x-bittorrent,*/*;q=0.5' } });
    } catch {
      throw new TorrentFetchError('Couldn’t download the .torrent file.');
    }
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) {
      if (hop >= MAX_REDIRECTS) throw new TorrentFetchError('That link redirects too many times.');
      const next = r.headers.get('location');
      if (/^magnet:\?/i.test(next)) return { magnet: next };
      url = new URL(next, url);
      continue;
    }
    if (!r.ok) throw new TorrentFetchError(`The site answered ${r.status}.`);
    if (Number(r.headers.get('content-length')) > maxBytes) throw new TorrentFetchError('That file is too big to be a .torrent.');
    const chunks = []; let size = 0;
    for await (const chunk of r.body) {
      size += chunk.length;
      if (size > maxBytes) throw new TorrentFetchError('That file is too big to be a .torrent.');
      chunks.push(chunk);
    }
    const file = Buffer.concat(chunks);
    if (!looksLikeTorrent(file)) throw new TorrentFetchError('That link isn’t a .torrent file.');
    return { file };
  }
}
