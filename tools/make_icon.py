# 앱 아이콘: 빨간 둥근 사각형 + 겹친 문서 두 장 + PDF 글자
from PIL import Image, ImageDraw, ImageFont
S = 1024
im = Image.new('RGBA', (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(im)
d.rounded_rectangle([40, 40, S - 40, S - 40], 190, fill=(217, 45, 32))
for off, col in ((0, (255, 205, 200)), (90, (255, 255, 255))):
    x0, y0 = 250 + off - 45, 170 + off - 45
    d.rounded_rectangle([x0, y0, x0 + 430, y0 + 540], 40, fill=col)
font = ImageFont.truetype('C:/Windows/Fonts/arialbd.ttf', 160)
t = 'PDF'
w = d.textlength(t, font=font)
d.text((295 + (430 - w) / 2, 520), t, font=font, fill=(217, 45, 32))
im.save('app/icon.png')
im.save('build/icon.ico', sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print('ok')
