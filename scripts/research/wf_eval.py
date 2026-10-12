import pickle, sys, math, itertools, random
from collections import defaultdict
rows = pickle.load(open(sys.argv[1], "rb"))
SPLIT = "2026-04-01"
def intra(r, g): return None if g is None else ((1+r/100)/(1+g/100)-1)*100
def corr(p):
    n=len(p); mx=sum(x for x,_ in p)/n; my=sum(y for _,y in p)/n
    sxy=sum((x-mx)*(y-my) for x,y in p); sxx=sum((x-mx)**2 for x,_ in p); syy=sum((y-my)**2 for _,y in p)
    return sxy/math.sqrt(sxx*syy) if sxx and syy else 0
def summ(ts):
    if not ts: return (0, None, None, 0)
    n=len(ts); w=sum(x>0 for _,x in ts)/n; a=sum(x for _,x in ts)/n
    return (n, w, a, len({e for e,_ in ts}))
def clus_ci(ts):
    by=defaultdict(list)
    for e,x in ts: by[e].append(x)
    ks=list(by); random.seed(0); rs=[]
    for _ in range(1000):
        s=[x for k in (random.choice(ks) for _ in ks) for x in by[k]]; rs.append(sum(v>0 for v in s)/len(s))
    rs.sort(); return rs[25], rs[975]
def fmt(name, tr, te):
    a=summ(tr); b=summ(te)
    ci=clus_ci(te) if b[0] >= 10 else (None, None)
    f=lambda s: f"{s[0]:5d}件/{s[3]:3d}イベ 勝率 {s[1]:.1%} 平均 {s[2]:+.2f}%" if s[0] else "    0件"
    print(f"{name:42s} 前半 {f(a)} | 後半 {f(b)}" + (f" [95% {ci[0]:.0%}-{ci[1]:.0%}]" if ci[0] is not None else ""))
# ---- ベースライン
P = lambda r: r["d"] < SPLIT
fmt("基準: 全部買い(前日引け→引け)", [(r["eid"], r["r"]) for r in rows if P(r)], [(r["eid"], r["r"]) for r in rows if not P(r)])
kbr=[r for r in rows if r["kb"] and r["g"] is not None]
fmt("基準: 結果判明後 全部 寄り→引け", [(r["eid"], intra(r["r"],r["g"])) for r in kbr if P(r)], [(r["eid"], intra(r["r"],r["g"])) for r in kbr if not P(r)])
# ---- A: 無条件の偏り（買いのみ）
def featA(r, N):
    v=[x for x in r["vals"][:N] if x is not None]; n=len(v)
    if n<6: return None
    up=sum(x>0 for x in v); avg=sum(v)/n; sd=math.sqrt(sum((x-avg)**2 for x in v)/(n-1)) if n>1 else 0
    t=avg/(sd/math.sqrt(n)) if sd>0 else 99
    nk=[(x,y) for x,y in zip(r["vals"][:N], r["nks"][:N]) if x is not None and y is not None]
    exw=sum(x-y>0 for x,y in nk)/len(nk) if nk else 0
    return n, up/n, avg, t, exw
res=[]
for N, rate, tmin, ex, req in itertools.product((10,20),(0.6,0.7,0.8),(1.0,1.5,2.0),(0,0.6,0.75),(None,"rule")):
    tr=[];te=[]
    for r in rows:
        f=featA(r,N)
        if not f: continue
        n,ur,avg,t,exw=f
        if ur<rate or avg<0.5*r["vol"] or t<tmin or exw<ex: continue
        if req=="rule" and r["rule"] is None: continue
        (tr if P(r) else te).append((r["eid"], r["r"]))
    res.append(((N,rate,tmin,ex,req), tr, te))
res=[x for x in res if len(x[1])>=60]
res.sort(key=lambda x: -summ(x[1])[1])
print("--- A 無条件・買いのみ（前半の勝率上位5。後半は答え合わせ）")
for p,tr,te in res[:5]: fmt(f"A N={p[0]} 率≥{p[1]} t≥{p[2]} 日経超≥{p[3]} {p[4] or ''}", tr, te)
# ---- B: 結果に連動（結果判明後に寄りで買い→引けで売り）
res=[]
for N, cmin, dmin, req in itertools.product((10,20),(0.3,0.4,0.5,0.6),(0.0,0.2,0.4),(None,"rule","rule+sign")):
    tr=[];te=[]
    for r in kbr:
        if r["dvE"] is None or abs(r["dvE"])<dmin: continue
        p=[(y,x) for x,y in zip(r["vals"][:N], r["dvs"][:N]) if x is not None and y is not None and y!=0]
        if len(p)<6: continue
        c=corr(p)
        if abs(c)<cmin: continue
        if req and r["rule"] is None: continue
        if req=="rule+sign" and (not r["rule"] or (c>0)!=(r["rule"]>0)): continue
        pred = (1 if c>0 else -1) * (1 if r["dvE"]>0 else -1)
        if pred<0: continue  # 買いのみ
        (tr if P(r) else te).append((r["eid"], intra(r["r"], r["g"])))
    res.append(((N,cmin,dmin,req),tr,te))
res=[x for x in res if len(x[1])>=60]
res.sort(key=lambda x: -summ(x[1])[1])
print("--- B 結果に連動・寄りで買い→引け（前半の勝率上位5）")
for p,tr,te in res[:5]: fmt(f"B N={p[0]} 相関≥{p[1]} ドル円≥{p[2]}% {p[3] or ''}", tr, te)
# B 同じだが前日引け→引け（参考: 結果が出る前に買う場合は不可能なので参考値）
# B の全設定で、後半の勝率 − 同じイベントの全銘柄の寄り→引け勝率（地合いを除いた上乗せ）
base=defaultdict(list)
for r in kbr: base[r["eid"]].append(intra(r["r"],r["g"])>0)
bw={e:sum(v)/len(v) for e,v in base.items()}
print("--- B 全設定: 上乗せ（勝率 − 同じイベントの全銘柄の勝率）")
out=[]
for p,tr,te in res:
    def up(ts): return (sum((x>0)-bw[e] for e,x in ts)/len(ts)) if ts else None
    out.append((p, len(tr), up(tr), len(te), up(te)))
import statistics
print("前半で上乗せ>0 の設定の割合", sum(o[2]>0 for o in out)/len(out), " 後半で上乗せ>0 の割合", sum(o[4] is not None and o[4]>0 for o in out)/len(out))
print("後半 上乗せの中央値", statistics.median([o[4] for o in out if o[4] is not None]))
for o in sorted(out, key=lambda o:-o[2])[:8]: print(o[0], o[1], f"{o[2]:+.1%}", o[3], f"{o[4]:+.1%}" if o[4] is not None else "-")
# 全期間通しで、条件を固定（N=20 相関≥0.4 ドル円≥0.2% rule+sign）の成績
