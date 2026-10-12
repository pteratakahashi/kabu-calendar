#!/usr/bin/env python3
"""「傾向」画面用: 今後の予定ごとに、理屈で関係する業種と、その理屈が過去に実際どれだけ当たったかを
site/data/bias.json に書き出す（v2）。売買の提案はしない（2026-10-13 の検証で、銘柄ごとの過去の偏りには
地合い以上の予測力が無かったため。scripts/research/ 参照）。

業種の分け方・理屈の対応表は app.js の stockGroup / evClass / REASONS と同じ（表示用の文章はアプリ側）。
理屈の「向き」sign: 結果の指標（指標＝発表1時間後のドル円、海外決算＝その会社の株価の反応）とその業種が
同じ向き(1)・逆向き(-1)に動くはず。0 は向きが決まらない理屈（振れ幅だけ集計する）。

各業種の成績（その予定の種類の過去の全回 × その業種の日経225銘柄、反応日の終値騰落率）:
  hit/n  = 結果の向き × 理屈の向き どおりに動いた件数 / 件数（sign≠0 のみ）
  lo/hi  = 回（イベント）単位で再標本化した的中率の95%範囲。下限が50%を超えれば「裏付けあり」
  ab     = 平均の振れ幅（普段の1日の値動きの何倍か）、nkab = 同じ日の日経平均の振れ幅（%）

使い方: python3 scripts/build_bias.py
"""
from __future__ import annotations

import datetime as dt
import json
import random
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "site" / "data"
HORIZON = 35       # 今日から何日先までの予定を対象にするか
MIN_EVENTS = 6     # 過去にこれより少ない回しかない予定の種類は出さない
SERIES_ALIAS = {"us-ism-svc": "us-ism-services", "us-fomc": "fomc"}
NOT_EARN = {"tsmc-monthly", "samsung-prelim"}
SEMI_TK = {"NVDA", "AMD", "AVGO", "MU", "INTC", "ASML", "TSM", "005930.KS"}
TECH_TK = {"MSFT", "GOOGL", "META", "AMZN", "AAPL"}
# app.js の REASONS の向き（文章はアプリ側）
SIGN = {
    "usmacro:export": 1, "usmacro:auto": 1, "usmacro:bank": 1, "usmacro:realestate": -1, "usmacro:domestic": -1,
    "usmacro:semi": 0, "usmacro:ai": 0, "usmacro:commodity": 0, "usmacro:defensive": 0,
    "jprate:bank": -1, "jprate:realestate": 1, "jprate:export": 1, "jprate:auto": 1, "jprate:domestic": -1,
    "jpmacro:export": 0, "ecb:export": 0, "ecb:auto": 0, "china:commodity": 0, "china:export": 0, "china:auto": 0,
    "semiearn:semi": 1, "semiearn:ai": 1, "techearn:semi": 1, "techearn:ai": 1, "techearn:export": 1,
    "nflx:game": 1, "tsla:auto": 1,
}
for _e in ("semiearn", "techearn"):
    for _g in ("bank", "realestate", "domestic", "commodity", "defensive"):
        SIGN.setdefault(f"{_e}:{_g}", -1)


def load(p: Path, default):
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def series_of(ev: dict) -> str:
    slug = re.sub(r"^\d{4}-\d{2}-\d{2}-", "", ev["id"])
    if ev.get("ticker") and slug not in NOT_EARN:
        return f"earn:{ev['ticker']}"
    return SERIES_ALIAS.get(slug, slug)


def ev_class(k: str) -> str:
    if k.startswith("earn:"):
        t = k[5:]
        return "semiearn" if t in SEMI_TK else "techearn" if t in TECH_TK else "nflx" if t == "NFLX" else "tsla" if t == "TSLA" else ""
    if re.match(r"^(tsmc-monthly|samsung-prelim)$", k):
        return "semiearn"
    if re.match(r"^(us-|fomc|beige-book|jackson-hole|warsh)", k):
        return "usmacro"
    if re.match(r"^(boj|jp-cpi|jp-tokyo-cpi|jp-cgpi)", k):
        return "jprate"
    if k.startswith("jp-"):
        return "jpmacro"
    if k.startswith("ecb"):
        return "ecb"
    if k.startswith("cn-"):
        return "china"
    return ""


def stock_group(sec: str, th: set) -> str:
    has = lambda *a: any(t in th for t in a)  # noqa: E731
    if has("semi", "semiequip", "semimat"):
        return "semi"
    if has("ai", "datacenter", "wire"):
        return "ai"
    if has("game"):
        return "game"
    if sec in ("銀行", "保険", "証券", "その他金融") or has("bank", "regbank"):
        return "bank"
    if sec == "不動産" or has("realestate"):
        return "realestate"
    if sec in ("自動車", "ゴム") or has("auto"):
        return "auto"
    if sec in ("商社", "鉄鋼", "非鉄金属製品", "石油", "鉱業", "海運") or has("trading", "steel", "ship", "rareearth"):
        return "commodity"
    if sec in ("電気機器", "精密機器", "機械", "化学", "窯業", "造船", "その他製造"):
        return "export"
    if sec in ("食品", "小売業", "電力", "ガス", "空運", "鉄道・バス", "陸運", "パルプ・紙", "水産", "繊維", "建設"):
        return "domestic"
    if sec in ("医薬品", "情報・通信", "サービス"):
        return "defensive"
    return ""


