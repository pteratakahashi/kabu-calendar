#!/usr/bin/env python3
"""速報（連想）: ニュースが出たら、連想で上がりそうな日本株を Claude に挙げてもらい、アプリの「速報」に出して結果を記録する。

このPC（WSL）で常に動かす見張り役（2分ごと）。PCが止まっている間は GitHub Actions の更新（↻ と1日2回）で --ci を1回ずつ動かす:
  1. ニュースを集める（Yahoo!ニュースのトピックス、Google ニュースのキーワード検索、TDnet の適時開示）
  2. 新しい見出しをまとめて Claude Code（claude -p、Claude のプランの範囲内・API 料金なし）に渡し、「連想で買われそうな銘柄」があるものだけ返してもらう
  3. 銘柄コードを上場銘柄一覧（site/data/stocks.json）で確かめ、売買代金が少なすぎる銘柄に印を付ける
  4. site/data/flash.json に記録して GitHub に置く（アプリの「速報」が読む。PC と Actions の両方が書くので、置く前に GitHub の内容とまとめる）
     .env に NTFY_TOPIC / DISCORD_WEBHOOK_URL があればそちらにも通知（任意）
5分ごとに、過去の速報の銘柄が通知後どう動いたか（5分後・30分後・その日の高値・引け・翌日・5営業日後）を書き足す。

設定は リポジトリ直下の .env（FLASH_MODEL, NTFY_TOPIC, DISCORD_WEBHOOK_URL。どれも任意）。
Actions では CLAUDE_CODE_OAUTH_TOKEN（claude setup-token で作ったプランのトークン）と GITHUB_TOKEN を使う。
使い方: .venv/bin/python scripts/flash/flash_watch.py [--once] [--dry] [--ci]
"""
from __future__ import annotations

import base64
import datetime as dt
import email.utils
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
import traceback
import unicodedata
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

import pandas as pd
import yfinance as yf

ROOT = Path(__file__).resolve().parents[2]
STATE_DIR = ROOT / ".flash"
STATE = STATE_DIR / "state.json"
CI = "--ci" in sys.argv
LIQ = ROOT / "data" / "flash_liq.json" if CI else STATE_DIR / "liquidity.json"  # Actions ではコミットして次回に使い回す
LOG = STATE_DIR / "watch.log"
OUT = STATE_DIR / "flash.json"  # 手元の控え（本体は GitHub の site/data/flash.json）
REPO = "pteratakahashi/kabu-calendar"
OUT_PATH = "site/data/flash.json"
JST = dt.timezone(dt.timedelta(hours=9))
UA = {"User-Agent": "Mozilla/5.0 (kabu-calendar flash; personal)"}

POLL = 120             # 何秒ごとにニュースを見るか（Claude のプランの利用枠を使いすぎないよう2分）
TRACK_EVERY = 300      # 何秒ごとに結果を更新するか
KEEP = 400             # flash.json に残す速報の数
MIN_STRENGTH = 2       # これ以上を通知（1〜3）
LIQ_MIN = 1e8          # 1日の売買代金（20日の中央値）がこれ未満は「売買しにくい」印
SAME_THEME_H = 3       # 同じテーマの速報は何時間以内なら通知をまとめるか
NEW_H = 6 if CI else 2  # 何時間前までの記事を見るか（Actions は回数が少ないので長め）
MODEL = os.environ.get("FLASH_MODEL", "opus")
CLAUDE = os.environ.get("CLAUDE_BIN") or shutil.which("claude") or str(Path.home() / ".npm-global/bin/claude")
ONCE, DRY = "--once" in sys.argv or CI, "--dry" in sys.argv

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


