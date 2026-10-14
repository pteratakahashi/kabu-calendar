import sys
import pickle, itertools, statistics as st
R=pickle.load(open(sys.argv[1] if len(sys.argv) > 1 else "buy_rows.pkl","rb"))
R.sort(key=lambda r:r["d"])
def s(rs,key="R"):
    v=[r[key] for r in rs if r[key] is not None]
    if not v: return (0,0,0)
    return (len(v), sum(x>0 for x in v)/len(v), sum(v)/len(v))
def show(lbl,rs,key="R"):
    n,w,a=s(rs,key); print(f"{lbl:28s} n={n:4d} 勝率={w:.1%} 平均={a:+.2f}%")
show("全体",R); show("全体(超過:日経比)",[dict(r,X=r["R"]-(r["nkR"] or 0)) for r in R],"X")
# 期間
cut1="2026-01-01"; cut2="2026-06-01"
for lbl,f in [("〜2025",lambda r:r["d"]<cut1),("2026前半",lambda r:cut1<=r["d"]<cut2),("2026後半",lambda r:r["d"]>=cut2)]:
    show(lbl,[r for r in R if f(r)])
print("--- 単一条件（全期間 / 前半=2026-01まで / 後半）")
conds={
 "rate>=0.85":lambda r:r["rate"]>=0.85,"rate>=0.9":lambda r:r["rate"]>=0.9,
 "n>=15":lambda r:r["n"]>=15,"n>=18":lambda r:r["n"]>=18,
 "t>=2.5":lambda r:r["t"]>=2.5,"t>=3":lambda r:r["t"]>=3,"t>=4":lambda r:r["t"]>=4,
 "last5==5":lambda r:r["last5"]==5,"last3==3":lambda r:r["last3"]==3,
 "xr>=0.7":lambda r:r["xr"]>=0.7,"xr>=0.8":lambda r:r["xr"]>=0.8,"xr<0.5":lambda r:r["xr"]<0.5,
 "avg>=1":lambda r:r["avg"]>=1,"avg>=1.5":lambda r:r["avg"]>=1.5,
 "minr>-1":lambda r:r["minr"]>-1,"earn":lambda r:r["k"]=="earn","ev":lambda r:r["k"]=="ev",
}
for k,f in conds.items():
    a=[r for r in R if f(r)]; p=[r for r in a if r["d"]<cut1]; q=[r for r in a if r["d"]>=cut1]
    n,w,av=s(a); n1,w1,a1=s(p); n2,w2,a2=s(q)
    print(f"{k:12s} 全 {n:4d} {w:.0%} {av:+.2f} | 前 {n1:4d} {w1:.0%} {a1:+.2f} | 後 {n2:4d} {w2:.0%} {a2:+.2f}")
print("--- 予定の種類別（全 / 前 / 後）")
from collections import defaultdict
by=defaultdict(list)
for r in R: by[r["ser"]].append(r)
for k,v in sorted(by.items(),key=lambda kv:-len(kv[1]))[:25]:
    p=[r for r in v if r["d"]<cut1]; q=[r for r in v if r["d"]>=cut1]
    n,w,av=s(v); n1,w1,a1=s(p); n2,w2,a2=s(q)
    print(f"{k:22s} 全 {n:4d} {w:.0%} {av:+.2f} | 前 {n1:3d} {w1:.0%} {a1:+.2f} | 後 {n2:3d} {w2:.0%} {a2:+.2f}")
print("=== AMD/NVDA 詳細")
import json
n225={x["c"]:x for x in json.load(open("site/data/n225.json"))["codes"]}
for ser in ["amd","nvda"]:
    v=[r for r in R if r["ser"]==ser]
    show(ser+" 1日",v); show(ser+" 日経比超過",[dict(r,X=r["R"]-(r["nkR"] or 0)) for r in v],"X")
    show(ser+" 窓(寄りで売る)",v,"g"); show(ser+" 1週間",v,"W")
    ev=defaultdict(list)
    for r in v: ev[r["d"]].append(r)
    for d,rs in sorted(ev.items()):
        n,w,a=s(rs); print(f"   {d} {n:3d}銘柄 勝率{w:.0%} 平均{a:+.2f}% 日経{rs[0]['nkR']}")
    cs=defaultdict(list)
    for r in v: cs[r["c"]].append(r)
    print("   銘柄:", ", ".join(f"{n225.get(c,{}).get('n',c)}({len(x)})" for c,x in sorted(cs.items(),key=lambda kv:-len(kv[1]))[:20]))
print("=== 前向き選択: 各時点で、それより前の結果が良かった種類だけ買う")
dates=sorted(set(r["d"] for r in R))
sel=[]
for r in R:
    prev=[x for x in R if x["ser"]==r["ser"] and x["d"]<r["d"]]
    if len(prev)>=20:
        n,w,a=s(prev)
        if w>=0.6 and a>0: sel.append(r)
show("前向き選択(過去勝率60%以上の種類)",sel); show("  2026〜",[r for r in sel if r["d"]>=cut1])
