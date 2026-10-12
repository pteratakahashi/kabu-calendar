#!/usr/bin/env python3
"""ホーム画面の「マーケット」用に、主要指標の直近の終値と前日比を site/data/market.json に保存する。

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
# (ティッカー, 表示名, 単位, グループ, 最初から表示するか) 単位 "bp" は利回りなので差を bp で出す。
# ホームの「マーケット」に出す指標はアプリで選べる（端末内に保存）。選ばれていない人の初期表示は def=True の8つ
SYMS = [
    ("^N225", "日経平均", "%", "日本", True), ("NIY=F", "日経先物(CME)", "%", "日本", True),
    ("1306.T", "TOPIX(ETF 1306)", "%", "日本", False), ("2516.T", "グロース250(ETF)", "%", "日本", False),
    ("^GSPC", "S&P500", "%", "米国", True), ("^IXIC", "ナスダック", "%", "米国", True), ("^DJI", "NYダウ", "%", "米国", False),
    ("^SOX", "SOX指数", "%", "米国", True), ("^RUT", "ラッセル2000", "%", "米国", False), ("^VIX", "VIX(恐怖指数)", "%", "米国", False),
    ("ES=F", "S&P500先物", "%", "米国", False), ("NQ=F", "ナスダック100先物", "%", "米国", False),
    ("JPY=X", "ドル円", "%", "為替", True), ("EURJPY=X", "ユーロ円", "%", "為替", False), ("GBPJPY=X", "ポンド円", "%", "為替", False),
    ("AUDJPY=X", "豪ドル円", "%", "為替", False), ("EURUSD=X", "ユーロドル", "%", "為替", False), ("CNY=X", "ドル人民元", "%", "為替", False),
    ("DX-Y.NYB", "ドル指数", "%", "為替", False),
    ("^TNX", "米10年金利", "bp", "金利", True), ("^FVX", "米5年金利", "bp", "金利", False), ("^TYX", "米30年金利", "bp", "金利", False),
    ("^IRX", "米3か月金利", "bp", "金利", False),
    ("CL=F", "原油(WTI)", "%", "商品", True), ("BZ=F", "原油(ブレント)", "%", "商品", False), ("GC=F", "金", "%", "商品", False),
    ("SI=F", "銀", "%", "商品", False), ("HG=F", "銅", "%", "商品", False), ("NG=F", "天然ガス", "%", "商品", False),
    ("^HSI", "香港ハンセン", "%", "アジア・欧州", False), ("000001.SS", "上海総合", "%", "アジア・欧州", False),
    ("^KS11", "韓国KOSPI", "%", "アジア・欧州", False), ("^TWII", "台湾加権", "%", "アジア・欧州", False),
    ("^GDAXI", "ドイツDAX", "%", "アジア・欧州", False), ("^FTSE", "英FTSE100", "%", "アジア・欧州", False),
    ("^STOXX50E", "ユーロストックス50", "%", "アジア・欧州", False),
    ("BTC-JPY", "ビットコイン(円)", "%", "暗号資産", False), ("BTC-USD", "ビットコイン(ドル)", "%", "暗号資産", False),
    ("ETH-USD", "イーサリアム(ドル)", "%", "暗号資産", False),
]


def main() -> int:
    out = []
    for sym, name, unit, grp, default in SYMS:
        try:
            df = yf.download(sym, period="10d", interval="1d", progress=False, auto_adjust=False)
            c = df["Close"]
            c = pd.to_numeric((c[sym] if isinstance(c, pd.DataFrame) and sym in c else c).squeeze(), errors="coerce").dropna()
            if len(c) < 2:
                continue
            last, prev = float(c.iloc[-1]), float(c.iloc[-2])
            chg = round((last - prev) * 100, 1) if unit == "bp" else round((last / prev - 1) * 100, 2)
            out.append({"sym": sym, "name": name, "unit": unit, "grp": grp, "def": default,
                        "last": round(last, 3 if unit == "bp" else 4 if last < 10 else 2),
                        "chg": chg, "d": c.index[-1].strftime("%Y-%m-%d")})
        except Exception as e:  # noqa: BLE001
            print(f"  {sym}: {e}", file=sys.stderr)
    OUT.write_text(json.dumps({"updated_at": dt.datetime.now(dt.timezone(dt.timedelta(hours=9))).isoformat(timespec="minutes"),
                               "items": out}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"market: {len(out)} items", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