def judge(sys_prompt: str, items: list[dict]) -> list[dict]:
    """Claude Code（claude -p）で判定。ANTHROPIC_API_KEY を渡さないので、ログイン中の Claude のプランで動く"""
    lines = "\n".join(f"[{x['id']}] {x['t'][11:16]} {x['src']}: {x['title']}" for x in items)
    env = {k: v for k, v in os.environ.items() if k not in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN")}
    cmd = [CLAUDE, "-p", "--no-session-persistence", "--strict-mcp-config", "--tools", "", "--model", MODEL,
           "--output-format", "json", "--system-prompt", sys_prompt, "--json-schema", json.dumps(SCHEMA),
           f"新しい見出し（{dt.datetime.now(JST):%Y-%m-%d %H:%M} 時点）:\n{lines}"]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=300, env=env, cwd=STATE_DIR)
    try:
        d = json.loads(r.stdout)
    except json.JSONDecodeError:
        log("判定に失敗:", (r.stderr or r.stdout)[-300:])
        return []
    if d.get("is_error"):
        log("判定に失敗:", str(d.get("result"))[:300])
        return []
    out = d.get("structured_output") or json.loads(d.get("result") or "{}")
    log(f"判定 {len(items)}件 → {len(out.get('alerts', []))}件 {d.get('duration_ms', 0) / 1000:.0f}秒")
    return out.get("alerts", [])


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


def merge(a: dict, b: dict) -> dict:
    """GitHub 上の flash.json と手元の内容をまとめる（PC と Actions の両方が書くため）"""
    items = {f["id"]: f for f in a.get("items", [])}
    for f in b.get("items", []):
        g = items.get(f["id"])
        if not g:
            items[f["id"]] = f
            continue
        rs = {s["c"]: s.get("r", {}) for s in g["stocks"]}
        for s in f["stocks"]:
            s["r"] = {**rs.get(s["c"], {}), **s.get("r", {})}
        f["done"] = f.get("done") or g.get("done")
        items[f["id"]] = f
    cut = (dt.datetime.now(JST) - dt.timedelta(days=2)).isoformat()
    seen = {k: v for k, v in {**a.get("seen", {}), **b.get("seen", {})}.items() if v >= cut}
    return {"hb": max(a.get("hb", ""), b.get("hb", "")), "ci_at": max(a.get("ci_at", ""), b.get("ci_at", "")), "seen": seen,
            "items": sorted(items.values(), key=lambda f: f["at"], reverse=True)[:KEEP]}


def publish(data: dict, msg: str) -> dict:
    """GitHub の内容とまとめてから置く。まとめた結果を返す"""
    tok = os.environ.get("GITHUB_TOKEN") or gh_token()
    if DRY or not tok:
        jsave(OUT, data)
        return data
    api = f"https://api.github.com/repos/{REPO}/contents/{OUT_PATH}"
    hdr = {"Authorization": f"Bearer {tok}", "Accept": "application/vnd.github+json"}
    for _ in range(4):
        try:
            sha, remote = None, {}
            try:
                cur = json.loads(http(api + f"?ref=main&t={int(time.time())}", headers=hdr))
                sha, remote = cur["sha"], json.loads(base64.b64decode(cur["content"]))
            except urllib.error.HTTPError as e:
                if e.code != 404:
                    raise
            data = merge(remote, data)
            body = {"message": f"{msg} [skip ci]", "branch": "main",
                    "content": base64.b64encode(json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode()).decode()}
            if sha:
                body["sha"] = sha
            http(api, json.dumps(body).encode(), {**hdr, "Content-Type": "application/json"}, "PUT")
            jsave(OUT, data)
            return data
        except urllib.error.HTTPError as e:
            if e.code in (409, 422):  # 他の更新と重なった → 取り直す
                time.sleep(2)
                continue
            if e.code == 401:
                _gh["token"] = None
            log("github", e.code)
            break
        except Exception as e:  # noqa: BLE001
            log("github", type(e).__name__)
            break
    jsave(OUT, data)
    return data


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
def make_flash(a: dict, x: dict, st: dict, liq: dict, now: dt.datetime, data: dict) -> dict | None:
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
        return None
    fl = {"id": f"{now:%Y%m%d%H%M}-{x['id']}", "at": now.isoformat(timespec="seconds"), "nt": x["t"],
          "src": x["src"], "title": x["title"], "url": x["url"], "theme": a["theme"], "why": a["why"],
          "strength": a["strength"], "stocks": picks, "by": "ci" if CI else "pc"}
    # 同じテーマが少し前に出ていれば「まとめ」扱い（強くなった時だけ目立たせる）
    base = lambda t: re.sub(r"[（(].*?[）)]", "", t).strip()  # noqa: E731  「サイバーセキュリティ（自治体）」も同じテーマ
    prev = [f for f in data["items"] if base(f["theme"]) == base(fl["theme"])
            and now - dt.datetime.fromisoformat(f["at"]) < dt.timedelta(hours=SAME_THEME_H)]
    fl["muted"] = bool(prev) and fl["strength"] <= max(f["strength"] for f in prev)
    return fl


