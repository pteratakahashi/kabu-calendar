#!/usr/bin/env python3
"""速報（連想）: ニュースが出たら、連想で上がりそうな日本株を Claude に挙げてもらい、スマホに通知して結果を記録する。

このPC（WSL）で常に動かす見張り役。1分ごとに:
  1. ニュースを集める（Yahoo!ニュースのトピックス、Google ニュースのキーワード検索、TDnet の適時開示）
  2. 新しい見出しをまとめて Claude に渡し、「連想で買われそうな銘柄」があるものだけ返してもらう
  3. 銘柄コードを上場銘柄一覧（site/data/stocks.json）で確かめ、売買代金が少なすぎる銘柄に印を付ける
  4. ntfy（スマホの通知アプリ）と、設定があれば Discord に通知
  5. site/data/flash.json に記録して GitHub に置く（アプリの「速報」が読む）
5分ごとに、過去の速報の銘柄が通知後どう動いたか（5分後・30分後・その日の高値・引け・翌日・5営業日後）を書き足す。

設定は リポジトリ直下の .env（ANTHROPIC_API_KEY, NTFY_TOPIC, DISCORD_WEBHOOK_URL, FLASH_MODEL）。
使い方: .venv/bin/python scripts/flash/flash_watch.py [--once] [--dry]
"""
from __future__ import annotations

import base64
import datetime as dt
import email.utils
import hashlib
import json
import os
import re
import subprocess
import sys
import time
import traceback
import unicodedata
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

import anthropic
import pandas as pd
import yfinance as yf

ROOT = Path(__file__).resolve().parents[2]
STATE_DIR = ROOT / ".flash"
STATE = STATE_DIR / "state.json"
LIQ = STATE_DIR / "liquidity.json"
LOG = STATE_DIR / "watch.log"
OUT = STATE_DIR / "flash.json"  # 手元の控え（本体は GitHub の site/data/flash.json）
REPO = "pteratakahashi/kabu-calendar"
OUT_PATH = "site/data/flash.json"
JST = dt.timezone(dt.timedelta(hours=9))
UA = {"User-Agent": "Mozilla/5.0 (kabu-calendar flash; personal)"}

POLL = 60              # 何秒ごとにニュースを見るか
TRACK_EVERY = 300      # 何秒ごとに結果を更新するか
KEEP = 400             # flash.json に残す速報の数
MIN_STRENGTH = 2       # これ以上を通知（1〜3）
LIQ_MIN = 1e8          # 1日の売買代金（20日の中央値）がこれ未満は「売買しにくい」印
SAME_THEME_H = 3       # 同じテーマの速報は何時間以内なら通知をまとめるか
MODEL = os.environ.get("FLASH_MODEL", "claude-opus-5-5")
ONCE, DRY = "--once" in sys.argv, "--dry" in sys.argv

YAHOO = ["top-picks", "business", "it", "domestic", "world", "science"]
GNEWS_Q = [
    "情報漏洩 OR 情報漏えい OR 不正アクセス OR サイバー攻撃 OR ランサムウェア",
    "システム障害 OR 通信障害 OR 大規模障害",
    "地震 震度 OR 津波 OR 噴火",
    "感染拡大 OR 新型ウイルス OR 鳥インフルエンザ",
    "閣議決定 OR 政府 方針 OR 補正予算 OR 経済対策",
    "株 急騰 関連銘柄",
]
TDNET_KW = re.compile("不正アクセス|サイバー|ランサム|情報漏え|情報漏洩|個人情報|システム障害|ウイルス|感染|火災|爆発|事故|リコール|行政処分")


def log(*a):
    s = f"{dt.datetime.now(JST):%m-%d %H:%M:%S} " + " ".join(str(x) for x in a)
    print(s, flush=True)
    try:
        with LOG.open("a", encoding="utf-8") as f:
            f.write(s + "\n")
    except OSError:
        pass


def load_env():
    p = ROOT / ".env"
    if p.exists():
        for line in p.read_text(encoding="utf-8").splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"'))


