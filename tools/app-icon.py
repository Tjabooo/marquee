#!/usr/bin/env python3
"""Draws Lilin's icons (python3 tools/app-icon.py; needs rsvg-convert): the "play corner" mark, a rounded
letter L in a gold-to-coral gradient whose open corner holds a play button, on the app's velvet.

  public/icon-192.png / icon-512.png        manifest "any": rounded square, transparent corners
  public/maskable-192.png / maskable-512.png  manifest "maskable": full bleed, mark inside the 80 % safe circle
  public/apple-touch-icon.png               180x180 full bleed, opaque (iOS rounds it itself)
  public/badge-96.png                       white silhouette for Android's notification bar
  public/favicon.svg                        the same mark on a 64 grid for browser tabs
  tv/android/.../splash.png, ic_launcher.png  the Android TV app's splash and launcher icons

tools/og-banner.py draws the link-preview card and the Android TV banner with the same MARK.
With --svg, also writes app-icon.svg (the rounded icon) in the current folder for previews.
"""
import os
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VELVET, PAPER, GOLD = "#1F1019", "#F6EADF", "#F4C152"

# On the 512 grid (centre ~256,256): the L (stem + foot, round ends) and the play triangle in its corner.
L_PATH = "M185 120a35 35 0 0 1 35 35v167h115a35 35 0 0 1 0 70H185a35 35 0 0 1-35-35V155a35 35 0 0 1 35-35z"
PLAY_PATH = "M262 168l92 56a8 8 0 0 1 0 14l-92 56a8 8 0 0 1-12-7V175a8 8 0 0 1 12-7z"
GRADIENT = ('<linearGradient id="lg" x1="150" y1="120" x2="370" y2="392" gradientUnits="userSpaceOnUse">'
            '<stop offset="0" stop-color="#FFD978"/><stop offset="1" stop-color="#E8735A"/></linearGradient>')


def mark(glow=True):
    """The mark's SVG elements (needs GRADIENT and, with glow, a #soft blur filter in <defs>)."""
    halo = f'<path d="{L_PATH}" fill="{GOLD}" opacity=".45" filter="url(#soft)"/>' if glow else ""
    return f'{halo}<path d="{L_PATH}" fill="url(#lg)"/><path d="{PLAY_PATH}" fill="{PAPER}"/>'


def svg(rounded):
    clip = '<clipPath id="c"><rect width="512" height="512" rx="112"/></clipPath>' if rounded else ""
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
<defs>
  {clip}{GRADIENT}
  <radialGradient id="bg" cx="50%" cy="42%" r="75%">
    <stop offset="0" stop-color="#3A1C2E"/><stop offset=".6" stop-color="{VELVET}"/><stop offset="1" stop-color="#140A10"/>
  </radialGradient>
  <filter id="soft" filterUnits="userSpaceOnUse" x="0" y="0" width="512" height="512"><feGaussianBlur stdDeviation="30"/></filter>
</defs>
<g{' clip-path="url(#c)"' if rounded else ''}>
  <rect width="512" height="512" fill="url(#bg)"/>
  {mark()}
</g>
</svg>'''


def silhouette():
    """One-colour version (notification badge): the L in white with the play button cut out beside it."""
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="120 96 272 320" width="512" height="512">'
            f'<path d="{L_PATH}" fill="#fff"/><path d="{PLAY_PATH}" fill="#fff"/></svg>')


def favicon():
    return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs>' + GRADIENT + '</defs>'
            '<rect width="64" height="64" rx="14" fill="#1F1019"/>'
            f'<g transform="translate(-0.5 0) scale(.125)"><path d="{L_PATH}" fill="url(#lg)"/><path d="{PLAY_PATH}" fill="{PAPER}"/></g></svg>\n')


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
    open(os.path.join(pub, "favicon.svg"), "w").write(favicon())
    if "--svg" in sys.argv:
        open("app-icon.svg", "w").write(svg(True))


if __name__ == "__main__":
    main()
