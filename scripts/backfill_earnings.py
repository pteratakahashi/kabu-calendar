#!/usr/bin/env python3
"""過去の国内決算日を Yahoo Finance から補完して data/earnings_backfill.json に保存する（手動・不定期実行）。

JPX の決算発表予定日 Excel は直近数か月分しか公開されないため、今年の初めからの分をここで埋める。
対象は「今の条件」= ★2以上（Core30/Large70/テーマ主力）とテーマ銘柄。
Yahoo の決算日時は米国東部時間で返るので日本時間に直す。精度は JPX より劣る（src="yf"）。

使い方: python3 scripts/backfill_earnings.py [開始日 YYYY-MM-DD]（省略時は今年の1/1）
"""
from __future__ import annotations

import datetime as dt
import json
import sys
import time
from pathlib import Path

import pandas as pd
import yfinance as yf

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "earnings_backfill.json"


def main() -> int:
    today = dt.date.today()
    since = sys.argv[1] if len(sys.argv) > 1 else f"{today.year}-01-01"
    stocks = {s["c"]: s for s in json.loads((ROOT / "site" / "data" / "stocks.json").read_text(encoding="utf-8"))}
    themes = json.loads((ROOT / "data" / "themes.json").read_text(encoding="utf-8"))
    theme_codes = {c for t in themes for c in t["codes"]}
    targets = sorted(c for c, s in stocks.items() if s.get("imp", 1) >= 2 or c in theme_codes)
    print(f"targets: {len(targets)} since {since}", file=sys.stderr)

    try:
        existing = json.loads(OUT.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        existing = []
    have = {(e["c"], e["d"]) for e in existing}
    out = list(existing)

    for i, c in enumerate(targets):
        try:
            df = yf.Ticker(f"{c}.T").get_earnings_dates(limit=12)
        except Exception as e:  # noqa: BLE001
            print(f"  {c}: {type(e).__name__}", file=sys.stderr)
            continue
        if df is None or df.empty:
            continue
        for ts in df.index:
            j = pd.Timestamp(ts).tz_convert("Asia/Tokyo")
            d = j.strftime("%Y-%m-%d")
            if not (since <= d < today.isoformat()) or (c, d) in have:
                continue
            hm = j.strftime("%H:%M")
            # 08:00〜10:59 JST は「時刻不明」の仮置き（米国東部の前日夜）→ 時刻なし＝引け後扱い
            out.append({
                "d": d, "t": "" if "08:00" <= hm < "11:00" else hm, "c": c, "n": stocks[c]["n"], "q": "", "fye": "",
                "mkt": stocks[c].get("mkt", ""), "sec": stocks[c].get("sec", ""), "src": "yf",
            })
            have.add((c, d))
        if i % 20 == 19:
            print(f"  {i + 1}/{len(targets)}", file=sys.stderr)
            time.sleep(1)

    out.sort(key=lambda e: (e["d"], e["c"]))
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=0) + "\n", encoding="utf-8")
    print(f"done: {len(out)} entries", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
