#!/usr/bin/env python3
"""国内決算の発表時刻を適時開示（TDnet）の記録から集め、site/data/earnings.json に書き足す。

JPX の決算発表予定には時刻が無い。そこで TDnet に「決算短信」が出た時刻を全社分記録しておき、
  - 発表済みの決算 → 実際に開示された時刻（t）
  - これからの決算 → その会社の前回の決算短信の時刻（t と、前回の日付 tp）。会社はほぼ毎回同じ時刻に出すため目安になる
を付ける。TDnet の一覧は「やのしん WebAPI」（webapi.yanoshin.jp、TDnet 適時開示の公開 JSON API）から日ごとに取る。

取得済みの日は data/tdnet.json にキャッシュし、毎回取り直すのは直近 RECENT 日だけ。
fetch_data.py の後に実行する（earnings.json を作り直した後に時刻を付け直す）。

使い方: python3 scripts/fetch_tdnet.py [取りに行く日数の上限=60]
"""
from __future__ import annotations

import datetime as dt
import json
import sys
import time
import unicodedata
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "data" / "tdnet.json"
EARN = ROOT / "site" / "data" / "earnings.json"
API = "https://webapi.yanoshin.jp/webapi/tdnet/list/{}.json?limit=10000"
JST = dt.timezone(dt.timedelta(hours=9))
BACK = 400     # 何日前まで遡って記録するか
RECENT = 3     # 直近この日数は毎回取り直す（当日分は開示が増えていくため）
MAX_FETCH = int(sys.argv[1]) if len(sys.argv) > 1 else 60  # 1回の実行で取りに行く日数の上限


def get(day: dt.date) -> list[dict]:
    url = API.format(day.strftime("%Y%m%d"))
    for i in range(3):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "kabu-calendar (personal)"})
            with urllib.request.urlopen(req, timeout=180) as r:
                return [x["Tdnet"] for x in json.loads(r.read()).get("items", [])]
        except Exception:  # noqa: BLE001
            if i == 2:
                raise
            time.sleep(5 * (i + 1))
    return []


def code4(c: str) -> str:
    # TDnet は 5 桁（末尾 0）。130A0 → 130A
    c = unicodedata.normalize("NFKC", c or "")
    return c[:4] if len(c) == 5 else c


def is_tanshin(title: str) -> bool:
    t = unicodedata.normalize("NFKC", title or "")
    return "決算短信" in t and "訂正" not in t and "修正" not in t


def main() -> int:
    now = dt.datetime.now(JST)
    today = now.date()
    try:
        cache = json.loads(CACHE.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        cache = {"days": [], "e": {}}
    done = set(cache["days"])
    rec: dict[str, dict[str, str]] = cache["e"]

    start = today - dt.timedelta(days=BACK)
    days = [start + dt.timedelta(days=i) for i in range(BACK + 1)]
    days = [d for d in days if d.weekday() < 5]
    todo = [d for d in reversed(days) if d.isoformat() not in done or (today - d).days < RECENT][:MAX_FETCH]
    ok = 0
    for d in todo:
        try:
            items = get(d)
        except Exception as e:  # noqa: BLE001
            print(f"tdnet: {d} 取得失敗 {type(e).__name__}", file=sys.stderr)
            continue
        for x in items:
            if not is_tanshin(x.get("title")):
                continue
            ds, hm = x["pubdate"][:10], x["pubdate"][11:16]
            c = code4(x.get("company_code"))
            # 同じ日に複数出たら最初の時刻（決算短信は通常1回）
            if c and (ds not in rec.setdefault(c, {}) or hm < rec[c][ds]):
                rec[c][ds] = hm
        if (today - d).days >= 1 or now.hour >= 20:  # 当日分は夜まで確定しない
            done.add(d.isoformat())
        ok += 1
        time.sleep(1)
    cut = start.isoformat()
    cache = {"days": sorted(x for x in done if x >= cut),
             "e": {c: {d: t for d, t in sorted(v.items()) if d >= cut} for c, v in sorted(rec.items())}}
    cache["e"] = {c: v for c, v in cache["e"].items() if v}
    CACHE.write_text(json.dumps(cache, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    # earnings.json に時刻を付ける
    try:
        earn = json.loads(EARN.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        print("tdnet: earnings.json が無いのでスキップ", file=sys.stderr)
        return 0
    n_act = n_prev = 0
    for e in earn:
        e.pop("tp", None)
        d, r = e.get("d"), cache["e"].get(e.get("c"), {})
        if not d or not r:
            continue
        if d in r:
            e["t"] = r[d]
            n_act += 1
        elif d >= today.isoformat():
            prev = max((x for x in r if x < d), default=None)
            if prev:
                e["t"], e["tp"] = r[prev], prev
                n_prev += 1
    EARN.write_text(json.dumps(earn, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"tdnet: {ok}/{len(todo)} 日取得・記録 {len(cache['days'])} 日 {len(cache['e'])} 社 / "
          f"決算に時刻を付与 実績 {n_act}・前回の時刻 {n_prev}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
