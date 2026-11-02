#!/usr/bin/env python3
"""Draws public/og-marquee.png (python3 tools/og-banner.py public/og-marquee.png; needs Pillow + Noto Sans): the 1200x630 card Discord shows for a marquee link (/c/).
A lit cinema marquee in Marquee's own palette (velvet, curtain, bulb gold)."""
import sys
from PIL import Image, ImageDraw, ImageFilter, ImageFont

W, H = 1200, 630
VELVET, CURTAIN, LINE, PAPER, DUST, BULB = "#1F1019", "#2B1724", "#4B2C3F", "#F6EADF", "#BA9DAD", "#F4C152"
F = "/usr/share/fonts/noto/NotoSans-{}.ttf"
out = sys.argv[1] if len(sys.argv) > 1 else "og-marquee.png"

img = Image.new("RGB", (W, H), VELVET)
glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
g = ImageDraw.Draw(glow)
g.ellipse((200, 40, 1000, 600), fill=(244, 193, 82, 46))
img.paste(glow.filter(ImageFilter.GaussianBlur(120)), (0, 0), glow.filter(ImageFilter.GaussianBlur(120)))
d = ImageDraw.Draw(img)

# the sign board
x0, y0, x1, y1 = 150, 120, 1050, 470
d.rounded_rectangle((x0, y0, x1, y1), radius=28, fill=CURTAIN, outline=LINE, width=3)
# bulbs around the board, each with a soft halo
bulbs = Image.new("RGBA", (W, H), (0, 0, 0, 0))
b = ImageDraw.Draw(bulbs)
pts = []
step = 36
for x in range(x0 + 30, x1 - 20, step):
    pts += [(x, y0 + 22), (x, y1 - 22)]
for y in range(y0 + 22 + step, y1 - 22 - step // 2, step):
    pts += [(x0 + 30, y), (x1 - 30, y)]
for (x, y) in pts:
    b.ellipse((x - 14, y - 14, x + 14, y + 14), fill=(244, 193, 82, 70))
img.paste(bulbs.filter(ImageFilter.GaussianBlur(6)), (0, 0), bulbs.filter(ImageFilter.GaussianBlur(6)))
for (x, y) in pts:
    d.ellipse((x - 6, y - 6, x + 6, y + 6), fill=BULB)
    d.ellipse((x - 2, y - 4, x + 2, y), fill="#FFF4D6")

d.text((W // 2, 268), "Marquee", font=ImageFont.truetype(F.format("Black"), 132), fill=PAPER, anchor="mm")
d.text((W // 2, 372), "NOW SHOWING  ·  FROM THE HOME SERVER", font=ImageFont.truetype(F.format("Bold"), 26), fill=BULB, anchor="mm")
d.text((W // 2, 545), "Films and shows on your phone, in the browser or on the TV", font=ImageFont.truetype(F.format("Medium"), 28), fill=DUST, anchor="mm")
img.save(out, optimize=True)
print(out)
