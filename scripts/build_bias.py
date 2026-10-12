#!/usr/bin/env python3
"""日経225銘柄 × 今後の予定（自社の決算・指標・海外決算）で、過去の反応が上昇か下落に偏っている組み合わせを
site/data/bias.json に書き出す（アプリの「傾向」一覧用）。

入力はすべて fetch_reactions.py が作ったファイル（追加のダウンロードはしない）:
  site/data/h/<コード>.json（各イベント反応日の騰落率 ev）、h/index.json、reactions.json（決算の反応）、
  events.json / earnings.json（今後の予定）、n225.json
過去の回の数え方はアプリと同じ（同じ種類のイベントの直近10回、反応日の終値騰落率）。

使い方: python3 scripts/build_bias.py
"""
from __future__ import annotations

import datetime as dt
import json
import math
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "site" / "data"
HIST_N = 10        # 過去何回まで見るか（アプリと同じ）
MIN_N = 6          # これより少ない回数しかない組み合わせは出さない
MIN_RATE = 0.8     # 上昇（下落）した回の割合がこれ以上
MIN_T = 1.5        # 平均 ÷ 標準誤差。1〜2回の大きな動きだけで平均が偏っているものを除く
HORIZON = 35       # 今日から何日先までの予定を対象にするか
SERIES_ALIAS = {"us-ism-svc": "us-ism-services", "us-fomc": "fomc"}
NOT_EARN = {"tsmc-monthly", "samsung-prelim"}


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


def judge(vals: list[float | None], vol: float) -> dict | None:
    v = [x for x in vals if x is not None]
    n = len(v)
    if n < MIN_N:
        return None
    up = sum(x > 0 for x in v)
    down = sum(x < 0 for x in v)
    side = 1 if up >= MIN_RATE * n else -1 if down >= MIN_RATE * n else 0
    avg = sum(v) / n
    if not side or avg * side <= 0:
        return None
    # 平均の動きが普段の1日の値動きの半分未満なら、偏っていても小さすぎて意味が薄い
    if abs(avg) < 0.5 * vol:
        return None
    sd = math.sqrt(sum((x - avg) ** 2 for x in v) / (n - 1)) if n > 1 else 0
    t = avg / (sd / math.sqrt(n)) if sd > 0 else 99.0
    if abs(t) < MIN_T:
        return None
    return {"s": side, "n": n, "w": up if side > 0 else down, "avg": round(avg, 2), "t": round(t, 1)}


def driver(rec: dict, series: str) -> float | None:
    """その回の「結果」を表す市場の動き。海外決算はその会社の株価の反応、指標は発表1時間後のドル円。"""
    if series.startswith("earn:"):
        return (rec.get("d1") or {}).get("tk")
    s = next((x for x in rec.get("series", []) if x["sym"] == "JPY=X"), None)
    return None if s is None else s.get("m60", s.get("end"))