def main() -> int:
    STATE_DIR.mkdir(exist_ok=True)
    load_env()
    st = stocks()
    liq = update_liquidity(st)
    state = jload(STATE, {"seen": {}})
    data = jload(OUT, None)
    try:  # GitHub の内容（PC と Actions の両方の速報・既読）から始める
        remote = json.loads(http(f"https://raw.githubusercontent.com/{REPO}/main/{OUT_PATH}?t={int(time.time())}"))
        data = merge(remote, data or {})
    except Exception:  # noqa: BLE001
        data = data or {"items": []}
    data.setdefault("seen", {})
    sys_p, sys_day = system_prompt(st), dt.date.today()
    last_track = 0.0
    last_hb = 0.0
    log(f"開始{' (Actions)' if CI else ''} model={MODEL} 銘柄 {len(st)} 売買代金 {len(liq.get('v', {}))}")
    while True:
        t0 = time.time()
        try:
            if dt.date.today() != sys_day:  # 1日1回、銘柄一覧・テーマ・売買代金を読み直す
                st = stocks(); liq = update_liquidity(st); sys_p, sys_day = system_prompt(st), dt.date.today()
            now = dt.datetime.now(JST)
            stamp = now.isoformat(timespec="minutes")
            new = []
            for x in collect():
                if x["id"] in state["seen"] or x["id"] in data["seen"]:
                    continue
                state["seen"][x["id"]] = data["seen"][x["id"]] = stamp
                # 古い記事は初動に間に合わないので見ない
                if now - dt.datetime.fromisoformat(x["t"]) < dt.timedelta(hours=NEW_H):
                    new.append(x)
            added = []
            if new:
                byid = {x["id"]: x for x in new}
                for a in judge(sys_p, new[:60]):
                    x = byid.get(a["id"])
                    if x and a["strength"] >= MIN_STRENGTH and (fl := make_flash(a, x, st, liq, now, data)):
                        data["items"].insert(0, fl)
                        added.append(fl)
                        log(f"速報 {'(まとめ) ' if fl['muted'] else ''}{'★' * fl['strength']} {fl['theme']}: {x['title']} →",
                            "、".join(p["n"] for p in fl["stocks"]))
                        if not fl["muted"]:
                            notify(fl)
            cut = (now - dt.timedelta(days=2)).isoformat()
            state["seen"] = {k: v for k, v in state["seen"].items() if v >= cut}
            jsave(STATE, state)
            tracked = False
            if time.time() - last_track > TRACK_EVERY:
                last_track = time.time()
                tracked = track(data)
            data["ci_at" if CI else "hb"] = stamp
            # 速報が出た・結果が増えた・30分たった（稼働中の印）・Actions の1回（既読を残す）のどれかで GitHub に置く
            if added or tracked or CI or time.time() - last_hb > 1800:
                last_hb = time.time()
                msg = f"flash: {added[0]['theme']}" if added else "flash: 結果を更新" if tracked else "flash: 稼働中"
                data = publish(data, msg)
        except Exception:  # noqa: BLE001
            log("エラー:", traceback.format_exc().splitlines()[-1])
        if ONCE:
            return 0
        time.sleep(max(5, POLL - (time.time() - t0)))


if __name__ == "__main__":
    sys.exit(main())
