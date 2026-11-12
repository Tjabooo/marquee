// Fake releases: a torrent named like a new episode or film that holds a program instead of a video
// ("South Park S29E01 ... 1080p WEB-DL x265 NTb.exe", 1 GB). qBittorrent's excluded names already keep
// the program from downloading, but the torrent stays put, looks like the episode and holds up the
// rest of the season. Judged from the file list once the metadata has arrived.
const VIDEO = /\.(mkv|mp4|m4v|avi|mov|webm|ts|m2ts|wmv|mpg|mpeg)$/i;
const PROGRAM = /\.(exe|scr|com|bat|cmd|msi|lnk|pif|vbs|vbe|js|jse|wsf|wsh|hta|ps1|jar|apk|reg|cpl)$/i;
// A real episode is far bigger than this; "codec" lures ship a short clip next to the program.
const REAL_VIDEO_BYTES = 50 * 1024 ** 2;

const base = (name) => String(name || '').replace(/\\/g, '/').split('/').pop();
const isSample = (name) => /(^|[^a-z])sample([^a-z]|$)/i.test(base(name));

// files: qBittorrent's file list ({ name, size }). Returns why the torrent is fake, or null.
export function fakeRelease(files) {
  if (!Array.isArray(files) || !files.length) return null;
  const programs = files.filter((f) => PROGRAM.test(base(f.name)));
  if (!programs.length) return null;
  const realVideo = files.some((f) => VIDEO.test(base(f.name)) && !isSample(f.name) && Number(f.size || 0) >= REAL_VIDEO_BYTES);
  if (realVideo) return null;
  return `holds a program (${base(programs[0].name)}) instead of a video`;
}
