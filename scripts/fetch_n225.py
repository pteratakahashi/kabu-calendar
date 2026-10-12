#!/usr/bin/env python3
"""日経平均の採用銘柄（225社）を取得して site/data/n225.json に保存する。入れ替えがあれば履歴に残し、
新しく採用された銘柄の過去の決算日（「過去10回の決算反応」用）を data/earnings_backfill.json に足す。

取得元: 日本語版 Wikipedia「日経平均株価」の「構成銘柄一覧」節（MediaWiki API。CC BY-SA）。
日経の公式ページ（indexes.nikkei.co.jp）はボット対策で自動取得できないため使わない。
Wikipedia は入れ替え当日〜数日で更新される。取得結果が 225 社前後でない・銘柄コードが不正などの
異常時は前回の一覧をそのまま使う（壊れた一覧で上書きしない）。

使い方: python3 scripts/fetch_n225.py
"""
from __future__ import annotations

import datetime as dt
import json
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "site" / "data" / "n225.json"
BACKFILL = ROOT / "data" / "earnings_backfill.json"
API = "https://ja.wikipedia.org/w/api.php?" + urllib.parse.urlencode(
    {"action": "parse", "page": "日経平均株価", "prop": "wikitext", "format": "json", "formatversion": "2"})
UA = "kabu-calendar/1.0 (personal stock calendar; https://github.com/pteratakahashi/kabu-calendar)"
CODE = re.compile(r"^\|\s*([0-9][0-9A-Z]{3})\s*(?:\|\||$)", re.M)


def log(*a):
    print(*a, file=sys.stderr)


def load(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def fetch() -> tuple[list[dict], str]:
    req = urllib.request.Request(API, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        w = json.loads(r.read().decode("utf-8"))["parse"]["wikitext"]
    i = w.find("== 構成銘柄一覧 ==")
    if i < 0:
        raise ValueError("構成銘柄一覧 の節が見つからない")
    j = w.find("\n== ", i + 5)
    sec = w[i: j if j > 0 else None]
    m = re.search(r"(\d{4}年\d{1,2}月\d{1,2}日)現在", sec)
    asof = m.group(1) if m else ""
    out = []
    for part in re.split(r"\n=== ", sec)[1:]:
        sector = re.sub(r"（\d+銘柄）.*", "", part.split("\n", 1)[0]).strip(" =")
        for row in part.split("|-")[1:]:
            c = CODE.search(row.strip())
            n = re.search(r"\[\[(?:[^\]|]*\|)?([^\]|]+)\]\]", row)
            if c:
                out.append({"c": c.group(1), "n": re.sub(r"\s*\(.*?\)$", "", n.group(1)) if n else "", "sec": sector})
    return out, asof


def add_earnings_dates(codes: list[str], names: dict[str, str]) -> int:
    """新規採用銘柄の過去約3年の決算日を Yahoo から足す（backfill_earnings.py と同じ形式）。"""
    if not codes:
        return 0
    import pandas as pd
    import yfinance as yf
    since = (dt.date.today() - dt.timedelta(days=365 * 3)).isoformat()
    today = dt.date.today().isoformat()
    data = load(BACKFILL, [])
    have = {(e["c"], e["d"]) for e in data}
    n = 0
    for c in codes:
        try:
            df = yf.Ticker(f"{c}.T").get_earnings_dates(limit=16)
        except Exception as e:  # noqa: BLE001
            log(f"  earnings {c}: {type(e).__name__}")
            continue
        if df is None or df.empty:
            continue
        for ts in df.index:
            j = pd.Timestamp(ts).tz_convert("Asia/Tokyo")
            d = j.strftime("%Y-%m-%d")
            if not (since <= d < today) or (c, d) in have:
                continue
            hm = j.strftime("%H:%M")
            data.append({"d": d, "t": "" if "08:00" <= hm < "11:00" else hm, "c": c, "n": names.get(c, c),
                         "q": "", "fye": "", "mkt": "", "sec": "", "src": "yf"})
            have.add((c, d))
            n += 1
    data.sort(key=lambda e: (e["d"], e["c"]))
    BACKFILL.write_text(json.dumps(data, ensure_ascii=False, indent=0) + "\n", encoding="utf-8")
    return n


def main() -> int:
    prev = load(OUT, {"codes": [], "history": []})
    try:
        items, asof = fetch()
        # Wikipedia 側の編集ミスで同じ銘柄が2業種に載ることがある → 先に出た方を採用
        seen: set[str] = set()
        items = [x for x in items if not (x["c"] in seen or seen.add(x["c"]))]
        if not 220 <= len(items) <= 230:
            raise ValueError(f"件数が異常: {len(items)} 件")
    except Exception as e:  # noqa: BLE001
        log(f"n225: 取得失敗のため前回の一覧を使う: {e}")
        return 0

    old = {x["c"] for x in prev.get("codes", [])}
    new = {x["c"] for x in items}
    history = prev.get("history", [])
    added, removed = sorted(new - old), sorted(old - new)
    if old and (added or removed):
        history.append({"d": dt.date.today().isoformat(), "asof": asof, "add": added, "del": removed})
        log(f"n225: 入れ替え 採用 {added} / 除外 {removed}")
    # 新規採用（初回は全銘柄）のうち、過去の決算日をまだ持っていない銘柄を補完
    have_bf = {e["c"] for e in load(BACKFILL, [])}
    need = sorted(c for c in (added if old else new) if c not in have_bf)
    if need:
        log(f"n225: 過去の決算日を補完 {len(need)} 社 → +{add_earnings_dates(need, {x['c']: x['n'] for x in items})} 件")
    items.sort(key=lambda x: x["c"])
    OUT.write_text(json.dumps({"asof": asof, "src": "ja.wikipedia.org 日経平均株価", "codes": items,
                               "history": history}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    log(f"n225: {len(items)} 社（{asof} 現在）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
