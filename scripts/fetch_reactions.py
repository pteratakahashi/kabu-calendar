#!/usr/bin/env python3
"""発表済みイベント・決算の「株価の反応」を集めて site/data/reactions.json に蓄積する。

- 時刻つきイベント（雇用統計・FOMC・日銀など）: 発表前60分〜後180分の5分足（騰落率%）
    米国・海外: S&P500先物 / 日経先物 / ドル円、日本の場中: 日経平均 / ドル円
- 海外企業決算（ticker つき）: その銘柄の5分足（時間外含む）＋ 日本の関連テーマ主力株の翌営業日騰落率
- 国内決算（★2以上・テーマ銘柄・時刻つきイベント）: 反応日の騰落率と前後の日足
    15:30 以降（または時刻不明）の発表は翌営業日を反応日とする

データ: Yahoo Finance（yfinance, 非公式）。5分足は直近60日しか取れないので毎日実行して蓄積する。
自分用プロトタイプ限定。販売時は正式なデータ契約に切り替えること。
"""
from __future__ import annotations

import datetime as dt
import json
import sys
from pathlib import Path

import pandas as pd
import yfinance as yf

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "site" / "data"
OUT = DATA / "reactions.json"
JST = "Asia/Tokyo"

PRE_MIN, POST_MIN = 60, 180
INTRADAY_DAYS = 58  # 5分足の取得上限(60日)より少し短く

NAMES = {"ES=F": "S&P500先物", "NIY=F": "日経先物", "JPY=X": "ドル円", "^N225": "日経平均"}


def log(*a):
    print(*a, file=sys.stderr)


