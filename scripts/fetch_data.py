#!/usr/bin/env python3
"""株イベントカレンダー用データを生成する。

出力 (site/data/):
  earnings.json  決算発表予定 [{d, c, n, q, fye, mkt, src}]  d=YYYY-MM-DD or "" (未定)
  stocks.json    銘柄一覧 [{c, n, mkt, w, sz, th, imp}]  w=TOPIXウエイト(%), sz=規模区分, th=テーマid, imp=影響度1-3
  events.json    イベント = data/events.json（Claude が毎日調査）+ SQ（自動計算）
  themes.json    テーマ定義 (data/themes.json をコピー)
  meta.json      最終更新日時・件数・各ソースの成否

データ源:
  1. JPX「決算発表予定日」Excel（全決算期。メイン）
  2. J-Quants V2 /equities/earnings-calendar（3・9月期。JPXに無い分の補完）
  3. J-Quants V2 /equities/master（検索用銘柄一覧。Freeは12週遅延）
  4. JPX TOPIX 構成銘柄ウエイト CSV（規模順・影響度の判定。月次更新）
  J-Quants は環境変数 JQUANTS_API_KEY がある時だけ使う。無ければ JPX のみで動く。
"""
from __future__ import annotations

import csv
import datetime as dt
import io
import json
import os
import re
import sys
import time
import unicodedata
import urllib.request
from pathlib import Path

import openpyxl

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "site" / "data"
JST = dt.timezone(dt.timedelta(hours=9))
UA = "kabu-calendar/0.1 (personal use)"

JPX_PAGE = "https://www.jpx.co.jp/listing/event-schedules/financial-announcement/index.html"
JQ_BASE = "https://api.jquants.com/v2"
TOPIX_CSV = "https://www.jpx.co.jp/automation/markets/indices/topix/files/topixweight_j.csv"
SIZE = {"TOPIX Core30": "Core30", "TOPIX Large70": "Large70", "TOPIX Mid400": "Mid400",
        "TOPIX Small 1": "Small1", "TOPIX Small 2": "Small2"}

KEEP_PAST_DAYS = 400  # 過去分はこの日数だけ保持（JPX Excel は直近分しか載らないため蓄積する）

QUARTER = {"第１四半期": "1Q", "第２四半期": "2Q", "第３四半期": "3Q", "第４四半期": "4Q", "本決算": "FY"}


def http_get(url: str, headers: dict | None = None, retries: int = 3) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA, **(headers or {})})
    for i in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001
            if i == retries - 1:
                raise
            print(f"  retry {url.split('?')[0]}: {e}", file=sys.stderr)
            time.sleep(3 * (i + 1))
    raise RuntimeError("unreachable")


def norm_code(code) -> str:
    """銘柄コードを4桁(英字含む)に揃える。J-Quants の5桁コードは末尾0を落とす。"""
    s = str(code).strip()
    if len(s) == 5 and s.endswith("0"):
        s = s[:4]
    return s


def nfkc(s) -> str:
    """全角英数を半角に（ＭＲＫ→MRK）。検索と表示を揃えるため。"""
    return unicodedata.normalize("NFKC", str(s or "")).strip()


def fmt_date(v) -> str:
    if isinstance(v, (dt.datetime, dt.date)):
        return v.strftime("%Y-%m-%d")
    return ""  # "未定_Undecided" 等


# ---------------------------------------------------------------- JPX

def fetch_jpx() -> list[dict]:
    html = http_get(JPX_PAGE).decode("utf-8", "replace")
    links = sorted(set(re.findall(r'href="([^"]+\.xlsx)"', html)))
    if not links:
        raise RuntimeError("JPX ページに xlsx リンクが見つからない（ページ構成変更の可能性）")
    rows: list[dict] = []
    for href in links:
        url = href if href.startswith("http") else "https://www.jpx.co.jp" + href
        print(f"  JPX {url.rsplit('/', 1)[-1]}")
        ws = openpyxl.load_workbook(io.BytesIO(http_get(url)), read_only=True).active
        for r in ws.iter_rows(values_only=True):
            if not r or len(r) < 11 or r[1] is None:
                continue
            date_cell, code, name, _en, fye, sector, _sec_en, kind, _kind_en, mkt, _mkt_en = r[:11]
            if not re.fullmatch(r"[0-9A-Z]{4}", str(code).strip()):
                continue  # 見出し行・注記行
            rows.append({
                "d": fmt_date(date_cell),
                "c": norm_code(code),
                "n": nfkc(name),
                "q": QUARTER.get(str(kind).strip(), str(kind).strip()),
                "fye": fmt_date(fye),
                "mkt": str(mkt or "").strip(),
                "sec": str(sector or "").strip(),
                "src": "jpx",
            })
        time.sleep(1)
    return rows


