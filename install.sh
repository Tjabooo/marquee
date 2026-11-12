#!/bin/sh
# Lilin installer and updater for Linux and macOS. Read it before running it; it is short.
#
#   sh install.sh                      install or update to the latest release, then run setup
#   sh install.sh --version v1.1.0     a specific release
#   sh install.sh --dir /opt/lilin   somewhere other than ~/lilin
#   sh install.sh --dry-run            show what would happen
#   sh install.sh --uninstall          remove the autostart service and the application files
#                                      (your .env, database and media stay)
#
# What it does: downloads lilin-<version>.tar.gz and SHA256SUMS from the GitHub release, checks
# the archive against the checksum, and unpacks it. On an update it replaces only application
# files; .env, the database, state files and cache/ are never touched, and the previous version is
# kept in .backup-<version>/. It never uses sudo. "Latest" is resolved to a concrete version first.
set -eu

REPO="Tjabooo/lilin"
DIR="${LILIN_DIR:-$HOME/lilin}"
VERSION=""
DRY=0
SETUP=1
YES=""
UNINSTALL=0
PURGE=0
APP_ITEMS="server.js setup.js package.json src public agents scripts tools docs start-lilin.cmd .env.example README.md CHANGELOG.md Dockerfile docker-compose.yml docker install.sh install.ps1"

say() { printf '%s\n' "$*"; }
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }
run() { if [ "$DRY" = 1 ]; then say "  would run: $*"; else "$@"; fi; }

while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="${2:?--version needs a value}"; shift 2 ;;
    --dir) DIR="${2:?--dir needs a value}"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --no-setup) SETUP=0; shift ;;
    --yes|-y) YES="--yes"; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    --purge) PURGE=1; shift ;;
    -h|--help) sed -n '2,15p' "$0" 2>/dev/null || true; exit 0 ;;
    *) die "unknown option $1" ;;
  esac
done

need() { command -v "$1" >/dev/null 2>&1; }

# ---------- uninstall ----------
if [ "$UNINSTALL" = 1 ]; then
  [ -f "$DIR/server.js" ] || die "no Lilin installation in $DIR"
  say "Removing Lilin from $DIR"
  if need node && [ "$DRY" = 0 ]; then node "$DIR/setup.js" service uninstall || say "  (no service to remove, or removal needs sudo: node setup.js service uninstall)"; fi
  for item in $APP_ITEMS; do [ -e "$DIR/$item" ] && run rm -rf "${DIR:?}/$item"; done
  if [ "$PURGE" = 1 ]; then
    say "--purge deletes EVERYTHING in $DIR, including .env, the database, Notes and cache."
    printf 'Type the folder path to confirm: '
    read -r answer
    [ "$answer" = "$DIR" ] || die "not confirmed; data kept"
    run rm -rf "${DIR:?}"
    say "Deleted $DIR. Media folders elsewhere were not touched."
  else
    say "Application files removed. Kept: .env, the database, state files and cache/ in $DIR."
    say "To delete those too: sh install.sh --uninstall --purge"
  fi
  exit 0
fi

# ---------- prerequisites ----------
need curl || need wget || die "curl or wget is required"
need tar || die "tar is required"
fetch() { if need curl; then curl -fsSL --proto '=https' --tlsv1.2 "$1" -o "$2"; else wget -q --https-only "$1" -O "$2"; fi; }
fetch_text() { if need curl; then curl -fsSL --proto '=https' --tlsv1.2 "$1"; else wget -qO- --https-only "$1"; fi; }
sha256() { if need sha256sum; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

node_ok() {
  need node || return 1
  node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=16)?0:1)'
}
if ! node_ok; then
  say "Lilin needs Node.js 22.16 or later$(need node && printf ' (found %s)' "$(node --version)")."
  say "Install the current LTS, then run this again:"
  case "$(uname -s)" in
    Darwin) say "  brew install node" ;;
    *) if need apt-get; then say "  https://github.com/nodesource/distributions (Debian/Ubuntu ship an older Node.js)"
       elif need dnf; then say "  sudo dnf install nodejs   (Fedora 41+; check: node --version)"
       elif need pacman; then say "  sudo pacman -S nodejs"
       elif need apk; then say "  sudo apk add nodejs   (Alpine 3.21+)"
       else say "  https://nodejs.org/en/download"; fi ;;
  esac
  exit 1
fi

# ---------- version ----------
if [ -z "$VERSION" ]; then
  VERSION=$(fetch_text "https://api.github.com/repos/$REPO/releases/latest" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n1)
  [ -n "$VERSION" ] || die "couldn't find the latest release; pass --version vX.Y.Z"
fi
case "$VERSION" in v*) ;; *) VERSION="v$VERSION" ;; esac
say "Lilin $VERSION → $DIR"

if [ -d "$DIR/.git" ]; then
  say "$DIR is a git checkout. Update it with git instead:"
  say "  cd \"$DIR\" && git fetch --tags && git checkout $VERSION   (or: git pull --ff-only)"
  exit 1
