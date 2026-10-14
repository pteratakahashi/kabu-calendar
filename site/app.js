"use strict";

// ---------- storage (ウォッチリスト・表示設定は端末内) ----------
const WATCH_KEY = "kabucal.watch.v1"; // 旧ウォッチ（v5まで）。保有銘柄へ移行する
const HOLD_KEY = "kabucal.hold.v1";
const PREF_KEY = "kabucal.prefs.v1";
const MKT_KEY = "kabucal.mkt.v1"; // ホームのマーケットに出す指標（ティッカーの並び）。未設定なら market.json の def の指標
const MKT_SEEN_KEY = "kabucal.mkt.seen.v1"; // 一度見た指標。後から増えた def の指標は、選び済みの人にも1回だけ足す
function loadJSON(key, def) {
  try { return JSON.parse(localStorage.getItem(key)) ?? def; } catch { return def; }
}
function saveJSON(key, v) {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* private mode 等 */ }
}

const prefs = Object.assign({ calSort: "imp", calMode: "day", evMode: "week", ipoMode: "up", newsCat: "", plan: "events", biasDir: "", biasKind: "", biasMode: "" }, loadJSON(PREF_KEY, {}));

const state = {
  earnings: [], stocks: [], events: [], themes: [], meta: null,
  stock: new Map(),      // code -> stock {c,n,mkt,sec,w,sz,th,imp}
  theme: new Map(),      // id -> theme
  byDate: new Map(),     // "YYYY-MM-DD" -> [earning]
  evByDate: new Map(),   // "YYYY-MM-DD" -> [event]
  biasOpen: new Set(), // 傾向: 全件表示にした予定
  nextByCode: new Map(), // code -> 直近の今後の決算 (なければ最新)
  hold: new Set(loadJSON(HOLD_KEY, null) ?? loadJSON(WATCH_KEY, [])), // 保有銘柄（日経225採用銘柄から選ぶ・端末内に保存）
  n225: { codes: [], history: [] }, n225set: new Set(),
  hidx: null, hev: new Map(), hnews: new Map(), hday: new Map(), // 保有銘柄の反応（h/index.json の id・日付 → 位置）
  alertList: [], brief: null, market: null,
  h: new Map(),          // 銘柄コード -> h/<コード>.json
  alerts: new Map(),     // イベント id -> [{c, abs, ratio, n}]（今後2週間、保有銘柄が大きく動きやすいもの）
  month: null, selected: null, weekStart: null,
  evTheme: "", calTheme: "",
  rx: { events: {}, earnings: {}, news: {} }, // 株価の反応（reactions.json）
  news: [], newsByDate: new Map(),  // 予定外ニュース（news.json、新しい順）
  series: new Map(),     // 同じ種類のイベント（過去の回用）: key -> [event]（古い順）
  rxByCode: new Map(),   // 銘柄コード -> [[決算日, reactions のキー]]（古い順）
  ipo: [], ipoByDate: new Map(),    // IPO（ipo.json）
  sheetFn: null,                    // 開いているシートの再描画関数
};

const $ = (s) => document.querySelector(s);
const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayStr = () => ymd(new Date());
const parse = (s) => new Date(s + "T00:00:00");
const WD = "日月火水木金土";
const Q_LABEL = { "1Q": "1Q", "2Q": "2Q", "3Q": "3Q", "4Q": "4Q", "FY": "本決算" };
const FLAG = { JP: "🇯🇵", US: "🇺🇸", TW: "🇹🇼", CN: "🇨🇳", EU: "🇪🇺", KR: "🇰🇷", GLOBAL: "🌐" };
const norm = (s) => (s || "").normalize("NFKC").toLowerCase();
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const stars = (n) => `<span class="stars s${n}" aria-label="影響度${n}">${"★".repeat(n)}<i>${"★".repeat(3 - n)}</i></span>`;

// 騰落率（日本式: 上昇=赤 / 下落=青）
function pct(v, { digits = 2, label = "" } = {}) {
  if (v == null) return `<span class="pct flat">${label}—</span>`;
  const cls = v > 0 ? "up" : v < 0 ? "down" : "flat";
  const arrow = v > 0 ? "▲" : v < 0 ? "▼" : "±";
  return `<span class="pct ${cls}">${label}${arrow}${Math.abs(v).toFixed(digits)}%</span>`;
}

