#!/usr/bin/env python3
"""発表済みイベント・決算の「株価の反応」を集めて site/data/reactions.json に蓄積する。

- 時刻つきイベント（雇用統計・FOMC・日銀など）: 発表前60分〜後180分の5分足（騰落率%）
    米国・海外: S&P500先物 / 日経先物 / ドル円、日本の場中: 日経平均 / ドル円
- 海外企業決算（ticker つき）: その銘柄の5分足（時間外含む）＋ 日本の関連テーマ主力株の翌営業日騰落率
- 国内決算（★2以上・テーマ銘柄・時刻つきイベント）: 反応日の騰落率と前後の日足
    15:30 以降（または時刻不明）の発表は翌営業日を反応日とする

- 予定外ニュース（data/news.json）: 反応日・1週間後・1か月後の騰落率（日経平均/S&P500/SOX/関連テーマ主力株/関連銘柄）
- 保有銘柄用（日経225採用銘柄）: 銘柄ごとに site/data/h/<コード>.json を作る。
    各イベントの反応日・各ニュースの反応日/1週間後/1か月後の騰落率（並びは h/index.json の id 順）
- 「過去10回」用: 指標は前年分まで（1時間足は730日まで取れる）、国内決算は約3年分、
    全イベントに反応日の日経平均騰落率（d1）を付ける

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

PRE_MIN, POST_MIN = 60, 180          # 5分足の窓
PRE_MIN_H, POST_MIN_H = 180, 360     # 1時間足の窓（60日より前のイベント）
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

_cache: dict[tuple, pd.Series] = {}
EV_START = (pd.Timestamp.now(tz=JST) - pd.Timedelta(days=720)).strftime("%Y-%m-%d")   # 1時間足の取得上限(730日)の内側
EARN_START = (pd.Timestamp.now(tz=JST) - pd.Timedelta(days=365 * 3)).strftime("%Y-%m-%d")  # 国内決算の過去10回用
DAILY_START = (pd.Timestamp(EARN_START) - pd.Timedelta(days=20)).strftime("%Y-%m-%d")


def intraday(sym: str, iv: str = "5m") -> pd.Series:
    """終値の Series。index は「その足の終了時刻」（足の開始時刻 + 足の長さ）に直す。"""
    key = (sym, iv)
    if key not in _cache:
        try:
            kw = {"period": f"{INTRADAY_DAYS}d"} if iv == "5m" else {"start": EV_START}
            df = yf.download(sym, interval=iv, prepost=True, progress=False, auto_adjust=False, **kw)
            s = closes(df, sym)
            if not s.empty:
                s.index = s.index.tz_convert(JST) + pd.Timedelta(iv.replace("m", "min"))
            _cache[key] = s
        except Exception as e:  # noqa: BLE001
            log(f"  intraday {sym} {iv} failed: {e}")
            _cache[key] = pd.Series(dtype=float)
    return _cache[key]


def window(sym: str, t: pd.Timestamp, iv: str = "5m") -> dict | None:
    s = intraday(sym, iv)
    if s.empty:
        return None
    pre, post = (PRE_MIN, POST_MIN) if iv == "5m" else (PRE_MIN_H, POST_MIN_H)
    before = s[s.index <= t]
    if before.empty or (t - before.index[-1]) > pd.Timedelta("3h"):
        return None  # 発表前の値が無い（休場など）
    base = float(before.iloc[-1])
    w = s[(s.index >= t - pd.Timedelta(minutes=pre)) & (s.index <= t + pd.Timedelta(minutes=post))]
    if len(w) < (6 if iv == "5m" else 4):
        return None
    pts = [[int((i - t).total_seconds() // 60), round((float(v) / base - 1) * 100, 3)] for i, v in w.items()]
    after = [p for p in pts if p[0] >= 0]
    if not after:
        return None

    def at(m):
        c = [p for p in after if p[0] <= m]
        return c[-1][1] if c else None

    marks = ([["5分後", at(5)], ["30分後", at(30)], ["1時間後", at(60)], ["3時間後", after[-1][1]]] if iv == "5m"
             else [["1時間後", at(60)], ["3時間後", at(180)], ["6時間後", after[-1][1]]])
    return {
        "sym": sym, "name": NAMES.get(sym, sym), "base": round(base, 4), "iv": iv, "marks": marks,
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
            df = yf.download(chunk, start=DAILY_START, interval="1d", progress=False, auto_adjust=False,
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


_idx_cache: dict[str, pd.Series] = {}


def dclose(sym: str) -> pd.Series:
    """指数・海外銘柄の日足終値（index は日付）。"""
    if sym not in _idx_cache:
        try:
            df = yf.download(sym, start=DAILY_START, interval="1d", progress=False, auto_adjust=False)
            s = closes(df, sym)
            s.index = pd.to_datetime(s.index).tz_localize(None).normalize()
            _idx_cache[sym] = s
        except Exception as e:  # noqa: BLE001
            log(f"  daily {sym} failed: {e}")
            _idx_cache[sym] = pd.Series(dtype=float)
    return _idx_cache[sym]


def index_daily(sym: str, name: str, d: str) -> dict | None:
    r = daily_reaction(dclose(sym), dt.date.fromisoformat(d) + dt.timedelta(days=1))
    return {**r, "sym": sym, "name": name} if r else None


def us_react_day(t: pd.Timestamp) -> dt.date:
    """米国市場で最初に反応する取引日（米東部 16:00 以降の発表は翌日。休場は daily 側で次に寄る）。"""
    et = t.tz_convert("America/New_York")
    return (et + pd.Timedelta(days=1)).date() if et.hour >= 16 else et.date()


def path(s: pd.Series | None, react_day: dt.date, pre: int = 5, post: int = 20) -> dict | None:
    """反応日の前日終値=0% とした、反応日・5営業日目・20営業日目の騰落率と推移。"""
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
    rel = lambda j: round((float(s.iloc[j]) / prev - 1) * 100, 2) if j < len(s) else None  # noqa: E731
    lo, hi = max(0, i - pre), min(len(s), i + post)
    return {
        "day": idx[i].strftime("%Y-%m-%d"), "r1": rel(i), "r5": rel(i + 4), "r20": rel(i + 19),
        "pts": [[d.strftime("%m-%d"), round((float(v) / prev - 1) * 100, 2)] for d, v in s.iloc[lo:hi].items()],
        "k": i - lo, "done": len(s) > i + 19,
    }


NEWS_IDX = (("^N225", "日経平均"), ("^GSPC", "S&P500"), ("^SOX", "SOX指数"), ("JPY=X", "ドル円"))
SOX_THEMES = {"semi", "semiequip", "semimat", "ai", "datacenter"}


def news_reaction(n: dict, themes: dict, stocks: dict, daily: dict) -> dict | None:
    t = pd.Timestamp(f'{n["d"]} {n.get("t") or "12:00"}', tz=JST)
    jp_day = react_day_jp(n["d"], n.get("t") or "12:00")  # 時刻不明は「その日の場中に伝わった」扱い
    us_day = us_react_day(t)
    idx = []
    for sym, name in NEWS_IDX:
        if sym == "^SOX" and not (set(n.get("themes", [])) & SOX_THEMES):
            continue
        p = path(dclose(sym), us_day if sym in ("^GSPC", "^SOX") else jp_day)
        if p:
            idx.append({"sym": sym, "name": name, **p})
    if not idx:
        return None
    rec = {"idx": idx}
    # 関連テーマ主力株の平均
    lead = []
    for th in n.get("themes", []):
        lead += [c for c in themes.get(th, {}).get("lead", []) if c not in lead]
    lead = lead[:8]
    ps = [p for c in lead if (p := path(daily.get(c), jp_day))]
    if ps:
        def avg(k):
            v = [p[k] for p in ps if p[k] is not None]
            return round(sum(v) / len(v), 2) if v else None
        rec["theme"] = {"n": len(ps), "codes": lead, "r1": avg("r1"), "r5": avg("r5"), "r20": avg("r20")}
    st = []
    for c in n.get("codes", []):
        if (p := path(daily.get(c), jp_day)):
            st.append({"c": c, "n": stocks.get(c, {}).get("n", c), "r1": p["r1"], "r5": p["r5"], "r20": p["r20"]})
    for tk in n.get("tickers", []):
        if (p := path(dclose(tk), us_day)):
            st.append({"c": tk, "n": tk, "r1": p["r1"], "r5": p["r5"], "r20": p["r20"], "us": True})
    if st:
        rec["stocks"] = st
    rec["done"] = all(x["done"] for x in idx)
    return rec


def react_day_jp(d: str, t: str | None) -> dt.date:
    day = dt.date.fromisoformat(d)
    if t and t < "15:00":
        return day  # 場中・寄り前の発表は当日が反応日（15時以降の発表は実質翌日に反映）
    return day + dt.timedelta(days=1)  # 引け後は翌営業日（土日は daily_reaction 側で次の営業日に寄る）


# ------------------------------------------------------------- main

def holding_day_r(s: pd.Series, day: str) -> float | None:
    """その日の終値 / 前営業日終値（その日に取引が無ければ None）。"""
    ts = pd.Timestamp(day)
    if s is None or s.empty or ts not in s.index:
        return None
    i = s.index.get_loc(ts)
    return round((float(s.iloc[i]) / float(s.iloc[i - 1]) - 1) * 100, 2) if i > 0 else None


def build_holdings(out: dict, news: list[dict], daily: dict, n225: list[str]) -> None:
    hdir = DATA / "h"
    hdir.mkdir(exist_ok=True)
    codes = sorted(set(n225) | {p.stem for p in hdir.glob("*.json") if p.stem != "index"})
    missing = [c for c in codes if c not in daily]
    daily.update(daily_closes(missing))
    # 日本株の反応日が決まっているイベント・ニュースだけ
    ev_ids, ev_days = [], []
    for eid, rec in out["events"].items():
        day = (rec.get("d1") or {}).get("nk_day") or next((x["day"] for x in rec.get("idx", []) if x["sym"] == "^N225"), None)
        if day:
            ev_ids.append(eid)
            ev_days.append(day)
    nw = [(n["id"], x["day"]) for n in news if (r := out["news"].get(n["id"]))
          for x in r["idx"] if x["sym"] == "^N225"]
    (hdir / "index.json").write_text(json.dumps({"ev": ev_ids, "news": [i for i, _ in nw]}, separators=(",", ":")),
                                     encoding="utf-8")
    n = 0
    for c in codes:
        s = daily.get(c)
        if s is None or s.empty:
            continue
        rets = s.pct_change().dropna().iloc[-250:]
        rec = {
            "c": c,
            "vol": round(float(rets.abs().mean()) * 100, 2),  # 普段の1日の値動き（直近250日の平均の振れ幅）
            "ev": [holding_day_r(s, d) for d in ev_days],
            "news": [[p["r1"], p["r5"], p["r20"]] if (p := path(s, dt.date.fromisoformat(d))) else None for _, d in nw],
        }
        (hdir / f"{c}.json").write_text(json.dumps(rec, separators=(",", ":")), encoding="utf-8")
        n += 1
    log(f"  holdings: {n} 銘柄")


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
        # 海外決算は日足（反応日の騰落率）だけでも過去10回の比較に使えるので3年分を対象にする
        if ev.get("auto") or ev.get("code") or ev["d"] < (EARN_START if ev.get("ticker") else EV_START) or ev["d"] > now.strftime("%Y-%m-%d"):
            continue
        if not ev.get("t") and not ev.get("ticker"):
            continue
        t = pd.Timestamp(f'{ev["d"]} {ev.get("t") or "15:30"}', tz=JST)
        if t > now:
            continue
        prev = out["events"].get(ev["id"]) or {}
        if prev.get("done"):
            continue
        iv = "5m" if ev["d"] >= oldest else "1h"
        # 発表時刻に市場が開いていない銘柄（TSMC月次の米ADR等）は足なし → 日本株の反応だけ出す
        series = [w for sym in instruments(ev) if (w := window(sym, t, iv))] if ev.get("t") else []
        if not series and not ev.get("ticker"):
            # 休場日（週末の選挙・地政学ニュース等）→ 次の取引日の終値ベースの騰落率
            jp = [r for sym, nm in (("^N225", "日経平均"), ("^GSPC", "S&P500"), ("JPY=X", "ドル円"))
                  if (r := index_daily(sym, nm, ev["d"]))]
            if jp:
                out["events"][ev["id"]] = {"t": t.isoformat(), "iv": "1d", "series": [], "idx": jp,
                                           "done": all(r["done"] for r in jp)}
                log(f"  event {ev['id']}: 休場明けの日足")
            continue
        rec = {"t": t.isoformat(), "iv": iv, "series": series,
               "done": now >= t + pd.Timedelta(minutes=(POST_MIN if iv == "5m" else POST_MIN_H) + 15)}
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
    since = EARN_START
    theme_codes = {c for t in themes.values() for c in t["codes"]}
    n225 = [x["c"] for x in load(DATA / "n225.json", {}).get("codes", [])]
    theme_codes |= set(n225)  # 日経225採用銘柄は保有銘柄に選べるので、過去の決算反応も全社分作る
    timed = {ev["code"]: ev for ev in events if ev.get("code")}
    # 過去10回の反応用に、アプリには出さない古い決算日（Yahoo 補完分）も対象にする。
    # 同じ銘柄の決算が前後4日以内に earnings.json にあれば（同じ回の日付ずれ）足さない
    near: dict[str, list[dt.date]] = {}
    for e in earnings:
        if e.get("d"):
            near.setdefault(e["c"], []).append(dt.date.fromisoformat(e["d"]))
    extra = [e for e in load(ROOT / "data" / "earnings_backfill.json", [])
             if not any(abs((dt.date.fromisoformat(e["d"]) - x).days) <= 4 for x in near.get(e["c"], []))]
    for e in earnings + extra:
        if not e.get("d") or not (since <= e["d"] <= today):
            continue
        st = stocks.get(e["c"], {})
        if st.get("imp", 1) < 2 and e["c"] not in theme_codes:
            continue
        key = f'{e["c"]}@{e["d"]}'
        if out["earnings"].get(key, {}).get("done"):
            continue
        tev = timed.get(e["c"])
        targets[key] = (e["c"], e["d"], tev["t"] if tev and tev["d"] == e["d"] else (e.get("t") or None))

    # 時刻つきで登録した国内決算イベントも対象に（Yahoo の決算日とずれていても拾う）
    for ev in events:
        if ev.get("code") and since <= ev["d"] <= today:
            key = f'{ev["code"]}@{ev["d"]}'
            if not out["earnings"].get(key, {}).get("done"):
                targets[key] = (ev["code"], ev["d"], ev.get("t"))

    news = load(DATA / "news.json", [])
    out.setdefault("news", {})
    news_codes = set()
    for n in news:
        news_codes |= set(n.get("codes", []))
        for th in n.get("themes", []):
            news_codes |= set(themes.get(th, {}).get("lead", [])[:8])
    codes = sorted({c for c, _, _ in targets.values()} | {c for v in lead_needed.values() for c in v} | news_codes)
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

    # 4) 全イベントに「反応日の日経平均」（過去10回の比較用）。海外決算はその銘柄の反応日騰落率も
    for ev in events:
        rec = out["events"].get(ev["id"])
        if not rec or (rec.get("d1") or {}).get("done"):
            continue
        t = pd.Timestamp(rec["t"]).tz_convert(JST)
        d1 = {}
        if (p := daily_reaction(dclose("^N225"), react_day_jp(ev["d"], t.strftime("%H:%M")))):
            d1["nk"], d1["nk_day"] = p["r"], p["day"]
        if ev.get("ticker") and (p := daily_reaction(dclose(ev["ticker"]), us_react_day(t))):
            d1["tk"], d1["tk_day"] = p["r"], p["day"]
        if d1:
            d1["done"] = "nk" in d1 and (pd.Timestamp(d1["nk_day"]) < pd.Timestamp(now.date()))
            rec["d1"] = d1

    # 5) 予定外ニュース
    for n in news:
        if n["d"] > now.strftime("%Y-%m-%d") or out["news"].get(n["id"], {}).get("done"):
            continue
        if (rec := news_reaction(n, themes, stocks, daily)):
            out["news"][n["id"]] = rec
    # 削除されたニュースの反応は捨てる
    ids = {n["id"] for n in news}
    out["news"] = {k: v for k, v in out["news"].items() if k in ids}

    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    # 6) 保有銘柄（日経225採用銘柄＋過去に採用されていた銘柄のファイルも更新し続ける）
    build_holdings(out, news, daily, n225)
    log(f"done: events={len(out['events'])} earnings={len(out['earnings'])} news={len(out['news'])}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
