#!/usr/bin/env python3
"""Draws Marquee's home-screen icons (python3 tools/app-icon.py public; needs rsvg-convert):
a lit marquee-sign letter M (gold face, bulbs along its strokes) on Marquee velvet.

  icon-192.png / icon-512.png       manifest "any": rounded square, transparent corners
  maskable-192.png / maskable-512.png  manifest "maskable": full bleed, M inside the 80 % safe circle
  apple-touch-icon.png              180x180 full bleed, opaque (iOS rounds it itself)
"""
import math
import os
import subprocess
import sys
import tempfile

VELVET, CURTAIN, BULB, PAPER = "#1F1019", "#2B1724", "#F4C152", "#F6EADF"

# M centreline (512 grid). Stroke W wide with round joins; fits the maskable safe circle (r 205).
W = 80
XL, XR, YT, YB, YM = 150, 362, 182, 372, 300
LINE = [(XL, YB), (XL, YT), (256, YM), (XR, YT), (XR, YB)]
PATH = "M" + " L".join(f"{x},{y}" for x, y in LINE)


def bulbs():
    """Bulbs along the centreline: one on every corner, even spacing per segment."""
    pts, ends = [], [(XL, YB - 24), (XL, YT), (256, YM), (XR, YT), (XR, YB - 24)]
    for (x0, y0), (x1, y1) in zip(ends, ends[1:]):
        n = max(2, round(math.hypot(x1 - x0, y1 - y0) / 54))
        pts += [(x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n) for i in range(n)]
    return pts + [ends[-1]]


def svg(rounded):
    clip = '<clipPath id="c"><rect width="512" height="512" rx="112"/></clipPath>' if rounded else ""
    bulb_glow = "".join(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="17"/>' for x, y in bulbs())
    sockets = "".join(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="14"/>' for x, y in bulbs())
    lamps = "".join(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="10.5"/>' for x, y in bulbs())
    shine = "".join(f'<circle cx="{x - 3:.1f}" cy="{y - 3.4:.1f}" r="3.6"/>' for x, y in bulbs())
    stroke = f'fill="none" stroke-width="{W}" stroke-linejoin="round" stroke-linecap="round"'
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
<defs>
  {clip}
  <radialGradient id="bg" cx="50%" cy="46%" r="70%">
    <stop offset="0" stop-color="#3A1C2E"/><stop offset=".55" stop-color="{VELVET}"/><stop offset="1" stop-color="#150A11"/>
  </radialGradient>
  <radialGradient id="warm" cx="50%" cy="52%" r="50%">
    <stop offset="0" stop-color="{BULB}" stop-opacity=".30"/><stop offset="1" stop-color="{BULB}" stop-opacity="0"/>
  </radialGradient>
  <linearGradient id="face" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#FFD36E"/><stop offset=".6" stop-color="{BULB}"/><stop offset="1" stop-color="#E3A43C"/>
  </linearGradient>
  <filter id="blur18" filterUnits="userSpaceOnUse" x="0" y="0" width="512" height="512"><feGaussianBlur stdDeviation="18"/></filter>
  <filter id="blur5" filterUnits="userSpaceOnUse" x="0" y="0" width="512" height="512"><feGaussianBlur stdDeviation="5"/></filter>
</defs>
<g{' clip-path="url(#c)"' if rounded else ''}>
  <rect width="512" height="512" fill="url(#bg)"/>
  <circle cx="256" cy="270" r="250" fill="url(#warm)"/>
  <!-- glow the sign throws on the velvet -->
  <path d="{PATH}" {stroke} stroke="{BULB}" opacity=".45" filter="url(#blur18)"/>
  <!-- letter depth (the sign's side), then the face and a thin lit rim -->
  <path d="{PATH}" {stroke} stroke="#7A4614" transform="translate(0 12)"/>
  <path d="{PATH}" {stroke} stroke="url(#face)"/>
  <path d="{PATH}" fill="none" stroke-width="{W - 8}" stroke-linejoin="round" stroke-linecap="round"
        stroke="#FFE7A8" opacity=".35" transform="translate(0 -3)" style="mix-blend-mode:screen"/>
  <path d="{PATH}" fill="none" stroke-width="{W - 14}" stroke-linejoin="round" stroke-linecap="round" stroke="url(#face)"/>
  <!-- bulbs: halo, dark socket, lamp, highlight -->
  <g fill="#FFF1C9" opacity=".9" filter="url(#blur5)">{bulb_glow}</g>
  <g fill="#8C5418">{sockets}</g>
  <g fill="#FFF6DD">{lamps}</g>
  <g fill="#FFFFFF" opacity=".9">{shine}</g>
</g>
</svg>'''


def render(src, out, size, opaque=False):
    cmd = ["rsvg-convert", "-w", str(size), "-h", str(size), "-o", out, src]
    if opaque:
        cmd[1:1] = ["-b", VELVET]
    subprocess.run(cmd, check=True)


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "."
    with tempfile.TemporaryDirectory() as tmp:
        rounded, full = os.path.join(tmp, "r.svg"), os.path.join(tmp, "f.svg")
        open(rounded, "w").write(svg(True))
        open(full, "w").write(svg(False))
        for size in (192, 512):
            render(rounded, os.path.join(out, f"icon-{size}.png"), size)
            render(full, os.path.join(out, f"maskable-{size}.png"), size, opaque=True)
        render(full, os.path.join(out, "apple-touch-icon.png"), 180, opaque=True)
    if "--svg" in sys.argv:
        open(os.path.join(out, "app-icon.svg"), "w").write(svg(True))


if __name__ == "__main__":
    main()