def driver(rec: dict, series: str) -> float | None:
    """その回の「結果」を表す市場の動き。海外決算はその会社の株価の反応、指標は発表1時間後のドル円。"""
    if series.startswith("earn:"):
        return (rec.get("d1") or {}).get("tk")
    s = next((x for x in rec.get("series", []) if x["sym"] == "JPY=X"), None)
    return None if s is None else s.get("m60", s.get("end"))


def nk_r(rec: dict) -> float | None:
    return (rec.get("d1") or {}).get("nk", next((x["r"] for x in rec.get("idx", []) if x["sym"] == "^N225"), None))


def ci(by_event: list[list[int]]) -> tuple[float, float]:
    """回（イベント）単位で再標本化した的中率の95%範囲。同じ回の銘柄は一緒に動くため、件数ではなく回数で幅を出す"""
    rnd = random.Random(0)
    rs = []
    for _ in range(1000):
        s = [x for _ in by_event for x in rnd.choice(by_event)]
        rs.append(sum(s) / len(s))
    rs.sort()
    return rs[25], rs[975]


def main() -> int:
    today = dt.date.today().isoformat()
    end = (dt.date.today() + dt.timedelta(days=HORIZON)).isoformat()
    idx = load(DATA / "h" / "index.json", None)
    if not idx:
        print("bias: h/index.json がないのでスキップ", file=sys.stderr)
        return 0
    rx = load(DATA / "reactions.json", {"events": {}})
    events = [e for e in load(DATA / "events.json", []) if not e.get("code")]
    n225 = load(DATA / "n225.json", {}).get("codes", [])
    th = {x["c"]: set(x.get("th") or []) for x in load(DATA / "stocks.json", [])}
    hev = {eid: i for i, eid in enumerate(idx["ev"])}
    H = {}
    for x in n225:
        h = load(DATA / "h" / f"{x['c']}.json", None)
        if h and h.get("vol"):
            H[x["c"]] = (h, stock_group(x.get("sec", ""), th.get(x["c"], set())))

    by_series: dict[str, list[dict]] = {}
    for e in sorted(events, key=lambda e: e["d"]):
        if e["id"] in rx["events"] and e["id"] in hev:
            by_series.setdefault(series_of(e), []).append(e)

    out, seen = [], set()
    for e in sorted(events, key=lambda e: (e["d"], e.get("t", ""))):
        if not (today <= e["d"] <= end):
            continue
        k = series_of(e)
        ec = ev_class(k)
        if k in seen or not ec:
            continue
        hist = [x for x in by_series.get(k, []) if x["d"] < today]
        if len(hist) < MIN_EVENTS:
            continue
        seen.add(k)
        groups = []
        for g in sorted({g for _, g in H.values() if g}):
            sign = SIGN.get(f"{ec}:{g}")
            if sign is None:
                continue
            members = [(h, c) for c, (h, gg) in H.items() if gg == g]
            per_ev, ab, nkab, n_ev = [], [], [], 0
            for p in hist:
                rec = rx["events"][p["id"]]
                dv, nk = driver(rec, k), nk_r(rec)
                vals = [(h["ev"][hev[p["id"]]], h["vol"]) for h, _ in members]
                vals = [(r, v) for r, v in vals if r is not None]
                if not vals:
                    continue
                n_ev += 1
                ab += [abs(r) / v for r, v in vals]
                if nk is not None:
                    nkab.append(abs(nk))
                if sign and dv:
                    per_ev.append([int((r > 0) == (sign * dv > 0)) for r, _ in vals if r != 0])
            per_ev = [x for x in per_ev if x]
            item = {"g": g, "sign": sign, "m": len(members), "ev": n_ev,
                    "ab": round(sum(ab) / len(ab), 2) if ab else None,
                    "nkab": round(sum(nkab) / len(nkab), 2) if nkab else None}
            if per_ev:
                flat = [x for v in per_ev for x in v]
                lo, hi = ci(per_ev)
                item.update({"n": len(flat), "hit": sum(flat), "nev": len(per_ev), "lo": round(lo, 3), "hi": round(hi, 3)})
            groups.append(item)
        if groups:
            out.append({"id": e["id"], "k": k, "ec": ec, "d": e["d"], "t": e.get("t", ""), "groups": groups})
    res = {"v": 2, "asof": today, "horizon": HORIZON, "items": out}
    (DATA / "bias.json").write_text(json.dumps(res, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"bias: 予定 {len(out)} 件・業種 {sum(len(x['groups']) for x in out)} 件", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
