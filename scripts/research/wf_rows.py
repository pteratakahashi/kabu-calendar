# 研究用: 買いのみ・関連性つきで、ウォークフォワードの勝率を最大化する条件を探す
import json, sys, math, re, pickle
from collections import defaultdict
from pathlib import Path
sys.path.insert(0, "scripts"); import build_bias as b
D = Path("site/data")
idx = json.load(open(D/"h/index.json")); rx = json.load(open(D/"reactions.json"))
events = [e for e in json.load(open(D/"events.json")) if not e.get("code")]
hev = {e: i for i, e in enumerate(idx["ev"])}; hday = {d: i for i, d in enumerate(idx["days"])}
n225 = json.load(open(D/"n225.json"))["codes"]; SEC = {x["c"]: x["sec"] for x in n225}
TH = {x["c"]: set(x.get("th") or []) for x in json.load(open(D/"stocks.json"))}
H = {x["c"]: json.load(open(D/f"h/{x['c']}.json")) for x in n225 if (D/f"h/{x['c']}.json").exists()}
SEMI = {"NVDA","AMD","AVGO","MU","INTC","ASML","TSM","005930.KS"}; TECH = {"MSFT","GOOGL","META","AMZN","AAPL"}
def evclass(k):
    if k.startswith("earn:"):
        t = k[5:]; return "semiearn" if t in SEMI else "techearn" if t in TECH else "nflx" if t == "NFLX" else "tsla" if t == "TSLA" else ""
    if re.match(r"^(tsmc-monthly|samsung-prelim)$", k): return "semiearn"
    if re.match(r"^(us-|fomc|beige-book|jackson-hole|warsh)", k): return "usmacro"
    if re.match(r"^(boj|jp-cpi|jp-tokyo-cpi|jp-cgpi)", k): return "jprate"
    if k.startswith("jp-"): return "jpmacro"
    if k.startswith("ecb"): return "ecb"
    if k.startswith("cn-"): return "china"
    return ""
def group(c):
    sec, th = SEC.get(c, ""), TH.get(c, set()); has = lambda *a: any(t in th for t in a)
    if has("semi","semiequip","semimat"): return "semi"
    if has("ai","datacenter","wire"): return "ai"
    if has("game"): return "game"
    if sec in ("銀行","保険","証券","その他金融") or has("bank","regbank"): return "bank"
    if sec == "不動産" or has("realestate"): return "realestate"
    if sec in ("自動車","ゴム") or has("auto"): return "auto"
    if sec in ("商社","鉄鋼","非鉄金属製品","石油","鉱業","海運") or has("trading","steel","ship","rareearth"): return "commodity"
    if sec in ("電気機器","精密機器","機械","化学","窯業","造船","その他製造"): return "export"
    if sec in ("食品","小売業","電力","ガス","空運","鉄道・バス","陸運","パルプ・紙","水産","繊維","建設"): return "domestic"
    if sec in ("医薬品","情報・通信","サービス"): return "defensive"
    return ""
RS = {"usmacro:export":1,"usmacro:auto":1,"usmacro:bank":1,"usmacro:realestate":-1,"usmacro:domestic":-1,"usmacro:semi":0,"usmacro:ai":0,
 "usmacro:commodity":0,"usmacro:defensive":0,"jprate:bank":-1,"jprate:realestate":1,"jprate:export":1,"jprate:auto":1,"jprate:domestic":-1,
 "jpmacro:export":0,"ecb:export":0,"ecb:auto":0,"china:commodity":0,"china:export":0,"china:auto":0,"semiearn:semi":1,"semiearn:ai":1,
 "techearn:semi":1,"techearn:ai":1,"techearn:export":1,"nflx:game":1,"tsla:auto":1}
for e_ in ("semiearn","techearn"):
    for g_ in ("bank","realestate","domestic","commodity","defensive"): RS.setdefault(f"{e_}:{g_}", -1)
def driver(eid, k):
    r = rx["events"].get(eid) or {}
    if k.startswith("earn:"): return (r.get("d1") or {}).get("tk")
    s = next((x for x in r.get("series", []) if x["sym"] == "JPY=X"), None)
    return None if s is None else s.get("m60", s.get("end"))
def evday(eid):
    r = rx["events"].get(eid) or {}
    return (r.get("d1") or {}).get("nk_day") or next((x["day"] for x in r.get("idx", []) if x["sym"] == "^N225"), None)
def nkr(eid):
    r = rx["events"].get(eid) or {}
    return (r.get("d1") or {}).get("nk", next((x["r"] for x in r.get("idx", []) if x["sym"] == "^N225"), None))
ser = defaultdict(list)
for e in sorted(events, key=lambda e: (e["d"], e.get("t",""))):
    if e["id"] in rx["events"] and e["id"] in hev: ser[b.series_of(e)].append(e)
def known_before_open(e):
    # 結果（1時間後のドル円）が反応日の寄り(9:00)より前に分かるか
    d, t = e["d"], e.get("t") or ""
    day = evday(e["id"])
    if not day or not t or not re.match(r"^\d\d:\d\d", t): return False
    hh, mm = int(t[:2]), int(t[3:5]); m = hh*60+mm+60
    if day > d: return True          # 夜間・休日の発表 → 翌立会日
    return m <= 9*60                  # 同日の寄り前
rows = []
for k, lst in ser.items():
    ec = evclass(k)
    for i, E in enumerate(lst):
        hist = lst[max(0, i-20):i][::-1]
        if len(hist) < 6: continue
        day = evday(E["id"]); di = hday.get(day)
        dvE = driver(E["id"], k); kb = known_before_open(E) and not k.startswith("earn:")
        for c, h in H.items():
            if not h.get("vol"): continue
            r = h["ev"][hev[E["id"]]]
            if r is None: continue
            g = h["g"][di] if (di is not None and h.get("g") and h["g"][di] is not None) else None
            vals = [h["ev"][hev[p["id"]]] for p in hist]
            dvs = [driver(p["id"], k) for p in hist]; nks = [nkr(p["id"]) for p in hist]
            rows.append(dict(eid=E["id"], d=E["d"], k=k, c=c, vol=h["vol"], r=r, g=g, vals=vals, dvs=dvs, nks=nks, dvE=dvE, kb=kb,
                             rule=RS.get(f"{ec}:{group(c)}"), nkE=nkr(E["id"])))
pickle.dump(rows, open(sys.argv[1], "wb"))
print(len(rows))
