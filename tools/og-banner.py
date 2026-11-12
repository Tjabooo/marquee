#!/usr/bin/env python3
"""Draws public/og-lilin.png, the 1200x630 card Discord and iMessage show for a Lilin link (/c/): the play-corner
mark from the app icon beside the "lilin" wordmark and the slogan "Your own cinema", on Lilin's velvet.

  python3 tools/og-banner.py [out.png]     # needs Chromium (or Chrome); uses the app's own font
  python3 tools/og-banner.py --tv          # writes tv/android/art/banner.html (same design at 1280x720)
"""
import base64
import importlib.util
import os
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_spec = importlib.util.spec_from_file_location("app_icon", os.path.join(ROOT, "tools", "app-icon.py"))
icon = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(icon)

TAGLINE = "YOUR OWN CINEMA"
SUBLINE = "Films and shows on your phone, your TV, anywhere."
FONT = "public/fonts/bricolage-grotesque-latin.woff2"


def page(w, h, *, scale, mark_x, mark_y, word_x, word_y, word_size, sub, font_url):
    sub_line = (f'<text x="{w / 2}" y="{h - 42}" font-family="B" font-weight="500" font-size="28" fill="#BA9DAD" '
                f'text-anchor="middle">{SUBLINE}</text>') if sub else ""
    return f'''<!doctype html><meta charset="utf-8"><style>
@font-face {{ font-family: B; font-weight: 200 800; font-stretch: 75% 100%; src: url({font_url}) format("woff2"); }}
html, body {{ margin: 0; width: {w}px; height: {h}px; overflow: hidden; background: #1F1019; }} svg {{ display: block; }}
</style><svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}">
<defs>{icon.GRADIENT}<radialGradient id="bg" cx="35%" cy="45%" r="80%"><stop offset="0" stop-color="#3A1C2E"/>
<stop offset=".6" stop-color="#1F1019"/><stop offset="1" stop-color="#140A10"/></radialGradient>
<filter id="soft" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="30"/></filter></defs>
<rect width="{w}" height="{h}" fill="url(#bg)"/>
<g transform="translate({mark_x} {mark_y}) scale({scale})">{icon.mark()}</g>
<text x="{word_x}" y="{word_y}" font-family="B" font-weight="800" font-size="{word_size}" fill="#F6EADF" letter-spacing="-5"
      style="font-stretch: 80%">lilin</text>
<text x="{word_x + 6}" y="{word_y + 66}" font-family="B" font-weight="700" font-size="26" fill="#F4C152" letter-spacing="4">{TAGLINE}</text>
{sub_line}
</svg>'''


def og_page(font_url):
    return page(1200, 630, scale=0.92, mark_x=142, mark_y=60, word_x=592, word_y=335, word_size=190, sub=True, font_url=font_url)


def tv_page(font_url):
    return page(1280, 720, scale=1.0, mark_x=138, mark_y=104, word_x=600, word_y=400, word_size=210, sub=False, font_url=font_url)


def shoot(html, w, h, out):
    browser = shutil.which("chromium") or shutil.which("google-chrome-stable") or shutil.which("google-chrome")
    if not browser:
        sys.exit("Needs Chromium or Chrome.")
    with tempfile.TemporaryDirectory() as tmp:
        src = os.path.join(tmp, "card.html")
        open(src, "w").write(html)
        subprocess.run([browser, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1",
                        "--virtual-time-budget=3000", f"--window-size={w},{h}", f"--screenshot={os.path.abspath(out)}",
                        f"file://{src}"], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


if __name__ == "__main__":
    if "--tv" in sys.argv:
        html = tv_page(f'"../../../{FONT}"').replace("<!doctype html>", "<!doctype html>\n<!-- The Android TV home-screen banner "
            "(320×180 dp), drawn at 4×: the play-corner mark, the lilin wordmark and \"Your own cinema\". Written by "
            "tools/og-banner.py --tv, rendered by render.sh. -->", 1)
        open(os.path.join(ROOT, "tv", "android", "art", "banner.html"), "w").write(html)
        print("tv/android/art/banner.html")
    else:
        font = "data:font/woff2;base64," + base64.b64encode(open(os.path.join(ROOT, FONT), "rb").read()).decode()
        out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "public", "og-lilin.png")
        shoot(og_page(font), 1200, 630, out)
        print(out)