fi
CURRENT=""
[ -f "$DIR/package.json" ] && CURRENT=$(node -p "require('$DIR/package.json').version" 2>/dev/null || true)
[ -n "$CURRENT" ] && say "Found Lilin $CURRENT: updating application files only"

# ---------- download and verify ----------
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT INT TERM
BASE="https://github.com/$REPO/releases/download/$VERSION"
ARCHIVE="lilin-$VERSION.tar.gz"
say "Downloading $ARCHIVE"
fetch "$BASE/$ARCHIVE" "$TMP/$ARCHIVE" || die "download failed: $BASE/$ARCHIVE"
fetch "$BASE/SHA256SUMS" "$TMP/SHA256SUMS" || die "download failed: $BASE/SHA256SUMS"
WANT=$(grep " $ARCHIVE\$" "$TMP/SHA256SUMS" | cut -d' ' -f1)
GOT=$(sha256 "$TMP/$ARCHIVE")
[ -n "$WANT" ] && [ "$WANT" = "$GOT" ] || die "checksum mismatch for $ARCHIVE (expected $WANT, got $GOT); not installing"
say "Checksum OK ($GOT)"
if need gh; then
  if gh attestation verify "$TMP/$ARCHIVE" --repo "$REPO" >/dev/null 2>&1; then say "Build provenance verified with gh"
  else say "Note: gh couldn't verify build provenance (not logged in, or offline); the checksum still matched"; fi
fi

# ---------- install ----------
STAGE="$DIR/.update-$VERSION"
run mkdir -p "$DIR"
[ -d "$STAGE" ] && run rm -rf "$STAGE"   # left by an interrupted run
run mkdir -p "$STAGE"
run tar -xzf "$TMP/$ARCHIVE" -C "$STAGE" --strip-components=1
if [ -n "$CURRENT" ]; then
  BACKUP="$DIR/.backup-$CURRENT"
  run rm -rf "$BACKUP"
  run mkdir -p "$BACKUP"
  for item in $APP_ITEMS; do [ -e "$DIR/$item" ] && run mv "$DIR/$item" "$BACKUP/$item"; done
fi
for item in $APP_ITEMS; do [ -e "$STAGE/$item" ] && run mv "$STAGE/$item" "$DIR/$item"; done
run rm -rf "$STAGE"
[ -n "$CURRENT" ] && say "Previous version kept in $BACKUP (delete it once the new one runs fine)"

# ---------- Android TV app (best effort) ----------
# Releases carry the Android TV app built without a server address (it asks on its first start);
# Lilin offers it at /android. An app of your own with the same or a newer version is left alone.
DIST="$DIR/tv/android/dist"
json_field() { sed -n "s/.*\"$1\": *\"\{0,1\}\([^\",}]*\).*/\1/p" "$2" | head -n1; }
if fetch "$BASE/Lilin.json" "$TMP/Lilin.json" 2>/dev/null; then
  NEW_CODE=$(json_field versionCode "$TMP/Lilin.json"); APK_SUM=$(json_field sha256 "$TMP/Lilin.json")
  HAVE_CODE=0
  if [ -f "$DIST/Lilin.apk" ] && [ -f "$DIST/Lilin.json" ]; then HAVE_CODE=$(json_field versionCode "$DIST/Lilin.json"); fi
  case "$NEW_CODE$HAVE_CODE" in *[!0-9]*|'') NEW_CODE=0 ;; esac
  if [ "${NEW_CODE:-0}" -gt "${HAVE_CODE:-0}" ] && [ -n "$APK_SUM" ]; then
    if fetch "$BASE/Lilin.apk" "$TMP/Lilin.apk" && [ "$(sha256 "$TMP/Lilin.apk")" = "$APK_SUM" ]; then
      run mkdir -p "$DIST"
      run cp "$TMP/Lilin.apk" "$DIST/Lilin.apk"
      run cp "$TMP/Lilin.json" "$DIST/Lilin.json"
      say "Added the Android TV app (Lilin offers it at /android on your home network)"
    else say "Note: skipped the Android TV app (download or checksum failed); Lilin works without it"; fi
  fi
fi

if [ "$DRY" = 1 ]; then say "Dry run: nothing was changed."; exit 0; fi
if [ "$SETUP" = 1 ]; then
  say ""
  # Piped into sh, stdin is this script: ask the questions on the terminal instead, if there is one.
  if [ -n "$YES" ]; then node "$DIR/setup.js" --yes
  elif [ -t 0 ]; then node "$DIR/setup.js"
  elif (: </dev/tty) 2>/dev/null; then node "$DIR/setup.js" </dev/tty
  else node "$DIR/setup.js" --yes; fi
fi
if [ -n "$CURRENT" ]; then say "Restart Lilin to use $VERSION: node \"$DIR/setup.js\" service restart"; fi
say "Done. Check the installation any time with: node \"$DIR/setup.js\" doctor"
