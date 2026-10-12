#!/usr/bin/env python3
"""海外企業決算の過去分（「過去10回の反応」用）を Yahoo Finance の決算日から data/events.json に足す（手動・不定期実行）。

events.json で ticker を持つ決算イベント（TSMC 月次・サムスン暫定は除く）の銘柄ごとに、
約3年分の決算日時を取り、同じ銘柄の決算が前後5日以内に無ければ追加する。
日時は Yahoo の値を日本時間に直したもの（米国東部の決算時刻）。desc で「過去分」と分かるようにする。

使い方: python3 scripts/backfill_history.py
"""
from __future__ import annotations

import datetime as dt
import json
import re
import sys
from pathlib import Path

import pandas as pd
import yfinance as yf

ROOT = Path(__file__).resolve().parent.parent
EVENTS = ROOT / "data" / "events.json"
SKIP_SLUGS = {"tsmc-monthly", "samsung-prelim"}
YEARS = 3


def slug(eid: str) -> str:
    return re.sub(r"^\d{4}-\d{2}-\d{2}-", "", eid)


def main() -> int:
    events = json.loads(EVENTS.read_text(encoding="utf-8"))
    today = dt.date.today()
    since = (today - dt.timedelta(days=365 * YEARS)).isoformat()

    # ticker ごとに「代表のイベント」（最新）を決める
    base: dict[str, dict] = {}
    for e in events:
        if e.get("ticker") and slug(e["id"]) not in SKIP_SLUGS:
            if e["ticker"] not in base or e["d"] > base[e["ticker"]]["d"]:
                base[e["ticker"]] = e

    added = []
    for tk, rep in sorted(base.items()):
        have = [dt.date.fromisoformat(e["d"]) for e in events
                if e.get("ticker") == tk and slug(e["id"]) not in SKIP_SLUGS]
        name = re.split(r"\s*\d+-\d+月期|\s*決算", rep["title"])[0].strip()
        try:
            df = yf.Ticker(tk).get_earnings_dates(limit=16)
        except Exception as e:  # noqa: BLE001
            print(f"  {tk}: {type(e).__name__}", file=sys.stderr)
            continue
        if df is None or df.empty:
            continue
        n = 0
        for ts in df.index:
            j = pd.Timestamp(ts).tz_convert("Asia/Tokyo")
            d = j.date()
            if not (since <= d.isoformat() < today.isoformat()) or any(abs((d - x).days) <= 5 for x in have):
                continue
            ev = {
                "id": f"{d.isoformat()}-{slug(rep['id'])}",
                "d": d.isoformat(), "t": j.strftime("%H:%M"), "approx": True,
                "country": rep["country"], "title": f"{name} 決算",
                "desc": "過去分（日時は Yahoo Finance の値）",
                "impact": rep["impact"], "themes": rep.get("themes", []), "tentative": False,
                "src": f"https://finance.yahoo.com/quote/{tk}/", "ticker": tk,
            }
            if any(e["id"] == ev["id"] for e in events):
                continue
            events.append(ev)
            added.append(ev)
            have.append(d)
            n += 1
        print(f"  {tk} ({name}): +{n}", file=sys.stderr)

    events.sort(key=lambda e: (e["d"], e.get("t") or "99:99"))
    EVENTS.write_text(json.dumps(events, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"done: +{len(added)} events", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
