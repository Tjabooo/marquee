#!/usr/bin/env python3
"""Draws public/og-lilin.png (python3 tools/og-banner.py public/og-lilin.png; needs Pillow + Noto Sans): the 1200x630
card Discord and iMessage show for a Lilin link (/c/). The wordmark is lit like a candle (lilin is Malay for candle):
both i's carry a flame instead of a dot, on Lilin's velvet with the warm light the flames throw."""
import sys
from PIL import Image, ImageDraw, ImageFilter, ImageFont

W, H = 1200, 630
VELVET, PAPER, DUST, BULB = "#1F1019", "#F6EADF", "#BA9DAD", "#F4C152"
F = "/usr/share/fonts/noto/NotoSans-{}.ttf"
out = sys.argv[1] if len(sys.argv) > 1 else "og-lilin.png"


def flame(cx, cy, s, n=40):
    """Teardrop polygon (same shape as tools/app-icon.py): tip up, round belly down; s = half width."""
    def bez(p0, p1, p2, p3, t):
        u = 1 - t
        return tuple(u**3 * a + 3 * u * u * t * b + 3 * u * t * t * c + t**3 * d for a, b, c, d in zip(p0, p1, p2, p3))
    import math
    tip, right, left = (cx, cy - 2.9 * s), (cx + s, cy + 0.35 * s), (cx - s, cy + 0.35 * s)
    pts = [bez(tip, (cx + 0.12 * s, cy - 1.9 * s), (cx + s, cy - 0.85 * s), right, i / n) for i in range(n)]
    pts += [(cx + s * math.cos(a), cy + 0.35 * s + s * math.sin(a)) for a in (math.pi * i / n for i in range(n + 1))]
    pts += [bez(left, (cx - s, cy - 0.85 * s), (cx - 0.12 * s, cy - 1.9 * s), tip, i / n) for i in range(1, n + 1)]
    return pts


img = Image.new("RGB", (W, H), VELVET)
word, font = "Lılın", ImageFont.truetype(F.format("Black"), 196)
cx, cy = W // 2, 300
x0 = cx - font.getlength(word) / 2
# flame centres: above each dotless i, where the dot would sit
asc = font.getbbox("ı", anchor="ls")[1]
base = cy + 70
flames = []
for i, ch in enumerate(word):
    if ch == "ı":
        left = x0 + font.getlength(word[:i])
        gx0, _, gx1, _ = font.getbbox(ch, anchor="ls")
        flames.append((left + (gx0 + gx1) / 2, base + asc - 52))

# room light from the flames
glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
g = ImageDraw.Draw(glow)
for fx, fy in flames:
    g.ellipse((fx - 330, fy - 260, fx + 330, fy + 300), fill=(244, 193, 82, 34))
glow = glow.filter(ImageFilter.GaussianBlur(110))
img.paste(glow, (0, 0), glow)

d = ImageDraw.Draw(img)
d.text((x0, base), word, font=font, fill=PAPER, anchor="ls")

halo = Image.new("RGBA", (W, H), (0, 0, 0, 0))
h = ImageDraw.Draw(halo)
for fx, fy in flames:
    h.polygon(flame(fx, fy, 30), fill=(255, 200, 97, 230))
halo = halo.filter(ImageFilter.GaussianBlur(9))
img.paste(halo, (0, 0), halo)
for fx, fy in flames:
    d.polygon(flame(fx, fy, 24), fill="#FFD978")
    d.polygon(flame(fx, fy + 11, 11), fill="#FFFBEF")

d.text((cx, 428), "FROM THE HOME SERVER", font=ImageFont.truetype(F.format("Bold"), 26), fill=BULB, anchor="mm")
d.text((cx, 545), "Films and shows on your phone, in the browser or on the TV",
       font=ImageFont.truetype(F.format("Medium"), 28), fill=DUST, anchor="mm")
img.save(out, optimize=True)
print(out)
