#!/usr/bin/env python3
"""IPO（新規上場）情報を JPX の新規上場会社ページから取得し、上場後の初値・推移を Yahoo で付けて
site/data/ipo.json に蓄積する。

JPX ページには「上場日（承認日）・会社名・コード・市場・仮条件・公開価格・公募/売出株数」が載る。
初値 = 上場後最初の取引日の始値（Yahoo）。騰落率は公開価格比。
"""
from __future__ import annotations

import datetime as dt
import html
import json
import re
import sys
import unicodedata
import urllib.request
from pathlib import Path

import pandas as pd
import yfinance as yf

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "site" / "data" / "ipo.json"
PAGE = "https://www.jpx.co.jp/listing/stocks/new/index.html"
UA = "kabu-calendar/0.1 (personal use)"


def nfkc(s: str) -> str:
    return unicodedata.normalize("NFKC", s or "").strip()


def num(s: str) -> float | None:
    m = re.search(r"[\d,]+(?:\.\d+)?", s or "")
    return float(m.group().replace(",", "")) if m else None


def cells(row: str) -> list[str]:
    return [" ".join(html.unescape(re.sub(r"<[^>]+>", " ", c)).split())
            for c in re.findall(r"<t[dh][^>]*>.*?</t[dh]>", row, flags=re.S)]


def parse(page: str) -> list[dict]:
    table = re.search(r"<table.*?</table>", page, flags=re.S)
    if not table:
        raise RuntimeError("JPX 新規上場ページに表が見つからない（構成変更の可能性）")
    rows = re.findall(r"<tr.*?</tr>", table.group(), flags=re.S)
    out = []
    i = 0
    while i < len(rows) - 1:
        a, b = cells(rows[i]), cells(rows[i + 1])
        m = re.match(r"(\d{4})/(\d{2})/(\d{2})\s*（(\d{4})/(\d{2})/(\d{2})）", a[0] if a else "")
        if not m or len(a) < 8 or len(b) < 5:
            i += 1
            continue
        g = m.groups()
        name = nfkc(re.sub(r"代表者インタビュー", "", a[1])).replace("(株)", "").replace("株式会社", "").strip()
        tech = name.endswith("*")  # JPX の「*」= テクニカル上場（持株会社化など。公募なし）
        name = name.rstrip("* ").strip()
        oa = re.search(r"OA\s*([\d,.]+)", b[4])
        sell = num(b[4].split("(")[0]) or 0.0
        out.append({
            "d": f"{g[0]}-{g[1]}-{g[2]}", "appr": f"{g[3]}-{g[4]}-{g[5]}",
            "c": nfkc(a[2]), "n": name, "mkt": nfkc(b[0]),
            "range": nfkc(a[5]) if a[5] not in ("-", "") else "",
            "price": num(b[3]) if b[3] not in ("-", "") else None,
            "pub": num(a[6]) or 0.0, "sell": sell, "oa": float(oa.group(1).replace(",", "")) if oa else 0.0,
            "unit": int(num(a[7]) or 100), "tech": tech,
        })
        i += 2
    return out


def first_trades(items: list[dict]) -> None:
    today = dt.date.today().isoformat()
    for it in items:
        if it["d"] > today or not it.get("price") or it.get("done"):
            continue
        try:
            df = yf.download(f'{it["c"]}.T', start=it["d"], interval="1d", progress=False, auto_adjust=False)
        except Exception as e:  # noqa: BLE001
            print(f"  {it['c']}: {type(e).__name__}", file=sys.stderr)
            continue
        if df is None or df.empty:
            continue
        if isinstance(df.columns, pd.MultiIndex):
            df.columns = df.columns.get_level_values(0)
        df = df[(df["Open"] > 0) & (df["Close"] > 0)]
        if df.empty:
            continue
        p = it["price"]
        it["first"] = round(float(df["Open"].iloc[0]), 1)
        it["first_d"] = df.index[0].strftime("%Y-%m-%d")
        it["first_r"] = round((it["first"] / p - 1) * 100, 1)
        it["last"] = round(float(df["Close"].iloc[-1]), 1)
        it["last_r"] = round((it["last"] / p - 1) * 100, 1)
        it["pts"] = [[i.strftime("%m-%d"), round((float(v) / p - 1) * 100, 1)] for i, v in df["Close"].iloc[:40].items()]
        it["done"] = len(df) >= 40  # 上場40営業日分そろったら確定


def main() -> int:
    req = urllib.request.Request(PAGE, headers={"User-Agent": UA})
    page = urllib.request.urlopen(req, timeout=60).read().decode("utf-8", "replace")
    fresh = parse(page)
    try:
        prev = {x["c"]: x for x in json.loads(OUT.read_text(encoding="utf-8"))}
    except (FileNotFoundError, json.JSONDecodeError):
        prev = {}
    for it in fresh:
        old = prev.get(it["c"], {})
        # JPX の最新情報（日程・価格）を優先し、初値などの計算済み項目は引き継ぐ
        prev[it["c"]] = {**old, **it}
    items = sorted(prev.values(), key=lambda x: (x["d"], x["c"]))
    for it in items:
        shares = (it.get("pub", 0) + it.get("sell", 0) + it.get("oa", 0)) * 1000
        px = it.get("price") or num((it.get("range") or "").replace("～", "~").split("~")[-1])
        it["size"] = round(shares * px / 1e8, 1) if px else None  # 吸収金額（億円）
        it["imp"] = 3 if (it["size"] or 0) >= 1000 else 2 if (it["size"] or 0) >= 100 else 1
    first_trades(items)
    OUT.write_text(json.dumps(items, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"done: ipo={len(items)} listed={sum(1 for x in items if 'first' in x)}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
