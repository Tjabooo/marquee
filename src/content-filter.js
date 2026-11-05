// Adult-content filter for downloads. Release names, .torrent contents and the file lists qBittorrent
// reports are checked against porn markers; anything that matches is hidden from torrent search,
// refused before it reaches qBittorrent, or (when only its files give it away) removed with its files.
//
// The rules aim at markers that don't appear in ordinary film and TV releases: the scene XXX tag, porn
// site and studio names, explicit act words and JAV catalogue codes. Studio names that are also normal
// words (Vixen, Private, Deeper…) only count next to a scene date (Vixen.24.01.05.…).
//
// CONTENT_FILTER=on (default) applies it to everyone, `members` to everyone except the server's owner,
// `off` turns it off. CONTENT_FILTER_WORDS adds comma-separated words or phrases of your own.

const MODE = (() => {
  const v = String(process.env.CONTENT_FILTER || 'on').trim().toLowerCase();
  return ['off', 'members'].includes(v) ? v : 'on';
})();

export const filterMode = () => MODE;
// Whether the filter applies to `user` ({ isOwner }); background work without a person counts as a member.
export const filterApplies = (user) => MODE === 'on' || (MODE === 'members' && !user?.isOwner);

// Single words, matched as whole words after punctuation is turned into spaces.
const WORDS = [
  'porn', 'porno', 'porns', 'pornstar', 'pornstars', 'hentai', 'jav', 'milf', 'milfs', 'blowjob', 'blowjobs',
  'gangbang', 'gangbangs', 'creampie', 'creampies', 'cumshot', 'cumshots', 'bukkake', 'handjob', 'handjobs',
  'footjob', 'titjob', 'deepthroat', 'stepsis', 'xxxx',
  // sites and studios whose names aren't ordinary words
  'brazzers', 'bangbros', 'realitykings', 'naughtyamerica', 'onlyfans', 'fansly', 'pornhub', 'xvideos', 'xhamster',
  'xnxx', 'chaturbate', 'manyvids', 'clips4sale', 'blacked', 'blackedraw', 'tushy', 'tushyraw', 'mofos', 'fakehub',
  'faketaxi', 'teamskeet', 'digitalplayground', 'julesjordan', 'legalporno', 'analvids', 'nubilefilms', 'sexart',
  'metart', 'hegre', 'joymii', 'wowgirls', 'puretaboo', 'girlsway', 'hardx', 'darkx', 'povd', 'bangbus', 'mylf',
  'cum4k', 'tiny4k', 'spyfam', 'pervmom', 'brattysis', 'sislovesme', 'familystrokes', 'exploitedcollegegirls',
  'letsdoeit', 'ztod', 'zzseries', 'momxxx', 'pornpros', 'castingcouchx', 'woodmancastingx', 'ddfnetwork',
  'adulttime', 'evilangel', 'pornworld', 'scoreland',
];

// Studio names that are also everyday words: adult only when a scene date follows within a few words.
const DATED = [
  'vixen', 'deeper', 'slayed', 'kink', 'private', 'babes', 'twistys', 'passion hd', 'passionhd', 'holed', 'lubed',
  'dorcel', 'marc dorcel', 'ddf', 'nubiles', 'hustler', 'penthouse', 'playboy', 'x art', 'xart', 'evil angel',
  'reality kings', 'naughty america', 'team skeet', 'digital playground', 'jules jordan', 'pure taboo',
  'bang bros', 'girls way', 'fake taxi', 'fake hub', 'adult time', 'nubile films', 'sex art', 'met art',
];

// Whole phrases (several words) that are adult wherever they appear.
const PHRASES = ['onlyfans siterip', 'only fans', 'porn hub', 'x videos', 'fc2 ppv', 'step sister fucks', 'casting couch x'];

// JAV catalogue codes (SSIS-123, IPX-456, FC2-PPV-1234567…): prefixes of the big studios only.
// Prefixes that are also words or months (Jul, Stars…) are left out; a year after the prefix doesn't count.
const JAV = /(?:^|[^a-z0-9])(?:ssis|ssni|ipx|ipz|midv|mide|miaa|abp|abw|pred|cawd|meyd|juq|juy|pppd|dvdms|hnd|sone|ebod|waaa|rbd|snis|mird|fsdss|mvsd|hmn|ppbd|sivr|kawd|ofje|dass|nsfs|mudr|huntb|cjod|mkmp|ksbj|savr)[-_]?(?!(?:19|20)\d\d(?:\D|$))\d{3,5}(?:[^a-z0-9]|$)/i;
const FC2 = /fc2[-_ ]?ppv[-_ ]?\d{5,8}/i;
// A scene date (YY MM DD or YYYY MM DD), as porn sites name their scenes.
const SCENE_DATE = /^(?:\d{2}|(?:19|20)\d{2}) (?:0[1-9]|1[0-2]) (?:0[1-9]|[12]\d|3[01])\b/;