def main() -> int:
    today = dt.date.today().isoformat()
    end = (dt.date.today() + dt.timedelta(days=HORIZON)).isoformat()
    idx = load(DATA / "h" / "index.json", None)
    if not idx:
        print("bias: h/index.json がないのでスキップ", file=sys.stderr)
        return 0
    rx = load(DATA / "reactions.json", {"events": {}, "earnings": {}})
    events = [e for e in load(DATA / "events.json", []) if not e.get("code")]
    earnings = load(DATA / "earnings.json", [])
    n225 = load(DATA / "n225.json", {}).get("codes", [])
    hev = {eid: i for i, eid in enumerate(idx["ev"])}
    hday = {d: i for i, d in enumerate(idx["days"])}
    nk_day = lambda d: idx["nk"][hday[d]] if "nk" in idx and d in hday else None  # noqa: E731
    # 窓（前日終値 → 反応日の始値）。r − g がおおよそ日中の動き
    gap = lambda h, d: h["g"][hday[d]] if h.get("g") and d in hday else None  # noqa: E731

    def week(h, d):
        """反応日から5営業日目の終値（反応日の前日終値比、%）。決算の「1週間後」と同じ定義"""
        if d not in hday or hday[d] + 5 > len(h["r"]):
            return None
        v = h["r"][hday[d]:hday[d] + 5]
        if any(x is None for x in v):
            return None
        return round((math.prod(1 + x / 100 for x in v) - 1) * 100, 2)

    def nk_week(d):
        """日経平均の同じ1週間（反応日から5営業日目の終値、前日終値比 %）。1週間持った分が相場全体の動きでないかを見る用"""
        if "nk" not in idx or d not in hday or hday[d] + 5 > len(idx["nk"]):
            return None
        v = idx["nk"][hday[d]:hday[d] + 5]
        if any(x is None for x in v):
            return None
        return round((math.prod(1 + x / 100 for x in v) - 1) * 100, 2)

    def ev_day(eid):
        r = rx["events"].get(eid) or {}
        return (r.get("d1") or {}).get("nk_day") or next((x["day"] for x in r.get("idx", []) if x["sym"] == "^N225"), None)

    def nk_r(eid):
        r = rx["events"].get(eid) or {}
        return (r.get("d1") or {}).get("nk", next((x["r"] for x in r.get("idx", []) if x["sym"] == "^N225"), None))

    # 種類ごとの過去の回（反応データのあるもの、古い順）
    by_series: dict[str, list[dict]] = {}
    for e in sorted(events, key=lambda e: e["d"]):
        by_series.setdefault(series_of(e), []).append(e)
    upcoming_ev = []
    seen = set()
    for e in events:
        if not (today <= e["d"] <= end):
            continue
        k = series_of(e)
        if k in seen:  # 同じ種類が期間内に2回あれば最初の回だけ
            continue
        hist = [x for x in by_series[k] if x["d"] < today and x["id"] in rx["events"] and x["id"] in hev][-HIST_N:][::-1]
        if len(hist) >= MIN_N:
            seen.add(k)
            upcoming_ev.append((e, hist))

    # 銘柄ごとの過去の決算反応（新しい順）
    earn_hist: dict[str, list[tuple[str, dict]]] = {}
    for key, r in rx["earnings"].items():
        c, d = key.split("@")
        if d < today and r.get("r") is not None:
            earn_hist.setdefault(c, []).append((d, r))
    nxt = {}
    for e in sorted(earnings, key=lambda e: e["d"]):
        if today <= e["d"] <= end and e["c"] not in nxt:
            nxt[e["c"]] = e

    items = []
    for x in n225:
        c = x["c"]
        h = load(DATA / "h" / f"{c}.json", None)
        if not h or not h.get("vol"):
            continue
        vol = h["vol"]
        if (e := nxt.get(c)):
            hist = sorted(earn_hist.get(c, []), key=lambda x: x[0], reverse=True)[:HIST_N]
            if (j := judge([r["r"] for _, r in hist], vol)):
                # 根拠を見るための各回の値（新しい順）: 日経平均（同じ反応日）、1週間後、決算日
                items.append({"k": "earn", "c": c, "d": e["d"], "tm": e.get("t", ""), **j,
                              "r": [r["r"] for _, r in hist], "nk": [nk_day(r["day"]) for _, r in hist],
                              "g": [gap(h, r["day"]) for _, r in hist],
                              "w1": [p[1] if (p := (r.get("pts") or [])[r["k"] + 4:r["k"] + 5]) and (p := p[0]) else None
                                     for _, r in hist],
                              "nw": [nk_week(r.get("day")) for _, r in hist],
                              "ds": [d for d, _ in hist]})
        for ev, hist in upcoming_ev:
            vals = [h["ev"][hev[p["id"]]] for p in hist]
            if (j := judge(vals, vol)):
                k = series_of(ev)
                items.append({"k": "ev", "c": c, "id": ev["id"], "d": ev["d"], "tm": ev.get("t", ""), **j,
                              "r": vals, "nk": [nk_r(p["id"]) for p in hist],
                              "dv": [driver(rx["events"][p["id"]], k) for p in hist],
                              "g": [gap(h, ev_day(p["id"])) for p in hist],
                              "w1": [week(h, ev_day(p["id"])) for p in hist],
                              "nw": [nk_week(ev_day(p["id"])) for p in hist]})
    items.sort(key=lambda i: (i["d"], -abs(i["t"])))
    out = {"asof": today, "horizon": HORIZON, "min_n": MIN_N, "min_rate": MIN_RATE, "items": items}
    (DATA / "bias.json").write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"bias: {len(items)} 件（決算 {sum(i['k'] == 'earn' for i in items)} / イベント {sum(i['k'] == 'ev' for i in items)}）",
          file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
