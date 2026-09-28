import json, numpy as np
from PIL import Image
from scipy import ndimage
meta={}
for line in open('tpl-list.tsv'):
    tid,url,tw,th,pw,ph,pt,pl,front=line.rstrip('\n').split('\t')
    meta[int(tid)]=dict(tw=int(tw),th=int(th),pw=int(pw),ph=int(ph),pt=int(pt),pl=int(pl))
names={19360:'front',19361:'back',19362:'sleeve_right',19363:'sleeve_left',19364:'pocket',19365:'hood',210233:'label_panel'}
PF=6000
out={}
for tid,name in names.items():
    m=meta[tid]
    im=Image.open(f'tpl-{tid}.png').convert('RGBA')
    if im.size!=(m['tw'],m['th']): im=im.resize((m['tw'],m['th']),Image.NEAREST)
    a=np.array(im)[...,3]
    mask=a<8
    lab,n=ndimage.label(mask)
    sizes=ndimage.sum(mask,lab,range(1,n+1))
    comps=[]
    for i,s in enumerate(sizes,1):
        if s<20000: continue
        ys,xs=np.where(lab==i)
        x0,x1,y0,y1=xs.min(),xs.max()+1,ys.min(),ys.max()+1
        # template px -> printfile fraction
        fx=lambda x:(x-m['pl'])/m['pw']; fy=lambda y:(y-m['pt'])/m['ph']
        comps.append(dict(area=int(s),tpl=[int(x0),int(y0),int(x1-x0),int(y1-y0)],
            frac=[round(fx(x0),4),round(fy(y0),4),round((x1-x0)/m['pw'],4),round((y1-y0)/m['ph'],4)]))
        np.save(f'mask-{name}-{len(comps)-1}.npy', mask[y0:y1,x0:x1])
    comps.sort(key=lambda c:(c['tpl'][1]//200,c['tpl'][0]))
    out[name]=comps
    print(name,tid,m)
    for c in comps: print('   ',c)
json.dump(out,open('tpl_pieces.json','w'),indent=1)
