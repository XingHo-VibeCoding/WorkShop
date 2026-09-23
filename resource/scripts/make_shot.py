#!/usr/bin/env python3
# 把 Playwright 截取的「页面」拼上一层浏览器外壳（含地址栏），满足打卡"图里要有地址栏"要求。
# 用法：python make_shot.py <page.png> <out.png> <url> [label]
import sys
from PIL import Image, ImageDraw

PAGE = sys.argv[1]
OUT = sys.argv[2]
URL = sys.argv[3]
LABEL = sys.argv[4] if len(sys.argv) > 4 else ""

BAR_H = 64
DOT = (212, 64, 52)   # 红
DOT_Y = (236, 193, 66)  # 黄
DOT_G = (60, 178, 76)   # 绿

img = Image.open(PAGE).convert("RGB")
W, H = img.size

canvas = Image.new("RGB", (W, H + BAR_H), (32, 33, 36))
d = ImageDraw.Draw(canvas)

# 三圆点（左侧）
cx = 22
for i, col in enumerate([DOT, DOT_Y, DOT_G]):
    d.ellipse([cx + i * 22, 24, cx + i * 22 + 13, 37], fill=col)

# 地址栏胶囊
ax0, ay0, ax1, ay1 = (78, 14, W - 16, 50)
d.rounded_rectangle([ax0, ay0, ax1, ay1], radius=14, fill=(60, 61, 66))
try:
    from PIL import ImageFont
    f = ImageFont.truetype("C:/Windows/Fonts/arial.ttf", 16)
except Exception:
    f = ImageFont.load_default()
d.text((ax0 + 14, 22), URL, fill=(225, 227, 230), font=f)
if LABEL:
    d.text((W - 150, 22), LABEL, fill=(150, 152, 156), font=f)

canvas.paste(img, (0, BAR_H))
canvas.save(OUT)
print("saved", OUT, canvas.size)