# ---------------------------------------------------------------- J-Quants

def jq_get_all(path: str, key: str, params: dict | None = None) -> list[dict]:
    out: list[dict] = []
    q = dict(params or {})
    while True:
        qs = "&".join(f"{k}={v}" for k, v in q.items())
        payload = json.loads(http_get(f"{JQ_BASE}{path}{'?' + qs if qs else ''}", {"x-api-key": key}))
        out.extend(payload.get("data", []))
        pk = payload.get("pagination_key")
        if not pk:
            return out
        q["pagination_key"] = pk


def fetch_jq_calendar(key: str) -> list[dict]:
    rows = []
    for r in jq_get_all("/equities/earnings-calendar", key):
        rows.append({
            "d": str(r.get("Date", ""))[:10],
            "c": norm_code(r.get("Code", "")),
            "n": nfkc(r.get("CoName")),
            "q": str(r.get("FQ", "")),
            "fye": "",
            "mkt": r.get("Section", ""),
            "sec": r.get("SectorNm", ""),
            "src": "jquants",
        })
    return rows


def fetch_jq_master(key: str) -> list[dict]:
    seen = {}
    for r in jq_get_all("/equities/master", key):
        c = norm_code(r.get("Code", ""))
        seen[c] = {"c": c, "n": nfkc(r.get("CoName")), "mkt": r.get("MktNm", "")}
    return list(seen.values())


# ---------------------------------------------------------------- TOPIX / 影響度

def fetch_topix() -> dict[str, dict]:
    """コード -> {w: TOPIXウエイト%, sz: 規模区分}。ウエイト≒浮動株時価総額の比率なので規模順に使う。"""
    text = http_get(TOPIX_CSV).decode("cp932", "replace")
    out = {}
    for row in csv.DictReader(io.StringIO(text)):
        code = (row.get("コード") or "").strip()
        if not code:
            continue
        try:
            w = float((row.get("TOPIXに占める個別銘柄のウエイト") or "0").rstrip("%"))
        except ValueError:
            w = 0.0
        out[norm_code(code)] = {"w": w, "n": nfkc(row.get("銘柄名")), "sz": SIZE.get((row.get("ニューインデックス区分") or "").strip(), "")}
    return out


def enrich_stocks(stocks: list[dict], topix: dict, themes: list[dict]) -> None:
    """規模・テーマ・影響度を付ける。
    影響度 3: Core30 またはテーマの主力株 / 2: Large70 またはテーマ銘柄 / 1: その他"""
    th_of: dict[str, list[str]] = {}
    lead: set[str] = set()
    for t in themes:
        for c in t["codes"]:
            th_of.setdefault(c, []).append(t["id"])
        lead.update(t.get("lead", []))
    for s in stocks:
        s["n"] = nfkc(s["n"])
        tp = topix.get(s["c"], {})
        s["w"] = tp.get("w", 0.0)
        s["sz"] = tp.get("sz", "")
        s["th"] = th_of.get(s["c"], [])
        if s["sz"] == "Core30" or s["c"] in lead:
            s["imp"] = 3
        elif s["sz"] == "Large70" or s["th"]:
            s["imp"] = 2
        else:
            s["imp"] = 1


def gen_sq(today: dt.date) -> list[dict]:
    """SQ（毎月第2金曜）。3・6・9・12月はメジャーSQ。祝日による前倒しは未対応（稀）。"""
    out = []
    y, m = today.year, today.month
    for i in range(-2, 7):
        yy, mm = y + (m - 1 + i) // 12, (m - 1 + i) % 12 + 1
        d = dt.date(yy, mm, 1)
        d += dt.timedelta(days=(4 - d.weekday()) % 7 + 7)  # 第2金曜
        major = mm in (3, 6, 9, 12)
        out.append({
            "id": f"{d.isoformat()}-sq", "d": d.isoformat(), "country": "JP",
            "title": "メジャーSQ" if major else "オプションSQ",
            "desc": "先物・オプションの特別清算日。前日〜当日朝は値動きが荒れやすい" if major
                    else "日経225オプションの特別清算日",
            "impact": 3 if major else 1, "themes": [], "auto": True,
        })
    return out


# ---------------------------------------------------------------- merge

def load_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def entry_key(e: dict) -> tuple:
    # 同じ会社・同じ決算期・同じ区分 = 同一イベント（予定日変更は上書き）
    return (e["c"], e.get("fye", ""), e["q"])