// 折れ線チャート（SVG）。pts=[[x,y%],...]、x0=発表位置、xLabels=[[x,"ラベル"],...]
function lineChart(pts, { x0 = 0, xLabels = [], x0Label = "" } = {}) {
  const W = 340, H = 150, L = 40, R = 8, T = 12, B = 22;
  if (!pts.length) return "";
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const xmin = Math.min(...xs, x0), xmax = Math.max(...xs, x0);
  const ymax = Math.max(0.2, ...ys.map(Math.abs)) * 1.15;
  const X = (x) => L + ((x - xmin) / (xmax - xmin || 1)) * (W - L - R);
  const Y = (y) => T + ((ymax - y) / (2 * ymax)) * (H - T - B);
  const line = (arr) => arr.map((p, i) => `${i ? "L" : "M"}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join("");
  const pre = pts.filter((p) => p[0] <= x0), post = pts.filter((p) => p[0] >= x0);
  if (pre.length && post.length && post[0][0] !== pre[pre.length - 1][0]) post.unshift(pre[pre.length - 1]);
  const last = ys[ys.length - 1];
  const cls = last > 0 ? "up" : last < 0 ? "down" : "flat";
  const fmt = (v) => `${v > 0 ? "+" : ""}${v.toFixed(Math.abs(v) < 1 ? 2 : 1)}%`;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="値動きチャート">
    <line class="zero" x1="${L}" x2="${W - R}" y1="${Y(0)}" y2="${Y(0)}"/>
    <text class="yl" x="${L - 4}" y="${Y(ymax / 1.15) + 4}">${fmt(ymax / 1.15)}</text>
    <text class="yl" x="${L - 4}" y="${Y(0) + 4}">0%</text>
    <text class="yl" x="${L - 4}" y="${Y(-ymax / 1.15) + 4}">${fmt(-ymax / 1.15)}</text>
    <line class="evline" x1="${X(x0)}" x2="${X(x0)}" y1="${T - 4}" y2="${H - B}"/>
    ${x0Label ? `<text class="evlabel" x="${X(x0) + 4}" y="${T + 6}">${esc(x0Label)}</text>` : ""}
    <path class="pre" d="${line(pre)}"/><path class="post ${cls}" d="${line(post)}"/>
    <circle class="post-dot ${cls}" cx="${X(xs[xs.length - 1])}" cy="${Y(last)}" r="3"/>
    ${xLabels.map(([x, l]) => {
      const px = Math.min(Math.max(X(x), L), W - R), anchor = px > W - R - 20 ? "end" : px < L + 10 ? "start" : "middle";
      return `<text class="xl" x="${px}" y="${H - 6}" text-anchor="${anchor}">${esc(l)}</text>`;
    }).join("")}
  </svg>`;
}

function fmtDay(s) {
  const d = parse(s);
  return `${d.getMonth() + 1}/${d.getDate()}(${WD[d.getDay()]})`;
}

// ---------- data ----------
// 通信が一瞬切れた・アプリを裏に回して読み込みが中断された等に備えて、少し待って2回まで取り直す。
// それでもだめなら端末に残っている前回のデータ（Service Worker のキャッシュ）を使う
async function getJSON(name) {
  let err;
  for (const wait of [0, 800, 2500]) {
    if (wait) await new Promise((r) => setTimeout(r, wait));
    try {
      const r = await fetch(`data/${name}`, { cache: "no-cache" });
      if (!r.ok) throw new Error(`${name}: ${r.status}`);
      return await r.json();
    } catch (e) { err = e; }
  }
  try {
    const c = await caches.match(`data/${name}`, { ignoreSearch: true });
    if (c) { state.usedCache = true; return await c.json(); }
  } catch { /* キャッシュも無い */ }
  throw err;
}

async function load() {
  // すべて並行して読む（以前は順番に読んでいて、スマホ回線だと遅かった）
  const CORE = ["earnings", "stocks", "events", "themes", "meta"];
  const OPT = { reactions: "rx", ipo: "ipo", news: "news", n225: "n225", brief: "brief", market: "market", bias: "bias" };
  const names = [...CORE, ...Object.keys(OPT)];
  const res = await Promise.allSettled(names.map((n) => getJSON(`${n}.json`)));
  const failed = [];
  res.forEach((r, i) => {
    const n = names[i];
    if (r.status === "fulfilled") state[OPT[n] || n] = r.value;
    else { failed.push(n); console.error(r.reason); }
  });
  state.rx.news ||= {};
  state.n225set = new Set((state.n225.codes || []).map((x) => x.c));
  state.loadFailed = failed.filter((n) => CORE.includes(n));
  if (failed.length) console.warn("読み込めなかったデータ:", failed.join(", "));
  index();
  renderUpdated();
  const t = todayStr();
  state.selected = t;
  state.month = t.slice(0, 7);
  state.weekStart = mondayOf(t);
  // 旧ウォッチからの移行: 日経225採用銘柄だけ引き継ぐ
  if (loadJSON(HOLD_KEY, null) == null && state.n225set.size) {
    state.hold = new Set([...state.hold].filter((c) => state.n225set.has(c)));
    saveHold();
  }
  renderThemeBars();
  renderAll();
  loadHoldings();
}

function index() {
  for (const s of state.stocks) state.stock.set(s.c, s);
  for (const t of state.themes) state.theme.set(t.id, t);
  const today = todayStr();
  for (const e of state.earnings) {
    if (!e.d) continue;
    if (!state.byDate.has(e.d)) state.byDate.set(e.d, []);
    state.byDate.get(e.d).push(e);
    const cur = state.nextByCode.get(e.c);
    // 今後の予定を優先し、その中で一番近いもの。無ければ一番新しい過去分。
    const better = !cur
      || (e.d >= today && (cur.d < today || e.d < cur.d))
      || (e.d < today && cur.d < today && e.d > cur.d);
    if (better) state.nextByCode.set(e.c, e);
  }
  for (const x of state.ipo) {
    if (!state.ipoByDate.has(x.d)) state.ipoByDate.set(x.d, []);
    state.ipoByDate.get(x.d).push(x);
  }
  for (const ev of state.events) {
    if (!state.evByDate.has(ev.d)) state.evByDate.set(ev.d, []);
    state.evByDate.get(ev.d).push(ev);
    const k = seriesOf(ev);
    if (!state.series.has(k)) state.series.set(k, []);
    state.series.get(k).push(ev);
  }
  for (const n of state.news) {
    if (!state.newsByDate.has(n.d)) state.newsByDate.set(n.d, []);
    state.newsByDate.get(n.d).push(n);
  }
  for (const key of Object.keys(state.rx.earnings)) {
    const [c, d] = key.split("@");
    if (!state.rxByCode.has(c)) state.rxByCode.set(c, []);
    state.rxByCode.get(c).push([d, key]);
  }
  for (const v of state.rxByCode.values()) v.sort((a, b) => a[0].localeCompare(b[0]));
}

// ---------- 過去の回（最大20回） ----------
// 同じ種類のイベントを束ねるキー。id の日付より後ろ（スラッグ）で判定し、表記ゆれは別名表で吸収する。
// 海外企業の決算は ticker で束ねる（四半期ごとにスラッグが違うため）
const SERIES_ALIAS = { "us-ism-svc": "us-ism-services", "us-fomc": "fomc" };
const NOT_EARN = new Set(["tsmc-monthly", "samsung-prelim"]);
function seriesOf(ev) {
  const slug = ev.id.replace(/^\d{4}-\d{2}-\d{2}-/, "");
  if (ev.ticker && !NOT_EARN.has(slug)) return `earn:${ev.ticker}`;
  return SERIES_ALIAS[slug] || slug;
}
// 過去何回まで見るか。20回に満たない種類（FOMC・日銀・ECB 約14回、海外決算・自社決算 約12回）はある分だけ
const HIST_N = 20;
const NEWS_N = 10; // ニュースの同じカテゴリの過去件数

// その回までの（その回を含む）反応データのある回。新しい順に最大 HIST_N 回
function eventHistory(ev) {
  return (state.series.get(seriesOf(ev)) || []).filter((e) => e.d <= ev.d && state.rx.events[e.id]).slice(-HIST_N).reverse();
}
function earnHistory(c, d) {
  return (state.rxByCode.get(c) || []).filter(([x]) => x <= d).slice(-HIST_N).reverse().map(([, k]) => k);
}

function stat(vals) {
  const v = vals.filter((x) => x != null);
  if (!v.length) return null;
  const sum = (f) => v.reduce((a, x) => a + f(x), 0);
  return { n: v.length, up: v.filter((x) => x > 0).length, avg: sum((x) => x) / v.length, abs: sum(Math.abs) / v.length };
}

// 棒グラフ（左が古い回）
function barChart(items) {
  const W = 340, H = 110, L = 6, R = 6, T = 14, B = 18;
  if (!items.length) return "";
  const m = Math.max(0.3, ...items.map((x) => Math.abs(x.v ?? 0))) * 1.1;
  const bw = (W - L - R) / items.length;
  const Y = (y) => T + ((m - y) / (2 * m)) * (H - T - B);
  const bars = items.map((x, i) => {
    if (x.v == null) return "";
    const cls = x.v > 0 ? "up" : x.v < 0 ? "down" : "flat";
    const y0 = Y(0), y1 = Y(x.v);
    const xx = L + i * bw + bw * 0.18;
    return `<rect class="b ${cls}${x.cur ? " cur" : ""}" x="${xx.toFixed(1)}" y="${Math.min(y0, y1).toFixed(1)}" width="${(bw * 0.64).toFixed(1)}" height="${Math.max(1, Math.abs(y1 - y0)).toFixed(1)}" rx="2"/>`
      + `<text x="${(xx + bw * 0.32).toFixed(1)}" y="${(x.v >= 0 ? Math.min(y0, y1) - 3 : Math.max(y0, y1) + 10).toFixed(1)}" text-anchor="middle">${x.v > 0 ? "+" : ""}${x.v.toFixed(1)}</text>`;
  }).join("");
  const lab = (i, a) => `<text x="${(L + i * bw + bw / 2).toFixed(1)}" y="${H - 4}" text-anchor="${a}">${esc(items[i].label)}</text>`;
  return `<svg class="chart bars" viewBox="0 0 ${W} ${H}" role="img" aria-label="過去の反応の棒グラフ">
    <line class="zero" x1="${L}" x2="${W - R}" y1="${Y(0)}" y2="${Y(0)}"/>${bars}
    ${lab(0, "start")}${items.length > 1 ? lab(items.length - 1, "end") : ""}</svg>`;
}

// 過去の回の一覧表＋傾向。cols=[{h, f(row)->値}]、rows=[{d, sub, attr, cur}]、main=棒グラフに使う列
function historyHtml(title, rows, cols, { main = 0, note = "" } = {}) {
  if (!rows.length) return "";
  const vals = cols.map((c) => rows.map((r) => c.f(r)));
  const st = vals.map(stat);
  const ms = st[main];
  const fy = (d) => { const x = parse(d); return `${x.getFullYear() % 100}/${x.getMonth() + 1}/${x.getDate()}`; };
  let html = `<h4 class="sheet-h">${esc(title)}（${rows.length}回）</h4>`;
  if (ms) {
    html += `<div class="trend"><span>${esc(cols[main].h)}: 上昇 <b>${ms.up}/${ms.n}回</b></span><span>平均 ${pct(ms.avg)}</span><span>平均の振れ幅 <b>${ms.abs.toFixed(2)}%</b></span></div>`;
  }
  html += `<div class="chart-box">${barChart(rows.map((r, i) => ({ v: vals[main][i], cur: r.cur, label: fy(r.d) })).reverse())}</div>`;
  html += `<table class="rxtable hist"><thead><tr><th></th>${cols.map((c) => `<th>${esc(c.h)}</th>`).join("")}</tr></thead><tbody>`
    + rows.map((r, i) => `<tr ${r.attr || ""} class="${r.cur ? "cur" : ""}"><th>${fy(r.d)}${r.sub ? `<small>${esc(r.sub)}</small>` : ""}</th>${cols.map((_, j) => `<td>${pct(vals[j][i])}</td>`).join("")}</tr>`).join("")
    + `</tbody><tfoot>`
    + `<tr><th>上昇回数</th>${st.map((x) => `<td class="num">${x ? `${x.up}/${x.n}` : "—"}</td>`).join("")}</tr>`
    + `<tr><th>平均</th>${st.map((x) => `<td>${x ? pct(x.avg) : "—"}</td>`).join("")}</tr>`
    + `<tr><th>平均の振れ幅</th>${st.map((x) => `<td class="num">${x ? x.abs.toFixed(2) + "%" : "—"}</td>`).join("")}</tr>`
    + `</tfoot></table>`;
  return html + (note ? `<p class="note">${note}</p>` : "");
}

// 発表直後の値（5分足なら30分後、1時間足なら1時間後）
const quick = (r) => { const x = r?.series?.[0]; return x ? (r.iv === "1h" ? (x.m60 ?? x.end) : (x.m30 ?? x.end)) : null; };
const jpAvg = (r) => (r?.jp?.length ? r.jp.reduce((a, j) => a + j.r, 0) / r.jp.length : null);

function eventHistoryHtml(ev) {
  const hist = eventHistory(ev);
  if (hist.length < 2 && !(hist.length === 1 && hist[0].id !== ev.id)) return "";
  const rows = hist.map((e) => ({ d: e.d, sub: e.desc, attr: `data-evrx="${esc(e.id)}"`, cur: e.id === ev.id, r: state.rx.events[e.id] }));
  const isEarn = seriesOf(ev).startsWith("earn:");
  let cols;
  if (isEarn) {
    cols = [{ h: `${ev.ticker} 反応日`, f: (x) => x.r.d1?.tk ?? null }, { h: "日本の関連株", f: (x) => jpAvg(x.r) }, { h: "日経平均", f: (x) => x.r.d1?.nk ?? null }];
  } else {
    const nm = hist.map((e) => state.rx.events[e.id].series?.[0]?.name).find(Boolean);
    cols = [{ h: "日経平均 反応日", f: (x) => x.r.d1?.nk ?? null }];
    if (nm) cols.push({ h: `${nm} 直後`, f: (x) => quick(x.r) });
  }
  return historyHtml("過去の反応", rows, cols, {
    note: isEarn ? `${esc(ev.ticker)} 反応日 = 決算発表後の最初の取引日の騰落率。日本の関連株 = 関連テーマ主力株の平均。行をタップでその回のチャート`
      : "日経平均 反応日 = 発表後に最初に開いた日本の立会日の終値騰落率。直後 = 発表30分後（1年以上前は1時間後）。行をタップでその回のチャート",
  });
}

function earnHistoryHtml(c, d) {
  const keys = earnHistory(c, d);
  if (!keys.length || (keys.length === 1 && keys[0] === `${c}@${d}`)) return "";
  const rows = keys.map((k) => ({ d: k.split("@")[1], attr: `data-rx="${esc(k)}"`, cur: k === `${c}@${d}`, r: state.rx.earnings[k] }));
  const wk = (r) => r.pts[r.k + 4]?.[1] ?? null;
  return historyHtml("過去の決算での反応", rows, [{ h: "反応日", f: (x) => x.r.r }, { h: "1週間後", f: (x) => wk(x.r) }],
    { note: "反応日 = 決算発表後の最初の立会日（15時以降の発表は翌営業日）の騰落率。1週間後 = 反応日から5営業日目の終値（反応日の前日終値比）。古い決算日は Yahoo Finance の日付のため1日ずれることがあります" });
}

// 決算エントリに銘柄情報（規模・テーマ・影響度）を足す
function info(e) {
  const s = state.stock.get(e.c) || {};
  return { ...s, ...e, n: s.n || e.n, w: s.w || 0, sz: s.sz || "", th: s.th || [], imp: s.imp || 1 };
}

function renderUpdated() {
  const el = $("#updated");
  if (state.loadFailed?.length) {
    // 主要データが読めなかった: タップ（または次にアプリを開いた時・回線が戻った時）に読み直す
    el.textContent = "読み込みに失敗 · タップで再読み込み";
    el.classList.add("stale", "retry");
    return;
  }
  if (!state.meta?.updated_at) return;
  const u = new Date(state.meta.updated_at);
  el.textContent = `最終更新 ${u.getMonth() + 1}/${u.getDate()} ${pad(u.getHours())}:${pad(u.getMinutes())}`;
  // 36時間以上更新が無ければ警告色（自動更新が止まっているサイン）
  el.classList.toggle("stale", Date.now() - u.getTime() > 36 * 3600 * 1000);
  const failed = Object.entries(state.meta.sources || {}).filter(([, v]) => !v.ok).map(([k]) => k);
  el.title = failed.length ? `取得失敗: ${failed.join(", ")}` : "";
}

// ---------- 共通パーツ ----------
function themeChips(ids, { link = true } = {}) {
  return (ids || []).map((id) => {
    const t = state.theme.get(id);
    return t ? `<button class="tchip" ${link ? `data-theme="${esc(id)}"` : ""}>${esc(t.name)}</button>` : "";
  }).join("");
}

function sizeBadge(sz) {
  return sz === "Core30" || sz === "Large70" ? `<span class="badge size">${sz}</span>` : "";
}

// 決算の発表時刻。tp があるのは「前回の決算短信の時刻」による目安（scripts/fetch_tdnet.py）
function earnTime(e) {
  if (!e.t) return "";
  return e.tp ? `<b class="etime" title="前回（${esc(fmtMD(e.tp))}）の発表時刻">${esc(e.t)}頃<small>前回</small></b>`
    : `<b class="etime">${esc(e.t)}</b>`;
}

function stockRow(e0, { showDate = false } = {}) {
  const e = info(e0);
  const watched = state.hold.has(e.c);
  const q = e.q ? `<span class="badge">${esc(Q_LABEL[e.q] || e.q)}</span>` : "";
  const when = showDate ? (e.d ? fmtDay(e.d) + (e.d < todayStr() ? " 発表済" : "") : "日付未定") : null;
  const sub = earnTime(e) + q + sizeBadge(e.sz) + [when, e.sec || e.mkt].filter(Boolean).map(esc).join(" · ");
  const rxKey = e.d ? `${e.c}@${e.d}` : `${e.c}@9999-12-31`;
  const rx = state.rx.earnings[rxKey];
  const nh = earnHistory(e.c, rxKey.split("@")[1]).length;
  const rxb = rx ? `<div class="rxline">${pct(rx.r, { label: rx.day === e.d ? "当日 " : "翌日 " })}<span class="rxhint">${nh > 1 ? `過去${nh}回 · ` : ""}チャート ›</span></div>`
    : nh ? `<div class="rxline"><span class="lbl">前回 ${pct(state.rx.earnings[earnHistory(e.c, rxKey.split("@")[1])[0]].r)}</span><span class="rxhint">過去${nh}回の反応 ›</span></div>` : "";
  const tap = rx || nh;
  return `<li class="${watched ? "watch" : ""}${tap ? " has-rx" : ""}" ${tap ? `data-rx="${esc(rxKey)}"` : ""}>
    <div class="lead"><span class="code">${esc(e.c)}</span>${stars(e.imp)}</div>
    <div class="main"><div class="name">${esc(e.n)}</div><div class="sub">${sub}</div>${rxb}
      ${e.th.length ? `<div class="chips">${themeChips(e.th)}</div>` : ""}</div>
  </li>`;
}

// ---------- イベント（週表示） ----------
function mondayOf(s) {
  const d = parse(s);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return ymd(d);
}

function weekItems(day) {
  // 指定日のイベント + 国内大型決算 + ウォッチ銘柄の決算 を1つのリストに
  const items = (state.evByDate.get(day) || []).map((ev) => {
    if (!ev.code) return { kind: "ev", ...ev };
    // 銘柄コード付きのイベント（時刻の分かる国内決算）は銘柄の影響度・テーマを引き継ぐ
    const s = state.stock.get(ev.code) || {};
    return { kind: "earn", ...ev, c: ev.code, rxKey: `${ev.code}@${day}`, watched: state.hold.has(ev.code),
      impact: Math.max(ev.impact, s.imp || 1), themes: ev.themes?.length ? ev.themes : (s.th || []) };
  });
  for (const x of state.ipoByDate.get(day) || []) {
    if (x.tech) continue; // テクニカル上場は新規公開ではないので出さない
    const price = x.price ? `公開価格 ${x.price.toLocaleString()}円` : x.range ? `仮条件 ${x.range}円` : "価格未定";
    items.push({ kind: "ipo", c: x.c, d: day, t: "09:00", country: "JP", impact: x.imp || 1, themes: [], ipo: x,
      title: `IPO ${x.n}（${x.c}）`, desc: [x.mkt, price, x.size ? `吸収 ${x.size}億円` : ""].filter(Boolean).join(" · ") });
  }
  for (const n of state.newsByDate.get(day) || []) items.push({ kind: "news", ...n });
  const covered = new Set(items.filter((it) => it.c && it.kind !== "ipo").map((it) => it.c));
  for (const e0 of state.byDate.get(day) || []) {
    if (covered.has(e0.c)) continue;
    const e = info(e0);
    const watched = state.hold.has(e.c);
    if (e.imp < 3 && !watched) continue;
    items.push({
      kind: "earn", c: e.c, d: day, t: e.t, approx: !!e.tp, country: "JP", watched, rxKey: `${e.c}@${day}`,
      title: `${e.n} 決算`, desc: [Q_LABEL[e.q] || e.q, e.sz && `TOPIX ${e.sz}`].filter(Boolean).join(" · "),
      impact: e.imp, themes: e.th,
    });
  }
  return items;
}

function evRow(it) {
  const time = it.t ? `${esc(it.t)}${it.approx ? "<small>頃</small>" : ""}` : "—";
  const tent = it.tentative ? '<span class="badge tent">予定</span>' : "";
  const watch = it.watched ? '<span class="badge wbadge">保有</span>' : "";
  const al = it.kind === "ev" && state.alerts.get(it.id);
  const alert = al ? `<span class="badge hbadge">保有株 注意</span>` : "";
  let rx = "", attr = it.kind === "earn" ? `data-code="${esc(it.c)}"` : "";
  if (it.kind === "ipo") {
    attr = `data-ipo="${esc(it.c)}"`;
    if (it.ipo.first != null) rx = `<div class="rxline">${pct(it.ipo.first_r, { digits: 1, label: "初値 " })}${pct(it.ipo.last_r, { digits: 1, label: "現在 " })}<span class="rxhint">チャート ›</span></div>`;
  } else if (it.kind === "news") {
    attr = `data-news="${esc(it.id)}"`;
    rx = newsRxLine(it.id, true) || `<div class="rxline"><span class="rxhint">詳細 ›</span></div>`;
  } else if (it.kind === "earn" && state.rx.earnings[it.rxKey]) {
    const r = state.rx.earnings[it.rxKey];
    rx = `<div class="rxline">${pct(r.r, { label: r.day === it.d ? "当日 " : "翌日 " })}<span class="rxhint">チャート ›</span></div>`;
    attr = `data-rx="${esc(it.rxKey)}"`;
  } else if (it.kind === "earn" && earnHistory(it.c, it.d).length) {
    rx = `<div class="rxline"><span class="rxhint">過去${earnHistory(it.c, it.d).length}回の反応 ›</span></div>`;
    attr = `data-rx="${esc(it.rxKey)}"`;
  } else if (it.kind === "ev" && !state.rx.events[it.id] && eventHistory(it).length) {
    // 発表前（または反応データなし）でも、同じ指標の過去の反応を見られるようにする
    const h = eventHistory(it), last = state.rx.events[h[0].id];
    const prev = it.ticker && last.d1?.tk != null && seriesOf(it).startsWith("earn:") ? pct(last.d1.tk, { label: `${it.ticker} ` })
      : last.d1?.nk != null ? pct(last.d1.nk, { label: "日経 " }) : "";
    rx = `<div class="rxline">${prev ? `<span class="lbl">前回 ${prev}</span>` : ""}<span class="rxhint">過去${h.length}回の反応 ›</span></div>`;
    attr = `data-evrx="${esc(it.id)}"`;
  } else if (it.kind === "ev" && state.rx.events[it.id]) {
    const r = state.rx.events[it.id];
    const hourly = r.iv === "1h";
    const parts = r.series.map((x) => pct(hourly ? (x.m60 ?? x.end) : (x.m30 ?? x.end), { label: `${x.name} ` }))
      .concat((r.idx || []).map((x) => pct(x.r, { label: `${x.name} ` })));
    if (r.jp?.length) parts.push(pct(r.jp[0].r, { label: `${r.jp[0].n} ` }));
    const nh = eventHistory(it).length;
    rx = `<div class="rxline">${parts.slice(0, 3).join("")}<span class="rxhint">${r.series.length ? (hourly ? "1時間後" : "30分後") : r.idx ? "休場明け" : "日本株"}${nh > 1 ? ` · 過去${nh}回` : ""} · チャート ›</span></div>`;
    attr = `data-evrx="${esc(it.id)}"`;
  }
  return `<div class="ev imp${it.impact}${it.watched ? " watched" : ""}${rx ? " has-rx" : ""}" ${attr}>
    <span class="flag">${it.kind === "ipo" ? "🆕" : it.kind === "news" ? "🗞️" : FLAG[it.country] || "🌐"}</span>
    <div class="ev-main">
      <div class="ev-title">${it.kind === "news" ? `<span class="cat">${esc(it.cat)}</span>` : ""}${esc(it.title)}${tent}${watch}${alert}</div>
      ${it.desc ? `<div class="ev-desc">${esc(it.desc)}</div>` : ""}
      <div class="ev-meta">${stars(it.impact)}${themeChips(it.themes)}</div>
      ${rx}
    </div>
    <div class="ev-time">${time}</div>
  </div>`;
}

function renderWeek() {
  let start = parse(state.weekStart), days = 7;
  if (prefs.evMode === "month") {
    start = new Date(start.getFullYear(), start.getMonth(), 1);
    days = new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate();
    $("#week-label").textContent = `${start.getFullYear()}年${start.getMonth() + 1}月`;
  } else {
    const end = new Date(start); end.setDate(start.getDate() + 6);
    $("#week-label").textContent = `${start.getMonth() + 1}/${start.getDate()}(月)〜${end.getMonth() + 1}/${end.getDate()}(日)`;
  }
  const today = todayStr();
  let html = "";
  for (let i = 0; i < days; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    const key = ymd(d);
    let items = weekItems(key);
    if (state.evTheme) items = items.filter((it) => (it.themes || []).includes(state.evTheme) || (!it.themes?.length && it.impact === 3 && it.kind === "ev"));
    if (!items.length) continue;
    items.sort((a, b) => (a.t || "99").localeCompare(b.t || "99") || b.impact - a.impact);
    html += `<section class="day wd${d.getDay()}${key === today ? " is-today" : ""}">
      <div class="day-date"><b>${d.getMonth() + 1}/${d.getDate()}</b><span>(${WD[d.getDay()]})</span>${key === today ? "<em>今日</em>" : ""}</div>
      <div class="day-items">${items.map(evRow).join("")}</div>
    </section>`;
  }
  $("#week").innerHTML = html || `<p class="empty-msg">この${prefs.evMode === "month" ? "月" : "週"}の該当イベントはありません</p>`;
}

function shiftWeek(delta) {
  const d = parse(state.weekStart);
  if (prefs.evMode === "month") { d.setDate(1); d.setMonth(d.getMonth() + delta); state.weekStart = ymd(d); }
  else { d.setDate(d.getDate() + 7 * delta); state.weekStart = mondayOf(ymd(d)); }
  renderWeek();
  window.scrollTo(0, 0);
}

// ---------- 決算カレンダー ----------
function renderCalendar() {
  const [y, m] = state.month.split("-").map(Number);
  $("#month-label").textContent = `${y}年${m}月`;
  const first = new Date(y, m - 1, 1);
  const start = new Date(first); start.setDate(1 - first.getDay());
  const today = todayStr();
  const grid = $("#grid");
  grid.innerHTML = "";
  for (let i = 0; i < 42; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    if (i === 35 && d.getMonth() !== m - 1) break; // 5週で収まる月は6行目を出さない
    const key = ymd(d);
    const list = state.byDate.get(key) || [];
    const hasWatch = list.some((e) => state.hold.has(e.c));
    const big = list.filter((e) => (state.stock.get(e.c)?.imp || 1) === 3).length;
    const cell = document.createElement("button");
    cell.className = "cell"
      + (d.getMonth() !== m - 1 ? " out" : "")
      + (d.getDay() === 0 ? " sun" : d.getDay() === 6 ? " sat" : "")
      + (key === today ? " today" : "")
      + (key === state.selected ? " sel" : "")
      + (hasWatch ? " has-watch" : "");
    cell.setAttribute("aria-label", `${key} 決算${list.length}社${big ? ` 大型${big}社` : ""}`);
    cell.innerHTML = `<span class="dn">${d.getDate()}</span>`
      + (list.length ? `<span class="cnt">${list.length}</span>` : "")
      + `<span class="marks">${big ? '<i class="dot big"></i>' : ""}${hasWatch ? '<i class="dot watch"></i>' : ""}</span>`;
    cell.onclick = () => {
      state.selected = key;
      if (key.slice(0, 7) !== state.month) state.month = key.slice(0, 7);
      renderCalendar(); renderDay();
    };
    grid.appendChild(cell);
  }
}

function shiftMonth(delta) {
  const [y, m] = state.month.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  state.month = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  renderCalendar(); renderMonth();
}

const SORTERS = {
  imp: (a, b) => b.imp - a.imp || b.w - a.w || a.c.localeCompare(b.c),
  w: (a, b) => b.w - a.w || b.imp - a.imp || a.c.localeCompare(b.c),
  c: (a, b) => a.c.localeCompare(b.c),
  t: (a, b) => (a.t || "99").localeCompare(b.t || "99") || b.imp - a.imp || b.w - a.w || a.c.localeCompare(b.c),
};

function renderDay() {
  const key = state.selected;
  const all = (state.byDate.get(key) || []).map(info);
  let list = all;
  if (state.calTheme) list = list.filter((e) => e.th.includes(state.calTheme));
  const sorter = SORTERS[prefs.calSort] || SORTERS.imp;
  // ウォッチ銘柄は常に先頭
  list.sort((a, b) => (state.hold.has(b.c) - state.hold.has(a.c)) || sorter(a, b));
  const big = all.filter((e) => e.imp === 3).length;
  $("#day-label").textContent = `${fmtDay(key)}　決算 ${all.length}社${big ? `（★★★ ${big}社）` : ""}`;
  let html = list.map((e) => stockRow(e)).join("");
  if (!html) html = `<li class="empty">${all.length ? "このテーマの銘柄はありません" : "予定はありません"}</li>`;
  $("#day-list").innerHTML = html;
}

// ---------- 月間まとめ ----------
function applyCalMode() {
  const month = prefs.calMode === "month";
  for (const sel of [".weekdays", "#grid", ".legend", ".day-head", "#day-list"]) $(sel).hidden = month;
  $("#month-list").hidden = !month;
  document.querySelector(".cal-cols").classList.toggle("month", month);
  $("#today-btn").hidden = month;
}

function renderMonth() {
  if (prefs.calMode !== "month") return;
  const [y, m] = state.month.split("-").map(Number);
  const sorter = SORTERS[prefs.calSort] || SORTERS.imp;
  const days = [...state.byDate.keys()].filter((d) => d.startsWith(state.month)).sort();
  let total = 0, html = "";
  for (const d of days) {
    let list = state.byDate.get(d).map(info);
    list = list.filter((e) => e.imp >= 2 || state.hold.has(e.c)); // 大企業（★★以上）＋保有
    if (state.calTheme) list = list.filter((e) => e.th.includes(state.calTheme));
    if (!list.length) continue;
    list.sort((a, b) => (state.hold.has(b.c) - state.hold.has(a.c)) || sorter(a, b));
    total += list.length;
    html += `<h4 class="mday${d === todayStr() ? " today" : ""}">${fmtDay(d)}<span>${list.length}社</span></h4><ul class="list">${list.map((e) => stockRow(e)).join("")}</ul>`;
  }
  $("#month-list").innerHTML = `<p class="msum">${y}年${m}月の大企業（★★以上）の決算 <b>${total}社</b>${state.calTheme ? `（${esc(state.theme.get(state.calTheme)?.name)}）` : ""}</p>`
    + (html || `<p class="empty-msg">該当する決算はありません</p>`);
}

// ---------- IPO ----------
function ipoCard(x) {
  const price = x.price ? `公開価格 <b>${x.price.toLocaleString()}円</b>` : x.range ? `仮条件 <b>${esc(x.range)}円</b>` : "価格未定";
  const listed = x.first != null;
  return `<li data-ipo="${esc(x.c)}" class="ipo-row">
    <div class="lead"><span class="code">${esc(x.c)}</span>${stars(x.imp || 1)}</div>
    <div class="main"><div class="name">${esc(x.n)}</div>
      <div class="sub"><span class="badge">${esc(x.mkt)}</span>${fmtDay(x.d)} 上場 · 承認 ${fmtDay(x.appr)}</div>
      <div class="sub">${price}${x.size ? ` · 吸収 ${x.size}億円` : ""}</div>
      ${listed ? `<div class="rxline">${pct(x.first_r, { digits: 1, label: "初値 " })}${pct(x.last_r, { digits: 1, label: "現在 " })}<span class="rxhint">チャート ›</span></div>` : ""}
    </div>
  </li>`;
}

function renderIpo() {
  const today = todayStr();
  const up = prefs.ipoMode !== "past";
  const list = state.ipo.filter((x) => !x.tech && (up ? x.d >= today : x.d < today));
  list.sort((a, b) => (up ? a.d.localeCompare(b.d) : b.d.localeCompare(a.d)));
  let html = "";
  if (!up && list.some((x) => x.first_r != null)) {
    const done = list.filter((x) => x.first_r != null);
    const wins = done.filter((x) => x.first_r > 0).length;
    const avg = done.reduce((s, x) => s + x.first_r, 0) / done.length;
    html += `<p class="msum">今年の上場 <b>${done.length}社</b> · 初値が公開価格超え ${wins}社（${Math.round((wins / done.length) * 100)}%）· 初値騰落率の平均 ${pct(avg, { digits: 1 })}</p>`;
  }
  html += list.length ? `<ul class="list">${list.map(ipoCard).join("")}</ul>` : `<p class="empty-msg">${up ? "予定されている IPO はありません" : "データがありません"}</p>`;
  $("#ipo-list").innerHTML = html;
}

function openIpo(c) {
  const x = state.ipo.find((i) => i.c === c);
  if (!x) return;
  const rows = [
    ["上場日", fmtDay(x.d)], ["上場承認日", fmtDay(x.appr)], ["市場", x.mkt],
    ["仮条件", x.range ? `${x.range}円` : "—"], ["公開価格", x.price ? `${x.price.toLocaleString()}円` : "—"],
    ["公募 / 売出", `${(x.pub || 0).toLocaleString()}千株 / ${(x.sell || 0).toLocaleString()}千株${x.oa ? `（OA ${x.oa.toLocaleString()}）` : ""}`],
    ["吸収金額", x.size ? `${x.size}億円` : "—"],
    ["初値", x.first != null ? `${x.first.toLocaleString()}円（${fmtDay(x.first_d)}）` : "—"],
  ];
  let html = `<table class="rxtable kv"><tbody>${rows.map(([k, v]) => `<tr><th>${k}</th><td>${esc(v)}</td></tr>`).join("")}</tbody></table>`;
  if (x.first != null) {
    html += `<div class="rx-big">${pct(x.first_r, { digits: 1 })}<span>初値の騰落率（公開価格比）</span></div>`;
    if (x.pts?.length > 1) {
      const pts = x.pts.map((p, i) => [i, p[1]]);
      html += `<div class="chart-box"><div class="chart-h"><b>上場後の終値（公開価格=0%）</b><span>現在 ${pct(x.last_r, { digits: 1 })}</span></div>`
        + lineChart([[-1, 0], ...pts], { x0: -0.5, x0Label: "上場", xLabels: [[0, x.pts[0][0].replace("-", "/")], [pts.length - 1, x.pts[x.pts.length - 1][0].replace("-", "/")]] })
        + `</div><p class="note">上場から最大40営業日分（データ: Yahoo Finance）</p>`;
    }
  }
  openSheet(`IPO ${x.n}（${x.c}）`, html, () => openIpo(c));
}

// ---------- テーマ ----------
function renderThemeBars() {
  const chips = (sel) => `<button class="tchip ${sel === "" ? "on" : ""}" data-pick="">全テーマ</button>`
    + state.themes.map((t) => `<button class="tchip ${sel === t.id ? "on" : ""}" data-pick="${esc(t.id)}">${esc(t.name)}</button>`).join("");
  $("#ev-themes").innerHTML = chips(state.evTheme);
  $("#cal-themes").innerHTML = chips(state.calTheme);
  $("#theme-grid").innerHTML = state.themes.map((t) =>
    `<button class="tcard" data-theme="${esc(t.id)}"><b>${esc(t.name)}</b><span>${t.codes.length}銘柄</span></button>`).join("");
}

function openSheet(title, html, fn) {
  $("#sheet-title").textContent = title;
  $("#sheet-body").innerHTML = html;
  state.sheetFn = fn;
  const dlg = $("#sheet");
  if (!dlg.open) { dlg.showModal(); dlg.scrollTop = 0; }
}

function openTheme(id) {
  const t = state.theme.get(id);
  if (!t) return;
  // 関連イベント（今後30日）
  const today = todayStr();
  const lim = new Date(); lim.setDate(lim.getDate() + 30);
  const evs = state.events.filter((e) => e.d >= today && e.d <= ymd(lim) && (e.themes || []).includes(id));
  const desc = esc(t.desc)
    + (evs.length ? `<span class="sheet-evs">${evs.map((e) => `${fmtDay(e.d)} ${esc(e.title)}`).join("<br>")}</span>` : "");
  const rows = t.codes.map((c) => {
    const nx = state.nextByCode.get(c);
    const s = state.stock.get(c) || { c, n: c };
    return { ...s, ...(nx || { d: "" }), c, n: s.n };
  }).map(info).sort(SORTERS.w);
  openSheet(`テーマ: ${t.name}`,
    `<p class="sheet-desc">${desc}</p><ul class="list">${rows.map((e) => stockRow(e, { showDate: true })).join("")}</ul>`,
    () => openTheme(id));
}

// イベント（指標・海外決算）の反応チャート
function openEventRx(id) {
  const ev = state.events.find((e) => e.id === id);
  const r = state.rx.events[id] || { series: [], none: true };
  if (!ev) return;
  const t = new Date(r.t || `${ev.d}T${ev.t || "00:00"}:00+09:00`);
  const hhmm = `${pad(t.getHours())}:${pad(t.getMinutes())}`;
  let html = `<p class="sheet-desc">${fmtDay(ev.d)} ${esc(ev.t || "")} 発表（日本時間）${ev.desc ? "<br>" + esc(ev.desc) : ""}</p>`;
  if (r.none) html += `<p class="msum">${ev.d >= todayStr() ? "まだ発表前です。" : "この回の値動きデータはありません。"}同じイベントの過去の反応から傾向を確認できます。</p>`;
  if (r.d1?.nk != null && !r.idx) html += `<div class="rx-big">${pct(r.d1.nk)}<span>日経平均 ${fmtDay(r.d1.nk_day)}（反応日）の騰落率</span></div>`;
  html += holdEventHtml(ev);
  html += eventHistoryHtml(ev);
  if (r.series.length) {
    const hourly = r.iv === "1h";
    const marks = (x) => x.marks || [["5分後", x.m5], ["30分後", x.m30], ["1時間後", x.m60], ["3時間後", x.end]];
    const heads = marks(r.series[0]).map((m) => m[0]);
    html += `<table class="rxtable"><thead><tr><th></th>${heads.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>`
      + r.series.map((x) => `<tr><th>${esc(x.name)}</th>${marks(x).map((m) => `<td>${pct(m[1])}</td>`).join("")}</tr>`).join("")
      + `</tbody></table>`;
    const xl = hourly ? [[-180, "-3h"], [180, "+3h"], [360, "+6h"]] : [[-60, "-1h"], [60, "+1h"], [120, "+2h"], [180, "+3h"]];
    for (const x of r.series) {
      html += `<div class="chart-box"><div class="chart-h"><b>${esc(x.name)}</b><span>高値 ${pct(x.hi)} / 安値 ${pct(x.lo)}</span></div>`
        + lineChart(x.pts, { x0: 0, x0Label: `発表 ${hhmm}`, xLabels: xl })
        + `</div>`;
    }
    html += `<p class="note">発表直前の値を 0% として、${hourly ? "1時間ごと（60日より前のため1時間足）" : "5分ごと"}の騰落率を表示（データ: Yahoo Finance）</p>`;
  }
  for (const x of r.idx || []) {
    const pts = x.pts.map((p, i) => [i, p[1]]);
    html += `<div class="chart-box"><div class="chart-h"><b>${esc(x.name)}</b><span>${fmtDay(x.day)} ${pct(x.r)}</span></div>`
      + lineChart(pts, { x0: x.k - 0.5, x0Label: "休場明け", xLabels: [[0, x.pts[0][0].replace("-", "/")], [pts.length - 1, x.pts[x.pts.length - 1][0].replace("-", "/")]] })
      + `</div>`;
  }
  if (r.idx) html += `<p class="note">発表が休場中だったため、休場明けの取引日の終値ベース（前日終値=0%）で表示</p>`;
  if (r.jp?.length) {
    html += `<h4 class="sheet-h">日本の関連株（${fmtDay(r.jp[0].day)} 終値ベース）</h4><ul class="list">`
      + r.jp.map((j) => `<li><span class="code">${esc(j.c)}</span><div class="main"><div class="name">${esc(j.n)}</div></div>${pct(j.r)}</li>`).join("")
      + `</ul>`;
  }
  openSheet(ev.title, html, () => openEventRx(id));
  $("#sheet").scrollTop = 0;
}

// 国内決算の反応チャート（日足）
function openEarnRx(key) {
  const r = state.rx.earnings[key];
  const [c, d] = key.split("@");
  const s = state.stock.get(c) || { n: c };
  let html = "";
  if (r) {
    const xl = [[0, r.pts[0][0].replace("-", "/")], [r.k, r.pts[r.k][0].replace("-", "/")], [r.pts.length - 1, r.pts[r.pts.length - 1][0].replace("-", "/")]];
    const pts = r.pts.map((p, i) => [i, p[1]]);
    html += `<div class="rx-big">${pct(r.r)}<span>${r.day === d ? "発表当日" : "発表翌営業日"}（${fmtDay(r.day)}）の騰落率</span></div>
    <div class="chart-box"><div class="chart-h"><b>${esc(s.n)}（${esc(c)}）</b><span>決算 ${fmtDay(d)}</span></div>
    ${lineChart(pts, { x0: r.k - 0.5, x0Label: "決算", xLabels: xl })}</div>
    <p class="note">反応日の前日終値を 0% とした終値の推移（データ: Yahoo Finance）</p>`;
  } else {
    html += `<p class="msum">${d === "9999-12-31" ? "次の決算日は未定です。" : d >= todayStr() ? `決算は ${fmtDay(d)} 予定（まだ発表前）。` : "この回の値動きデータはありません。"}過去の決算での反応から傾向を確認できます。</p>`;
  }
  if (d !== "9999-12-31" && d >= todayStr() && state.h.get(c)) {
    const a = earnArrays(c, d), h = state.h.get(c), e = state.earnings.find((x) => x.c === c && x.d === d);
    const av = a.r.filter((v) => v != null), sg = av.length && av.reduce((x, v) => x + v, 0) >= 0 ? 1 : -1;
    const keys = earnHistory(c, d).filter((k) => k.split("@")[1] < d);
    html += timingHtml(d, e?.t || "", timing({ r: a.r, g: keys.map((k) => gapOf(h, state.rx.earnings[k]?.day)), w1: a.w1, nk: a.nk, nw: keys.map((k) => nkWeek(state.rx.earnings[k]?.day)), s: sg, d, t: e?.t || "" }), sg,
      { unknownNote: "時刻未定（多くは15時以降）" });
  }
  html += earnEvidenceHtml(c, d);
  html += earnHistoryHtml(c, d);
  html += `<ul class="list">${stockRow({ ...s, ...(state.nextByCode.get(c) || {}), c, n: s.n }, { showDate: true })}</ul>`;
  if (state.n225set.has(c)) {
    html += state.hold.has(c) ? `<button class="btn wide" data-hold="${esc(c)}">保有銘柄の詳細を見る</button>`
      : `<button class="btn wide" data-addhold="${esc(c)}">＋ 保有銘柄に追加</button>`;
  }
  openSheet(`${s.n} 決算の反応`, html, () => openEarnRx(key));
  $("#sheet").scrollTop = 0;
}

// ---------- 予定外ニュース ----------
const NEWS_CATS = ["AI・半導体", "関税・貿易", "要人発言", "地政学", "金融・市場", "政治", "企業", "その他"];

function newsRxLine(id, compact = false) {
  const r = state.rx.news[id];
  const nk = r?.idx?.find((x) => x.sym === "^N225");
  if (!r || (!nk && !r.theme)) return "";
  const parts = [];
  if (nk) parts.push(pct(nk.r1, { label: "日経 " }), pct(nk.r5, { label: "1週 " }));
  if (nk && !compact) parts.push(pct(nk.r20, { label: "1か月 " }));
  if (r.theme) parts.push(pct(r.theme.r1, { label: "関連株 " }));
  return `<div class="rxline">${parts.join("")}<span class="rxhint">チャート ›</span></div>`;
}

function newsCard(n, compact = false) {
  const d = parse(n.d);
  if (compact) {
    const nk = state.rx.news[n.id]?.idx?.find((x) => x.sym === "^N225");
    return `<li class="row has-rx" data-news="${esc(n.id)}"><div class="when"><b>${d.getMonth() + 1}/${d.getDate()}</b><span>${esc(n.cat)}</span></div>
      <div class="main"><div class="name">${esc(n.title)}</div>${nk ? `<div class="sub">日経 ${pct(nk.r1)}${nk.r5 != null ? ` · 1週間 ${pct(nk.r5)}` : ""}</div>` : ""}</div><span class="chev">›</span></li>`;
  }
  return `<li class="news-row has-rx" data-news="${esc(n.id)}">
    <div class="lead"><span class="nd">${d.getMonth() + 1}/${d.getDate()}</span><span class="nt">${n.t ? esc(n.t) + (n.approx ? "頃" : "") : `(${WD[d.getDay()]})`}</span>${stars(n.impact)}</div>
    <div class="main"><div class="name"><span class="cat">${esc(n.cat)}</span>${FLAG[n.country] || ""} ${esc(n.title)}</div>
      ${n.desc ? `<div class="desc">${esc(n.desc)}</div>` : ""}
      ${n.themes?.length ? `<div class="chips">${themeChips(n.themes)}</div>` : ""}
      ${newsRxLine(n.id)}</div>
  </li>`;
}

function renderNews() {
  const cats = NEWS_CATS.filter((c) => state.news.some((n) => n.cat === c));
  $("#news-cats").innerHTML = `<button class="tchip ${prefs.newsCat ? "" : "on"}" data-ncat="">すべて（${state.news.length}）</button>`
    + cats.map((c) => `<button class="tchip ${prefs.newsCat === c ? "on" : ""}" data-ncat="${esc(c)}">${esc(c)}（${state.news.filter((n) => n.cat === c).length}）</button>`).join("");
  const list = state.news.filter((n) => !prefs.newsCat || n.cat === prefs.newsCat);
  // 絞り込み中は「このカテゴリのニュースが出たとき日経平均はどう動いたか」の傾向
  let sum = "";
  if (prefs.newsCat && list.length) {
    const nk = (n, k) => state.rx.news[n.id]?.idx?.find((x) => x.sym === "^N225")?.[k] ?? null;
    const a = stat(list.map((n) => nk(n, "r1"))), b = stat(list.map((n) => nk(n, "r5"))), c = stat(list.map((n) => nk(n, "r20")));
    if (a) sum = `<div class="chart-box"><div class="trend"><span>「${esc(prefs.newsCat)}」のニュース後の日経平均</span></div>
      <table class="rxtable hist"><thead><tr><th></th><th>反応日</th><th>1週間後</th><th>1か月後</th></tr></thead><tbody>
      <tr><th>上昇回数</th>${[a, b, c].map((x) => `<td class="num">${x ? `${x.up}/${x.n}` : "—"}</td>`).join("")}</tr>
      <tr><th>平均</th>${[a, b, c].map((x) => `<td>${x ? pct(x.avg) : "—"}</td>`).join("")}</tr></tbody></table></div>`;
  }
  $("#news-sum").innerHTML = sum;
  let html = "", month = "";
  for (const n of list) {
    const m = n.d.slice(0, 7);
    if (m !== month) {
      if (month) html += "</ul>";
      month = m;
      html += `<h4 class="mday">${Number(m.slice(0, 4))}年${Number(m.slice(5))}月<span>${list.filter((x) => x.d.startsWith(m)).length}件</span></h4><ul class="list">`;
    }
    html += newsCard(n);
  }
  $("#news-list").innerHTML = html ? html + "</ul>" : `<p class="empty-msg">ニュースはまだありません</p>`;
}

function openNews(id) {
  const n = state.news.find((x) => x.id === id);
  if (!n) return;
  const r = state.rx.news[id];
  let html = `<p class="sheet-desc">${fmtDay(n.d)}${n.t ? ` ${esc(n.t)}${n.approx ? "頃" : ""}（日本時間）` : ""} · <span class="cat">${esc(n.cat)}</span>${stars(n.impact)}<br>${esc(n.desc || "")}
    ${n.src ? `<br><a class="srcl" href="${esc(n.src)}" target="_blank" rel="noopener">出典 ↗</a>` : ""}</p>`;
  if (n.themes?.length) html += `<div class="chips" style="margin:-4px 0 10px">${themeChips(n.themes)}</div>`;
  html += holdNewsHtml(id);
  if (r) {
    const rows = r.idx.map((x) => [x.name + (x.sym === "^GSPC" || x.sym === "^SOX" ? " 🇺🇸" : ""), x]);
    if (r.theme) rows.push([`関連テーマ主力 ${r.theme.n}社平均`, r.theme]);
    for (const x of r.stocks || []) rows.push([`${x.n}${x.us ? "" : `（${x.c}）`}`, x]);
    html += `<table class="rxtable"><thead><tr><th></th><th>反応日</th><th>1週間後</th><th>1か月後</th></tr></thead><tbody>`
      + rows.map(([nm, x]) => `<tr><th>${esc(nm)}</th><td>${pct(x.r1)}</td><td>${pct(x.r5)}</td><td>${pct(x.r20)}</td></tr>`).join("")
      + `</tbody></table>`;
    for (const x of r.idx.filter((i) => i.sym !== "JPY=X")) {
      const pts = x.pts.map((p, i) => [i, p[1]]);
      html += `<div class="chart-box"><div class="chart-h"><b>${esc(x.name)}</b><span>${fmtDay(x.day)} から ${pct(x.r20 ?? x.pts[x.pts.length - 1][1])}</span></div>`
        + lineChart(pts, { x0: x.k - 0.5, x0Label: "ニュース", xLabels: [[0, x.pts[0][0].replace("-", "/")], [x.k, x.pts[x.k][0].replace("-", "/")], [pts.length - 1, x.pts[x.pts.length - 1][0].replace("-", "/")]] })
        + `</div>`;
    }
    html += `<p class="note">反応日の前日終値を 0% とした終値の推移（反応日・5営業日目・20営業日目）。1か月たっていないものは途中経過</p>`;
  } else {
    html += `<p class="msum">値動きデータは次回の更新で入ります</p>`;
  }
  // 同じカテゴリの過去のニュース
  const same = state.news.filter((x) => x.cat === n.cat && x.d <= n.d && state.rx.news[x.id]).slice(0, NEWS_N);
  const nk = (x, k) => state.rx.news[x.id]?.idx?.find((i) => i.sym === "^N225")?.[k] ?? null;
  if (same.length > 1) {
    html += historyHtml(`同じ「${n.cat}」の過去のニュース`, same.map((x) => ({ d: x.d, sub: x.title, attr: `data-news="${esc(x.id)}"`, cur: x.id === id, x })),
      [{ h: "日経 反応日", f: (o) => nk(o.x, "r1") }, { h: "1週間後", f: (o) => nk(o.x, "r5") }, { h: "1か月後", f: (o) => nk(o.x, "r20") }],
      { note: "行をタップでそのニュースへ" });
  }
  openSheet(n.title, html, () => openNews(id));
  $("#sheet").scrollTop = 0;
}

// ---------- 検索・ウォッチ ----------
function renderSearch() {
  const q = norm($("#q").value.trim());
  const out = $("#search-list");
  $("#theme-grid").hidden = !!q;
  document.querySelector("#view-search .sec-h").hidden = !!q;
  if (!q) { out.innerHTML = ""; return; }
  const hits = [];
  for (const s of state.stocks) {
    if (s.c.toLowerCase().startsWith(q) || norm(s.n).includes(q)) hits.push(s);
  }
  hits.sort(SORTERS.w);
  out.innerHTML = hits.length
    ? hits.slice(0, 50).map((s) => stockRow({ ...s, ...(state.nextByCode.get(s.c) || { d: "" }), n: s.n, c: s.c }, { showDate: true })).join("")
    : `<li class="empty">見つかりません</li>`;
}

// ---------- 保有銘柄 ----------
// 選べるのは日経平均採用銘柄。保有銘柄・株数・取得単価は端末内（localStorage）だけに保存。
// 各銘柄の反応は h/<コード>.json を必要な時に読む
const ALERT_RATIO = 1.5; // 過去の平均の振れ幅が「普段の1日の値動き」の何倍以上なら注意とするか
const POS_KEY = "kabucal.pos.v1"; // {コード: {q: 株数, cost: 取得単価}}
const pos = loadJSON(POS_KEY, {});

async function loadHold(c) {
  if (state.h.has(c)) return state.h.get(c);
  try {
    const r = await getJSON(`h/${c}.json`);
    state.h.set(c, r);
    return r;
  } catch { return null; }
}

async function loadHoldings() {
  try {
    state.hidx = await getJSON("h/index.json");
    state.hidx.ev.forEach((id, i) => state.hev.set(id, i));
    state.hidx.news.forEach((id, i) => state.hnews.set(id, i));
    (state.hidx.days || []).forEach((d, i) => state.hday.set(d, i));
  } catch { return; }
  await Promise.all([...state.hold].map(loadHold));
  refreshHold();
}

function refreshHold() {
  computeAlerts();
  renderHome(); renderHold(); renderWeek();
  if ($("#sheet").open && state.sheetFn) state.sheetFn();
}

function saveHold() {
  saveJSON(HOLD_KEY, [...state.hold]);
  try { localStorage.removeItem(WATCH_KEY); } catch { /* noop */ }
}

const holdName = (c) => state.stock.get(c)?.n || state.n225.codes.find((x) => x.c === c)?.n || c;
const evR = (h, id) => (h && state.hev.has(id) ? h.ev[state.hev.get(id)] : null);
const newsR = (h, id) => (h && state.hnews.has(id) ? h.news[state.hnews.get(id)] : null);
const dayR = (h, d) => (h?.r && state.hday.has(d) ? h.r[state.hday.get(d)] : null);
const nkR = (id) => state.rx.events[id]?.d1?.nk ?? state.rx.events[id]?.idx?.find((x) => x.sym === "^N225")?.r ?? null;

// ---- 株数・金額 ----
const qty = (c) => (state.hold.has(c) ? pos[c]?.q || 0 : 0);
const value = (c) => qty(c) * (state.h.get(c)?.px || 0);
const hasPos = () => [...state.hold].some((c) => qty(c) > 0 && state.h.get(c));
function yen(v, { sign = false } = {}) {
  if (v == null || Number.isNaN(v)) return "—";
  const a = Math.abs(v), s = sign ? (v > 0 ? "+" : v < 0 ? "−" : "±") : v < 0 ? "−" : "";
  if (a >= 1e8) return `${s}${(a / 1e8).toFixed(a >= 1e9 ? 1 : 2)}億円`;
  if (a >= 1e4) return `${s}${(a / 1e4).toFixed(a >= 1e6 ? 0 : 1)}万円`;
  return `${s}${Math.round(a).toLocaleString()}円`;
}
const yenPct = (v) => `<span class="pct ${v > 0 ? "up" : v < 0 ? "down" : "flat"}">${yen(v, { sign: true })}</span>`;

// ポートフォリオ全体（今の株数で計算）
function portfolio() {
  const cs = [...state.hold].filter((c) => qty(c) > 0 && state.h.get(c));
  if (!cs.length) return null;
  const val = cs.reduce((a, c) => a + value(c), 0);
  const costed = cs.filter((c) => pos[c]?.cost > 0);
  const pl = costed.length ? costed.reduce((a, c) => a + qty(c) * (state.h.get(c).px - pos[c].cost), 0) : null;
  const plBase = costed.reduce((a, c) => a + qty(c) * pos[c].cost, 0);
  // 前日比・普段の1日の振れ幅（直近250立会日、今の株数で）
  const days = state.hidx?.days || [];
  const daily = days.slice(-250).map((d) => cs.reduce((a, c) => { const r = dayR(state.h.get(c), d); return r == null ? a : a + value(c) * r / 100; }, 0));
  const vol = daily.length ? daily.reduce((a, v) => a + Math.abs(v), 0) / daily.length : 0;
  const lastDay = state.h.get(cs[0]).pd;
  const chg = cs.reduce((a, c) => { const r = dayR(state.h.get(c), state.h.get(c).pd); return r == null ? a : a + value(c) / (1 + r / 100) * r / 100; }, 0);
  return { cs, val, pl, plPct: plBase ? pl / plBase * 100 : null, vol, chg, chgPct: chg / (val - chg) * 100, lastDay };
}

// 指標の名前（同じ種類のイベントの代表名）
function seriesName(ev) {
  const k = seriesOf(ev);
  const t = ev.title.replace(/（.*?）|\(.*?\)/g, "").replace(/^(米|日本|中国)?\d+月/, "$1").replace(/\s*\d+-\d+月期/, "").replace(/決算.*$/, "").trim();
  return k.startsWith("earn:") ? `${t} 決算` : t;
}

// その銘柄の、その種類のイベントでの過去の反応（ev の回まで、最大 HIST_N 回）
function holdSeriesStat(h, ev) {
  const hist = eventHistory(ev).filter((e) => e.id !== ev.id || ev.d < todayStr());
  const vals = hist.map((e) => evR(h, e.id));
  const st = stat(vals);
  return st && { ...st, hist, vals, nk: stat(hist.map((e) => nkR(e.id))) };
}

// ---- 同業他社 ----
// 同じ業種（日経225の業種分類）か、同じテーマ（高配当は除く）の日経225銘柄
function peersOf(c) {
  const me = state.n225.codes.find((x) => x.c === c);
  const th = new Set((state.stock.get(c)?.th || []).filter((t) => t !== "highdiv"));
  return state.n225.codes.filter((x) => x.c !== c && ((me && x.sec === me.sec) || (state.stock.get(x.c)?.th || []).some((t) => th.has(t)))).map((x) => x.c);
}
// 同業 p の過去の決算（反応日）で、保有銘柄 c がどう動いたか
function peerStat(c, p, before = todayStr()) {
  const h = state.h.get(c);
  if (!h?.r) return null;
  const own = new Set(earnHistory(c, "9999-12-31").map((k) => state.rx.earnings[k]?.day));
  const keys = earnHistory(p, before).filter((k) => k.split("@")[1] < before);
  const rows = keys.map((k) => ({ k, d: k.split("@")[1], day: state.rx.earnings[k]?.day })).filter((x) => x.day && !own.has(x.day));
  const st = stat(rows.map((x) => dayR(h, x.day)));
  return st && { ...st, rows, pr: stat(rows.map((x) => state.rx.earnings[x.k]?.r)) };
}

// 今後2週間の注意: イベント・同業の決算で、保有銘柄（株数が入っていればポートフォリオ全体）が過去に普段より大きく動いたもの
function computeAlerts() {
  state.alerts.clear();
  state.alertList = [];
  const today = todayStr(), lim = new Date(); lim.setDate(lim.getDate() + 14);
  const end = ymd(lim);
  const pf = portfolio();
  for (const ev of state.events) {
    if (ev.d < today || ev.d > end || ev.code) continue;
    const stocks = [];
    for (const c of state.hold) {
      const h = state.h.get(c);
      if (!h?.vol) continue;
      const st = holdSeriesStat(h, ev);
      if (st && st.n >= 3) stocks.push({ c, abs: st.abs, avg: st.avg, up: st.up, n: st.n, ratio: st.abs / h.vol, hist: st.hist });
    }
    let pfa = null;
    if (pf && stocks.length) {
      const hist = stocks[0].hist;
      const yv = hist.map((e) => pf.cs.reduce((a, c) => { const r = evR(state.h.get(c), e.id); return r == null ? a : a + value(c) * r / 100; }, 0));
      const st = stat(yv);
      if (st) pfa = { abs: st.abs, avg: st.avg, up: st.up, n: st.n, ratio: st.abs / (pf.vol || 1) };
    }
    const hot = stocks.filter((x) => x.ratio >= ALERT_RATIO);
    if (hot.length || (pfa && pfa.ratio >= ALERT_RATIO)) {
      const a = { kind: "ev", id: ev.id, d: ev.d, t: ev.t, title: ev.title, stocks: hot.sort((x, y) => y.ratio - x.ratio), pf: pfa };
      state.alerts.set(ev.id, a);
      state.alertList.push(a);
    }
  }
  // 同業の決算
  for (const c of state.hold) {
    const h = state.h.get(c);
    if (!h?.vol) continue;
    const peers = new Set(peersOf(c));
    for (let d = new Date(); ymd(d) <= end; d.setDate(d.getDate() + 1)) {
      for (const e of state.byDate.get(ymd(d)) || []) {
        if (!peers.has(e.c)) continue;
        const st = peerStat(c, e.c);
        if (!st || st.n < 4 || st.abs / h.vol < ALERT_RATIO) continue;
        const id = `peer:${e.c}@${e.d}`;
        let a = state.alerts.get(id);
        if (!a) { a = { kind: "peer", id, p: e.c, d: e.d, t: e.t, title: `${holdName(e.c)} 決算（同業）`, stocks: [] }; state.alerts.set(id, a); state.alertList.push(a); }
        a.stocks.push({ c, abs: st.abs, avg: st.avg, up: st.up, n: st.n, ratio: st.abs / h.vol });
      }
    }
  }
  state.alertList.sort((a, b) => (a.d + (a.t || "")).localeCompare(b.d + (b.t || "")));
}

function alertRow(a) {
  const attr = a.kind === "peer" ? `data-hser="${esc(a.stocks[0].c)}|peer:${esc(a.p)}"` : `data-evrx="${esc(a.id)}"`;
  const lines = [];
  if (a.pf) lines.push(`保有株全体 <b>±${yen(a.pf.abs)}</b>（普段の${a.pf.ratio.toFixed(1)}倍）`);
  for (const s of a.stocks.slice(0, 3)) {
    const yv = qty(s.c) ? `≒±${yen(value(s.c) * s.abs / 100)}` : "";
    lines.push(`${esc(holdName(s.c))} ±${s.abs.toFixed(1)}%${yv ? ` ${yv}` : ""}（上昇${s.up}/${s.n}回）`);
  }
  return `<li class="row has-rx" ${attr}>
    <div class="when"><b>${fmtMD(a.d)}</b><span>${esc(a.t || "")}</span></div>
    <div class="main"><div class="name">${a.kind === "peer" ? '<span class="tag">同業決算</span>' : ""}${esc(a.title)}</div>
    <div class="sub">${lines.join("<br>")}</div></div><span class="chev">›</span></li>`;
}

const fmtMD = (s) => { const d = parse(s); return `${d.getMonth() + 1}/${d.getDate()}(${WD[d.getDay()]})`; };

function pfCard(pf, { link = false } = {}) {
  if (!pf) return "";
  return `<div class="card pf ${link ? "has-rx" : ""}" ${link ? 'data-go="hold"' : ""}>
    <div class="pf-top"><div><div class="lbl">評価額</div><div class="big">${yen(pf.val)}</div></div>
      ${pf.pl != null ? `<div class="r"><div class="lbl">含み損益</div><div class="mid">${yenPct(pf.pl)}<small>${pf.plPct != null ? ` (${pf.plPct > 0 ? "+" : ""}${pf.plPct.toFixed(1)}%)` : ""}</small></div></div>` : ""}</div>
    <div class="pf-row"><span>前日比（${fmtMD(pf.lastDay)}）</span><span>${yenPct(pf.chg)} ${pct(pf.chgPct)}</span></div>
    <div class="pf-row"><span>普段の1日の値動き</span><b>±${yen(pf.vol)}</b></div>
  </div>`;
}

function renderHold() {
  const el = $("#hold-list");
  if (!el) return;
  const asof = state.n225.asof ? `（${esc(state.n225.asof)}現在）` : "";
  $("#hold-note").innerHTML = `選べるのは日経平均採用銘柄 225社${asof}。採用銘柄が入れ替わったら自動で反映されます。保有銘柄・株数・取得単価はこの端末にだけ保存されます。株価は前営業日の終値。`;
  const codes = [...state.hold].sort((a, b) => value(b) - value(a) || a.localeCompare(b));
  const pf = portfolio();
  $("#pf-sum").innerHTML = pfCard(pf) || (codes.length ? `<p class="hint">銘柄をタップして株数を入れると、影響を円で見られます</p>` : "");
  if (!codes.length) {
    $("#hold-alert").innerHTML = "";
    el.innerHTML = `<div class="empty-card"><b>持っている銘柄を登録しましょう</b><p>ニュースや指標・決算で、その株がどう動いたかが分かります</p><button class="btn" id="hold-edit2">＋ 銘柄を選ぶ</button></div>`;
    return;
  }
  $("#hold-alert").innerHTML = state.alertList.length
    ? `<h3 class="sec">今後2週間の注意</h3><ul class="list">${state.alertList.map(alertRow).join("")}</ul>`
    : `<p class="hint">今後2週間、保有株が普段の${ALERT_RATIO}倍以上動いてきた予定はありません</p>`;
  const today = todayStr();
  el.innerHTML = `<h3 class="sec">保有銘柄（${codes.length}）</h3><ul class="list">` + codes.map((c) => {
    const h = state.h.get(c), q = qty(c), nx = state.nextByCode.get(c);
    const out = !state.n225set.has(c) ? '<span class="tag">日経225から除外</span>' : "";
    const r1 = h ? dayR(h, h.pd) : null;
    const right = q && h ? `<div class="num-r"><b>${yen(value(c))}</b>${pos[c]?.cost ? yenPct(q * (h.px - pos[c].cost)) : pct(r1, { label: "前日 " })}</div>`
      : `<div class="num-r">${h ? `<b>${h.px.toLocaleString()}円</b>${pct(r1, { label: "前日 " })}` : ""}</div>`;
    return `<li class="row has-rx" data-hold="${esc(c)}">
      <div class="main"><div class="name">${esc(holdName(c))}${out}</div>
      <div class="sub">${esc(c)}${q ? ` · ${q.toLocaleString()}株` : ""}${nx?.d && nx.d >= today ? ` · 決算 ${fmtMD(nx.d)}` : ""}</div></div>
      ${right}<span class="chev">›</span></li>`;
  }).join("") + `</ul>`;
}

// ---------- なぜ動く？（根拠） ----------
// ① 一般的な理屈（予定の種類 × 銘柄の業種・テーマ）と、② 過去の回のデータでの裏付け
//   ・結果との連動: その回の「結果」を表す市場の動き（海外決算＝その会社の株価の反応、指標＝発表1時間後のドル円）と同じ向き・逆向きに動いたか
//   ・銘柄固有か: 日経平均を上回った（下回った）回の多さ
//   ・地合いか: 日経平均も同じ向きに偏っていたか
const SEMI_TK = new Set(["NVDA", "AMD", "AVGO", "MU", "INTC", "ASML", "TSM", "005930.KS"]);
const TECH_TK = new Set(["MSFT", "GOOGL", "META", "AMZN", "AAPL"]);
function evClass(k) {
  if (k.startsWith("earn:")) {
    const t = k.slice(5);
    return SEMI_TK.has(t) ? "semiearn" : TECH_TK.has(t) ? "techearn" : t === "NFLX" ? "nflx" : t === "TSLA" ? "tsla" : "";
  }
  if (/^(tsmc-monthly|samsung-prelim)$/.test(k)) return "semiearn";
  if (/^(us-|fomc|beige-book|jackson-hole|warsh)/.test(k)) return "usmacro";
  if (/^(boj|jp-cpi|jp-tokyo-cpi|jp-cgpi)/.test(k)) return "jprate";
  if (/^jp-/.test(k)) return "jpmacro";
  if (/^ecb/.test(k)) return "ecb";
  if (/^cn-/.test(k)) return "china";
  return "";
}
function stockGroup(c) {
  const sec = state.n225.codes.find((x) => x.c === c)?.sec || state.stock.get(c)?.sec || "";
  const th = new Set(state.stock.get(c)?.th || []);
  const has = (...a) => a.some((t) => th.has(t));
  if (has("semi", "semiequip", "semimat")) return "semi";
  if (has("ai", "datacenter", "wire")) return "ai";
  if (has("game")) return "game";
  if (["銀行", "保険", "証券", "その他金融"].includes(sec) || has("bank", "regbank")) return "bank";
  if (sec === "不動産" || has("realestate")) return "realestate";
  if (["自動車", "ゴム"].includes(sec) || has("auto")) return "auto";
  if (["商社", "鉄鋼", "非鉄金属製品", "石油", "鉱業", "海運"].includes(sec) || has("trading", "steel", "ship", "rareearth")) return "commodity";
  if (["電気機器", "精密機器", "機械", "化学", "窯業", "造船", "その他製造"].includes(sec)) return "export";
  if (["食品", "小売業", "電力", "ガス", "空運", "鉄道・バス", "陸運", "パルプ・紙", "水産", "繊維", "建設"].includes(sec)) return "domestic";
  if (["医薬品", "情報・通信", "サービス"].includes(sec)) return "defensive";
  return "";
}
// sign = 結果の指標（ドル円・海外企業の株価）とこの銘柄が、理屈の上で同じ向き(1)・逆向き(-1)に動くはずか（0=決まらない）
const EXPORT_US = { tag: "円安で追い風", sign: 1, why: "米国の指標は米金利とドル円を動かします。輸出の多い企業は、円安になると海外の売上・利益が円に直したときに増えるため買われやすくなります。" };
const EXPORT_JP = { tag: "円高が逆風", sign: 1, why: "日銀の利上げ観測が強まると円高（ドル円は下落）になりやすく、輸出企業は円に直した利益が減る連想で売られやすくなります。" };
const SEMI_US = { tag: "米ハイテク連動", sign: 0, why: "米金利が下がるとハイテク・成長株が買われやすく、その夜の米国の半導体株の動きが日本の半導体・AI関連にそのまま波及します。" };
const REASONS = {
  "usmacro:export": EXPORT_US, "usmacro:auto": EXPORT_US,
  "usmacro:bank": { tag: "金利上昇で追い風", sign: 1, why: "強い米指標 → 米金利上昇（ドル円も上昇）→ 日本の金利も上がりやすい、という連想で、利ざやが広がる銀行・保険が買われやすくなります。" },
  "usmacro:realestate": { tag: "金利上昇が逆風", sign: -1, why: "金利が上がると借入コストが増え物件の価値も下がりやすいため、米金利の上昇（ドル円の上昇）で売られやすくなります。" },
  "usmacro:domestic": { tag: "円高で追い風", sign: -1, why: "原材料や燃料を輸入する内需企業は、円高（ドル円の下落）で輸入コストが下がるため買われやすくなります。" },
  "usmacro:semi": SEMI_US, "usmacro:ai": SEMI_US,
  "usmacro:commodity": { tag: "景気・資源連動", sign: 0, why: "米国の景気の強さは、資源価格や世界の物流量の見通しを通じて商社・素材・海運に影響します。" },
  "usmacro:defensive": { tag: "逃げ先", sign: 0, why: "医薬品・通信などは景気の影響を受けにくく、指標で相場が荒れる日に資金の逃げ先として買われやすい傾向があります。" },
  "jprate:bank": { tag: "利上げで追い風", sign: -1, why: "日銀の利上げ観測が強まると国内金利が上がり、利ざやが広がる期待で銀行・保険が買われやすくなります（このとき円高＝ドル円は下落しやすい）。" },
  "jprate:realestate": { tag: "利上げが逆風", sign: 1, why: "利上げ観測は借入コスト増の連想で不動産に逆風です（このとき円高＝ドル円は下落しやすい）。" },
  "jprate:export": EXPORT_JP, "jprate:auto": EXPORT_JP,
  "jprate:domestic": { tag: "円高で追い風", sign: -1, why: "利上げ観測で円高になると、輸入コストが下がる内需企業には追い風です。" },
  "jpmacro:export": { tag: "国内の設備投資", sign: 0, why: "国内の設備投資・景況感を映す指標で、機械・電機の受注見通しに関係します。" },
  "ecb:export": { tag: "欧州売上", sign: 0, why: "欧州の金利とユーロ円を通じて、欧州での売上が大きい企業の業績見通しに影響します。" },
  "ecb:auto": { tag: "欧州売上", sign: 0, why: "欧州の金利とユーロ円を通じて、欧州での売上が大きい企業の業績見通しに影響します。" },
  "china:commodity": { tag: "中国需要", sign: 0, why: "中国の景気は鉄鋼・資源・海運の需要に直結します。" },
  "china:export": { tag: "中国需要", sign: 0, why: "中国は建機・工作機械・電子部品の大きな市場で、景気指標が受注見通しに影響します。" },
  "china:auto": { tag: "中国需要", sign: 0, why: "中国は自動車・部品の大きな市場で、景気指標が販売見通しに影響します。" },
  "semiearn:semi": { tag: "受注見通し", sign: 1, why: "海外の半導体大手の業績や設備投資計画は、日本の製造装置・材料メーカーの受注見通しに直結します。" },
  "semiearn:ai": { tag: "AI需要", sign: 1, why: "AI向け半導体の需要の強さが、データセンター・電線・電力設備の需要見通しに波及します。" },
  "techearn:semi": { tag: "AI投資連動", sign: 1, why: "大手IT企業のAI向け設備投資の計画が、半導体・データセンター関連の需要見通しに波及します。" },
  "techearn:ai": { tag: "AI投資連動", sign: 1, why: "大手IT企業のAI向け設備投資の計画が、半導体・データセンター関連の需要見通しに波及します。" },
  "techearn:export": { tag: "部品需要", sign: 1, why: "アップルなど大手ITの販売動向は、スマホ・PC向けの電子部品メーカーの受注見通しに影響します。" },
  "nflx:game": { tag: "IP評価", sign: 1, why: "動画配信の会員数やコンテンツ投資の動向が、アニメ・ゲームなどIPを持つ企業の評価に波及します。" },
  "tsla:auto": { tag: "EV見通し", sign: 1, why: "EV・自動運転の見通しが、自動車・部品・電池関連の評価に波及します。" },
};
// 半導体・大手ITの決算で半導体株が売られる日は、資金が割安株・内需株へ移りやすい（セクターローテーション）
const ROTATION = { tag: "資金の移動", sign: -1, why: "半導体・AI株が売られる日は、その資金が銀行・建設・内需・資源などの割安株に移りやすく（セクターローテーション）、逆に半導体株が買われる日はこれらが売られやすくなります。" };
for (const e of ["semiearn", "techearn"]) for (const g of ["bank", "realestate", "domestic", "commodity", "defensive"]) REASONS[`${e}:${g}`] ||= ROTATION;
const reasonFor = (c, key) => REASONS[`${evClass(key)}:${stockGroup(c)}`] || null;

// その回の「結果」を表す市場の動き（build_bias.py の driver と同じ定義）
function driverVal(id, key) {
  const r = state.rx.events[id];
  if (!r) return null;
  if (key.startsWith("earn:")) return r.d1?.tk ?? null;
  const s = r.series?.find((x) => x.sym === "JPY=X");
  return s ? (s.m60 ?? s.end ?? null) : null;
}
function driverName(ev) {
  return seriesOf(ev).startsWith("earn:") ? `${seriesName(ev).replace(/ 決算$/, "")}の株価` : "ドル円";
}

function corr(p) {
  const n = p.length, mx = p.reduce((a, [x]) => a + x, 0) / n, my = p.reduce((a, [, y]) => a + y, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (const [x, y] of p) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2; }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0;
}

// r: この銘柄の各回の騰落率、nk: 同じ日の日経平均、dv: 結果の指標（あれば）。s: 偏りの向き（1=上昇, -1=下落）
function evidence({ r, nk, dv, s, rule }) {
  const both = (a) => r.map((x, i) => [x, a?.[i]]).filter(([x, y]) => x != null && y != null);
  const ex = both(nk).map(([x, y]) => x - y);
  const exW = ex.filter((v) => Math.sign(v) === s).length;
  const nkV = (nk || []).filter((v) => v != null), nkSame = nkV.filter((v) => Math.sign(v) === s).length;
  let link = null;
  const p = both(dv).filter(([, y]) => y !== 0);
  if (p.length >= 5) {
    const g = (f) => { const q = p.filter(([, y]) => f(y)); return { n: q.length, up: q.filter(([x]) => x > 0).length, avg: q.length ? q.reduce((a, [x]) => a + x, 0) / q.length : null }; };
    link = { n: p.length, c: corr(p), hi: g((y) => y > 0), lo: g((y) => y < 0) };
  }
  // 結果の向きで株価の向きも変わっているか（上がった回と下がった回で、上昇した割合が5割以上違う）
  const linked = !!(link && link.n >= 6 && link.hi.n >= 2 && link.lo.n >= 2 && Math.abs(link.c) >= 0.4
    && Math.sign(link.hi.up / link.hi.n - link.lo.up / link.lo.n) === Math.sign(link.c)
    && Math.abs(link.hi.up / link.hi.n - link.lo.up / link.lo.n) >= 0.5);
  const own = ex.length >= 6 && exW >= 0.75 * ex.length;
  const mkt = nkV.length >= 6 && nkSame >= 0.7 * nkV.length;
  const code = linked ? "link" : own ? "own" : mkt ? "mkt" : "weak";
  const match = linked && rule?.sign ? Math.sign(link.c) === rule.sign : null;
  // 理屈（向きが決まっているもの）が過去のデータで確かめられたか: true=裏付けあり / false=当てはまらない / null=確かめられない
  const ruleOk = rule?.sign && link && link.n >= 6 ? !!(linked && match) : null;
  return { code, ruleOk, label: { link: "結果に連動", own: "銘柄固有", mkt: "地合い", weak: "根拠薄" }[code], ex, exW, nkV, nkSame, link, linked, own, mkt, match };
}

const verdictChip = (e) => `<span class="vchip v-${e.code}">${e.label}</span>`;

// 一覧の1行用（短く）
function evidenceShort(c, key, x) {
  const rule = reasonFor(c, key);
  const e = evidence({ r: x.r, nk: x.nk, dv: x.dv, s: x.s, rule });
  const t = !rule ? (e.code === "weak" ? "偶然かも" : "") : e.ruleOk === true ? `${rule.tag} ✓` : e.ruleOk === false ? "理屈では説明できず" : rule.tag;
  return `${verdictChip(e)}${t ? `<span class="vtag">${esc(t)}</span>` : ""}`;
}

// シート用（詳しく）
function evidenceHtml(c, key, { r, nk, dv, dname }) {
  const v = r.filter((x) => x != null);
  if (v.length < 4) return "";
  const avg = v.reduce((a, x) => a + x, 0) / v.length, s = avg >= 0 ? 1 : -1;
  const rule = reasonFor(c, key);
  const e = evidence({ r, nk, dv, s, rule });
  const dir = s > 0 ? "上昇" : "下落";
  const name = esc(holdName(c));
  const li = [];
  if (e.link) {
    const L = e.link, st = (g) => (g.n ? `${g.up}/${g.n}回上昇<br>平均 ${pct(g.avg)}` : "—");
    const hiLbl = dname === "ドル円" ? "ドル円が上がった（円安）回" : `${esc(dname)}が上がった回`;
    const loLbl = dname === "ドル円" ? "ドル円が下がった（円高）回" : `${esc(dname)}が下がった回`;
    li.push(`<b>結果との連動</b>: ${e.linked ? "あり（結果の向きで、この銘柄の向きも変わる）" : "なし（結果の向きによらず同じように動く）"}
      <table class="rxtable mini"><tr><th>${hiLbl}</th><td>${st(L.hi)}</td></tr><tr><th>${loLbl}</th><td>${st(L.lo)}</td></tr></table>`
      );
  }
  if (e.ex.length) li.push(`<b>日経平均との比較</b>: 日経平均より${s > 0 ? "強かった" : "弱かった"}回 ${e.exW}/${e.ex.length}（平均 ${pct(e.ex.reduce((a, x) => a + x, 0) / e.ex.length)}）${e.own ? " → 相場全体と関係なくこの銘柄が動いている" : ""}`);
  if (e.nkV.length) li.push(`<b>地合い</b>: 同じ回に日経平均も${dir}したのは ${e.nkSame}/${e.nkV.length}回${e.mkt ? " → 相場全体の動きが大きい" : ""}`);
  const sum = {
    link: `${esc(dname)}と${e.link?.c > 0 ? "同じ向き" : "逆向き"}に動く傾向です。今回も結果（${esc(dname)}の動き）次第で向きが変わりやすく、過去の${dir}の偏りは、結果がたまたま一方に偏っていたことによる面もあります。`,
    own: `相場全体とは関係なく、この予定の日に${name}が${dir}しやすい傾向です。`,
    mkt: `この予定の日は相場全体が${dir}しやすく、${name}の偏りも主に地合いによるものです。`,
    weak: "結果とも相場全体とも一貫した関係が見つかりません。偶然の偏りの可能性があります。",
  }[e.code];
  return `<div class="card why"><div class="why-h">なぜ動く？ ${verdictChip(e)}</div>
    <p class="why-sum">${sum}</p>
    <ul class="why-list">${li.map((x) => `<li>${x}</li>`).join("")}</ul>
    <div class="why-rule"><b>一般的な理屈</b>${rule ? `<span class="vtag">${esc(rule.tag)}</span><p>${esc(rule.why)}</p>${e.ruleOk === true ? `<p class="ok">✓ 過去の回でも、${esc(dname)}の動きとこの理屈どおりの関係が見られます。</p>` : e.ruleOk === false ? `<p class="ng">△ ただし過去の回では、${esc(dname)}の動きとこの銘柄の動きにこの理屈どおりの関係が見られません。偏りの理由は別にある可能性があります。</p>` : ""}` : `<p>この予定と${name}の業種を結びつける一般的な理由は見当たりません。</p>`}</div></div>`;
}

// 自社の決算: 決算そのものへの反応か、1週間後も続くか、同じ時期の決算での傾向
function earnArrays(c, before) {
  const keys = earnHistory(c, before).filter((k) => k.split("@")[1] < before);
  const nkD = (d) => (state.hidx?.nk && state.hday.has(d) ? state.hidx.nk[state.hday.get(d)] : null);
  return {
    ds: keys.map((k) => k.split("@")[1]),
    r: keys.map((k) => state.rx.earnings[k]?.r ?? null),
    nk: keys.map((k) => nkD(state.rx.earnings[k]?.day)),
    w1: keys.map((k) => { const x = state.rx.earnings[k]; return x?.pts?.[x.k + 4]?.[1] ?? null; }),
  };
}
function earnEvidenceHtml(c, d) {
  const a = earnArrays(c, d);
  const v = a.r.filter((x) => x != null);
  if (v.length < 4) return "";
  const avg = v.reduce((x, y) => x + y, 0) / v.length, s = avg >= 0 ? 1 : -1, dir = s > 0 ? "上昇" : "下落";
  const e = evidence({ r: a.r, nk: a.nk, s });
  const pw = a.r.map((x, i) => [x, a.w1[i]]).filter(([x, y]) => x != null && y != null);
  const keep = pw.filter(([, y]) => Math.sign(y) === s).length;
  const m = parse(d).getMonth() + 1;
  const near = (x) => { const k = Math.abs(parse(x).getMonth() + 1 - m); return Math.min(k, 12 - k) <= 1; };
  const same = a.r.filter((x, i) => x != null && d !== "9999-12-31" && near(a.ds[i]));
  const li = [];
  if (e.ex.length) li.push(`<b>日経平均との比較</b>: 反応日に日経平均より${s > 0 ? "強かった" : "弱かった"}回 ${e.exW}/${e.ex.length}${e.own ? " → 地合いではなく決算そのものへの反応" : ""}`);
  if (pw.length) li.push(`<b>その後</b>: 1週間後も${dir}のままだった回 ${keep}/${pw.length}${keep >= 0.7 * pw.length ? " → 反応が続きやすい" : keep <= 0.3 * pw.length ? " → 1週間で戻しやすい" : ""}`);
  if (same.length >= 2) li.push(`<b>同じ時期の決算</b>（${m}月前後）: ${dir} ${same.filter((x) => Math.sign(x) === s).length}/${same.length}回`);
  const fy = m === 4 || m === 5;
  return `<div class="card why"><div class="why-h">なぜ動く？ ${verdictChip(e)}</div>
    <ul class="why-list">${li.map((x) => `<li>${x}</li>`).join("")}</ul>
    <div class="why-rule"><b>一般的な理屈</b><p>${fy ? "4〜5月の本決算では新しい年度の会社予想が出ます。予想を控えめに出す会社は、内容が良くても売られやすい傾向があります。" : "四半期の決算は、会社予想に対する進み具合や、予想の上方・下方修正の有無で動きやすくなります。"}決算の中身（予想との差など）のデータはまだ取り込んでいないため、偏りの理由までは断定できません。</p></div></div>`;
}

// ---------- いつ仕込む？（発表時刻 × 窓と日中の値動き） ----------
// 騰落率 r は「反応日の終値 ÷ 前日の終値」。これを 窓（前日の終値 → 反応日の始値）と 日中（始値 → 終値）に分けて、
// 動きが寄り付きの時点でもう出ているのか、日中に出るのかを見る
function isJpBiz(d) {
  const x = parse(d), md = d.slice(5);
  if (x.getDay() === 0 || x.getDay() === 6 || md === "12-31" || md <= "01-03") return false;
  return !(state.evByDate.get(d) || []).some((e) => /jp-holiday/.test(e.id));
}
function nextJpBiz(d) {
  const x = parse(d);
  do { x.setDate(x.getDate() + 1); } while (!isJpBiz(ymd(x)));
  return ymd(x);
}
// 発表（日本時間）→ 日本株の反応日。15時より前の立会日の発表はその日、それ以外は次の立会日（fetch_reactions.py と同じ決め方）
function reactTiming(d, t) {
  if (isJpBiz(d) && t && t < "09:00") return { day: d, kind: "pre" };
  if (isJpBiz(d) && t && t < "15:00") return { day: d, kind: "session" };
  return { day: nextJpBiz(d), kind: "post", unknown: !t };
}
const intra = (r, g) => (r != null && g != null ? ((1 + r / 100) / (1 + g / 100) - 1) * 100 : null);
const gapOf = (h, d) => (h?.g && state.hday.has(d) ? h.g[state.hday.get(d)] : null);
// 日経平均の反応日から5営業日目の終値（前日終値比 %）
const nkWeek = (d) => { const nk = state.hidx?.nk; if (!nk || !state.hday.has(d)) return null; const i = state.hday.get(d), v = nk.slice(i, i + 5); return v.length === 5 && v.every((x) => x != null) ? (v.reduce((a, x) => a * (1 + x / 100), 1) - 1) * 100 : null; };
const evDay = (id) => { const r = state.rx.events[id]; return r?.d1?.nk_day ?? r?.idx?.find((x) => x.sym === "^N225")?.day ?? null; };

function prevJpBiz(d) {
  const x = parse(d);
  do { x.setDate(x.getDate() - 1); } while (!isJpBiz(ymd(x)));
  return ymd(x);
}
function addJpBiz(d, n) { let x = d; for (let i = 0; i < n; i++) x = nextJpBiz(x); return x; }

// 楽天証券の制度信用（ゼロコースで手数料0円）。買いは買方金利、空売りは貸株料（年%）。
// 新規の受渡日から返済の受渡日まで両端入れの日割り（デイトレでも1日分）
// 売買で取れた利益（空売りは下落をプラス）。値動きの ▲▼ と混ざらないよう +/− で書く
const prof = (v) => (v == null ? "—" : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}%`);
const MARGIN_RATE = { 1: 2.8, [-1]: 1.1 };
const marginCost = (s, inD, outD) => MARGIN_RATE[s] * ((parse(addJpBiz(outD, 2)) - parse(addJpBiz(inD, 2))) / 864e5 + 1) / 365;
// 入る時（前日の引け / 反応日の寄り）× 出る時（反応日の寄り / 反応日の引け / 5営業日目の引け）の5通り
const ROUTES = [
  { key: "G", entry: "prev", exit: "open", lbl: "窓", sub: "前日引け→反応日の寄り" },
  { key: "I", entry: "open", exit: "close", lbl: "日中", sub: "反応日の寄り→引け" },
  { key: "R", entry: "prev", exit: "close", lbl: "1日", sub: "前日引け→反応日の引け" },
  { key: "W", entry: "prev", exit: "week", lbl: "1週間", sub: "前日引け→5営業日目の引け" },
  { key: "OW", entry: "open", exit: "week", lbl: "寄り→1週間", sub: "反応日の寄り→5営業日目の引け" },
];

// 各回の r（前日引け→反応日引け）・g（窓）・w1（前日引け→反応日から5営業日目の引け）、日経平均の nk（反応日）・nw（同じ1週間）と
// 偏りの向き s から、5通りの入り方・出方の過去の成績を出し、金利を引いた平均の利益が一番大きいものを選ぶ。
// 1週間持つ形は、日経平均の分を除いても反応日より伸びている（＝イベントへの反応が続いている）ときだけ候補にする
function timing({ r, g, w1, nk, nw, s, d, t }) {
  const idx = r.map((x, i) => i).filter((i) => r[i] != null && g?.[i] != null);
  if (idx.length < 4) return null;
  const kind = reactTiming(d, t).kind;
  const st = (v) => {
    v = v.filter((x) => x != null);
    if (!v.length) return null;
    const n = v.length, avg = v.reduce((a, x) => a + x, 0) / n, sd = n > 1 ? Math.sqrt(v.reduce((a, x) => a + (x - avg) ** 2, 0) / (n - 1)) : 0;
    return { n, same: v.filter((x) => Math.sign(x) === s).length, avg, t: sd > 0 ? avg / (sd / Math.sqrt(n)) : 99 };
  };
  const val = {
    G: (i) => g[i], I: (i) => intra(r[i], g[i]), R: (i) => r[i],
    W: (i) => w1?.[i] ?? null, OW: (i) => (w1?.[i] != null ? intra(w1[i], g[i]) : null),
  };
  const S = Object.fromEntries(ROUTES.map((x) => [x.key, st(idx.map(val[x.key]))]));
  const strong = (x) => x && x.same >= 0.6 * x.n && x.avg * s > 0;
  const opp = (x) => x && x.same <= 0.4 * x.n && x.avg * s < 0;
  const up = s > 0 ? "上がり" : "下がり";
  // 動きの形（窓と日中の内訳）
  let why;
  if (kind === "session") why = strong(S.G) && strong(S.I) ? `寄りの時点ですでに${up}やすく、発表後の日中も同じ向きでした。`
    : strong(S.I) ? "動きは主に発表をはさむ日中に出ています。" : strong(S.G) ? `発表前の寄りの時点で${up}やすく、日中はまちまちでした。` : "窓・日中のどちらにも一貫した形はありませんでした。";
  else why = strong(S.G) && strong(S.I) ? `寄りで窓を開けて${up}、日中もさらに同じ向きに動きやすい形でした。`
    : strong(S.G) && opp(S.I) ? "寄りで窓を開けたあと、日中は戻しやすい形でした。" : strong(S.G) ? "動きの大半は寄り付きの窓で出て、日中はまちまちでした。"
    : strong(S.I) ? "窓はまちまちで、動きは主に日中に出ています。" : "窓・日中のどちらにも一貫した形はなく、前日の引けから反応日の引けまで持って初めて偏りが出る形でした。";
  // 1週間持った分がイベントへの反応か（日経平均との差で見る）
  const xR = st(idx.map((i) => (nk?.[i] != null ? r[i] - nk[i] : null)));
  const xW = st(idx.map((i) => (w1?.[i] != null && nw?.[i] != null ? w1[i] - nw[i] : null)));
  let weekOk = !!(S.W && S.W.n >= 5 && S.W.same >= 0.7 * S.W.n && xW && xW.n >= 5 && xW.same >= 0.7 * xW.n && (!xR || xW.avg * s >= xR.avg * s));
  let weekNote = "";
  if (S.W && S.W.n >= 5 && S.W.avg * s > 0 && !weekOk) {
    weekNote = S.W.same < 0.7 * S.W.n ? `1週間持つと同じ向きは ${S.W.same}/${S.W.n}回とばらつくため、候補から外しました。`
      : `1週間持つと平均 ${pct(S.W.avg)} でしたが、日経平均の動きを除くと反応日より伸びておらず${xW ? `（日経平均との差 ${pct(xW.avg)}、同じ向き ${xW.same}/${xW.n}回）` : ""}、相場全体の動きの分が大きいため候補から外しました。`;
  } else if (S.W && S.W.n >= 5 && S.W.same <= 0.4 * S.W.n) weekNote = "1週間後には戻していることが多いので、持ち越さない方が無難でした。";
  // 候補ごとの成績と金利。いちばん利益の大きいものを選ぶ
  const C = ROUTES.map((x) => {
    const p = plan(d, t, x, s), v = S[x.key];
    const cost = marginCost(s, p.inD, p.outD);
    // 候補にするのは、同じ向き7割以上で、1〜2回の大きな動きだけで平均が偏っていないもの（一覧の判定と同じ t ≥ 1.5）
    const no = !v || v.n < 4 ? "回数不足" : v.avg * s <= 0 ? "逆向き" : v.same < 0.7 * v.n ? "7割未満"
      : v.t * s < 1.5 ? "大きな回頼み" : x.exit === "week" && !weekOk ? (S.W.same < 0.7 * S.W.n ? "1週間後ばらつく" : "地合いの分が大") : "";
    return { ...x, st: v, cost, net: v ? v.avg * s - cost : null, ok: !no, no };
  });
  const ok = C.filter((x) => x.ok).sort((a, b) => b.net - a.net);
  const fallback = !ok.length;
  const pick = ok[0] || C.find((x) => x.key === "R");
  if (fallback) why += "どの入り方・出方も同じ向きが7割に届かないため、前日の引けから反応日の引けまでを目安にしています。";
  else if (ok.length > 1) why += `5通りのうち、金利を引いた平均の利益が一番大きいのは「${pick.sub}」でした。`;
  return { entry: pick.entry, exit: pick.exit, key: pick.key, why, weekNote, fallback, C, P: pick.st, cost: pick.cost, net: pick.net };
}

// 入る日・出る日（具体的な日付）
function plan(d, t, tm, s) {
  const rt = reactTiming(d, t);
  const inD = tm.entry === "prev" ? prevJpBiz(rt.day) : rt.day;
  const outD = tm.exit === "week" ? addJpBiz(rt.day, 4) : rt.day;
  const [act, back] = s > 0 ? ["買い", "売り"] : ["空売り", "買い戻し"];
  const inT = tm.entry === "prev" ? "引け" : "寄り", outT = tm.exit === "open" ? "寄り" : "引け";
  return { rt, inD, outD, act, back, inT, outT,
    short: `${act} ${fmtMD(inD)}${inT} → ${back} ${fmtMD(outD)}${outT}` };
}

const KIND_TXT = { pre: "寄り前の発表", session: "取引時間中の発表", post: "引け後・夜間の発表" };
function timingHtml(d, t, tm, s, { unknownNote = "" } = {}) {
  const rt = reactTiming(d, t);
  const when = `${fmtMD(d)}${t ? " " + esc(t) : ""}`;
  const pre = `<p class="why-sum">一覧の騰落率は<b>反応日（${fmtMD(rt.day)}）の終値 ÷ その前の営業日（${fmtMD(prevJpBiz(rt.day))}）の終値</b>です。${KIND_TXT[rt.kind]}${t ? "" : "（時刻未定のため引け後として計算）"}なので、${rt.kind === "session" ? "発表への反応はその日の取引時間中に出ます。" : "発表への反応はまず反応日の寄り付き（窓）に出ます。"}</p>`;
  if (!tm) return `<div class="card why"><div class="why-h">いつ買って、いつ売る？</div>
    <div class="tl"><span><small>発表（日本時間）</small><b>${when}</b></span><span class="arr">→</span><span><small>日本株の反応日</small><b>${fmtMD(rt.day)}</b></span></div>${pre}
    <p class="hint">寄り付きの値段のデータが足りないため、窓と日中の内訳は出せません。</p></div>`;
  const p = plan(d, t, tm, s);
  const steps = `<div class="tl3">
    <span><small>① ${p.act}</small><b>${fmtMD(p.inD)} ${p.inT}</b></span><span class="arr">→</span>
    <span><small>発表</small><b>${when}</b>${t ? "" : `<small>${unknownNote || "時刻未定"}</small>`}</span><span class="arr">→</span>
    <span><small>② ${p.back}</small><b>${fmtMD(p.outD)} ${p.outT}</b></span></div>`;
  const line = (x) => (x.st ? `<tr class="${x.key === tm.key ? "pick" : ""}"><th>${x.key === tm.key ? "★ " : ""}${x.lbl}<small>${x.sub}</small></th><td>同じ向き ${x.st.same}/${x.st.n}回${x.no ? `<small>× ${x.no}</small>` : ""}</td><td>利益 ${prof(x.st.avg * s)}<small>金利後 ${prof(x.net)}</small></td></tr>` : "");
  return `<div class="card why"><div class="why-h">いつ買って、いつ売る？${tm.fallback ? ' <span class="vchip v-mkt">決め手なし</span>' : ""}</div>${steps}
    <p class="why-sum"><b>過去の形:</b> ${tm.why}${tm.weekNote}</p>
    ${tm.P ? `<p class="why-sum">この入り方・出方だと、過去は<b>同じ向き ${tm.P.same}/${tm.P.n}回・利益 平均 ${prof(tm.P.avg * s)}</b>、金利 ${tm.cost.toFixed(3)}% を引いて<b>${prof(tm.net)}</b>。</p>` : ""}
    ${pre}
    <table class="rxtable mini">${tm.C.map(line).join("")}</table>
    <p class="hint">利益は${s > 0 ? "買い" : "空売り"}で取れた分（${s > 0 ? "上昇" : "下落"}をプラス）。同じ向き7割以上でばらつきの小さい形から、金利後の平均が一番大きいもの（★）を選んでいます。×は候補から外した理由（大きな回頼み＝1〜2回の大きな動きで平均が膨らんでいる、地合いの分が大＝日経平均の動きを除くと伸びていない）。</p>
    <p class="note"><b>注文の出し方:</b>「寄り」は<b>寄成</b>（よりなり＝寄り付きの値段で成行）、「引け」は<b>引成</b>（ひけなり＝大引けの値段で成行）注文に当たり、その日の始値・終値で約定します（上の成績はこの値段で計算）。寄成は9時前、引成は大引け（15:30）の少し前までに出します。締め切りは証券会社ごとに違います。値が大きく飛んで寄り付かない・引けで約定しない日は失効することがあります。空売りは信用取引の口座が必要です。</p>
    <p class="note">過去の回の始値・終値から見た目安で、売買の推奨ではありません。金利後は楽天証券の制度信用（ゼロコースで手数料0円、買方金利 年2.80%・貸株料 年1.10%、受渡日ベースの日割り）で計算。逆日歩・配当落調整金・寄り付きで値段がつかない場合などは考えていません。</p></div>`;
}

// ---------- 傾向 ----------
// 日経225 × 今後の予定（自社の決算・指標・海外決算）で、過去の反応が上昇か下落に偏っている組み合わせ。
// 計算はサーバ側（scripts/build_bias.py → bias.json）。過去の回の数え方はアプリと同じ（最大20回）
function spark(vals) {
  // 古い回が左。棒の高さは各回の騰落率
  const v = vals.slice().reverse(), W = 64, H = 26, bw = W / Math.max(v.length, 1);
  const m = Math.max(0.5, ...v.map(Math.abs));
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" aria-hidden="true"><line x1="0" x2="${W}" y1="${H / 2}" y2="${H / 2}"/>`
    + v.map((x, i) => { const h = Math.max(1, Math.abs(x) / m * (H / 2 - 1)); return `<rect class="${x > 0 ? "up" : "down"}" x="${(i * bw + bw * 0.15).toFixed(1)}" y="${(x > 0 ? H / 2 - h : H / 2).toFixed(1)}" width="${(bw * 0.7).toFixed(1)}" height="${h.toFixed(1)}"/>`; }).join("")
    + `</svg>`;
}

