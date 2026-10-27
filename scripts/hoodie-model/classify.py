import json, numpy as np
isl=json.load(open('islands.json'))
rows=[]
for i,d in enumerate(isl):
    P=np.array([p for poly in d['polys'] for p in poly])
    x0,y0=P.min(0); x1,y1=P.max(0)
    S=np.array(d['samples']); w=S[:,8]
    c=(S[:,2:5]*w[:,None]).sum(0)/w.sum(); n=(S[:,5:8]*w[:,None]).sum(0)/w.sum()
    # linear fit pos = A @ [u, v, 1]
    X=np.c_[S[:,0],S[:,1],np.ones(len(S))]
    A,res,_,_=np.linalg.lstsq(X,S[:,2:5],rcond=None)
    du,dv=A[0],A[1]   # 3D change per image px right, per image px down
    d.update(bbox=[float(x0),float(y0),float(x1-x0),float(y1-y0)],c=c.tolist(),n=n.tolist(),du=du.tolist(),dv=dv.tolist())
    rows.append((i,d['obj'],d['faces'],[round(v) for v in d['bbox']],np.round(c,1),np.round(n,2),np.round(du/np.linalg.norm(du),2),np.round(dv/np.linalg.norm(dv),2)))
for r in rows: print(r)
json.dump(isl,open('islands.json','w'))
