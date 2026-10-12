#!/usr/bin/env python3
# 使い方: python3 scripts/walkforward_bias.py 2025-10-01（検証の開始日）
# ウォークフォワード検証: 各過去イベントについて、その時点より前の回だけで傾向判定 → 実際の反応日で勝ち負け
import json, sys, math, random
from collections import defaultdict
sys.path.insert(0, "scripts")
import build_bias as b
from pathlib import Path
D = Path("site/data")
idx = json.load(open(D/"h/index.json")); rx = json.load(open(D/"reactions.json"))
events = [e for e in json.load(open(D/"events.json")) if not e.get("code")]
hev = {e: i for i, e in enumerate(idx["ev"])}
n225 = json.load(open(D/"n225.json"))["codes"]
H = {x["c"]: json.load(open(D/f"h/{x['c']}.json")) for x in n225 if (D/f"h/{x['c']}.json").exists()}
ser = defaultdict(list)
for e in sorted(events, key=lambda e: e["d"]):
    if e["id"] in rx["events"] and e["id"] in hev: ser[b.series_of(e)].append(e)
START = sys.argv[1] if len(sys.argv) > 1 else "2025-10-01"
trades = []  # (event_id, date, code, win, profit%)
for k, lst in ser.items():
    for i, E in enumerate(lst):
        if E["d"] < START: continue
        hist = lst[max(0, i - 20):i][::-1]
        if len(hist) < 6: continue
        for c, h in H.items():
            if not h.get("vol"): continue
            vals = [h["ev"][hev[p["id"]]] for p in hist]
            j = b.judge(vals, h["vol"])
            if not j: continue
            r = h["ev"][hev[E["id"]]]
            if r is None: continue
            trades.append((E["id"], E["d"], c, r * j["s"] > 0, r * j["s"]))
# 自社決算
eh = defaultdict(list)
for key, r in rx["earnings"].items():
    c, d = key.split("@")
    if r.get("r") is not None: eh[c].append((d, r["r"]))
for c, lst in eh.items():
    if c not in H or not H[c].get("vol"): continue
    lst.sort()
    for i, (d, r) in enumerate(lst):
        if d < START: continue
        hist = [x[1] for x in lst[max(0, i - 20):i]][::-1]
        j = b.judge(hist, H[c]["vol"])
        if j: trades.append((f"earn@{c}@{d}", d, c, r * j["s"] > 0, r * j["s"]))
n = len(trades); w = sum(t[3] for t in trades)
print(f"期間 {START}〜  売買 {n} 回  勝ち {w} ({w/n:.1%})  平均 {sum(t[4] for t in trades)/n:+.2f}%")
by = defaultdict(list)
for t in trades: by[t[0]].append(t)
multi = {k: v for k, v in by.items() if len(v) >= 2}
allloss = [k for k, v in multi.items() if not any(x[3] for x in v)]
print(f"イベント単位（2銘柄以上）: {len(multi)} 回、全部負け {len(allloss)} 回 ({len(allloss)/max(1,len(multi)):.1%})")
for k in allloss: print("  全敗:", k, len(by[k]), "件", f"{sum(x[4] for x in by[k])/len(by[k]):+.2f}%")
# 35日ごとの窓
from datetime import date, timedelta
d0 = date.fromisoformat(START); res = []
while d0 < date(2026, 10, 1):
    d1 = d0 + timedelta(days=35)
    ts = [t for t in trades if d0.isoformat() <= t[1] < d1.isoformat()]
    if ts: res.append((d0, len(ts), sum(t[3] for t in ts), sum(t[4] for t in ts) / len(ts)))
    d0 = d1
print("35日ごと（一覧1回分に相当）:")
for d0, k, ww, a in res: print(f"  {d0}〜 {k:4d}件 勝ち {ww/k:.0%} 平均 {a:+.2f}%")
# 1件あたりの勝率の分布（銘柄×イベントの相関を見るため、日ごとの勝率）
byd = defaultdict(list)
for t in trades: byd[t[1]].append(t[3])
bad = sorted(((sum(v)/len(v), d, len(v)) for d, v in byd.items() if len(v) >= 5))[:8]
print("勝率が低かった日（5件以上）:", [(d, n_, f"{r:.0%}") for r, d, n_ in bad])
ea=[t for t in trades if t[0].startswith("earn@")]; ev=[t for t in trades if not t[0].startswith("earn@")]
for nm, ts in (("自社決算", ea), ("指標・海外決算", ev)):
    if ts: print(nm, len(ts), f"勝ち {sum(t[3] for t in ts)/len(ts):.1%}", f"平均 {sum(t[4] for t in ts)/len(ts):+.2f}%")
# 同じ日の売買どうしの連動: 日ごとの勝率のばらつき vs 独立なら
import statistics
rates=[sum(v)/len(v) for v in byd.values() if len(v)>=5]
print("日ごとの勝率（5件以上の日）: 0〜20%の日", sum(r<=0.2 for r in rates), "/", len(rates), " 80%以上の日", sum(r>=0.8 for r in rates))
# 1回の35日リスト全件のうち、全部負けになるか（ブートストラップ: 実際の日ごとの結果を再標本化）
