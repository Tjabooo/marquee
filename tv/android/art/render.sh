#!/usr/bin/env bash
# Renders banner.html into the app's banner drawables (needs Chromium or Chrome, and Pillow).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
res="$here/../app/src/main/res"
browser="$(command -v chromium || command -v google-chrome-stable || command -v google-chrome)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
# The font goes in as a data: URL (a file:// page may not load fonts beside it).
python3 - "$here/banner.html" "$here/../../../public/fonts/bricolage-grotesque-latin.woff2" "$tmp/banner.html" <<'PY'
import sys, base64
html, font, out = sys.argv[1:]
data = "data:font/woff2;base64," + base64.b64encode(open(font, "rb").read()).decode()
open(out, "w").write(open(html).read().replace("../../../public/fonts/bricolage-grotesque-latin.woff2", data))
PY
"$browser" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 --virtual-time-budget=3000 \
  --window-size=1280,720 --screenshot="$tmp/banner.png" "file://$tmp/banner.html" >/dev/null 2>&1
python3 - "$tmp/banner.png" "$res" <<'PY'
import sys, os
from PIL import Image
src, res = sys.argv[1], sys.argv[2]
im = Image.open(src).convert("RGB")
for folder, size in (("drawable-xhdpi", (320, 180)), ("drawable-xxxhdpi", (640, 360))):
    os.makedirs(os.path.join(res, folder), exist_ok=True)
    im.resize(size, Image.LANCZOS).save(os.path.join(res, folder, "banner.png"), optimize=True)
PY
echo "Banner written to $res/drawable-{xhdpi,xxxhdpi}/banner.png"