def load(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def closes(df: pd.DataFrame, sym: str | None = None) -> pd.Series:
    """yf.download の結果から終値 Series を取り出す（単一/複数ティッカー両対応）。"""
    if df is None or df.empty:
        return pd.Series(dtype=float)
    if isinstance(df.columns, pd.MultiIndex):
        lv0 = df.columns.get_level_values(0)
        if sym is not None and sym in lv0:
            s = df[sym]["Close"]
        elif "Close" in lv0:
            s = df["Close"]
            s = s[sym] if sym is not None and sym in getattr(s, "columns", []) else s.squeeze()
        else:
            return pd.Series(dtype=float)
    else:
        s = df["Close"]
    return pd.to_numeric(s.squeeze(), errors="coerce").dropna()


# ------------------------------------------------------------- intraday

_cache: dict[str, pd.Series] = {}


def intraday(sym: str) -> pd.Series:
    if sym not in _cache:
        try:
            df = yf.download(sym, period=f"{INTRADAY_DAYS}d", interval="5m", prepost=True,
                             progress=False, auto_adjust=False)
            s = closes(df, sym)
            if not s.empty:
                s.index = s.index.tz_convert(JST)
            _cache[sym] = s
        except Exception as e:  # noqa: BLE001
            log(f"  intraday {sym} failed: {e}")
            _cache[sym] = pd.Series(dtype=float)
    return _cache[sym]


def window(sym: str, t: pd.Timestamp) -> dict | None:
    s = intraday(sym)
    if s.empty:
        return None
    before = s[s.index < t]
    if before.empty or (t - before.index[-1]) > pd.Timedelta("3h"):
        return None  # 発表前の値が無い（休場など）
    base = float(before.iloc[-1])
    w = s[(s.index >= t - pd.Timedelta(minutes=PRE_MIN)) & (s.index <= t + pd.Timedelta(minutes=POST_MIN))]
    if len(w) < 6:
        return None
    pts = [[int((i - t).total_seconds() // 60), round((float(v) / base - 1) * 100, 3)] for i, v in w.items()]
    after = [p for p in pts if p[0] >= 0]
    if not after:
        return None

    def at(m):
        c = [p for p in after if p[0] <= m]
        return c[-1][1] if c else None

    return {
        "sym": sym, "name": NAMES.get(sym, sym), "base": round(base, 4),
        "m5": at(5), "m30": at(30), "m60": at(60), "end": after[-1][1],
        "hi": max(p[1] for p in after), "lo": min(p[1] for p in after),
        "pts": pts,
    }


def instruments(ev: dict) -> list[str]:
    if ev.get("ticker"):
        return [ev["ticker"]]
    if ev.get("country") == "JP":
        hh = int(ev["t"][:2])
        return ["^N225" if 9 <= hh < 15 else "NIY=F", "JPY=X"]
    return ["ES=F", "NIY=F", "JPY=X"]


# ------------------------------------------------------------- daily (国内株)

def daily_closes(codes: list[str]) -> dict[str, pd.Series]:
    if not codes:
        return {}
    tick = [f"{c}.T" for c in codes]
    out = {}
    for i in range(0, len(tick), 100):
        chunk = tick[i:i + 100]
        try:
            df = yf.download(chunk, period="6mo", interval="1d", progress=False, auto_adjust=False,
                             group_by="ticker", threads=True)
        except Exception as e:  # noqa: BLE001
            log(f"  daily chunk failed: {e}")
            continue
        for t in chunk:
            s = closes(df, t)
            if not s.empty:
                s.index = pd.to_datetime(s.index).tz_localize(None).normalize()
                out[t[:-2]] = s
    return out


def daily_reaction(s: pd.Series, react_day: dt.date) -> dict | None:
    """反応日の終値 / 前営業日終値。前後5営業日の推移も返す。"""
    if s is None or s.empty:
        return None
    idx = s.index
    after = idx[idx >= pd.Timestamp(react_day)]
    if after.empty:
        return None
    i = idx.get_loc(after[0])
    if i == 0:
        return None
    prev = float(s.iloc[i - 1])
    lo, hi = max(0, i - 6), min(len(s), i + 6)
    series = [[d.strftime("%m-%d"), round((float(v) / prev - 1) * 100, 2)] for d, v in s.iloc[lo:hi].items()]
    return {
        "day": idx[i].strftime("%Y-%m-%d"),
        "r": round((float(s.iloc[i]) / prev - 1) * 100, 2),
        "pts": series, "k": i - lo,  # k = 反応日の位置
        "done": hi - i >= 6,  # 反応日後のデータが揃ったら確定
    }


def react_day_jp(d: str, t: str | None) -> dt.date:
    day = dt.date.fromisoformat(d)
    if t and t < "15:00":
        return day  # 場中・寄り前の発表は当日が反応日（15時以降の発表は実質翌日に反映）
    return day + dt.timedelta(days=1)  # 引け後は翌営業日（土日は daily_reaction 側で次の営業日に寄る）


# ------------------------------------------------------------- main

def main() -> int:
    now = pd.Timestamp.now(tz=JST)
    events = load(DATA / "events.json", [])
    earnings = load(DATA / "earnings.json", [])
    stocks = {s["c"]: s for s in load(DATA / "stocks.json", [])}
    themes = {t["id"]: t for t in load(DATA / "themes.json", [])}
    out = load(OUT, {"events": {}, "earnings": {}})
    out.setdefault("events", {})
    out.setdefault("earnings", {})

    oldest = (now - pd.Timedelta(days=INTRADAY_DAYS - 1)).strftime("%Y-%m-%d")

    # 1) 時刻つきイベントの5分足
    lead_needed: dict[str, list[str]] = {}  # event id -> 関連主力株コード
    for ev in events:
        if ev.get("auto") or ev.get("code") or ev["d"] < oldest or ev["d"] > now.strftime("%Y-%m-%d"):
            continue
        if not ev.get("t") and not ev.get("ticker"):
            continue
        t = pd.Timestamp(f'{ev["d"]} {ev.get("t") or "15:30"}', tz=JST)
        if t > now:
            continue
        prev = out["events"].get(ev["id"]) or {}
        if prev.get("done"):
            continue
        # 発表時刻に市場が開いていない銘柄（TSMC月次の米ADR等）は5分足なし → 日本株の反応だけ出す
        series = [w for sym in instruments(ev) if (w := window(sym, t))] if ev.get("t") else []
        if not series and not ev.get("ticker"):
            continue
        rec = {"t": t.isoformat(), "series": series, "done": now >= t + pd.Timedelta(minutes=POST_MIN + 15)}
        out["events"][ev["id"]] = {**prev, **rec}
        if ev.get("ticker"):
            codes = []
            for th in ev.get("themes", []):
                codes += [c for c in themes.get(th, {}).get("lead", []) if c not in codes]
            if codes:
                lead_needed[ev["id"]] = codes[:6]
        log(f"  event {ev['id']}: {', '.join(s['name'] for s in series) or '(日本株のみ)'}")

    # 2) 国内決算の対象を決める
    targets: dict[str, tuple[str, str, str | None]] = {}  # key -> (code, date, time)
    today = now.strftime("%Y-%m-%d")
    since = (now - pd.Timedelta(days=150)).strftime("%Y-%m-%d")
    theme_codes = {c for t in themes.values() for c in t["codes"]}
    timed = {ev["code"]: ev for ev in events if ev.get("code")}
    for e in earnings:
        if not e.get("d") or not (since <= e["d"] <= today):
            continue
        st = stocks.get(e["c"], {})
        if st.get("imp", 1) < 2 and e["c"] not in theme_codes:
            continue
        key = f'{e["c"]}@{e["d"]}'
        if out["earnings"].get(key, {}).get("done"):
            continue
        tev = timed.get(e["c"])
        targets[key] = (e["c"], e["d"], tev["t"] if tev and tev["d"] == e["d"] else None)

    codes = sorted({c for c, _, _ in targets.values()} | {c for v in lead_needed.values() for c in v})
    log(f"  daily: {len(codes)} codes")
    daily = daily_closes(codes)

    for key, (c, d, t) in targets.items():
        r = daily_reaction(daily.get(c), react_day_jp(d, t))
        if r:
            out["earnings"][key] = r

    # 3) 海外決算 → 日本の主力株の反応（イベントの JST 日付が反応日。早朝発表のため）
    for eid, cs in lead_needed.items():
        ev = next(e for e in events if e["id"] == eid)
        day = dt.date.fromisoformat(ev["d"])
        if (ev.get("t") or "15:30") >= "15:00":
            day += dt.timedelta(days=1)
        leads = []
        for c in cs:
            r = daily_reaction(daily.get(c), day)
            if r:
                leads.append({"c": c, "n": stocks.get(c, {}).get("n", c), "r": r["r"], "day": r["day"]})
        if leads:
            out["events"][eid]["jp"] = leads
        # 日本株の反応日のデータが揃うまでは未確定扱い
        if len(leads) < len(cs) or not leads:
            out["events"][eid]["done"] = False

    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    log(f"done: events={len(out['events'])} earnings={len(out['earnings'])}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