// 傾向の各件を「売買する時」（日付 × 寄り/引け）の枠に振り分ける。入る注文 ins と、出る注文 outs（予定ごとにまとめる）
const biasTitle = (x) => { const ev = x.k === "ev" ? state.events.find((e) => e.id === x.id) : null; return ev ? seriesName(ev) : "決算"; };
// 同じ銘柄・同じ向きで、前の売買の出る時と次の売買の入る時が同じ枠（または前の保有期間中）なら1本にまとめる
// （例: 10/13引けで買い→10/14引けで売り と 10/14引けで買い→10/15引けで売り → 10/13引けで買い→10/15引けで売り）。
// ins には「まとめた売買」{ c, s, legs: [{x, p, tm0}], p: 全体の入り・出 } が入る。
// 逆向きの売買と保有期間が重なるものは clash に印をつける（両方は持てないため）
const biasKey = (x) => `${x.c}|${x.k === "earn" ? `earn@${x.d}` : x.id}`;
const slotKey = (d, t) => `${d}|${t === "寄り" ? 0 : 1}`;
function biasChains(items) {
  const legs = items.map((x) => {
    const tm0 = timing({ r: x.r, g: x.g, w1: x.w1, nk: x.nk, nw: x.nw, s: x.s, d: x.d, t: x.tm });
    const p = plan(x.d, x.tm, tm0 || { entry: "prev", exit: "close" }, x.s);
    return { x, p, tm0, inK: slotKey(p.inD, p.inT), outK: slotKey(p.outD, p.outT) };
  });
  const byC = new Map();
  for (const l of legs) { if (!byC.has(l.x.c)) byC.set(l.x.c, []); byC.get(l.x.c).push(l); }
  const chains = [];
  for (const ls of byC.values()) {
    ls.sort((a, b) => a.inK.localeCompare(b.inK) || a.outK.localeCompare(b.outK));
    const open = { 1: null, [-1]: null }; // 向きごとに、まとめている途中の売買
    for (const l of ls) {
      const s = l.x.s, cur = open[s];
      if (cur && l.inK <= cur.outK) {
        cur.legs.push(l);
        if (l.outK > cur.outK) { cur.outK = l.outK; cur.p = { ...cur.p, outD: l.p.outD, outT: l.p.outT }; }
      } else {
        open[s] = { c: l.x.c, s, legs: [l], inK: l.inK, outK: l.outK, p: { ...l.p }, clash: null };
        chains.push(open[s]);
      }
    }
  }
  // 逆向きの売買と保有期間が重なる（片方の出る前にもう片方に入る）
  for (const a of chains) for (const b of chains) {
    if (a !== b && a.c === b.c && a.s !== b.s && a.inK < b.outK && b.inK < a.outK) a.clash = b;
  }
  for (const ch of chains) {
    // 全体の利益の目安: 各予定の平均利益（金利前）の合計 − 通しで持った金利
    const gross = ch.legs.reduce((a, l) => a + (l.tm0?.P ? l.tm0.P.avg * ch.s : l.x.avg * ch.s), 0);
    ch.cost = marginCost(ch.s, ch.p.inD, ch.p.outD);
    ch.net = gross - ch.cost;
    ch.title = ch.legs.map((l) => biasTitle(l.x)).filter((t, i, a) => a.indexOf(t) === i).join("＋");
  }
  return chains;
}

