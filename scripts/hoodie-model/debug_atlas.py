import json, colorsys
from PIL import Image, ImageDraw, ImageFont
L=json.load(open('layout.json')); A=L['atlas']
im=Image.new('RGB',(A,A),(255,255,255)); d=ImageDraw.Draw(im)
try: font=ImageFont.truetype('/System/Library/Fonts/Supplemental/Arial Bold.ttf',40); small=ImageFont.truetype('/System/Library/Fonts/Supplemental/Arial Bold.ttf',28)
except: font=small=ImageFont.load_default()
for i,p in enumerate(L['pieces']):
    x,y,w,h=p['rect']
    col=tuple(int(c*255) for c in colorsys.hsv_to_rgb(i/len(L['pieces']),0.55,0.9))
    d.rectangle([x,y,x+w,y+h],fill=col)
    # top band dark = garment "up" edge; left edge stripe black = viewer's left
    d.rectangle([x,y,x+w,y+max(8,h//12)],fill=(20,20,20))
    d.rectangle([x,y,x+max(6,w//14),y+h],fill=(0,0,0))
    d.text((x+w/2,y+h/2),p['key'],fill=(0,0,0),font=small if w<300 else font,anchor='mm')
    d.text((x+w/2,y+h/2+50),'UP ^  R>',fill=(0,0,0),font=small,anchor='mm')
im.save('debug_atlas.png')