const extraWords = String(process.env.CONTENT_FILTER_WORDS || '')
  .split(',').map((w) => tokens(w).join(' ')).filter(Boolean);

function tokens(text) {
  return String(text || '').toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
}

const WORD_SET = new Set(WORDS);
const hasPhrase = (spaced, phrase) => (` ${spaced} `).includes(` ${phrase} `);

// Why `text` (a release name or a file path) looks like adult content, or null when it doesn't.
export function adultReason(text) {
  const raw = String(text || '');
  if (!raw.trim()) return null;
  const list = tokens(raw);
  const spaced = list.join(' ');
  // XXX is the scene tag for porn (…XXX.1080p.MP4-GROUP). "xXx" the Vin Diesel film starts with it, so
  // the very first word may be xxx; anywhere else it's the tag.
  if (list.slice(1).includes('xxx')) return 'tagged XXX';
  for (const w of list) if (WORD_SET.has(w)) return `“${w}”`;
  for (const p of PHRASES) if (hasPhrase(spaced, p)) return `“${p}”`;
  for (const p of extraWords) if (hasPhrase(spaced, p)) return `“${p}”`;
  if (FC2.test(raw) || JAV.test(raw)) return 'an adult video catalogue code';
  for (const name of DATED) {
    let at = ` ${spaced} `.indexOf(` ${name} `);
    while (at !== -1) {
      const after = spaced.slice(at + name.length).trim();
      // the date within the next three words: "Vixen 24 01 05", "Vixen - Name - 24.01.05" isn't required
      const rest = after.split(' ');
      for (let i = 0; i <= 3 && i < rest.length; i++) {
        if (SCENE_DATE.test(rest.slice(i).join(' '))) return `“${name}” scene`;
      }
      at = ` ${spaced} `.indexOf(` ${name} `, at + 1);
    }
  }
  return null;
}

// The first adult reason among several names (torrent name, file paths…), with the name that matched.
export function firstAdult(names) {
  for (const name of names || []) {
    const reason = adultReason(name);
    if (reason) return { name: String(name), reason };
  }
  return null;
}

// 1337x's XXX subcategories (/sub/48/0/ = XXX Video, 49 Picture, 50 Games, 51 Hentai, 67 Magazine).
export const X1337_ADULT_SUBS = new Set(['48', '49', '50', '51', '67']);
// The Pirate Bay's porn categories are 5xx.
export const tpbAdultCategory = (cat) => /^5\d\d$/.test(String(cat || ''));

// Names inside a .torrent file (its name and every file path), read with a small bencode parser.
// Returns [] when the file can't be read; qBittorrent then decides whether it's a torrent at all.
export function torrentFileNames(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  let i = 0;
  const fail = () => { throw new Error('bad bencode'); };
  function read(depth = 0) {
    if (depth > 50 || i >= buf.length) fail();
    const c = buf[i];
    if (c === 0x69) { // i<int>e
      const end = buf.indexOf(0x65, i);
      if (end < 0) fail();
      const v = Number(buf.toString('latin1', i + 1, end));
      i = end + 1;
      return v;
    }
    if (c === 0x6c) { // l…e
      i++;
      const out = [];
      while (buf[i] !== 0x65) { out.push(read(depth + 1)); if (i >= buf.length) fail(); }
      i++;
      return out;
    }
    if (c === 0x64) { // d…e
      i++;
      const out = new Map();
      while (buf[i] !== 0x65) {
        const key = read(depth + 1);
        if (!Buffer.isBuffer(key)) fail();
        out.set(key.toString('latin1'), read(depth + 1));
        if (i >= buf.length) fail();
      }
      i++;
      return out;
    }
    if (c >= 0x30 && c <= 0x39) { // <len>:<bytes>
      const colon = buf.indexOf(0x3a, i);
      if (colon < 0) fail();
      const len = Number(buf.toString('latin1', i, colon));
      if (!Number.isSafeInteger(len) || len < 0 || colon + 1 + len > buf.length) fail();
      const v = buf.subarray(colon + 1, colon + 1 + len);
      i = colon + 1 + len;
      return v;
    }
    return fail();
  }
  try {
    const root = read();
    const info = root instanceof Map ? root.get('info') : null;
    if (!(info instanceof Map)) return [];
    const text = (v) => (Buffer.isBuffer(v) ? v.toString('utf8') : '');
    const names = [text(info.get('name.utf-8') || info.get('name'))];
    for (const f of Array.isArray(info.get('files')) ? info.get('files') : []) {
      if (!(f instanceof Map)) continue;
      const parts = f.get('path.utf-8') || f.get('path');
      if (Array.isArray(parts)) names.push(parts.map(text).join('/'));
    }
    return names.filter(Boolean);
  } catch { return []; }
}

export const BLOCKED_MESSAGE = 'Marquee doesn’t download adult content, so this download was blocked.';