// keep: 一覧の絞り込み（まとめ方・逆向きの判定は絞り込む前の全件で行う）
function biasSlots(items, today, keep = () => true) {
  const slots = new Map();
  const slot = (d, t) => { const k = slotKey(d, t); if (!slots.has(k)) slots.set(k, { k, d, t, ins: [], outs: new Map(), holds: [] }); return slots.get(k); };
  state.biasChain = new Map();
  for (const ch of biasChains(items)) {
    if (!ch.legs.some((l) => keep(l.x))) continue;
    const p = ch.p;
    for (const l of ch.legs) if (ch.legs.length > 1) state.biasChain.set(biasKey(l.x), ch);
    if (p.inD >= today) slot(p.inD, p.inT).ins.push(ch);
    // 途中の予定で入る枠: 売らずに持ち越す
    for (const l of ch.legs.slice(1)) if (l.p.inD >= today && l.inK > ch.inK) slot(l.p.inD, l.p.inT).holds.push({ ch, l });
    if (p.outD >= today) {
      const o = slot(p.outD, p.outT).outs, k = `${ch.legs.map((l) => (l.x.k === "earn" ? "earn" : l.x.id)).join("+")}|${p.back}|${p.inD}${p.inT}`;
      if (!o.has(k)) o.set(k, { title: ch.title, back: p.back, from: `${fmtMD(p.inD)}${p.inT}`, xs: [] });
      o.get(k).xs.push(ch.legs[ch.legs.length - 1].x);
    }
  }
  return [...slots.keys()].sort().map((k) => slots.get(k));
}

