# Builds the hoodie's atlas layout (2048-unit space) and each piece's source region on the
# 6000x6000 print file (fractions), from the measured model islands and Printful templates.
import json
isl=json.load(open('islands.json'))
tp=json.load(open('tpl_pieces.json'))
A=2048; s=0.42; PAD=12
def bb(i): return isl[i]['bbox']
# piece: island idx, orientation transform (stored -> upright/unmirrored as printed), template
pieces=[
 dict(key='front',       island=28, T='flipY', src='art',    tpl=('front',0),  anchor='bottom'),
 dict(key='back',        island=30, T='flipY', src='back',   tpl=('back',0),   anchor='bottom'),
 dict(key='sleeveRight', island=26, T='flipY', src='art',    tpl=('sleeve_right',0), anchor='bottom'),
 dict(key='sleeveLeft',  island=32, T='flipY', src='art',    tpl=('sleeve_left',0),  anchor='bottom'),
 dict(key='hoodRightOut',island=2,  T='flipY', src='art',    tpl=('hood',5),   anchor='center'),
 dict(key='hoodLeftOut', island=6,  T='flipY', src='art',    tpl=('hood',4),   anchor='center'),
 dict(key='hoodRightIn', island=3,  T='rot180',src='art',    tpl=('hood',0),   anchor='center'),
 dict(key='hoodLeftIn',  island=7,  T='rot180',src='art',    tpl=('hood',1),   anchor='center'),
 dict(key='pocket',      island=34, T='flipY', src='pocket', tpl=('pocket',0), anchor='center'),
 dict(key='bandFront',   island=0,  T='flipX', src='art',    tpl=('front',2),  anchor='top'),
 dict(key='bandBack',    island=36, T='flipX', src='back',   tpl=('back',2),   anchor='top'),
 dict(key='cuffRight',   island=14, T='flipX', src='art',    tpl=('sleeve_right',2), anchor='top'),
 dict(key='cuffLeft',    island=12, T='flipX', src='art',    tpl=('sleeve_left',2),  anchor='top'),
]
# global scale: print-file fraction per model px, from the front torso's height
front_t=tp['front'][0]['frac']; kf=front_t[3]/bb(28)[3]
# manual shelf layout (atlas units), rows as planned
def sz(i): x,y,w,h=bb(i); return round(w*s),round(h*s)
place={}
x=PAD; y=PAD
for k in ['front','back','sleeveRight']:
    i=[p for p in pieces if p['key']==k][0]['island']; w,h=sz(i); place[k]=[x,y,w,h]; x+=w+PAD
rowA=max(place[k][3] for k in place)
x=PAD; y=PAD+rowA+PAD
for k in ['sleeveLeft','hoodRightOut','hoodLeftOut','hoodRightIn','hoodLeftIn']:
    i=[p for p in pieces if p['key']==k][0]['island']; w,h=sz(i); place[k]=[x,y,w,h]; x+=w+PAD
rowBtop=y; rowB=max(place[k][3] for k in ['sleeveLeft','hoodRightOut','hoodLeftOut','hoodRightIn','hoodLeftIn'])
# cuffs under the two outer hoods
hx=place['hoodRightOut'][0]; hy=rowBtop+max(place['hoodRightOut'][3],place['hoodLeftOut'][3])+PAD
for k in ['cuffRight','cuffLeft']:
    i=[p for p in pieces if p['key']==k][0]['island']; w,h=sz(i); place[k]=[hx,hy,w,h]; hx+=w+PAD
x=PAD; y=rowBtop+rowB+PAD
for k in ['pocket','bandFront','bandBack']:
    i=[p for p in pieces if p['key']==k][0]['island']; w,h=sz(i); place[k]=[x,y,w,h]; x+=w+PAD
white=[A-PAD-96, A-PAD-96, 96, 96]
maxx=max(v[0]+v[2] for v in place.values()); maxy=max(v[1]+v[3] for v in place.values())
print('atlas extent',maxx,maxy,'kf',kf)
out=[]
for p in pieces:
    x0,y0,w,h=bb(p['island'])
    sw,sh=w*kf,h*kf
    tx,ty,tw,th=tp[p['tpl'][0]][p['tpl'][1]]['frac']
    cx=tx+tw/2
    if p['anchor']=='bottom': sy=ty+th-sh
    elif p['anchor']=='top': sy=ty
    else: sy=ty+th/2-sh/2
    sx=cx-sw/2
    out.append(dict(key=p['key'],island=p['island'],T=p['T'],src=p['src'],rect=place[p['key']],
                    region=[round(sx,5),round(sy,5),round(sw,5),round(sh,5)]))
    print(f"{p['key']:13s} rect {place[p['key']]}  src {p['src']:6s} region {out[-1]['region']}  tpl {[round(v,4) for v in (tx,ty,tw,th)]}")
json.dump(dict(atlas=A,scale=s,white=white,pieces=out),open('layout.json','w'),indent=1)
