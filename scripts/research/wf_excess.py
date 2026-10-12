import pickle, sys, math, itertools
from collections import defaultdict
rows = pickle.load(open(sys.argv[1], "rb"))
SPLIT="2026-04-01"
def corr(p):
    n=len(p); mx=sum(x for x,_ in p)/n; my=sum(y for _,y in p)/n
    sxy=sum((x-mx)*(y-my) for x,y in p); sxx=sum((x-mx)**2 for x,_ in p); syy=sum((y-my)**2 for _,y in p)
    return sxy/math.sqrt(sxx*syy) if sxx and syy else 0
base=defaultdict(list)
for r in rows: base[r["eid"]].append(r["r"]>0)
bw={e:sum(v)/len(v) for e,v in base.items()}
pre=[]
for r in rows:
    for N in (10,20):
        v=[x for x in r["vals"][:N] if x is not None]; n=len(v)
        if n<6: continue
        up=sum(x>0 for x in v); avg=sum(v)/n; sd=math.sqrt(sum((x-avg)**2 for x in v)/(n-1))
        t=avg/(sd/math.sqrt(n)) if sd>0 else 99
        nk=[(x,y) for x,y in zip(r["vals"][:N], r["nks"][:N]) if x is not None and y is not None]
        exw=sum(x-y>0 for x,y in nk)/len(nk) if nk else 0
        p=[(y,x) for x,y in zip(r["vals"][:N], r["dvs"][:N]) if x is not None and y is not None and y!=0]
        c=corr(p) if len(p)>=6 else 0
        linked = r["rule"] is not None and r["rule"]!=0 and abs(c)>=0.4 and (c>0)==(r["rule"]>0)
        pre.append((N,r,up/n,avg,t,exw,linked))
print("条件 | 前半 件数 勝率 上乗せ 平均 | 後半 件数 勝率 上乗せ 平均")
out=[]
for N,rate,tmin,ex,req in itertools.product((10,20),(0.6,0.7,0.8),(1.0,1.5,2.0),(0,0.6,0.75),(None,"rule","linked")):
    A=[[],[]]
    for (n_,r,ur,avg,t,exw,linked) in pre:
        if n_!=N or ur<rate or avg<0.5*r["vol"] or t<tmin or exw<ex: continue
        if req=="rule" and r["rule"] is None: continue
        if req=="linked" and not linked: continue
        A[r["d"]>=SPLIT].append(r)
    s=lambda L:(len(L), sum(r["r"]>0 for r in L)/len(L) if L else 0, sum((r["r"]>0)-bw[r["eid"]] for r in L)/len(L) if L else 0, sum(r["r"] for r in L)/len(L) if L else 0, len({r["eid"] for r in L}))
    out.append(((N,rate,tmin,ex,req),s(A[0]),s(A[1])))
ok=[o for o in out if o[1][0]>=50 and o[2][0]>=30]
print("両方で上乗せ>0:", sum(o[1][2]>0 and o[2][2]>0 for o in ok), "/", len(ok))
for o in sorted(ok, key=lambda o:-min(o[1][2],o[2][2]))[:10]:
    a,b=o[1],o[2]; print(o[0], f"| {a[0]}件{a[4]}イベ {a[1]:.1%} {a[2]:+.1%} {a[3]:+.2f}% | {b[0]}件{b[4]}イベ {b[1]:.1%} {b[2]:+.1%} {b[3]:+.2f}%")