// 傾向の1行（入る注文）の中身。まとめた売買は予定ごとに1行ずつ
function chainLegsHtml(ch, { short = false } = {}) {
  const dir = ch.s > 0 ? "上昇" : "下落";
  return ch.legs.map(({ x, p, tm0 }) => {
    const ev = `${fmtMD(x.d)}${x.k === "earn" || short ? "" : " " + esc(x.tm || "")} ${esc(biasTitle(x))}`;
    const res = tm0 ? `${dir} <b>${tm0.P.same}/${tm0.P.n}回</b> · ${ch.legs.length > 1 ? "平均" : "利益 平均"} <b>${prof(ch.legs.length > 1 ? tm0.P.avg * ch.s : tm0.net)}</b>` : `${dir} <b>${x.w}/${x.n}回</b> · 平均 ${pct(x.avg)}`;
    return ch.legs.length > 1
      ? `<div class="sub leg" data-bias="${esc(biasKey(x))}">${ev} · ${res} ›</div>`
      : `<div class="sub">${ev} → ${p.back} ${fmtMD(p.outD)}${p.outT}${tm0?.fallback || !tm0 ? "（決め手なし）" : ""}</div><div class="sub">この売買で ${res}${tm0 ? '<small class="muted">（金利後）</small>' : ""}</div>`;
  }).join("");
}
const chainHead = (ch) => (ch.legs.length > 1
  ? `<div class="sub">${ch.p.act} ${fmtMD(ch.p.inD)}${ch.p.inT} → ${ch.p.back} ${fmtMD(ch.p.outD)}${ch.p.outT}<span class="tag t-chain">${ch.legs.length}つの予定をまとめて保有</span></div>`
    + `<div class="sub">合計 平均 <b>${prof(ch.net)}</b><small class="muted">（各予定の平均の合計・通しの金利後）</small></div>`
  : "") + (ch.clash ? `<div class="sub clash">⚠ 保有中の ${fmtMD(ch.clash.p.inD)}${ch.clash.p.inT}〜${fmtMD(ch.clash.p.outD)}${ch.clash.p.outT} に、${esc(ch.clash.title)}で逆向き（${ch.clash.p.act}）の傾向。両方は持てません</div>` : "");

