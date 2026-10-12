#!/usr/bin/env python3
"""data/events.json と data/news.json の検証（標準ライブラリのみ）。

使い方: python3 scripts/validate_events.py
エラーがあれば一覧を表示して exit 1、問題なければ件数サマリを表示。
"""
import json
import re
import sys
from collections import Counter
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EVENTS = ROOT / "data" / "events.json"
NEWS = ROOT / "data" / "news.json"
THEMES = ROOT / "data" / "themes.json"

REQUIRED = ("id", "d", "country", "title", "impact")
COUNTRIES = {"JP", "US", "TW", "CN", "EU", "KR", "GLOBAL"}
ALLOWED_KEYS = {"id", "code", "ticker", "d", "t", "approx", "country", "title", "desc",
                "impact", "themes", "tentative", "src"}
NEWS_KEYS = {"id", "d", "t", "approx", "country", "cat", "title", "desc", "impact", "themes",
             "codes", "tickers", "src"}
NEWS_CATS = {"要人発言", "関税・貿易", "地政学", "企業", "AI・半導体", "金融・市場", "政治", "その他"}
CODE_RE = re.compile(r"^[0-9][0-9A-Z]{3}$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
TIME_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")


def load(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        print(f"ERROR: {path} を読み込めません: {e}")
        sys.exit(1)


def check(events, theme_ids, allowed, news=False):
    errors = []
    if not isinstance(events, list):
        return ["トップレベルが配列である必要があります"]

    seen = set()
    for i, ev in enumerate(events):
        tag = f"[{i}] {ev.get('id', '?') if isinstance(ev, dict) else '?'}"
        if not isinstance(ev, dict):
            errors.append(f"{tag}: オブジェクトではありません")
            continue
        for k in REQUIRED:
            if k not in ev or ev[k] in (None, ""):
                errors.append(f"{tag}: 必須フィールド '{k}' がありません")
        for k in ev:
            if k not in allowed:
                errors.append(f"{tag}: 未知のフィールド '{k}'")

        eid = ev.get("id")
        if eid is not None:
            if not isinstance(eid, str):
                errors.append(f"{tag}: id は文字列")
            elif eid in seen:
                errors.append(f"{tag}: id が重複しています")
            else:
                seen.add(eid)

        d = ev.get("d")
        if d is not None:
            if not isinstance(d, str) or not DATE_RE.match(d):
                errors.append(f"{tag}: d '{d}' は YYYY-MM-DD 形式ではありません")
            else:
                try:
                    date.fromisoformat(d)
                except ValueError:
                    errors.append(f"{tag}: d '{d}' は存在しない日付です")

        if "t" in ev:
            t = ev["t"]
            if not isinstance(t, str) or not TIME_RE.match(t):
                errors.append(f"{tag}: t '{t}' は HH:MM (00:00-23:59) ではありません")

        imp = ev.get("impact")
        if imp is not None and (isinstance(imp, bool) or not isinstance(imp, int) or not 1 <= imp <= 3):
            errors.append(f"{tag}: impact '{imp}' は 1〜3 の整数である必要があります")

        c = ev.get("country")
        if c is not None and c not in COUNTRIES:
            errors.append(f"{tag}: country '{c}' は {sorted(COUNTRIES)} のいずれか")

        th = ev.get("themes", [])
        if not isinstance(th, list):
            errors.append(f"{tag}: themes は配列")
        else:
            for x in th:
                if x not in theme_ids:
                    errors.append(f"{tag}: theme '{x}' は themes.json にありません")

        for k in ("approx", "tentative"):
            if k in ev and not isinstance(ev[k], bool):
                errors.append(f"{tag}: {k} は true/false")
        for k in ("title", "desc", "src"):
            if k in ev and not isinstance(ev[k], str):
                errors.append(f"{tag}: {k} は文字列")
        if news:
            if ev.get("cat") not in NEWS_CATS:
                errors.append(f"{tag}: cat '{ev.get('cat')}' は {sorted(NEWS_CATS)} のいずれか")
            if not ev.get("src"):
                errors.append(f"{tag}: ニュースは src（根拠URL）必須")
            for c in ev.get("codes", []):
                if not isinstance(c, str) or not CODE_RE.match(c):
                    errors.append(f"{tag}: codes '{c}' は4桁の銘柄コード")
            if not all(isinstance(x, str) and x for x in ev.get("tickers", [])):
                errors.append(f"{tag}: tickers は文字列の配列")
    return errors


def main():
    events = load(EVENTS)
    themes = load(THEMES)
    theme_ids = {t.get("id") for t in themes if isinstance(t, dict)}
    news = load(NEWS) if NEWS.exists() else []
    errors = [f"events.json {e}" for e in check(events, theme_ids, ALLOWED_KEYS)]
    errors += [f"news.json {e}" for e in check(news, theme_ids, NEWS_KEYS, news=True)]
    brief_path = ROOT / "data" / "brief.json"
    if brief_path.exists():
        b = load(brief_path)
        if not isinstance(b, dict) or not DATE_RE.match(str(b.get("d", ""))) or not TIME_RE.match(str(b.get("t", ""))):
            errors.append("brief.json: d (YYYY-MM-DD) と t (HH:MM) が必要")
        items = b.get("items") if isinstance(b, dict) else None
        if not isinstance(items, list) or not 1 <= len(items) <= 6:
            errors.append("brief.json: items は1〜6件の配列")
        else:
            for i, x in enumerate(items):
                if not isinstance(x, dict) or not isinstance(x.get("h"), str) or not x["h"] or not isinstance(x.get("b", ""), str):
                    errors.append(f"brief.json: items[{i}] は {{h: 見出し, b: 本文}}")
                elif len(x["h"]) > 30 or len(x.get("b", "")) > 120:
                    errors.append(f"brief.json: items[{i}] が長すぎ（見出し30字・本文120字まで）")
    if errors:
        print(f"NG: {len(errors)} 件のエラー")
        for e in errors:
            print("  - " + e)
        sys.exit(1)

    imp = Counter(ev["impact"] for ev in events)
    cty = Counter(ev["country"] for ev in events)
    tent = sum(1 for ev in events if ev.get("tentative"))
    dates = sorted(ev["d"] for ev in events)
    print(f"OK: {len(events)} 件 ({dates[0]} 〜 {dates[-1]})" if events else "OK: 0 件")
    print("  impact: " + ", ".join(f"★{k}={imp[k]}" for k in (3, 2, 1)))
    print("  country: " + ", ".join(f"{k}={v}" for k, v in sorted(cty.items())))
    print(f"  tentative: {tent}")
    print(f"news: {len(news)} 件" + (f" ({min(n['d'] for n in news)} 〜 {max(n['d'] for n in news)})" if news else ""))


if __name__ == "__main__":
    main()