def merge(previous: list[dict], jpx: list[dict], jq: list[dict]) -> list[dict]:
    today = dt.datetime.now(JST).date()
    cutoff = (today - dt.timedelta(days=KEEP_PAST_DAYS)).isoformat()
    merged: dict[tuple, dict] = {}
    for e in previous:
        if e.get("d") and e["d"] >= cutoff:
            merged[entry_key(e)] = e
    for e in jpx:
        merged[entry_key(e)] = e
    # J-Quants は fye を持たないので (code, date) で JPX と突き合わせ、JPX に無いものだけ足す
    have = {(e["c"], e["d"]) for e in merged.values()}
    for e in jq:
        if e["d"] and (e["c"], e["d"]) not in have:
            merged[(e["c"], "", e["q"], e["d"])] = e
    return sorted(merged.values(), key=lambda e: (e["d"] or "9999", e["c"]))


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    meta = {"sources": {}}
    key = os.environ.get("JQUANTS_API_KEY", "").strip()

    jpx: list[dict] = []
    try:
        jpx = fetch_jpx()
        meta["sources"]["jpx"] = {"ok": True, "count": len(jpx)}
    except Exception as e:  # noqa: BLE001
        print(f"JPX failed: {e}", file=sys.stderr)
        meta["sources"]["jpx"] = {"ok": False, "error": str(e)[:200]}

    jq_cal: list[dict] = []
    stocks: list[dict] = []
    if key:
        try:
            jq_cal = fetch_jq_calendar(key)
            meta["sources"]["jquants_calendar"] = {"ok": True, "count": len(jq_cal)}
        except Exception as e:  # noqa: BLE001
            # エラー文にキーが含まれないよう、型名とHTTPステータス程度だけ残す
            print(f"J-Quants calendar failed: {type(e).__name__}", file=sys.stderr)
            meta["sources"]["jquants_calendar"] = {"ok": False, "error": type(e).__name__}
        try:
            stocks = fetch_jq_master(key)
            meta["sources"]["jquants_master"] = {"ok": True, "count": len(stocks)}
        except Exception as e:  # noqa: BLE001
            print(f"J-Quants master failed: {type(e).__name__}", file=sys.stderr)
            meta["sources"]["jquants_master"] = {"ok": False, "error": type(e).__name__}
    else:
        meta["sources"]["jquants"] = {"ok": False, "error": "JQUANTS_API_KEY 未設定"}

    if not jpx and not jq_cal:
        print("全データソース失敗。既存データを保持して終了。", file=sys.stderr)
        return 1

    earnings = merge(load_json(OUT / "earnings.json", []), jpx, jq_cal)

    # 銘柄一覧: J-Quants master + 決算データに出てくる銘柄（新規上場の補完）
    by_code = {s["c"]: s for s in (stocks or load_json(OUT / "stocks.json", []))}
    for e in earnings:
        by_code.setdefault(e["c"], {"c": e["c"], "n": e["n"], "mkt": e.get("mkt", "")})
        by_code[e["c"]].setdefault("sec", e.get("sec", ""))
    stocks = sorted(by_code.values(), key=lambda s: s["c"])

    themes = load_json(ROOT / "data" / "themes.json", [])
    topix: dict = {}
    try:
        topix = fetch_topix()
        meta["sources"]["topix"] = {"ok": True, "count": len(topix)}
    except Exception as e:  # noqa: BLE001
        print(f"TOPIX failed: {e}", file=sys.stderr)
        meta["sources"]["topix"] = {"ok": False, "error": str(e)[:200]}
        # 失敗時は前回の値を使う
        topix = {s["c"]: {"w": s.get("w", 0.0), "sz": s.get("sz", "")} for s in load_json(OUT / "stocks.json", [])}
    for c, tp in topix.items():  # 決算予定に無い TOPIX 銘柄も検索できるように
        if c not in by_code and tp.get("n"):
            by_code[c] = {"c": c, "n": tp["n"], "mkt": "プライム"}
    stocks = sorted(by_code.values(), key=lambda s: s["c"])
    enrich_stocks(stocks, topix, themes)

    today = dt.datetime.now(JST).date()
    events = load_json(ROOT / "data" / "events.json", []) + gen_sq(today)
    events.sort(key=lambda e: (e["d"], e.get("t") or "99:99"))

    now = dt.datetime.now(JST)
    meta.update({
        "updated_at": now.isoformat(timespec="seconds"),
        "earnings_count": len(earnings),
        "stocks_count": len(stocks),
        "events_count": len(events),
    })

    def dump(name, obj):
        (OUT / name).write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    dump("earnings.json", earnings)
    dump("stocks.json", stocks)
    dump("events.json", events)
    dump("themes.json", themes)
    (OUT / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"done: earnings={len(earnings)} stocks={len(stocks)} events={len(events)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