// ---------- 傾向: やっていたら（過去の結果） ----------
// bias_past.json: 過去の各回について、その回より前のデータだけで一覧と同じ判定をしたら出ていたはずの件と、実際の動き a。
// 売買の形（いつ入って、いつ出るか）も当時のデータで一覧と同じ timing() で選び、実際の値段で損益を出す（金利込み・手数料0円）
function pastResult(x) {
  if (x._res !== undefined) return x._res;
  const tm0 = timing({ r: x.r, g: x.g, w1: x.w1, nk: x.nk, nw: x.nw, s: x.s, d: x.d, t: x.tm });
  const route = tm0 || ROUTES.find((r) => r.key === "R");
  const p = plan(x.d, x.tm, route, x.s), a = x.a;
  const v = { G: a.g, I: intra(a.r, a.g), R: a.r, W: a.w1, OW: intra(a.w1, a.g) }[route.key];
  const cost = marginCost(x.s, p.inD, p.outD);
  x._res = { p, key: route.key, fallback: !tm0 || tm0.fallback, net: v == null ? null : v * x.s - cost, move: v };
  return x._res;
}
function pastStats(xs) {
  const v = xs.map((x) => pastResult(x).net).filter((n) => n != null);
  const w = v.filter((n) => n > 0).length, sum = v.reduce((a, n) => a + n, 0);
  return { n: v.length, w, rate: v.length ? w / v.length : 0, avg: v.length ? sum / v.length : 0, sum };
}
function renderBiasPast() {
  const el = $("#bias-list");
  if (state.biasPast === undefined) {
    state.biasPast = null;
    el.innerHTML = `<p class="empty-msg">読み込み中…</p>`;
    getJSON("bias_past.json").then((d) => { state.biasPast = d; }).catch(() => { state.biasPast = { items: [] }; }).then(renderBias);
    return;
  }
  if (!state.biasPast) return;
  const P = state.biasPast;
  const q = norm($("#bias-q").value.trim());
  const keep = (x) => (!prefs.biasDir || x.s === Number(prefs.biasDir)) && (!prefs.biasKind || x.k === prefs.biasKind)
    && (!q || x.c.toLowerCase().startsWith(q) || norm(holdName(x.c)).includes(q));
  const xs = (P.items || []).filter(keep);
  if (!xs.length) { el.innerHTML = `<p class="empty-msg">${P.items?.length ? "条件に合う売買はありません" : "データがまだありません（次回の更新で作られます）"}</p>`; $("#bias-note").innerHTML = ""; return; }
  const row = (lbl, st) => `<tr><td>${lbl}</td><td>${st.n}</td><td>${st.w}勝${st.n - st.w}敗</td><td>${Math.round(st.rate * 100)}%</td><td>${prof(st.avg)}</td><td><b>${prof(st.sum)}</b></td></tr>`;
  const all = pastStats(xs), buy = pastStats(xs.filter((x) => x.s > 0)), sh = pastStats(xs.filter((x) => x.s < 0));
  let html = `<p class="hint">${fmtMD(P.from)}以降、この「傾向」の一覧に<b>出ていたはずの売買</b>を全部やっていたら、の結果です。各回より前のデータだけで同じ判定・同じ売買の形を選び、実際の始値・終値で計算しています（金利込み）。</p>
    <table class="pastsum"><thead><tr><th></th><th>回数</th><th>勝ち負け</th><th>勝率</th><th>1回平均</th><th>合計</th></tr></thead><tbody>
    ${row("すべて", all)}${buy.n && sh.n ? row("買い", buy) + row("空売り", sh) : ""}</tbody></table>
    <p class="hint">合計は「毎回同じ金額で売買した」ときの損益率の合計（例: 毎回10万円なら ${prof(all.sum)} × 10万円 ＝ 約${Math.round(all.sum * 1000).toLocaleString()}円）。</p>`;
  // 月ごと（運の波を見る）
  const byM = new Map();
  for (const x of xs) { const m = x.d.slice(0, 7); if (!byM.has(m)) byM.set(m, []); byM.get(m).push(x); }
  html += `<h3 class="sec">月ごと</h3><table class="pastsum"><tbody>${[...byM.keys()].sort().reverse().map((m) => row(`${Number(m.slice(5))}月`, pastStats(byM.get(m)))).join("")}</tbody></table>`;
  // 1件ずつ（新しい順）
  const LIM = state.pastLim || 80;
  html += `<h3 class="sec">1件ずつ（新しい順）</h3><ul class="list">` + xs.slice(0, LIM).map((x) => {
    const R = pastResult(x), p = R.p;
    const res = R.net == null ? `<span class="res wait">結果待ち</span>` : `<span class="res ${R.net > 0 ? "win" : "lose"}">${R.net > 0 ? "○" : "×"} ${prof(R.net)}</span>`;
    return `<li class="row"><div class="main"><div class="name"><span class="tag ${x.s > 0 ? "t-buy" : "t-short"}">${p.act}</span>${esc(holdName(x.c))} <span class="ncode">${esc(x.c)}</span></div>
      <div class="sub">${fmtMD(x.d)} ${esc(biasTitle(x))} · ${x.s > 0 ? "上昇" : "下落"} ${x.w}/${x.n}回${R.fallback ? "（決め手なし）" : ""}</div>
      <div class="sub">${p.act} ${fmtMD(p.inD)}${p.inT} → ${p.back} ${fmtMD(p.outD)}${p.outT}${R.move != null ? ` · 株価 ${pct(R.move)}` : ""}</div></div>${res}</li>`;
  }).join("") + `</ul>` + (xs.length > LIM ? `<button class="btn ghost more" data-past-more>ほか ${xs.length - LIM} 件を表示</button>` : "");
  el.innerHTML = html;
  $("#bias-note").innerHTML = `一覧と同じく、同じ銘柄・同じ向きの売買をまとめる前の、予定1つごとの結果です（まとめた場合とは金利がわずかに違います）。日経225の今の採用銘柄が対象。`
    + `<br><b>注意:</b> 勝率が5割前後なら、偏りは偶然の範囲と区別がつきません。当たった回・外れた回のどちらにも運の要素が大きく、将来も同じ成績になるとは限りません。（${esc(P.asof)} 計算）`;
}

function renderBias() {
  const el = $("#bias-list");
  if (!el) return;
  $("#bias-q").hidden = prefs.biasMode !== "past";
  if (prefs.biasMode === "past") { renderBiasPast(); return; }
  const b = state.bias;
  if (!b?.items?.length) { el.innerHTML = `<p class="empty-msg">データがまだありません（次回の更新で作られます）</p>`; return; }
  const today = todayStr();
  const all = b.items.filter((x) => x.d >= today && state.n225set.has(x.c));
  const keep = (x) => (!prefs.biasDir || x.s === Number(prefs.biasDir)) && (!prefs.biasKind || x.k === prefs.biasKind);
  const items = all.filter(keep);
  // 売買する順（日付 → 寄り → 引け）に並べる。入る行（買い・空売り）は1件ずつ、出る行（売り・買い戻し）は予定ごとに1行にまとめる
  const slots = biasSlots(all, today, keep);
  let html = `<p class="hint">今後${b.horizon}日の予定で、過去${b.min_n}〜${b.hist_n || 10}回のうち${Math.round(b.min_rate * 100)}%以上${b.min_rate_long ? `（15回以上あるものは${Math.round(b.min_rate_long * 100)}%以上）` : ""}が上がった日経225銘柄（${items.length}件・買いのみ。空売りは過去の成績が悪いため出していません）。売買する順に並べています</p>`;
  const LIM = 6;
  for (const sl of slots) {
    const k = sl.k;
    const head = sl.t === "寄り" ? "寄り（9:00 前に寄成）" : "引け（15:30 前に引成）";
    html += `<h3 class="sec bias-h"><span>${fmtMD(sl.d)} ${head}</span></h3>`;
    if (sl.outs.size) {
      html += `<ul class="list outs">` + [...sl.outs.values()].map((o) => `<li class="row out"><div class="main">
        <div class="name"><span class="tag ${o.back === "売り" ? "t-sell" : "t-cover"}">${o.back}</span>${esc(o.title)}${o.title === "決算" ? "" : ""}<small class="muted">（${esc(o.from)}に入った分）</small></div>
        <div class="sub">${o.xs.map((x) => `<span class="oname" data-bias="${esc(x.c)}|${esc(x.k === "earn" ? `earn@${x.d}` : x.id)}">${esc(holdName(x.c))} ${esc(x.c)}</span>`).join("、")}</div></div></li>`).join("") + `</ul>`;
    }
    if (sl.holds.length) {
      html += `<ul class="list outs"><li class="row out"><div class="main"><div class="name"><span class="tag t-chain">持ち越し</span>売らずにそのまま持つ</div>
        <div class="sub">${sl.holds.map(({ ch, l }) => `<span class="oname" data-bias="${esc(biasKey(l.x))}">${esc(holdName(ch.c))} ${esc(ch.c)}</span><small class="muted">（次: ${esc(biasTitle(l.x))}）</small>`).join("、")}</div></div></li></ul>`;
    }
    if (sl.ins.length) {
      const key0 = (ch) => ch.legs[0].x.d + (ch.legs[0].x.tm || "");
      sl.ins.sort((a, c) => key0(a).localeCompare(key0(c)) || Math.abs(c.legs[0].x.t) - Math.abs(a.legs[0].x.t));
      const open = state.biasOpen.has(k);
      html += `<ul class="list">` + sl.ins.slice(0, open ? sl.ins.length : LIM).map((ch) => {
        const x = ch.legs[0].x;
        const held = state.hold.has(x.c);
        const dir = x.s > 0 ? "上昇" : "下落";
        return `<li class="row has-rx" data-bias="${esc(biasKey(x))}">
          <div class="main"><div class="name"><span class="tag ${x.s > 0 ? "t-buy" : "t-short"}">${ch.p.act}</span>${held ? '<span class="tag">保有</span>' : ""}${esc(holdName(x.c))} <span class="ncode">${esc(x.c)}</span></div>
          ${chainHead(ch)}${chainLegsHtml(ch)}
          ${ch.legs.length > 1 ? "" : `<div class="vline">${x.k === "earn" ? verdictChip(evidence({ r: x.r, nk: x.nk, s: x.s })) : evidenceShort(x.c, seriesOf(state.events.find((e) => e.id === x.id) || { id: x.id }), x)}</div>`}</div>
          <div class="bias-r"><span class="bias-badge ${x.s > 0 ? "up" : "down"}">${x.s > 0 ? "▲" : "▼"} ${dir}</span>${ch.legs.map((l) => spark(l.x.r.filter((v) => v != null))).join("")}</div>
          <span class="chev">›</span></li>`;
      }).join("") + `</ul>`
        + (sl.ins.length > LIM && !open ? `<button class="btn ghost more" data-bias-more="${esc(k)}">ほか ${sl.ins.length - LIM} 銘柄を表示</button>` : "");
    }
  }
  if (!items.length) html += `<p class="empty-msg">条件に合う銘柄はありません</p>`;
  el.innerHTML = html;
  $("#bias-note").innerHTML = `反応日（発表後に最初に開いた日本の立会日）の終値騰落率で判定。平均の動きが普段の1日の値動きの半分未満、またはばらつきが大きすぎるものは除いています。`
    + `判定チップが「地合い」のものは、個別の傾向というより相場全体の動きです。`
    + `<br><b>注意:</b> 225銘柄 × 多くの予定を調べると、偶然だけでも一定数の偏りは見つかります。過去の傾向は将来の値動きを保証しません。売買の判断はご自身で。（${esc(b.asof)} 計算）`;
}

async function openBias(v) {
  const [c, key] = v.split("|");
  await loadHold(c);
  if (key.startsWith("earn@")) openEarnRx(`${c}@${key.slice(5)}`);
  else openHoldSeries(c, key);
  // 傾向一覧で前後の予定とまとめた売買なら、シートの先頭にその旨を出す（下の「いつ買って、いつ売る？」はこの予定単独の場合）
  const ch = state.biasChain?.get(v);
  if (ch) {
    $("#sheet-body").insertAdjacentHTML("afterbegin", `<div class="card why chain-note"><div class="why-h">前後の予定とまとめて保有</div>
      <p class="why-sum">${esc(holdName(c))}は${ch.legs.map((l) => `${fmtMD(l.x.d)} ${esc(biasTitle(l.x))}`).join("、")}の${ch.legs.length}つで同じ向き（${ch.s > 0 ? "上昇" : "下落"}）の傾向があり、売る日と次に買う日が重なるため、一覧では<b>${ch.p.act} ${fmtMD(ch.p.inD)}${ch.p.inT} → ${ch.p.back} ${fmtMD(ch.p.outD)}${ch.p.outT}</b>の1回の売買にまとめています（いったん売ってすぐ同じ値段で買い直すのと同じなので）。</p>
      <p class="hint">合計の目安 ${prof(ch.net)}（各予定の過去の平均利益の合計から、通しで持った金利を引いた値）。予定どうしの組み合わせで過去に検証したものではありません。下の「いつ買って、いつ売る？」はこの予定だけで売買した場合です。</p></div>`);
  }
}

// ---------- マーケットの指標選び ----------
function mktSel() {
  const all = state.market?.items || [];
  let sel = loadJSON(MKT_KEY, null);
  if (!all.length) return Array.isArray(sel) ? sel : [];
  if (Array.isArray(sel)) {
    // 記録が無い端末は、この仕組みを入れる前からある指標を見たことにする（日本の半導体だけが新しい）
    const seen = new Set(loadJSON(MKT_SEEN_KEY, null) ?? all.filter((x) => x.grp !== "日本の半導体").map((x) => x.sym));
    const add = all.filter((x) => x.def !== false && !seen.has(x.sym) && !sel.includes(x.sym)).map((x) => x.sym);
    if (add.length) {
      const at = sel.indexOf("^SOX");
      sel = at >= 0 ? [...sel.slice(0, at + 1), ...add, ...sel.slice(at + 1)] : [...sel, ...add];
      saveJSON(MKT_KEY, sel);
    }
  }
  saveJSON(MKT_SEEN_KEY, all.map((x) => x.sym));
  return Array.isArray(sel) ? sel : all.filter((x) => x.def !== false).map((x) => x.sym);
}
function mktShown() {
  const by = new Map((state.market?.items || []).map((x) => [x.sym, x]));
  return mktSel().map((s) => by.get(s)).filter(Boolean);
}
function mktTile(x) {
  const dp = x.unit === "bp" ? 2 : x.last >= 1000 ? 0 : x.last < 10 ? 4 : 2;
  return `<div class="tile"><span>${esc(x.name)}</span><b>${x.last.toLocaleString(undefined, { maximumFractionDigits: dp })}${x.unit === "bp" ? "%" : ""}</b>${x.unit === "bp" ? `<span class="pct ${x.chg > 0 ? "up" : x.chg < 0 ? "down" : "flat"}">${x.chg > 0 ? "+" : ""}${x.chg}bp</span>` : pct(x.chg)}</div>`;
}
function openMktEdit() {
  openSheet("マーケットの指標", "", null);
  renderMktEdit();
}
function renderMktEdit() {
  const items = state.market?.items || [];
  const by = new Map(items.map((x) => [x.sym, x]));
  const sel = mktSel().filter((s) => by.has(s));
  let html = `<p class="sheet-desc">ホームに出す指標を選びます。タップで追加・外す、↑↓で並べ替え（この端末に保存）</p>
    <h4 class="mday">表示中（${sel.length}）</h4>`;
  html += sel.length ? `<ul class="list">${sel.map((s, i) => `<li class="pick on mkt-row"><div class="main"><div class="name">${esc(by.get(s).name)}</div></div>
      <button class="mv" data-mkt-mv="${esc(s)}|-1" ${i === 0 ? "disabled" : ""} aria-label="上へ">↑</button><button class="mv" data-mkt-mv="${esc(s)}|1" ${i === sel.length - 1 ? "disabled" : ""} aria-label="下へ">↓</button>
      <button class="mv" data-mkt-tg="${esc(s)}" aria-label="外す">×</button></li>`).join("")}</ul>` : `<p class="hint">まだありません</p>`;
  let grp = "";
  for (const x of items) {
    if (sel.includes(x.sym)) continue;
    const g = x.grp || "その他";
    if (g !== grp) { if (grp) html += "</ul>"; grp = g; html += `<h4 class="mday">${esc(g)}</h4><ul class="list">`; }
    html += `<li class="pick" data-mkt-tg="${esc(x.sym)}"><div class="main"><div class="name">${esc(x.name)}</div></div><span class="ck">＋</span></li>`;
  }
  if (grp) html += "</ul>";
  html += `<button class="btn ghost wide" data-mkt-reset>最初の状態に戻す</button>`;
  $("#sheet-body").innerHTML = html;
}
function mktSave(sel) {
  saveJSON(MKT_KEY, sel);
  renderMktEdit();
  renderHome();
}

