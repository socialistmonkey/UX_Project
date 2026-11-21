import numpy as np, os
from PIL import Image, ImageDraw
rng = np.random.default_rng(7)
W, H = 641, 403   # odd sizes on purpose: exercises BMP row padding and non-multiple-of-16 JPEG
y, x = np.mgrid[0:H, 0:W]
r = (x / W * 255).astype(np.uint8)
g = (y / H * 255).astype(np.uint8)
b = ((np.sin(x / 23.0) + np.sin(y / 17.0)) * 60 + 128).astype(np.uint8)
img = np.dstack([r, g, b]) + rng.integers(0, 12, (H, W, 3), dtype=np.uint8)
im = Image.fromarray(img.astype(np.uint8), 'RGB')
d = ImageDraw.Draw(im)
for i in range(14):
    cx, cy, rad = rng.integers(20, W - 20), rng.integers(20, H - 20), rng.integers(10, 60)
    d.ellipse([cx - rad, cy - rad, cx + rad, cy + rad], fill=tuple(int(v) for v in rng.integers(0, 255, 3)))
d.rectangle([40, 300, 600, 380], outline=(255, 255, 255), width=3)
d.text((60, 320), "IMAGE BENDER TEST 0123456789", fill=(255, 255, 255))
im.save('fixtures/rgb24.bmp')
im.convert('RGBA').save('fixtures/rgba32.bmp')
im.convert('P', palette=Image.ADAPTIVE, colors=64).save('fixtures/pal8.bmp')
im.save('fixtures/rgb.tif', compression=None)
im.convert('L').save('fixtures/gray.tif', compression=None)
im.convert('RGBA').save('fixtures/rgba.tif', compression=None)
im.save('fixtures/rgb.png')
im.convert('RGBA').save('fixtures/rgba.png')
im.convert('L').save('fixtures/gray.png')
im.convert('P', palette=Image.ADAPTIVE, colors=32).save('fixtures/pal.png')
im.save('fixtures/base.jpg', quality=80, subsampling=2)
im.save('fixtures/prog.jpg', quality=80, progressive=True)
im.save('fixtures/rgb.gif')
im.save('fixtures/big.png')
# multi-strip TIFF via ImageMagick if present
os.system("convert fixtures/rgb.png -compress none -define tiff:rows-per-strip=16 fixtures/strips.tif 2>/dev/null")
# 16-bit PNG
a16 = (img.astype(np.uint16) << 8) | img.astype(np.uint16)
os.system("convert fixtures/rgb.png -depth 16 fixtures/rgb16.png 2>/dev/null")
print(sorted(os.listdir('fixtures')))
# extra GIFs: animated, interlaced, transparent
frames = [im.convert('P', palette=Image.ADAPTIVE, colors=32), im.rotate(10).convert('P', palette=Image.ADAPTIVE, colors=32)]
frames[0].save('fixtures/anim.gif', save_all=True, append_images=frames[1:], duration=100, loop=0)
im.convert('P', palette=Image.ADAPTIVE, colors=16).save('fixtures/inter.gif', interlace=True)
t = im.convert('P', palette=Image.ADAPTIVE, colors=16); t.save('fixtures/trans.gif', transparency=3)
# ---- more formats ----
sm = im.resize((160, 104))
sm.save('fixtures/rgb.ppm')
sm.convert('L').save('fixtures/gray.pgm')
sm.save('fixtures/lossy.webp', quality=80)
sm.save('fixtures/lossless.webp', lossless=True)
ico = Image.new('RGBA', (64, 64)); ImageDraw.Draw(ico).ellipse([4, 4, 60, 60], fill=(255, 60, 0, 255))
ico.save('fixtures/icon_png.ico', sizes=[(16, 16), (32, 32), (64, 64)])
try:
    ico.save('fixtures/icon_dib.ico', sizes=[(16, 16), (32, 32), (64, 64)], bitmap_format='bmp')
except Exception as e:
    print('no bmp ico', e)
# PNG with some optional chunks
from PIL import PngImagePlugin
info = PngImagePlugin.PngInfo(); info.add_text('Title', 'chunk test'); info.add_text('Author', 'luka'); info.add_text('Comment', 'one more')
sm.save('fixtures/text.png', pnginfo=info, dpi=(144, 144))