def http(url: str, data: bytes | None = None, headers: dict | None = None, method: str | None = None, timeout=20) -> bytes:
    req = urllib.request.Request(url, data=data, headers={**UA, **(headers or {})}, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def norm(s: str) -> str:
    return unicodedata.normalize("NFKC", s or "").strip()


def jload(p: Path, default):
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def jsave(p: Path, v):
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(v, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    tmp.replace(p)


# ---------- ニュースを集める ----------
def rss_items(url: str, src: str) -> list[dict]:
    root = ET.fromstring(http(url))
    out = []
    for it in root.iter("item"):
        title = norm(it.findtext("title"))
        link = (it.findtext("link") or "").strip()
        pub = it.findtext("pubDate")
        try:
            t = email.utils.parsedate_to_datetime(pub).astimezone(JST) if pub else dt.datetime.now(JST)
        except (TypeError, ValueError):
            t = dt.datetime.now(JST)
        if title:
            out.append({"src": src, "title": title, "url": link, "t": t.isoformat(timespec="minutes"),
                        "id": hashlib.md5(re.sub(r"\s+-\s+[^-]+$", "", title).encode()).hexdigest()[:12]})
    return out


def collect() -> list[dict]:
    items = []
    for f in YAHOO:
        try:
            items += rss_items(f"https://news.yahoo.co.jp/rss/topics/{f}.xml", "Yahoo!ニュース")
        except Exception as e:  # noqa: BLE001
            log("yahoo", f, type(e).__name__)
    for q in GNEWS_Q:
        url = "https://news.google.com/rss/search?" + urllib.parse.urlencode({"q": q + " when:1h", "hl": "ja", "gl": "JP", "ceid": "JP:ja"})
        try:
            for x in rss_items(url, "Googleニュース"):
                m = re.search(r"\s+-\s+([^-]+)$", x["title"])
                if m:
                    x["src"], x["title"] = m.group(1).strip(), x["title"][:m.start()].strip()
                items.append(x)
        except Exception as e:  # noqa: BLE001
            log("gnews", type(e).__name__)
    try:
        d = json.loads(http("https://webapi.yanoshin.jp/webapi/tdnet/list/recent.json?limit=200"))
        for x in d.get("items", []):
            x = x["Tdnet"]
            title = norm(x.get("title"))
            if TDNET_KW.search(title):
                t = dt.datetime.strptime(x["pubdate"], "%Y-%m-%d %H:%M:%S").replace(tzinfo=JST)
                items.append({"src": "TDnet", "title": f"{norm(x.get('company_name'))}（{(x.get('company_code') or '')[:4]}）{title}",
                              "url": x.get("document_url", ""), "t": t.isoformat(timespec="minutes"), "id": "td" + str(x.get("id"))})
    except Exception as e:  # noqa: BLE001
        log("tdnet", type(e).__name__)
    return items


# ---------- 銘柄データ ----------
def stocks() -> dict[str, dict]:
    return {x["c"]: x for x in jload(ROOT / "site" / "data" / "stocks.json", [])}


def themes_text(st: dict) -> str:
    lines = []
    for t in jload(ROOT / "data" / "themes.json", []):
        names = "、".join(f"{st[c]['n']}({c})" for c in t["codes"] if c in st)
        lines.append(f"- {t['name']}: {t.get('desc', '')} 銘柄: {names}")
    return "\n".join(lines)


def update_liquidity(st: dict) -> dict:
    """全上場株の1日の売買代金（直近20営業日の中央値、円）。1日1回"""
    liq = jload(LIQ, {})
    if liq.get("d") == dt.date.today().isoformat():
        return liq
    log("売買代金を更新中…", len(st), "銘柄")
    out = {}
    codes = [c for c in st if st[c].get("mkt") != "REIT"]
    for i in range(0, len(codes), 150):
        chunk = [f"{c}.T" for c in codes[i:i + 150]]
        try:
            df = yf.download(chunk, period="1mo", interval="1d", progress=False, auto_adjust=False, group_by="ticker", threads=True)
            for tk in chunk:
                try:
                    sub = df[tk] if isinstance(df.columns, pd.MultiIndex) else df
                    v = (sub["Close"] * sub["Volume"]).dropna().tail(20)
                    if len(v):
                        out[tk[:-2]] = float(v.median())
                except KeyError:
                    pass
        except Exception as e:  # noqa: BLE001
            log("liq", type(e).__name__)
    if len(out) > 1000:
        liq = {"d": dt.date.today().isoformat(), "v": out}
        jsave(LIQ, liq)
    log("売買代金", len(out), "銘柄")
    return liq


# ---------- Claude ----------
SCHEMA = {
    "type": "object",
    "properties": {"alerts": {"type": "array", "items": {
        "type": "object",
        "properties": {
            "id": {"type": "string"},
            "strength": {"type": "integer"},
            "theme": {"type": "string"},
            "why": {"type": "string"},
            "stocks": {"type": "array", "items": {
                "type": "object",
                "properties": {"code": {"type": "string"}, "name": {"type": "string"}, "reason": {"type": "string"}},
                "required": ["code", "name", "reason"], "additionalProperties": False}},
        },
        "required": ["id", "strength", "theme", "why", "stocks"], "additionalProperties": False}}},
    "required": ["alerts"], "additionalProperties": False,
}


def system_prompt(st: dict) -> str:
    return f"""あなたは日本株のテーマ株・連想買いに詳しいアナリストです。
新しく出たニュースの見出しを読み、「そのニュースをきっかけに、連想で買われそうな東証上場銘柄」があるものだけを選んでください。
例: 大手企業の情報漏えい・サイバー攻撃 → サイバーセキュリティ銘柄、大地震 → 防災・建設・耐震銘柄、通信障害 → 冗長化・ネットワーク銘柄、
感染症の流行 → 検査薬・マスク・ワクチン銘柄、政府の新政策 → その政策の受益銘柄。

ルール:
- 連想で上がる側だけ。被害を受けた会社自身や、下がりそうな銘柄は挙げない。
- ニュースの当事者の会社の決算・業績の話（その会社だけが動く話）は対象外。
- 1つのニュースにつき銘柄は3〜8社。小型株でも、そのテーマで実際によく名前が挙がる銘柄を優先する。東証の4桁コード（例 3692、英字入りは 130A のように）と正式な社名を書く。確信がない銘柄は書かない。
- strength: 3＝市場で広く連想買いが起きそう（大企業の大規模な被害、大きな災害、政策の正式決定など）、2＝一部の銘柄が動きそう、1＝弱い。
- why は「なぜその銘柄が買われそうか」を1文で。reason は銘柄ごとに短く（20字程度）。
- 同じ出来事の見出しが複数あれば、最も具体的な1つだけ選ぶ。該当がなければ alerts は空。
- 株価・相場の動きそのものを伝える記事（「〇〇関連株が急騰」など）は、すでに動いた後なので strength を1つ下げる。

参考: アプリにあるテーマと銘柄（これ以外の銘柄も挙げてよい）
{themes_text(st)}"""


def judge(client: anthropic.Anthropic, sys_prompt: str, items: list[dict]) -> list[dict]:
    lines = "\n".join(f"[{x['id']}] {x['t'][11:16]} {x['src']}: {x['title']}" for x in items)
    r = client.beta.messages.create(
        model=MODEL, max_tokens=8000,
        betas=["server-side-fallback-2026-07-01"], fallbacks="default",
        cache_control={"type": "ephemeral"},
        system=sys_prompt,
        output_config={"effort": "low", "format": {"type": "json_schema", "schema": SCHEMA}},
        messages=[{"role": "user", "content": f"新しい見出し（{dt.datetime.now(JST):%Y-%m-%d %H:%M} 時点）:\n{lines}"}],
    )
    if r.stop_reason == "refusal":
        log("Claude が判定を断りました", getattr(r, "stop_details", None))
        return []
    text = next((b.text for b in r.content if b.type == "text"), "")
    u = r.usage
    log(f"判定 {len(items)}件 → in {u.input_tokens}+cache {getattr(u, 'cache_read_input_tokens', 0)} / out {u.output_tokens}")
    return json.loads(text).get("alerts", []) if text else []


def name_ok(a: str, b: str) -> bool:
    """Claude の社名と上場一覧の社名が同じ会社か（略し方の違いは許す）"""
    strip = lambda s: re.sub(r"(株式会社|ホールディングス|HD|グループ|\(株\)|・|\s)", "", norm(s)).lower()  # noqa: E731
    a, b = strip(a), strip(b)
    return bool(a and b) and (a in b or b in a or len(set(a) & set(b)) >= max(2, min(len(a), len(b)) * 0.6))


# ---------- 通知 ----------
def notify(fl: dict):
    stars = "★" * fl["strength"]
    lines = [f"{s['n']}（{s['c']}）{'⚠売買少' if s.get('thin') else ''} {s['reason']}" for s in fl["stocks"]]
    body = f"{fl['why']}\n" + "\n".join(lines) + f"\n\n{fl['src']}: {fl['title']}"
    title = f"{stars} 速報 {fl['theme']}"
    if os.environ.get("NTFY_TOPIC"):
        try:
            http(f"https://ntfy.sh/{os.environ['NTFY_TOPIC']}", body.encode(),
                 {"Title": title.encode("utf-8").decode("latin-1"), "Priority": "high" if fl["strength"] >= 3 else "default",
                  "Tags": "chart_with_upwards_trend", "Click": "https://pteratakahashi.github.io/kabu-calendar/#flash"}, "POST")
        except Exception as e:  # noqa: BLE001
            log("ntfy", type(e).__name__, e)
    if os.environ.get("DISCORD_WEBHOOK_URL"):
        try:
            http(os.environ["DISCORD_WEBHOOK_URL"], json.dumps({"content": f"**{title}**\n{body}"[:1900]}).encode(),
                 {"Content-Type": "application/json"}, "POST")
        except Exception as e:  # noqa: BLE001
            log("discord", type(e).__name__, e)


# ---------- GitHub に置く ----------
_gh = {"token": None, "sha": None}


def gh_token() -> str | None:
    if _gh["token"] is None:
        try:
            _gh["token"] = subprocess.run(["gh", "auth", "token"], capture_output=True, text=True, timeout=20).stdout.strip() or ""
        except Exception:  # noqa: BLE001
            _gh["token"] = ""
    return _gh["token"] or None


def publish(data: dict, msg: str):
    jsave(OUT, data)
    if DRY or not (tok := gh_token()):
        return
    api = f"https://api.github.com/repos/{REPO}/contents/{OUT_PATH}"
    hdr = {"Authorization": f"Bearer {tok}", "Accept": "application/vnd.github+json"}
    for _ in range(3):
        try:
            if not _gh["sha"]:
                try:
                    _gh["sha"] = json.loads(http(api + "?ref=main", headers=hdr))["sha"]
                except urllib.error.HTTPError as e:
                    if e.code != 404:
                        raise
            body = {"message": f"{msg} [skip ci]", "branch": "main",
                    "content": base64.b64encode(json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode()).decode()}
            if _gh["sha"]:
                body["sha"] = _gh["sha"]
            r = json.loads(http(api, json.dumps(body).encode(), {**hdr, "Content-Type": "application/json"}, "PUT"))
            _gh["sha"] = r["content"]["sha"]
            return
        except urllib.error.HTTPError as e:
            if e.code in (409, 422):  # 他の更新と重なった → sha を取り直す
                _gh["sha"] = None
                continue
            if e.code == 401:
                _gh["token"] = None
            log("github", e.code)
            return
        except Exception as e:  # noqa: BLE001
            log("github", type(e).__name__)
            return


# ---------- 結果の記録 ----------
def jp_open(t: dt.datetime) -> bool:
    if t.weekday() >= 5:
        return False
    hm = t.strftime("%H:%M")
    return "09:00" <= hm < "11:30" or "12:30" <= hm < "15:30"


def track(data: dict) -> bool:
    """通知した銘柄の、通知後の値動き。基準は通知の時刻以降の最初の1分足の始値（場の外なら次の寄り付き）"""
    now = dt.datetime.now(JST)
    todo = [f for f in data["items"] if not f.get("done") and now - dt.datetime.fromisoformat(f["at"]) < dt.timedelta(days=10)]
    codes = sorted({s["c"] for f in todo for s in f["stocks"]})
    if not codes:
        return False
    tick = {f"{c}.T": c for c in codes}
    try:
        m1 = yf.download(list(tick), period="7d", interval="1m", progress=False, auto_adjust=False, group_by="ticker", threads=True)
        d1 = yf.download(list(tick), period="1mo", interval="1d", progress=False, auto_adjust=False, group_by="ticker", threads=True)
    except Exception as e:  # noqa: BLE001
        log("track", type(e).__name__)
        return False

    def ser(df, tk, col):
        try:
            s = (df[tk] if isinstance(df.columns, pd.MultiIndex) else df)[col].dropna()
        except KeyError:
            return pd.Series(dtype=float)
        if s.index.tz is None:
            s.index = s.index.tz_localize("UTC")
        return s.tz_convert(JST) if len(s) else s

    changed = False
    for f in todo:
        at = dt.datetime.fromisoformat(f["at"])
        all_done = True
        for s in f["stocks"]:
            tk = f"{s['c']}.T"
            o1, c1, h1 = ser(m1, tk, "Open"), ser(m1, tk, "Close"), ser(m1, tk, "High")
            dc = ser(d1, tk, "Close")
            r = s.setdefault("r", {})
            if "base" not in r:
                after = o1[o1.index >= at.replace(second=0)]
                if len(after):
                    r["base"], r["bt"] = round(float(after.iloc[0]), 2), after.index[0].isoformat(timespec="minutes")
                    changed = True
                else:
                    all_done = False
                    continue
            base, bt = r["base"], dt.datetime.fromisoformat(r["bt"])
            pc = lambda v: round((float(v) / base - 1) * 100, 2)  # noqa: E731
            for k, mins in (("m5", 5), ("m30", 30)):
                if k not in r:
                    x = c1[(c1.index >= bt + dt.timedelta(minutes=mins - 1))]
                    if len(x) and x.index[0].date() == bt.date():
                        r[k] = pc(x.iloc[0]); changed = True
            day = bt.date()
            dclose = dc[[i.date() == day for i in dc.index]] if len(dc) else dc
            if "close" not in r and len(dclose) and (now.date() > day or now.strftime("%H:%M") >= "15:40"):
                r["close"] = pc(dclose.iloc[-1])
                hh = h1[(h1.index >= bt) & ([i.date() == day for i in h1.index])]
                if len(hh):
                    r["high"] = pc(hh.max())
                changed = True
            later = dc[[i.date() > day for i in dc.index]] if len(dc) else dc
            if "d1" not in r and len(later) >= 1 and (later.index[0].date() < now.date() or now.strftime("%H:%M") >= "15:40"):
                r["d1"] = pc(later.iloc[0]); changed = True
            if "d5" not in r and len(later) >= 5 and (later.index[4].date() < now.date() or now.strftime("%H:%M") >= "15:40"):
                r["d5"] = pc(later.iloc[4]); changed = True
            if "d5" not in r:
                all_done = False
        if all_done:
            f["done"] = True
            changed = True
    return changed


# ---------- 本体 ----------
def main() -> int:
    STATE_DIR.mkdir(exist_ok=True)
    load_env()
    client = anthropic.Anthropic()
    st = stocks()
    liq = update_liquidity(st)
    state = jload(STATE, {"seen": {}})
    data = jload(OUT, None)
    if data is None:  # 手元に控えが無ければ GitHub から
        try:
            data = json.loads(http(f"https://raw.githubusercontent.com/{REPO}/main/{OUT_PATH}?t={int(time.time())}"))
        except Exception:  # noqa: BLE001
            data = {"items": []}
    first = not state["seen"]
    sys_p, sys_day = system_prompt(st), dt.date.today()
    last_track = 0.0
    last_hb = 0.0
    log(f"開始 model={MODEL} 銘柄 {len(st)} 売買代金 {len(liq.get('v', {}))} 初回={first}")
    while True:
        t0 = time.time()
        try:
            if dt.date.today() != sys_day:  # 1日1回、銘柄一覧・テーマ・売買代金を読み直す
                st = stocks(); liq = update_liquidity(st); sys_p, sys_day = system_prompt(st), dt.date.today()
            now = dt.datetime.now(JST)
            items = collect()
            new = []
            for x in items:
                if x["id"] in state["seen"]:
                    continue
                state["seen"][x["id"]] = now.isoformat(timespec="minutes")
                # 2時間より古い記事は初動に間に合わないので見ない
                if not first and now - dt.datetime.fromisoformat(x["t"]) < dt.timedelta(hours=2):
                    new.append(x)
            if first:
                log("初回: 既存の見出し", len(state["seen"]), "件は既読にしました")
                first = False
            if new:
                byid = {x["id"]: x for x in new}
                for a in judge(client, sys_p, new[:60]):
                    x = byid.get(a["id"])
                    if not x or a["strength"] < MIN_STRENGTH:
                        continue
                    picks = []
                    for s in a["stocks"]:
                        c = norm(s["code"]).upper()
                        if c in st and name_ok(s["name"], st[c]["n"]) and c not in {p["c"] for p in picks}:
                            v = liq.get("v", {}).get(c)
                            picks.append({"c": c, "n": st[c]["n"], "mkt": st[c].get("mkt", ""), "reason": s["reason"],
                                          "liq": round(v / 1e8, 1) if v else None, "thin": bool(v is not None and v < LIQ_MIN)})
                        else:
                            log("  銘柄を確認できず除外:", s["code"], s["name"])
                    if not picks:
                        continue
                    fl = {"id": f"{now:%Y%m%d%H%M}-{x['id']}", "at": now.isoformat(timespec="seconds"), "nt": x["t"],
                          "src": x["src"], "title": x["title"], "url": x["url"], "theme": a["theme"], "why": a["why"],
                          "strength": a["strength"], "stocks": picks}
                    # 同じテーマが少し前に出ていれば、強くなった時だけ通知
                    prev = [f for f in data["items"] if f["theme"] == fl["theme"]
                            and now - dt.datetime.fromisoformat(f["at"]) < dt.timedelta(hours=SAME_THEME_H)]
                    fl["muted"] = bool(prev) and fl["strength"] <= max(f["strength"] for f in prev)
                    data["items"].insert(0, fl)
                    data["items"] = data["items"][:KEEP]
                    log(f"速報 {'(通知まとめ) ' if fl['muted'] else ''}{'★' * fl['strength']} {fl['theme']}: {x['title']} →",
                        "、".join(p["n"] for p in picks))
                    if not fl["muted"]:
                        notify(fl)
                    data["hb"] = now.isoformat(timespec="minutes")
                    publish(data, f"flash: {fl['theme']}")
            # 3日より古い既読は忘れる
            cut = (now - dt.timedelta(days=3)).isoformat()
            state["seen"] = {k: v for k, v in state["seen"].items() if v >= cut}
            jsave(STATE, state)
            if time.time() - last_track > TRACK_EVERY:
                last_track = time.time()
                if track(data):
                    data["hb"] = now.isoformat(timespec="minutes")
                    publish(data, "flash: 結果を更新")
                    last_hb = time.time()
            if time.time() - last_hb > 1800:  # 30分ごとに「動いています」の印
                last_hb = time.time()
                data["hb"] = now.isoformat(timespec="minutes")
                publish(data, "flash: 稼働中")
        except anthropic.AuthenticationError:
            log("APIキーが使えません。.env の ANTHROPIC_API_KEY を確認してください")
        except anthropic.RateLimitError:
            log("API の利用上限。少し待ちます")
            time.sleep(60)
        except Exception:  # noqa: BLE001
            log("エラー:", traceback.format_exc().splitlines()[-1])
        if ONCE:
            return 0
        time.sleep(max(5, POLL - (time.time() - t0)))


if __name__ == "__main__":
    sys.exit(main())