// 銘柄を選ぶ（日経225の業種別リスト）
function openPicker() {
  const html = `<input id="pick-q" type="search" placeholder="コード・社名で絞り込み" autocomplete="off"><div id="pick-list"></div>`;
  openSheet(`保有銘柄を選ぶ（${state.hold.size}）`, html, null);
  renderPicker();
  $("#pick-q").addEventListener("input", renderPicker);
}

function renderPicker() {
  const q = norm($("#pick-q")?.value.trim() || "");
  const list = state.n225.codes.filter((x) => !q || x.c.toLowerCase().startsWith(q) || norm(x.n).includes(q) || norm(holdName(x.c)).includes(q));
  let html = "", sec = "";
  for (const x of list) {
    if (x.sec !== sec) { if (sec) html += "</ul>"; sec = x.sec; html += `<h4 class="mday">${esc(sec)}</h4><ul class="list">`; }
    const on = state.hold.has(x.c);
    html += `<li class="pick${on ? " on" : ""}" data-pick-hold="${esc(x.c)}"><span class="code">${esc(x.c)}</span><div class="main"><div class="name">${esc(holdName(x.c))}</div></div><span class="ck">${on ? "✓" : ""}</span></li>`;
  }
  $("#pick-list").innerHTML = list.length ? html + "</ul>" : `<p class="empty-msg">見つかりません</p>`;
  $("#sheet-title").textContent = `保有銘柄を選ぶ（${state.hold.size}）`;
}

async function togglePick(c) {
  state.hold.has(c) ? state.hold.delete(c) : state.hold.add(c);
  saveHold();
  renderPicker();
  await loadHold(c);
  computeAlerts();
  renderHome(); renderHold(); renderWeek(); renderCalendar(); renderDay(); renderMonth();
}

function setPos(c, k, v) {
  const n = Number(String(v).replace(/[^\d.]/g, ""));
  pos[c] = { ...(pos[c] || {}), [k]: n > 0 ? n : 0 };
  saveJSON(POS_KEY, pos);
  computeAlerts();
  renderHome(); renderHold(); renderWeek();
  const h = state.h.get(c), el = $("#pos-out");
  if (el && h) el.innerHTML = posSummary(c);
}

function posSummary(c) {
  const h = state.h.get(c), q = qty(c);
  if (!h || !q) return `<span class="hint">株数を入れると評価額と、イベントごとの影響が円で出ます</span>`;
  const pl = pos[c]?.cost ? q * (h.px - pos[c].cost) : null;
  return `評価額 <b>${yen(value(c))}</b>${pl != null ? ` · 含み損益 ${yenPct(pl)}` : ""} · 普段の1日 ±${yen(value(c) * h.vol / 100)}`;
}

// 保有銘柄の詳細: どのイベント・ニュース・決算でどう動いたか
async function openHolding(c) {
  const h = await loadHold(c);
  const name = holdName(c);
  const s = state.stock.get(c) || {};
  const today = todayStr();
  const nx = state.nextByCode.get(c);
  const q = qty(c);
  const y = (p) => (q && p != null ? `<small>≒${yen(value(c) * p / 100)}</small>` : "");
  let html = `<p class="sheet-desc">${esc(c)} · ${esc(s.sec || "")}${h ? ` · 終値 ${h.px.toLocaleString()}円（${fmtMD(h.pd)}）· 普段の1日の値動き ±${h.vol.toFixed(2)}%` : ""}</p>`;
  if (!h) { openSheet(name, html + `<p class="msum">反応データはまだありません（次回の更新で作られます）</p>`, null); return; }
  html += `<div class="card posbox"><div class="pos-in">
      <label>株数<input inputmode="numeric" data-pos="${esc(c)}|q" value="${pos[c]?.q || ""}" placeholder="例 100"></label>
      <label>取得単価（円）<input inputmode="decimal" data-pos="${esc(c)}|cost" value="${pos[c]?.cost || ""}" placeholder="任意"></label></div>
    <div id="pos-out" class="pos-out">${posSummary(c)}</div></div>`;

  // 1) 今後2週間のイベント・同業の決算
  const lim = new Date(); lim.setDate(lim.getDate() + 14);
  const up = state.events.filter((e) => e.d >= today && e.d <= ymd(lim) && !e.code)
    .map((e) => ({ e, st: holdSeriesStat(h, e) })).filter((x) => x.st && x.st.n >= 3)
    .sort((a, b) => b.st.abs - a.st.abs);
  if (up.length) {
    html += `<h3 class="sec">今後2週間のイベント</h3><table class="rxtable hist"><thead><tr><th></th><th>上昇</th><th>平均</th><th>振れ幅</th></tr></thead><tbody>`
      + up.slice(0, 8).map(({ e, st }) => `<tr data-hser="${esc(c)}|${esc(e.id)}" class="${st.abs / h.vol >= ALERT_RATIO ? "warn" : ""}"><th>${fmtMD(e.d)} ${esc(seriesName(e))}<small>${st.abs / h.vol >= ALERT_RATIO ? "⚠ 普段より大きく動きやすい · " : ""}過去${st.n}回</small></th>
        <td class="num">${st.up}/${st.n}</td><td>${pct(st.avg)}</td><td class="num">${st.abs.toFixed(1)}%${y(st.abs)}</td></tr>`).join("")
      + `</tbody></table>`;
  }

  // 2) 同業他社の決算
  const peers = peersOf(c).map((p) => ({ p, st: peerStat(c, p) })).filter((x) => x.st && x.st.n >= 4).sort((a, b) => b.st.abs - a.st.abs).slice(0, 8);
  if (peers.length) {
    html += `<h3 class="sec">同業他社の決算のとき</h3><table class="rxtable hist"><thead><tr><th></th><th>上昇</th><th>平均</th><th>振れ幅</th></tr></thead><tbody>`
      + peers.map(({ p, st }) => { const n = state.nextByCode.get(p); return `<tr data-hser="${esc(c)}|peer:${esc(p)}" class="${st.abs / h.vol >= ALERT_RATIO ? "warn" : ""}"><th>${esc(holdName(p))}<small>${n?.d >= today ? `次回 ${fmtMD(n.d)} · ` : ""}過去${st.n}回</small></th>
        <td class="num">${st.up}/${st.n}</td><td>${pct(st.avg)}</td><td class="num">${st.abs.toFixed(1)}%${y(st.abs)}</td></tr>`; }).join("")
      + `</tbody></table><p class="note">同じ業種・テーマの日経225銘柄の決算反応日に、この銘柄がどう動いたか（自社の決算と重なった日は除く）</p>`;
  }

  // 3) 指標・イベント別（よく動く順）
  const seen = new Set(), rows = [];
  for (const ev of [...state.events].reverse()) {
    if (ev.d > today || ev.code) continue;
    const k = seriesOf(ev);
    if (seen.has(k)) continue;
    seen.add(k);
    const st = holdSeriesStat(h, ev);
    if (st && st.n >= 3) rows.push({ ev, st });
  }
  rows.sort((a, b) => b.st.abs - a.st.abs);
  if (rows.length) {
    html += `<h3 class="sec">指標・イベント別（よく動く順）</h3><table class="rxtable hist"><thead><tr><th></th><th>上昇</th><th>平均</th><th>振れ幅</th><th>日経</th></tr></thead><tbody>`
      + rows.slice(0, 12).map(({ ev, st }) => `<tr data-hser="${esc(c)}|${esc(ev.id)}"><th>${esc(seriesName(ev))}<small>過去${st.n}回</small></th>
        <td class="num">${st.up}/${st.n}</td><td>${pct(st.avg)}</td><td class="num">${st.abs.toFixed(1)}%</td><td class="num muted">${st.nk ? st.nk.abs.toFixed(1) + "%" : "—"}</td></tr>`).join("")
      + `</tbody></table><p class="note">各イベントの反応日（発表後に最初に開いた日本の立会日）の騰落率、過去20回まで（それより少ない種類はある分だけ）。振れ幅＝上げ下げを問わない平均の動き。日経＝同じ日の日経平均の振れ幅。同じ日に別のイベントがあった場合はその影響も含みます</p>`;
  }

  // 4) ニュース（大きく動いた順）
  const ns = state.news.map((n) => ({ n, r: newsR(h, n.id) })).filter((x) => x.r && x.r[0] != null)
    .sort((a, b) => Math.abs(b.r[0]) - Math.abs(a.r[0])).slice(0, 8);
  if (ns.length) {
    html += `<h3 class="sec">大きく動いたニュース</h3><table class="rxtable hist"><thead><tr><th></th><th>反応日</th><th>1週間</th><th>1か月</th></tr></thead><tbody>`
      + ns.map(({ n, r }) => `<tr data-news="${esc(n.id)}"><th>${fmtMD(n.d)} ${esc(n.title)}</th>
        <td>${pct(r[0])}</td><td>${pct(r[1])}</td><td>${pct(r[2])}</td></tr>`).join("")
      + `</tbody></table>`;
  }

  // 5) 決算
  html += earnHistoryHtml(c, nx?.d && nx.d >= today ? nx.d : "9999-12-31");
  if (nx?.d) html += `<p class="msum">次の決算: ${fmtDay(nx.d)}${nx.d < today ? "（発表済・次回は未定）" : ""}</p>`;
  html += `<button class="btn ghost" data-unhold="${esc(c)}">保有から外す</button>`;
  openSheet(name, html, () => openHolding(c));
}

// 保有銘柄 × 指標（または同業の決算）: 各回の反応
function openHoldSeries(c, key) {
  const h = state.h.get(c);
  if (!h) return;
  const q = qty(c);
  let title, desc, rows, cols, why = "";
  if (key.startsWith("peer:")) {
    const p = key.slice(5), st = peerStat(c, p);
    if (!st) return;
    title = `${holdName(p)} 決算 × ${holdName(c)}`;
    desc = `同業の${esc(holdName(p))}の決算反応日に、${esc(holdName(c))}（普段の1日 ±${h.vol.toFixed(2)}%）がどう動いたか`;
    rows = st.rows.slice().reverse().map((x) => ({ d: x.d, attr: `data-rx="${esc(x.k)}"`, x }));
    cols = [{ h: holdName(c).slice(0, 8), f: (o) => dayR(h, o.x.day) }, { h: holdName(p).slice(0, 8), f: (o) => state.rx.earnings[o.x.k]?.r ?? null }];
  } else {
    const ev = state.events.find((e) => e.id === key);
    if (!ev) return;
    title = `${seriesName(ev)} × ${holdName(c)}`;
    desc = `${esc(holdName(c))}（普段の1日 ±${h.vol.toFixed(2)}%）が「${esc(seriesName(ev))}」の反応日にどう動いたか`;
    rows = eventHistory(ev).filter((e) => e.d < todayStr()).map((e) => ({ d: e.d, sub: e.desc, attr: `data-evrx="${esc(e.id)}"`, id: e.id }));
    cols = [{ h: holdName(c).slice(0, 8), f: (x) => evR(h, x.id) }, { h: "日経平均", f: (x) => nkR(x.id) },
      { h: "日経との差", f: (x) => (evR(h, x.id) != null && nkR(x.id) != null ? evR(h, x.id) - nkR(x.id) : null) }];
    const k = seriesOf(ev), dname = driverName(ev);
    if (rows.some((x) => driverVal(x.id, k) != null)) cols.push({ h: dname === "ドル円" ? "ドル円 1時間後" : dname.replace(/の株価$/, ""), f: (x) => driverVal(x.id, k) });
    const nxt = (state.series.get(k) || []).find((e) => e.d >= todayStr()) || ev;
    const rr = rows.map((x) => evR(h, x.id)), av = rr.filter((v) => v != null);
    const sg = av.length && av.reduce((a, v) => a + v, 0) >= 0 ? 1 : -1, rk = reactTiming(nxt.d, nxt.t);
    const wk = (d) => { if (!state.hday.has(d)) return null; const i = state.hday.get(d), v = h.r.slice(i, i + 5); return v.length === 5 && v.every((x) => x != null) ? (v.reduce((a, x) => a * (1 + x / 100), 1) - 1) * 100 : null; };
    why = timingHtml(nxt.d, nxt.t, timing({ r: rr, g: rows.map((x) => gapOf(h, evDay(x.id))), w1: rows.map((x) => wk(evDay(x.id))), nk: rows.map((x) => nkR(x.id)), nw: rows.map((x) => nkWeek(evDay(x.id))), s: sg, d: nxt.d, t: nxt.t }), sg);
    why += evidenceHtml(c, k, { r: rows.map((x) => evR(h, x.id)), nk: rows.map((x) => nkR(x.id)), dv: rows.map((x) => driverVal(x.id, k)), dname });
  }
  const st = stat(rows.map((r) => cols[0].f(r)));
  const html = `<p class="sheet-desc">${desc}</p>`
    + (q && st ? `<p class="msum">今の株数（${q.toLocaleString()}株）なら、平均 ±${yen(value(c) * st.abs / 100)} の値動き</p>` : "")
    + why
    + historyHtml(`${holdName(c)} の反応`, rows, cols, { note: `反応日の終値騰落率。${cols.length > 3 ? (cols[3].h.startsWith("ドル円") ? "ドル円 1時間後 = 発表1時間後のドル円の変化率（その回の結果を市場がどう受け止めたかの目安）。" : `${esc(cols[3].h)} = その会社の決算後の最初の取引日の騰落率。`) : ""}行をタップでその回の詳細` })
    + (!state.hold.has(c) && state.n225set.has(c) ? `<button class="btn wide" data-addhold="${esc(c)}">＋ 保有銘柄に追加</button>` : "");
  openSheet(title, html, () => openHoldSeries(c, key));
  $("#sheet").scrollTop = 0;
}

// イベント・ニュースのシートに差し込む「保有銘柄の反応」
function holdEventHtml(ev) {
  if (!state.hold.size || !state.hidx) return "";
  const rows = [...state.hold].map((c) => {
    const h = state.h.get(c);
    if (!h) return "";
    const r = evR(h, ev.id), st = holdSeriesStat(h, ev);
    if (r == null && !st) return "";
    return `<tr data-hser="${esc(c)}|${esc(ev.id)}"><th>${esc(holdName(c))}${qty(c) && st ? `<small>平均 ±${yen(value(c) * st.abs / 100)}</small>` : ""}</th><td>${pct(r)}</td><td class="num">${st ? `${st.up}/${st.n}` : "—"}</td><td class="num">${st ? st.abs.toFixed(1) + "%" : "—"}</td></tr>`;
  }).join("");
  const a = state.alerts.get(ev.id);
  return rows ? `<h3 class="sec">保有銘柄の反応</h3>${a?.pf ? `<p class="msum">保有株全体で過去平均 <b>±${yen(a.pf.abs)}</b>（普段の${a.pf.ratio.toFixed(1)}倍）</p>` : ""}<table class="rxtable hist"><thead><tr><th></th><th>この回</th><th>過去の上昇</th><th>過去の振れ幅</th></tr></thead><tbody>${rows}</tbody></table>` : "";
}

function holdNewsHtml(id) {
  if (!state.hold.size || !state.hidx) return "";
  let tot = 0, any = false;
  const rows = [...state.hold].map((c) => {
    const r = newsR(state.h.get(c), id);
    if (r && r[0] != null && qty(c)) { tot += value(c) / (1 + (r[0] || 0) / 100) * r[0] / 100; any = true; }
    return r ? `<tr data-hold="${esc(c)}"><th>${esc(holdName(c))}</th><td>${pct(r[0])}</td><td>${pct(r[1])}</td><td>${pct(r[2])}</td></tr>` : "";
  }).join("");
  return rows ? `<h3 class="sec">保有銘柄の反応</h3>${any ? `<p class="msum">今の株数なら反応日に ${yenPct(tot)}</p>` : ""}<table class="rxtable hist"><thead><tr><th></th><th>反応日</th><th>1週間</th><th>1か月</th></tr></thead><tbody>${rows}</tbody></table>` : "";
}

// ---------- ホーム ----------
function renderHome() {
  const el = $("#home");
  if (!el) return;
  const now = new Date(), today = todayStr();
  const evening = now.getHours() >= 15;
  let html = `<div class="home-head"><div class="date">${now.getMonth() + 1}月${now.getDate()}日(${WD[now.getDay()]})</div><h2>${evening ? "夕方のブリーフ" : "朝のブリーフ"}</h2></div>`;

  // ブリーフ（Claude 定期実行が作る）
  const b = state.brief;
  if (b?.items?.length) {
    const stale = b.d !== today;
    html += `<div class="card brief"><div class="card-h"><span>今日のポイント</span><small>${stale ? `${fmtMD(b.d)} ` : ""}${esc(b.t || "")} 作成</small></div>
      <ol>${b.items.map((x) => `<li><b>${esc(x.h)}</b>${x.b ? `<p>${esc(x.b)}</p>` : ""}</li>`).join("")}</ol></div>`;
  }

  // 市場（表示する指標は「編集」で選べる）
  if (state.market?.items?.length) {
    const m = mktShown();
    html += `<div class="card"><div class="card-h"><span>マーケット</span><small>前日比 · 終値ベース <button class="link" data-mkt-edit>編集</button></small></div>`
      + (m.length ? `<div class="tiles">${m.map(mktTile).join("")}</div>` : `<p class="hint">表示する指標が選ばれていません。「編集」から選べます</p>`)
      + `</div>`;
  }

  // 保有株
  const pf = portfolio();
  if (pf) html += pfCard(pf, { link: true });
  else if (state.hold.size) html += `<div class="card has-rx" data-go="hold"><div class="card-h"><span>保有銘柄 ${state.hold.size}</span><small>株数を入れると評価額と影響額（円）が出ます ›</small></div></div>`;
  else if (!state.hold.size) html += `<div class="empty-card"><b>持っている株を登録しよう</b><p>イベントやニュースで、あなたの株がどう動きやすいかをここに出します</p><button class="btn" data-go="hold">保有銘柄を登録</button></div>`;

  // 今日・次の営業日
  const days = [];
  for (let d = new Date(now); days.length < 2; d.setDate(d.getDate() + 1)) {
    const k = ymd(d);
    if (k === today || (d.getDay() % 6 !== 0)) days.push(k);
  }
  for (const k of days) {
    const items = weekItems(k).filter((it) => it.kind !== "news" && (it.impact >= 2 || it.watched || state.alerts.has(it.id) || /holiday/.test(it.id || "")));
    for (const a of state.alertList.filter((x) => x.kind === "peer" && x.d === k)) items.push({ kind: "peer", a, d: k, t: a.t, title: a.title, impact: 2 });
    items.sort((a, b) => (a.t || "99").localeCompare(b.t || "99") || b.impact - a.impact);
    html += `<h3 class="sec">${k === today ? "今日" : fmtMD(k)}の予定</h3>`;
    html += items.length ? `<ul class="list">${items.map(homeRow).join("")}</ul>` : `<p class="hint">大きな予定はありません</p>`;
  }

  // 傾向: 次の売買（直近2つの枠）
  if (state.bias?.items?.length && state.n225set.size) {
    const hm = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const its = state.bias.items.filter((x) => x.d >= today && state.n225set.has(x.c));
    const sls = biasSlots(its, today).filter((sl) => sl.d > today || (sl.t === "寄り" ? hm < "09:00" : hm < "15:30")).slice(0, 2);
    if (sls.length) {
      html += `<h3 class="sec">次の売買（傾向）<button class="link" data-go="bias">すべて ›</button></h3>`;
      for (const sl of sls) {
        const L = 5;
        html += `<div class="card slot"><div class="card-h"><span>${sl.d === today ? "今日" : fmtMD(sl.d)} ${sl.t === "寄り" ? "寄り（9:00前に寄成）" : "引け（15:30前に引成）"}</span></div><ul class="slot-list">`
          + [...sl.outs.values()].map((o) => `<li><span class="tag ${o.back === "売り" ? "t-sell" : "t-cover"}">${o.back}</span><span class="sl-main">${o.xs.map((x) => `<span class="oname" data-bias="${esc(x.c)}|${esc(x.k === "earn" ? `earn@${x.d}` : x.id)}">${esc(holdName(x.c))} ${esc(x.c)}</span>`).join("、")}<small>${esc(o.title)}（${esc(o.from)}に入った分）</small></span></li>`).join("")
          + sl.holds.map(({ ch, l }) => `<li data-bias="${esc(biasKey(l.x))}" class="has-rx"><span class="tag t-chain">持ち越し</span><span class="sl-main"><b>${esc(holdName(ch.c))}</b> <span class="ncode">${esc(ch.c)}</span><small>売らずに次の ${esc(biasTitle(l.x))} まで持つ（${ch.p.back} ${fmtMD(ch.p.outD)}${ch.p.outT}）</small></span><span class="chev">›</span></li>`).join("")
          + sl.ins.slice(0, L).map((ch) => { const { x, tm0 } = ch.legs[0], p = ch.p, many = ch.legs.length > 1;
            return `<li data-bias="${esc(biasKey(x))}" class="has-rx"><span class="tag ${x.s > 0 ? "t-buy" : "t-short"}">${p.act}</span><span class="sl-main"><b>${esc(holdName(x.c))}</b> <span class="ncode">${esc(x.c)}</span><small>${ch.legs.map((l) => `${fmtMD(l.x.d)} ${esc(biasTitle(l.x))}`).join("＋")} → ${p.back} ${fmtMD(p.outD)}${p.outT} · ${x.s > 0 ? "上昇" : "下落"} ${many ? `${ch.legs.map((l) => (l.tm0 ? `${l.tm0.P.same}/${l.tm0.P.n}` : `${l.x.w}/${l.x.n}`)).join("・")}回 合計 ${prof(ch.net)}` : tm0 ? `${tm0.P.same}/${tm0.P.n}回 利益 ${prof(tm0.net)}` : `${x.w}/${x.n}回 ${pct(x.avg)}`}${ch.clash ? " · ⚠逆向きと重なる" : ""}</small></span><span class="chev">›</span></li>`; }).join("")
          + (sl.ins.length > L ? `<li class="more-li" data-go="bias">ほか ${sl.ins.length - L} 銘柄 ›</li>` : "")
          + `</ul></div>`;
      }
    }
  }

  // この先2週間の注意（今日・次の日以外）
  const later = state.alertList.filter((a) => !days.includes(a.d));
  if (later.length) html += `<h3 class="sec">この先2週間、保有株が動きやすい予定</h3><ul class="list">${later.slice(0, 6).map(alertRow).join("")}</ul>`;

  // 保有株の決算
  const ups = [...state.hold].map((c) => ({ c, e: state.nextByCode.get(c) })).filter((x) => x.e?.d >= today).sort((a, b) => a.e.d.localeCompare(b.e.d)).slice(0, 5);
  if (ups.length) html += `<h3 class="sec">保有株の決算予定</h3><ul class="list">${ups.map(({ c, e }) => `<li class="row has-rx" data-rx="${esc(c)}@${esc(e.d)}"><div class="when"><b>${fmtMD(e.d)}</b><span>${esc(e.t || "")}</span></div><div class="main"><div class="name">${esc(holdName(c))}</div><div class="sub">過去の決算反応を見る</div></div><span class="chev">›</span></li>`).join("")}</ul>`;

  // 最新ニュース
  if (state.news.length) html += `<h3 class="sec">最近の相場ニュース<button class="link" data-go="news">すべて ›</button></h3><ul class="list">${state.news.slice(0, 4).map((n) => newsCard(n, true)).join("")}</ul>`;
  el.innerHTML = html;
}

