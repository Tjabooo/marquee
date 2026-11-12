// Install commands for Lilin's optional tools, from each platform's official package source.
// setup.js only prints these unless the user agrees (or passes --allow-install); system package
// managers on Linux need root, and setup.js never runs sudo without saying so first.
const PACKAGES = {
  ffmpeg: {
    winget: ['winget', 'install', '--id', 'Gyan.FFmpeg', '-e', '--accept-source-agreements'],
    choco: ['choco', 'install', 'ffmpeg', '-y'],
    apt: ['apt-get', 'install', '-y', 'ffmpeg'],
    // Fedora's own ffmpeg-free lacks H.264/HEVC encoders; RPM Fusion's ffmpeg has them.
    dnf: ['dnf', 'install', '-y', 'ffmpeg-free'],
    pacman: ['pacman', '-S', '--needed', '--noconfirm', 'ffmpeg'],
    zypper: ['zypper', '--non-interactive', 'install', 'ffmpeg'],
    apk: ['apk', 'add', 'ffmpeg'],
    brew: ['brew', 'install', 'ffmpeg'],
  },
  tesseract: {
    winget: null, // Windows has OCR built in
    choco: null,
    apt: ['apt-get', 'install', '-y', 'tesseract-ocr'],
    dnf: ['dnf', 'install', '-y', 'tesseract'],
    pacman: ['pacman', '-S', '--needed', '--noconfirm', 'tesseract', 'tesseract-data-eng'],
    zypper: ['zypper', '--non-interactive', 'install', 'tesseract-ocr'],
    apk: ['apk', 'add', 'tesseract-ocr'],
    brew: ['brew', 'install', 'tesseract'],
  },
  'qbittorrent-nox': {
    winget: ['winget', 'install', '--id', 'qBittorrent.qBittorrent', '-e', '--accept-source-agreements'],
    choco: ['choco', 'install', 'qbittorrent', '-y'],
    apt: ['apt-get', 'install', '-y', 'qbittorrent-nox'],
    dnf: ['dnf', 'install', '-y', 'qbittorrent-nox'],
    pacman: ['pacman', '-S', '--needed', '--noconfirm', 'qbittorrent-nox'],
    zypper: ['zypper', '--non-interactive', 'install', 'qbittorrent-nox'],
    apk: ['apk', 'add', 'qbittorrent-nox'],
    brew: ['brew', 'install', '--cask', 'qbittorrent'],
  },
};

export const NOTES = {
  ffmpeg: { dnf: 'For H.264/HEVC encoding on Fedora, enable RPM Fusion and run: sudo dnf swap ffmpeg-free ffmpeg --allowerasing' },
  pyatv: 'Apple TV: install pyatv with pipx (recommended) or pip: pipx install pyatv',
};

// Linux system package managers need root; winget, choco (from an elevated shell) and brew don't use sudo.
const NEEDS_ROOT = new Set(['apt', 'dnf', 'pacman', 'zypper', 'apk']);

export function installCommand(pkg, manager, { isRoot = typeof process.getuid === 'function' && process.getuid() === 0 } = {}) {
  const cmd = PACKAGES[pkg]?.[manager];
  if (!cmd) return null;
  const sudo = NEEDS_ROOT.has(manager) && !isRoot;
  // apt needs a fresh index on minimal images; shown as its own command.
  const pre = manager === 'apt' ? [[...(sudo ? ['sudo'] : []), 'apt-get', 'update']] : [];
  return { commands: [...pre, [...(sudo ? ['sudo'] : []), ...cmd]], sudo, note: NOTES[pkg]?.[manager] || null };
}

export const KNOWN_PACKAGES = Object.keys(PACKAGES);
