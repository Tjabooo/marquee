#!/usr/bin/env python3
"""Draws Lilin's icons (python3 tools/app-icon.py; needs rsvg-convert). Lilin is Malay for candle:
a lit gold letter L whose stem carries a small flame, on the app's velvet.

  public/icon-192.png / icon-512.png        manifest "any": rounded square, transparent corners
  public/maskable-192.png / maskable-512.png  manifest "maskable": full bleed, mark inside the 80 % safe circle
  public/apple-touch-icon.png               180x180 full bleed, opaque (iOS rounds it itself)
  public/badge-96.png                       white silhouette for Android's notification bar
  public/favicon.svg                        simplified 64-grid mark for browser tabs
  tv/android/.../splash.png, ic_launcher.png  the Android TV app's splash and launcher icons

With --svg, also writes app-icon.svg (the rounded icon) next to this script's output for previews.
"""
import os
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VELVET, BULB = "#1F1019", "#F4C152"

# L centreline on the 512 grid, stroke W wide. The flame sits above the stem's top.
W = 78
SX, YT, YB, XR = 196, 206, 372, 336
PATH = f"M{SX},{YT} L{SX},{YB} L{XR},{YB}"
FX, FY = SX, 128  # flame centre


def flame(cx, cy, s):
    """Teardrop flame centred on (cx, cy); s = half width. Pointed tip up, round belly down."""
    return (f"M{cx:.1f},{cy - 2.9 * s:.1f} "
            f"C{cx + 0.12 * s:.1f},{cy - 1.9 * s:.1f} {cx + s:.1f},{cy - 0.85 * s:.1f} {cx + s:.1f},{cy + 0.35 * s:.1f} "
            f"A{s:.1f},{s:.1f} 0 0 1 {cx - s:.1f},{cy + 0.35 * s:.1f} "
            f"C{cx - s:.1f},{cy - 0.55 * s:.1f} {cx - 0.12 * s:.1f},{cy - 1.9 * s:.1f} {cx:.1f},{cy - 2.9 * s:.1f} Z")


def svg(rounded):
    clip = '<clipPath id="c"><rect width="512" height="512" rx="112"/></clipPath>' if rounded else ""
    stroke = f'fill="none" stroke-width="{W}" stroke-linejoin="round" stroke-linecap="round"'
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
<defs>
  {clip}
  <radialGradient id="bg" cx="42%" cy="34%" r="75%">
    <stop offset="0" stop-color="#3E1E31"/><stop offset=".55" stop-color="{VELVET}"/><stop offset="1" stop-color="#140A10"/>
  </radialGradient>
  <radialGradient id="warm" cx="50%" cy="50%" r="50%">
    <stop offset="0" stop-color="{BULB}" stop-opacity=".42"/><stop offset="1" stop-color="{BULB}" stop-opacity="0"/>
  </radialGradient>
  <linearGradient id="face" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#FFD978"/><stop offset=".55" stop-color="{BULB}"/><stop offset="1" stop-color="#DE9C36"/>
  </linearGradient>
  <linearGradient id="fire" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#FFB347"/><stop offset=".6" stop-color="#FFD978"/><stop offset="1" stop-color="#FFF4D6"/>
  </linearGradient>
  <filter id="blur22" filterUnits="userSpaceOnUse" x="0" y="0" width="512" height="512"><feGaussianBlur stdDeviation="22"/></filter>
  <filter id="blur8" filterUnits="userSpaceOnUse" x="0" y="0" width="512" height="512"><feGaussianBlur stdDeviation="8"/></filter>
</defs>
<g{' clip-path="url(#c)"' if rounded else ''}>
  <rect width="512" height="512" fill="url(#bg)"/>
  <!-- the light the flame throws into the room -->
  <circle cx="{FX}" cy="{FY + 10}" r="230" fill="url(#warm)"/>
  <path d="{PATH}" {stroke} stroke="{BULB}" opacity=".35" filter="url(#blur22)"/>
  <!-- letter depth, face, lit rim -->
  <path d="{PATH}" {stroke} stroke="#7A4614" transform="translate(0 12)"/>
  <path d="{PATH}" {stroke} stroke="url(#face)"/>
  <path d="{PATH}" fill="none" stroke-width="{W - 10}" stroke-linejoin="round" stroke-linecap="round"
        stroke="#FFE7A8" opacity=".3" transform="translate(0 -3)"/>
  <path d="{PATH}" fill="none" stroke-width="{W - 16}" stroke-linejoin="round" stroke-linecap="round" stroke="url(#face)"/>
  <!-- wick, then the flame: halo, body, hot core -->
  <path d="M{SX},{YT - W / 2 + 4} L{SX},{FY + 34}" stroke="#5A3210" stroke-width="6" stroke-linecap="round"/>
  <path d="{flame(FX, FY, 34)}" fill="#FFC861" opacity=".85" filter="url(#blur8)"/>
  <path d="{flame(FX, FY, 28)}" fill="url(#fire)"/>
  <path d="{flame(FX, FY + 14, 13)}" fill="#FFFBEF"/>
</g>
</svg>'''


def silhouette():
    """One-colour version (notification badge): the same L and flame in white on transparent."""
    stroke = f'fill="none" stroke-width="{W}" stroke-linejoin="round" stroke-linecap="round"'
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="36 40 440 440" width="512" height="512">
<path d="{PATH}" {stroke} stroke="#fff"/><path d="{flame(FX, FY - 4, 30)}" fill="#fff"/></svg>'''


FAVICON = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#1F1019"/>'
           '<path d="M24 28V48H44" fill="none" stroke="#F4C152" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>'
           '<path d="M24 7C26 11 29 13 29 17.5A5 5 0 0 1 19 17.5C19 13 22 11 24 7Z" fill="#FFD978"/></svg>\n')


def render(src, out, size, opaque=False):
    os.makedirs(os.path.dirname(out), exist_ok=True)
    cmd = ["rsvg-convert", "-w", str(size), "-h", str(size), "-o", out, src]
    if opaque:
        cmd[1:1] = ["-b", VELVET]
    subprocess.run(cmd, check=True)


def main():
    pub = os.path.join(ROOT, "public")
    res = os.path.join(ROOT, "tv", "android", "app", "src", "main", "res")
    with tempfile.TemporaryDirectory() as tmp:
        rounded, full, mono = (os.path.join(tmp, n) for n in ("r.svg", "f.svg", "m.svg"))
        open(rounded, "w").write(svg(True))
        open(full, "w").write(svg(False))
        open(mono, "w").write(silhouette())
        for size in (192, 512):
            render(rounded, os.path.join(pub, f"icon-{size}.png"), size)
            render(full, os.path.join(pub, f"maskable-{size}.png"), size, opaque=True)
        render(full, os.path.join(pub, "apple-touch-icon.png"), 180, opaque=True)
        render(mono, os.path.join(pub, "badge-96.png"), 96)
        render(full, os.path.join(res, "drawable-xhdpi", "splash.png"), 480, opaque=True)
        render(rounded, os.path.join(res, "mipmap-xhdpi", "ic_launcher.png"), 96)
        render(rounded, os.path.join(res, "mipmap-xxxhdpi", "ic_launcher.png"), 192)
    open(os.path.join(pub, "favicon.svg"), "w").write(FAVICON)
    if "--svg" in sys.argv:
        open("app-icon.svg", "w").write(svg(True))


if __name__ == "__main__":
    main()