function homeRow(it) {
  let attr = "", sub = it.desc || "";
  if (it.kind === "peer") return alertRow(it.a);
  if (it.kind === "ev") attr = state.rx.events[it.id] || eventHistory(it).length ? `data-evrx="${esc(it.id)}"` : "";
  else if (it.kind === "earn") attr = `data-rx="${esc(it.rxKey)}"`;
  else if (it.kind === "ipo") attr = `data-ipo="${esc(it.c)}"`;
  const a = it.kind === "ev" && state.alerts.get(it.id);
  if (a) sub = a.pf ? `保有株全体で過去平均 ±${yen(a.pf.abs)}（普段の${a.pf.ratio.toFixed(1)}倍）` : a.stocks.map((s) => `${holdName(s.c)} ±${s.abs.toFixed(1)}%`).join(" · ");
  return `<li class="row${attr ? " has-rx" : ""}${a ? " alert" : ""}" ${attr}>
    <div class="when"><b>${esc(it.t || "—")}${it.t && it.approx ? "<small>頃</small>" : ""}</b>${stars(it.impact)}</div>
    <div class="main"><div class="name">${it.watched ? '<span class="tag">保有</span>' : ""}${esc(it.title)}</div>${sub ? `<div class="sub">${esc(sub)}</div>` : ""}</div>${attr ? '<span class="chev">›</span>' : ""}</li>`;
}

function renderAll() {
  renderHome(); renderWeek(); renderCalendar(); renderDay(); renderSearch(); renderHold(); renderIpo(); renderNews(); renderBias();
  renderMonth();
  if ($("#sheet").open && state.sheetFn) state.sheetFn();
}

// ---------- 操作 ----------
function setSeg(el, v) {
  el.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.v === v));
}

document.addEventListener("click", (ev) => {
  const go = ev.target.closest("[data-go]");
  if (go) {
    if ($("#sheet").open) $("#sheet").close();
    switchTab(go.dataset.go);
    if (go.dataset.go === "hold" && !state.hold.size) openPicker();
    return;
  }
  if (ev.target.closest("#hold-edit2")) { openPicker(); return; }
  const addh = ev.target.closest("[data-addhold]");
  if (addh) {
    const c = addh.dataset.addhold;
    state.hold.add(c); saveHold();
    loadHold(c).then(() => { refreshHold(); renderCalendar(); renderDay(); openHolding(c); });
    return;
  }
  const unh = ev.target.closest("[data-unhold]");
  if (unh) { state.hold.delete(unh.dataset.unhold); saveHold(); $("#sheet").close(); refreshHold(); renderCalendar(); renderDay(); return; }
  if (ev.target.closest("input")) return;
  if (ev.target.closest("[data-mkt-edit]")) { openMktEdit(); return; }
  const mtg = ev.target.closest("[data-mkt-tg]");
  if (mtg) { const s = mtg.dataset.mktTg, sel = mktSel(); mktSave(sel.includes(s) ? sel.filter((x) => x !== s) : [...sel, s]); return; }
  const mmv = ev.target.closest("[data-mkt-mv]");
  if (mmv) {
    const [s, d] = mmv.dataset.mktMv.split("|"), sel = mktSel(), i = sel.indexOf(s), j = i + Number(d);
    if (i >= 0 && j >= 0 && j < sel.length) { [sel[i], sel[j]] = [sel[j], sel[i]]; mktSave(sel); }
    return;
  }
  if (ev.target.closest("[data-mkt-reset]")) { try { localStorage.removeItem(MKT_KEY); } catch { /* noop */ } renderMktEdit(); renderHome(); return; }
  const ph = ev.target.closest("[data-pick-hold]");
  if (ph) { togglePick(ph.dataset.pickHold); return; }
  if (ev.target.closest("#hold-edit")) { openPicker(); return; }
  if (ev.target.closest("[data-past-more]")) { state.pastLim = (state.pastLim || 80) + 200; renderBias(); return; }
  const bm = ev.target.closest("[data-bias-more]");
  if (bm) { state.biasOpen.add(bm.dataset.biasMore); renderBias(); return; }
  const bi = ev.target.closest("[data-bias]");
  if (bi) { openBias(bi.dataset.bias); return; }
  const hs = ev.target.closest("[data-hser]");
  if (hs) { const [c, id] = hs.dataset.hser.split("|"); openHoldSeries(c, id); return; }
  const hev = ev.target.closest("[data-hev]");
  if (hev) { openEventRx(hev.dataset.hev); return; }
  const hd = ev.target.closest("[data-hold]");
  if (hd) { openHolding(hd.dataset.hold); return; }
  const ncat = ev.target.closest("[data-ncat]");
  if (ncat) { prefs.newsCat = ncat.dataset.ncat; saveJSON(PREF_KEY, prefs); renderNews(); return; }
  const nw = ev.target.closest("[data-news]");
  if (nw && !ev.target.closest("[data-theme]")) { openNews(nw.dataset.news); return; }
  const erx = ev.target.closest("[data-evrx]");
  if (erx && !ev.target.closest("[data-theme]")) { openEventRx(erx.dataset.evrx); return; }
  const rxe = ev.target.closest("[data-rx]");
  if (rxe && !ev.target.closest("[data-theme]")) { openEarnRx(rxe.dataset.rx); return; }
  const th = ev.target.closest("[data-theme]");
  if (th) { openTheme(th.dataset.theme); return; }
  const pick = ev.target.closest("[data-pick]");
  if (pick) {
    const inEv = !!pick.closest("#ev-themes");
    const v = pick.dataset.pick;
    if (inEv) state.evTheme = v; else state.calTheme = v;
    renderThemeBars();
    if (inEv) renderWeek(); else { renderDay(); renderMonth(); }
    return;
  }
  const seg = ev.target.closest(".seg button");
  if (seg) {
    const box = seg.parentElement;
    setSeg(box, seg.dataset.v);
    if (box.id === "plan-seg") { switchTab(seg.dataset.v); return; }
    if (box.id === "ipo-mode") { prefs.ipoMode = seg.dataset.v; renderIpo(); }
    else if (box.id === "bias-dir") { prefs.biasDir = seg.dataset.v; renderBias(); }
    else if (box.id === "bias-kind") { prefs.biasKind = seg.dataset.v; renderBias(); }
    else if (box.id === "bias-mode") { prefs.biasMode = seg.dataset.v; renderBias(); }
    else if (box.id === "ev-mode") {
      prefs.evMode = seg.dataset.v;
      if (prefs.evMode === "week") state.weekStart = mondayOf(state.weekStart);
      renderWeek();
    }
    else if (box.id === "cal-mode") { prefs.calMode = seg.dataset.v; applyCalMode(); renderMonth(); }

    saveJSON(PREF_KEY, prefs);
    return;
  }
  const ipoEl = ev.target.closest("[data-ipo]");
  if (ipoEl) { openIpo(ipoEl.dataset.ipo); return; }
  const earn = ev.target.closest(".ev[data-code]");
  if (earn) {
    // 決算イベントをタップ → 決算タブのその日へ
    state.selected = state.earnings.find((e) => e.c === earn.dataset.code && e.d >= state.weekStart)?.d || state.selected;
    state.month = state.selected.slice(0, 7);
    switchTab("cal");
    renderCalendar(); renderDay();
    return;
  }
  const tab = ev.target.closest(".tabs button");
  if (tab) switchTab(tab.dataset.v);
});

// 下のタブ: ホーム / 予定（イベント・決算・IPO を上の切り替えで）/ ニュース / 保有 / 検索
const PLAN = ["events", "cal", "ipo", "bias"];
const TITLES = { home: "ホーム", plan: "予定", news: "ニュース", hold: "保有銘柄", search: "検索" };
function switchTab(v) {
  if (PLAN.includes(v)) { prefs.plan = v; saveJSON(PREF_KEY, prefs); v = "plan"; }
  const view = v === "plan" ? (prefs.plan || "events") : v;
  document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.v === v));
  document.querySelectorAll(".view").forEach((s) => s.classList.toggle("active", s.id === `view-${view}`));
  $("#plan-seg").hidden = v !== "plan";
  setSeg($("#plan-seg"), view);
  $("#page-title").textContent = TITLES[v] || "";
  window.scrollTo(0, 0);
}

// 読み込みに失敗したとき: 表示をタップ、アプリを開き直す、回線が戻る のどれかで読み直す
const retryLoad = () => { if (state.loadFailed?.length) location.reload(); };
$("#updated").addEventListener("click", retryLoad);
document.addEventListener("visibilitychange", () => { if (!document.hidden) retryLoad(); });
window.addEventListener("online", retryLoad);

// ---------- 最新の状況に更新（↻） ----------
// GitHub Actions のデータ更新（update.yml）をその場で動かし、終わったら読み直す。
// 動かすには GitHub のトークン（このリポジトリの Actions 読み書きだけ許可したもの）が要り、この端末にだけ保存する
const GH_REPO = "pteratakahashi/kabu-calendar", GH_WF = "update.yml";
// 名前・期限・権限（Actions の読み書き）を入れた状態で作成画面を開く（リポジトリの選択だけは URL で指定できない）
const GH_TOKEN_URL = "https://github.com/settings/personal-access-tokens/new?name=kabu-calendar-refresh&description=" + encodeURIComponent("株カレンダーの更新ボタン用") + "&expires_in=none&actions=write";
const GH_TOKEN_KEY = "kabucal.ghtoken.v1", GH_RUN_KEY = "kabucal.refresh.v1";
const ghToken = () => { try { return localStorage.getItem(GH_TOKEN_KEY) || ""; } catch { return ""; } };
async function gh(path, opt = {}) {
  const r = await fetch(`https://api.github.com/repos/${GH_REPO}${path}`, { ...opt, cache: "no-store",
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${ghToken()}`, ...(opt.headers || {}) } });
  if (r.status === 401 || r.status === 403 || r.status === 404) throw Object.assign(new Error("token"), { auth: true });
  if (!r.ok) throw new Error(`GitHub ${r.status}`);
  return r.status === 204 ? null : r.json();
}
function refreshMsg(t) {
  const el = $("#updated");
  el.textContent = t;
  el.classList.remove("stale");
}
async function startRefresh() {
  if (!ghToken()) { openRefreshSetup(); return; }
  const btn = $("#refresh");
  btn.classList.add("busy");
  refreshMsg("更新を開始…");
  const since = Date.now() - 15000;
  try {
    await gh(`/actions/workflows/${GH_WF}/dispatches`, { method: "POST", body: JSON.stringify({ ref: "main" }) });
    saveJSON(GH_RUN_KEY, { since });
    await pollRefresh(since);
  } catch (e) {
    btn.classList.remove("busy");
    renderUpdated();
    if (e.auth) openRefreshSetup("トークンが使えませんでした（期限切れ・権限不足など）。作り直して登録してください。");
    else alert(`更新を始められませんでした（${e.message}）。時間をおいて試してください。`);
  }
}
async function pollRefresh(since) {
  const btn = $("#refresh");
  btn.classList.add("busy");
  const t0 = Date.now();
  while (Date.now() - since < 15 * 60 * 1000) {
    let run = null;
    try {
      const d = await gh(`/actions/workflows/${GH_WF}/runs?event=workflow_dispatch&per_page=5`);
      run = (d.workflow_runs || []).find((r) => Date.parse(r.created_at) >= since - 60000) || null;
    } catch (e) { if (e.auth) break; }
    const sec = Math.round((Date.now() - since) / 1000);
    const el = `${Math.floor(sec / 60)}:${pad(sec % 60)}`;
    if (run?.status === "completed") {
      saveJSON(GH_RUN_KEY, null);
      if (run.conclusion === "success") { refreshMsg("更新完了 · 読み直し中…"); location.reload(); return; }
      btn.classList.remove("busy");
      renderUpdated();
      alert(`データの更新が失敗しました（${run.conclusion}）。前回のデータのまま表示しています。`);
      return;
    }
    refreshMsg(`${run?.status === "in_progress" ? "データを取り直し中" : "更新の順番待ち"}… ${el}（3〜5分）`);
    await new Promise((r) => setTimeout(r, Date.now() - t0 < 60000 ? 5000 : 10000));
  }
  saveJSON(GH_RUN_KEY, null);
  btn.classList.remove("busy");
  renderUpdated();
}
function openRefreshSetup(err = "") {
  openSheet("最新の状況に更新", `${err ? `<p class="clash">${esc(err)}</p>` : ""}
    <p class="sheet-desc">↻ を押すと、株価・予定・傾向のデータをその場で取り直します（3〜5分）。いつもは 7:00 と 18:30 の1日2回、自動で更新しています。</p>
    <p class="sheet-desc">取り直しは GitHub で動いているので、最初に1回だけ <b>GitHub の合い鍵（トークン）</b>をこの端末に登録します。GitHub の画面は英語ですが、押す場所だけ書いておきます。</p>
    <a class="btn wide" href="${GH_TOKEN_URL}" target="_blank" rel="noopener">① GitHub の合い鍵の作成画面を開く</a>
    <p class="hint">名前・期限（無期限）・権限は入力済みの状態で開きます。ログイン画面が出たらログインしてください。</p>
    <ol class="steps-ol">
      <li>画面の中ほどの <b>「Repository access」</b>（どのリポジトリに使うか）で、<b>「Only select repositories」</b>（選んだものだけ）を押す</li>
      <li>すぐ下に出る <b>「Select repositories」</b> を押して、<b>kabu-calendar</b> を選ぶ</li>
      <li>一番下までスクロールして、緑のボタン <b>「Generate token」</b>（作成）を押す。確認の画面が出たら、もう一度 <b>「Generate token」</b></li>
      <li><b>github_pat_</b> で始まる長い文字の横にある、<b>四角が2つ重なったマーク</b>（コピー）を押す</li>
      <li>このアプリに戻って、下の「貼り付け」を押す（または欄に貼り付け）</li>
    </ol>
    <p class="hint">※「Permissions」の欄に「Actions: Read and write」と出ていれば権限はOKです。ここは触らなくて大丈夫です。</p>
    <input id="gh-token" class="tok-input" type="password" placeholder="github_pat_… をここに貼り付け" autocomplete="off" value="${esc(ghToken())}">
    <button class="btn ghost wide" data-tok-paste>貼り付け</button>
    <button class="btn wide" data-tok-save>登録して更新する</button>
    <p class="hint">トークンはこの端末の中だけに保存され、GitHub 以外には送りません。このリポジトリのデータ更新を動かすことしかできない権限です。</p>
    <button class="btn ghost wide" data-reload>データの読み直しだけする</button>
    ${ghToken() ? `<button class="btn ghost wide" data-tok-del>この端末のトークンを消す</button>` : ""}`, null);
}
$("#refresh").addEventListener("click", startRefresh);
$("#sheet").addEventListener("click", (ev) => {
  if (ev.target.closest("[data-tok-save]")) {
    const v = $("#gh-token").value.trim();
    if (!v) return;
    if (!/^(github_pat_|ghp_)/.test(v)) { alert("github_pat_ で始まる文字を貼り付けてください"); return; }
    try { localStorage.setItem(GH_TOKEN_KEY, v); } catch { alert("この端末に保存できませんでした"); return; }
    $("#sheet").close();
    startRefresh();
  } else if (ev.target.closest("[data-tok-paste]")) {
    navigator.clipboard?.readText?.().then((t) => { $("#gh-token").value = t.trim(); $("#gh-token").type = "text"; })
      .catch(() => alert("貼り付けできませんでした。欄を長押しして「ペースト」してください"));
  } else if (ev.target.closest("[data-tok-del]")) {
    try { localStorage.removeItem(GH_TOKEN_KEY); } catch { /* noop */ }
    $("#sheet").close();
  } else if (ev.target.closest("[data-reload]")) location.reload();
});
// 更新中にアプリを閉じた・読み直した場合は続きを待つ
{ const r = loadJSON(GH_RUN_KEY, null); if (r?.since && Date.now() - r.since < 15 * 60 * 1000 && ghToken()) pollRefresh(r.since); }

$("#sheet-close").onclick = () => $("#sheet").close();
$("#sheet").addEventListener("close", () => { state.sheetFn = null; renderHold(); });
$("#sheet").addEventListener("click", (e) => { if (e.target.id === "sheet") $("#sheet").close(); });
$("#prev").onclick = () => shiftMonth(-1);
$("#next").onclick = () => shiftMonth(1);
$("#wprev").onclick = () => shiftWeek(-1);
$("#wnext").onclick = () => shiftWeek(1);
$("#thisweek").onclick = () => { state.weekStart = mondayOf(todayStr()); renderWeek(); };
$("#ev-date").addEventListener("change", (e) => {
  if (!e.target.value) return;
  state.weekStart = prefs.evMode === "month" ? e.target.value : mondayOf(e.target.value);
  renderWeek();
});
$("#today-btn").onclick = () => {
  state.selected = todayStr(); state.month = state.selected.slice(0, 7);
  renderCalendar(); renderDay();
};
$("#q").addEventListener("input", renderSearch);
// 株数・取得単価の入力（シート内）
document.addEventListener("change", (e) => {
  const el = e.target.closest("[data-pos]");
  if (el) { const [c, k] = el.dataset.pos.split("|"); setPos(c, k, el.value); }
});
$("#cal-sort").value = prefs.calSort;
$("#cal-sort").addEventListener("change", (e) => { prefs.calSort = e.target.value; saveJSON(PREF_KEY, prefs); renderDay(); renderMonth(); });
setSeg($("#ipo-mode"), prefs.ipoMode);
prefs.biasDir = ""; // 空売りをやめたので向きの絞り込みは使わない
setSeg($("#bias-dir"), prefs.biasDir);
setSeg($("#bias-kind"), prefs.biasKind);
setSeg($("#bias-mode"), prefs.biasMode);
$("#bias-q").addEventListener("input", () => renderBias());
setSeg($("#ev-mode"), prefs.evMode);
setSeg($("#cal-mode"), prefs.calMode);
applyCalMode();

// 左右スワイプで月送り・週送り
function swipe(el, fn) {
  let x = null;
  el.addEventListener("touchstart", (e) => { x = e.touches[0].clientX; }, { passive: true });
  el.addEventListener("touchend", (e) => {
    if (x == null) return;
    const dx = e.changedTouches[0].clientX - x;
    if (Math.abs(dx) > 60) fn(dx < 0 ? 1 : -1);
    x = null;
  });
}
swipe($("#grid"), shiftMonth);

if ("serviceWorker" in navigator) {
  // 新しいバージョンが有効になったら自動で読み込み直す
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener("controllerchange", () => { if (hadController) location.reload(); });
  navigator.serviceWorker.register("sw.js", { updateViaCache: "none" })
    .then((reg) => { reg.update(); document.addEventListener("visibilitychange", () => { if (!document.hidden) reg.update(); }); })
    .catch(() => {});
}

load();
