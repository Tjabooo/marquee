#!/usr/bin/env bash
# Builds Lilin's Samsung TV app and (with --install) puts it on the TV. See docs/samsung-tv.md.
#
#   LILIN_URL=http://192.168.1.10:8080 tv/tizen/build.sh            # just the .wgt in tv/tizen/dist
#   LILIN_URL=... TV=192.168.1.30 tv/tizen/build.sh --install       # build, install and start it
#
# Settings (environment, or tv/tizen/.env):
#   LILIN_URL    where the TV reaches Lilin (required), e.g. http://192.168.1.10:8080
#   TV             the TV's address, for --install (port 26101 is added when missing)
#   TIZEN_PROFILE  the signing profile made with `tizen security-profiles add` (default: lilin)
#   TIZEN_STUDIO   where Tizen Studio is installed (default: ~/tizen-studio, then ~/.local/share/tizen-studio)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
[ -f "$here/.env" ] && set -a && . "$here/.env" && set +a

install=0
for arg in "$@"; do
  case "$arg" in
    --install) install=1 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

: "${LILIN_URL:?Set LILIN_URL to where the TV reaches Lilin, e.g. http://192.168.1.10:8080}"
server="${LILIN_URL%/}"
case "$server" in http://*|https://*) ;; *) echo "LILIN_URL must start with http:// or https://" >&2; exit 2 ;; esac
profile="${TIZEN_PROFILE:-lilin}"
studio="${TIZEN_STUDIO:-}"
if [ -z "$studio" ]; then
  for d in "$HOME/tizen-studio" "$HOME/.local/share/tizen-studio"; do [ -x "$d/tools/ide/bin/tizen" ] && studio="$d" && break; done
fi
[ -n "$studio" ] && [ -x "$studio/tools/ide/bin/tizen" ] || { echo "Tizen Studio (CLI) not found. Install it, or set TIZEN_STUDIO." >&2; exit 1; }
tizen="$studio/tools/ide/bin/tizen"
sdb="$studio/tools/sdb"

version="$(sed -n 's/.*"version": *"\([0-9.]*\)".*/\1/p' "$here/../../package.json" | head -1)"
build="$(mktemp -d)"
trap 'rm -rf "$build"' EXIT
sed -e "s#@VERSION@#${version:-1.0.0}#" "$here/config.xml.in" > "$build/config.xml"
cp "$here/index.html" "$here/shell.js" "$build/"
cp "$here/../../public/maskable-512.png" "$build/icon.png" # full-bleed: Samsung shows app tiles square
printf 'window.LILIN_SERVER = %s;\n' "\"${server//\"/}\"" > "$build/config.js"

"$tizen" package -t wgt -s "$profile" -- "$build" >/dev/null
mkdir -p "$here/dist"
mv "$build"/*.wgt "$here/dist/Lilin.wgt"
echo "Built $here/dist/Lilin.wgt for $server"

if [ "$install" = 1 ]; then
  : "${TV:?Set TV to the address of the TV to install}"
  target="$TV"; case "$target" in *:*) ;; *) target="$target:26101" ;; esac
  "$sdb" connect "$target" >/dev/null
  "$tizen" install -n "$here/dist/Lilin.wgt" -s "$target" | grep -E 'Installed|error|fail' || true
  "$tizen" run -p LilTvApp01.Lilin -s "$target" | grep -E 'launched|error|fail' || true
fi
