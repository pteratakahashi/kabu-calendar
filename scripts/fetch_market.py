#!/usr/bin/env python3
"""ホーム画面の「夜間の市場」用に、主要指標の直近の終値と前日比を site/data/market.json に保存する。

データ: Yahoo Finance（yfinance, 非公式）。07:00 JST の実行で前夜の米国市場の引け値が入る。
"""
from __future__ import annotations

import datetime as dt
import json
import sys
from pathlib import Path

import pandas as pd
import yfinance as yf

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "site" / "data" / "market.json"
# (ティッカー, 表示名, 単位) 単位 "bp" は利回りなので差を bp で出す
SYMS = [
    ("^N225", "日経平均", "%"), ("NIY=F", "日経先物(CME)", "%"), ("^GSPC", "S&P500", "%"),
    ("^IXIC", "ナスダック", "%"), ("^SOX", "SOX指数", "%"), ("JPY=X", "ドル円", "%"),
    ("^TNX", "米10年金利", "bp"), ("CL=F", "原油(WTI)", "%"),
]


def main() -> int:
    out = []
    for sym, name, unit in SYMS:
        try:
            df = yf.download(sym, period="10d", interval="1d", progress=False, auto_adjust=False)
            c = df["Close"]
            c = pd.to_numeric((c[sym] if isinstance(c, pd.DataFrame) and sym in c else c).squeeze(), errors="coerce").dropna()
            if len(c) < 2:
                continue
            last, prev = float(c.iloc[-1]), float(c.iloc[-2])
            chg = round((last - prev) * 100, 1) if unit == "bp" else round((last / prev - 1) * 100, 2)
            out.append({"sym": sym, "name": name, "unit": unit, "last": round(last, 3 if unit == "bp" else 2),
                        "chg": chg, "d": c.index[-1].strftime("%Y-%m-%d")})
        except Exception as e:  # noqa: BLE001
            print(f"  {sym}: {e}", file=sys.stderr)
    OUT.write_text(json.dumps({"updated_at": dt.datetime.now(dt.timezone(dt.timedelta(hours=9))).isoformat(timespec="minutes"),
                               "items": out}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"market: {len(out)} items", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
