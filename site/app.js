"use strict";

// ---------- storage (ウォッチリスト・表示設定は端末内) ----------
const WATCH_KEY = "kabucal.watch.v1"; // 旧ウォッチ（v5まで）。保有銘柄へ移行する
const HOLD_KEY = "kabucal.hold.v1";
const PREF_KEY = "kabucal.prefs.v1";
function loadJSON(key, def) {
  try { return JSON.parse(localStorage.getItem(key)) ?? def; } catch { return def; }
}
function saveJSON(key, v) {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* private mode 等 */ }
}

const prefs = Object.assign({ calSort: "imp", calMode: "day", evMode: "week", ipoMode: "up", newsCat: "" }, loadJSON(PREF_KEY, {}));

const state = {
  earnings: [], stocks: [], events: [], themes: [], meta: null,
  stock: new Map(),      // code -> stock {c,n,mkt,sec,w,sz,th,imp}
  theme: new Map(),      // id -> theme
  byDate: new Map(),     // "YYYY-MM-DD" -> [earning]
  evByDate: new Map(),   // "YYYY-MM-DD" -> [event]
  nextByCode: new Map(), // code -> 直近の今後の決算 (なければ最新)
  hold: new Set(loadJSON(HOLD_KEY, null) ?? loadJSON(WATCH_KEY, [])), // 保有銘柄（日経225採用銘柄から選ぶ・端末内に保存）
  n225: { codes: [], history: [] }, n225set: new Set(),
  hidx: null, hev: new Map(), hnews: new Map(), // 保有銘柄の反応（h/index.json の id → 位置）
  h: new Map(),          // 銘柄コード -> h/<コード>.json
  alerts: new Map(),     // イベント id -> [{c, abs, ratio, n}]（今後2週間、保有銘柄が大きく動きやすいもの）
  month: null, selected: null, weekStart: null,
  evTheme: "", calTheme: "",
  rx: { events: {}, earnings: {}, news: {} }, // 株価の反応（reactions.json）
  news: [], newsByDate: new Map(),  // 予定外ニュース（news.json、新しい順）
  series: new Map(),     // 同じ種類のイベント（過去10回用）: key -> [event]（古い順）
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
async function getJSON(name) {
  const r = await fetch(`data/${name}`, { cache: "no-cache" });
  if (!r.ok) throw new Error(`${name}: ${r.status}`);
  return r.json();
}

async function load() {
  try {
    const [earnings, stocks, events, themes, meta] = await Promise.all(
      ["earnings.json", "stocks.json", "events.json", "themes.json", "meta.json"].map(getJSON));
    Object.assign(state, { earnings, stocks, events, themes, meta });
    state.rx = await getJSON("reactions.json").catch(() => state.rx);
    state.ipo = await getJSON("ipo.json").catch(() => []);
    state.news = await getJSON("news.json").catch(() => []);
    state.n225 = await getJSON("n225.json").catch(() => state.n225);
    state.n225set = new Set(state.n225.codes.map((x) => x.c));
    state.rx.news ||= {};
  } catch (e) {
    $("#updated").textContent = "データ取得に失敗しました";
    $("#updated").classList.add("stale");
    console.error(e);
  }
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

// ---------- 過去10回 ----------
// 同じ種類のイベントを束ねるキー。id の日付より後ろ（スラッグ）で判定し、表記ゆれは別名表で吸収する。
// 海外企業の決算は ticker で束ねる（四半期ごとにスラッグが違うため）
const SERIES_ALIAS = { "us-ism-svc": "us-ism-services", "us-fomc": "fomc" };
const NOT_EARN = new Set(["tsmc-monthly", "samsung-prelim"]);
function seriesOf(ev) {
  const slug = ev.id.replace(/^\d{4}-\d{2}-\d{2}-/, "");
  if (ev.ticker && !NOT_EARN.has(slug)) return `earn:${ev.ticker}`;
  return SERIES_ALIAS[slug] || slug;
}
const HIST_N = 10;

// その回までの（その回を含む）反応データのある回。新しい順に最大10回
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

function stockRow(e0, { showDate = false } = {}) {
  const e = info(e0);
  const watched = state.hold.has(e.c);
  const q = e.q ? `<span class="badge">${esc(Q_LABEL[e.q] || e.q)}</span>` : "";
  const when = showDate ? (e.d ? fmtDay(e.d) + (e.d < todayStr() ? " 発表済" : "") : "日付未定") : null;
  const sub = q + sizeBadge(e.sz) + [when, e.sec || e.mkt].filter(Boolean).map(esc).join(" · ");
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
      kind: "earn", c: e.c, d: day, t: e.t, country: "JP", watched, rxKey: `${e.c}@${day}`,
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
  html += earnHistoryHtml(c, d);
  html += `<ul class="list">${stockRow({ ...s, ...(state.nextByCode.get(c) || {}), c, n: s.n }, { showDate: true })}</ul>`;
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

function newsCard(n) {
  const d = parse(n.d);
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
  const same = state.news.filter((x) => x.cat === n.cat && x.d <= n.d && state.rx.news[x.id]).slice(0, HIST_N);
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
// 選べるのは日経平均採用銘柄。端末内（localStorage）に保存。各銘柄の反応は h/<コード>.json を必要な時に読む
const ALERT_RATIO = 1.5; // 過去の平均の振れ幅が「普段の1日の値動き」の何倍以上なら注意とするか

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
  } catch { return; }
  await Promise.all([...state.hold].map(loadHold));
  computeAlerts();
  renderHold(); renderWeek();
  if ($("#sheet").open && state.sheetFn) state.sheetFn();
}

function saveHold() {
  saveJSON(HOLD_KEY, [...state.hold]);
  try { localStorage.removeItem(WATCH_KEY); } catch { /* noop */ }
}

const holdName = (c) => state.stock.get(c)?.n || state.n225.codes.find((x) => x.c === c)?.n || c;
const evR = (h, id) => (h && state.hev.has(id) ? h.ev[state.hev.get(id)] : null);
const newsR = (h, id) => (h && state.hnews.has(id) ? h.news[state.hnews.get(id)] : null);
const nkR = (id) => state.rx.events[id]?.d1?.nk ?? state.rx.events[id]?.idx?.find((x) => x.sym === "^N225")?.r ?? null;

// 指標の名前（同じ種類のイベントの代表名）
function seriesName(ev) {
  const k = seriesOf(ev);
  const t = ev.title.replace(/（.*?）|\(.*?\)/g, "").replace(/^(米|日本|中国)?\d+月/, "$1").replace(/\s*\d+-\d+月期/, "").replace(/決算.*$/, "").trim();
  return k.startsWith("earn:") ? `${t} 決算` : t;
}

// その銘柄の、その種類のイベントでの過去の反応（ev の回まで、最大10回）
function holdSeriesStat(h, ev) {
  const hist = eventHistory(ev).filter((e) => e.id !== ev.id || ev.d < todayStr());
  const vals = hist.map((e) => evR(h, e.id));
  const st = stat(vals);
  return st && { ...st, hist, vals, nk: stat(hist.map((e) => nkR(e.id))) };
}

// 今後2週間のイベントのうち、保有銘柄が過去に大きく動いたもの
function computeAlerts() {
  state.alerts.clear();
  const today = todayStr(), lim = new Date(); lim.setDate(lim.getDate() + 14);
  const end = ymd(lim);
  for (const ev of state.events) {
    if (ev.d < today || ev.d > end || ev.code) continue;
    for (const c of state.hold) {
      const h = state.h.get(c);
      if (!h?.vol) continue;
      const st = holdSeriesStat(h, ev);
      if (!st || st.n < 3) continue;
      const ratio = st.abs / h.vol;
      if (ratio < ALERT_RATIO) continue;
      if (!state.alerts.has(ev.id)) state.alerts.set(ev.id, []);
      state.alerts.get(ev.id).push({ c, abs: st.abs, ratio, n: st.n, up: st.up, avg: st.avg });
    }
  }
  for (const v of state.alerts.values()) v.sort((a, b) => b.ratio - a.ratio);
}

function renderHold() {
  const el = $("#hold-list");
  if (!el) return;
  const asof = state.n225.asof ? `（${esc(state.n225.asof)}現在）` : "";
  $("#hold-note").innerHTML = `選べるのは日経平均採用銘柄 225社${asof}。採用銘柄が入れ替わったら自動で反映されます。保有銘柄はこの端末にだけ保存されます。`;
  const codes = [...state.hold].sort((a, b) => a.localeCompare(b));
  if (!codes.length) {
    $("#hold-alert").innerHTML = "";
    el.innerHTML = `<p class="empty-msg">「銘柄を選ぶ」から持っている銘柄を登録すると、<br>ニュースや指標・決算でその株がどう動いたかが見られます</p>`;
    return;
  }
  // 今後2週間の注意イベント
  const today = todayStr();
  const evs = state.events.filter((e) => state.alerts.has(e.id)).sort((a, b) => (a.d + (a.t || "")).localeCompare(b.d + (b.t || "")));
  $("#hold-alert").innerHTML = evs.length ? `<h4 class="sheet-h">今後2週間の注意イベント</h4><ul class="list">`
    + evs.map((e) => `<li class="has-rx" data-hev="${esc(e.id)}"><div class="lead"><span class="nd">${fmtDay(e.d)}</span><span class="nt">${esc(e.t || "")}</span></div>
      <div class="main"><div class="name">${esc(e.title)}</div>
      <div class="sub">${state.alerts.get(e.id).map((a) => `${esc(holdName(a.c))} 振れ幅 <b>${a.abs.toFixed(1)}%</b>（普段の${a.ratio.toFixed(1)}倍）`).join("<br>")}</div></div></li>`).join("")
    + `</ul><p class="note">過去の同じイベント（最大10回）で、その銘柄の反応日の平均の振れ幅が普段の1日の値動きの${ALERT_RATIO}倍以上のもの</p>`
    : `<p class="msum">今後2週間、保有銘柄が普段より大きく動いてきたイベントはありません</p>`;
  el.innerHTML = `<h4 class="sheet-h">保有銘柄（${codes.length}）</h4><ul class="list">` + codes.map((c) => {
    const s = state.stock.get(c) || {}, h = state.h.get(c);
    const nx = state.nextByCode.get(c);
    const out = !state.n225set.has(c) ? '<span class="badge">日経225から除外</span>' : "";
    const last = earnHistory(c, todayStr())[0];
    return `<li class="has-rx" data-hold="${esc(c)}"><div class="lead"><span class="code">${esc(c)}</span></div>
      <div class="main"><div class="name">${esc(holdName(c))}${out}</div>
      <div class="sub">${esc(s.sec || "")}${nx?.d ? ` · 決算 ${fmtDay(nx.d)}${nx.d < today ? " 発表済" : ""}` : ""}</div>
      <div class="rxline">${h ? `<span class="lbl">普段の値動き ±${h.vol.toFixed(1)}%</span>` : ""}${last ? `<span class="lbl">前回決算 ${pct(state.rx.earnings[last].r)}</span>` : ""}<span class="rxhint">影響を見る ›</span></div></div></li>`;
  }).join("") + `</ul>`;
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
  renderHold(); renderWeek(); renderCalendar(); renderDay(); renderMonth();
}

// 保有銘柄の詳細: どのイベント・ニュース・決算でどう動いたか
async function openHolding(c) {
  const h = await loadHold(c);
  const name = holdName(c);
  const s = state.stock.get(c) || {};
  const today = todayStr();
  const nx = state.nextByCode.get(c);
  let html = `<p class="sheet-desc">${esc(c)} · ${esc(s.sec || "")}${h ? ` · 普段の1日の値動き ±${h.vol.toFixed(2)}%（直近1年の平均）` : ""}</p>`;
  if (!h) { openSheet(name, html + `<p class="msum">反応データはまだありません（次回の更新で作られます）</p>`, null); return; }

  // 1) 今後2週間のイベント
  const lim = new Date(); lim.setDate(lim.getDate() + 14);
  const up = state.events.filter((e) => e.d >= today && e.d <= ymd(lim) && !e.code)
    .map((e) => ({ e, st: holdSeriesStat(h, e) })).filter((x) => x.st && x.st.n >= 3)
    .sort((a, b) => b.st.abs - a.st.abs);
  if (up.length) {
    html += `<h4 class="sheet-h">今後2週間のイベントと、この銘柄の過去の反応</h4><table class="rxtable hist"><thead><tr><th></th><th>上昇</th><th>平均</th><th>振れ幅</th></tr></thead><tbody>`
      + up.slice(0, 8).map(({ e, st }) => `<tr data-hser="${esc(c)}|${esc(e.id)}" class="${st.abs / h.vol >= ALERT_RATIO ? "warn" : ""}"><th>${fmtDay(e.d)} ${esc(seriesName(e))}<small>${st.abs / h.vol >= ALERT_RATIO ? "⚠ 普段より大きく動きやすい · " : ""}過去${st.n}回</small></th>
        <td class="num">${st.up}/${st.n}</td><td>${pct(st.avg)}</td><td class="num">${st.abs.toFixed(1)}%</td></tr>`).join("")
      + `</tbody></table>`;
  }

  // 2) 指標・イベント別（よく動く順）
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
    html += `<h4 class="sheet-h">指標・イベント別の反応（各 過去10回まで、よく動く順）</h4><table class="rxtable hist"><thead><tr><th></th><th>上昇</th><th>平均</th><th>振れ幅</th><th>日経の振れ幅</th></tr></thead><tbody>`
      + rows.slice(0, 15).map(({ ev, st }) => `<tr data-hser="${esc(c)}|${esc(ev.id)}"><th>${esc(seriesName(ev))}<small>過去${st.n}回</small></th>
        <td class="num">${st.up}/${st.n}</td><td>${pct(st.avg)}</td><td class="num">${st.abs.toFixed(1)}%</td><td class="num">${st.nk ? st.nk.abs.toFixed(1) + "%" : "—"}</td></tr>`).join("")
      + `</tbody></table><p class="note">反応日（発表後に最初に開いた日本の立会日）の騰落率。振れ幅＝上げ下げを問わない平均の動きの大きさ。同じ日に別のイベントがあった場合はその影響も含みます。行をタップで各回の一覧</p>`;
  }

  // 3) ニュース（大きく動いた順）
  const ns = state.news.map((n) => ({ n, r: newsR(h, n.id) })).filter((x) => x.r && x.r[0] != null)
    .sort((a, b) => Math.abs(b.r[0]) - Math.abs(a.r[0])).slice(0, 10);
  if (ns.length) {
    const nk = (id) => state.rx.news[id]?.idx?.find((x) => x.sym === "^N225")?.r1 ?? null;
    html += `<h4 class="sheet-h">大きく動いたニュース（今年・上位10件）</h4><table class="rxtable hist"><thead><tr><th></th><th>反応日</th><th>1週間後</th><th>1か月後</th></tr></thead><tbody>`
      + ns.map(({ n, r }) => `<tr data-news="${esc(n.id)}"><th>${fmtDay(n.d)} ${esc(n.title)}<small>日経平均 ${nk(n.id) != null ? (nk(n.id) > 0 ? "+" : "") + nk(n.id).toFixed(2) + "%" : "—"}</small></th>
        <td>${pct(r[0])}</td><td>${pct(r[1])}</td><td>${pct(r[2])}</td></tr>`).join("")
      + `</tbody></table>`;
  }

  // 4) 決算
  html += earnHistoryHtml(c, nx?.d && nx.d >= today ? nx.d : "9999-12-31")
    || `<p class="msum">過去の決算の反応データはありません</p>`;
  if (nx?.d) html += `<p class="msum">次の決算: ${fmtDay(nx.d)}${nx.d < today ? "（発表済・次回は未定）" : ""}</p>`;
  openSheet(name, html, () => openHolding(c));
}

// 保有銘柄 × 指標: 各回の反応
function openHoldSeries(c, evId) {
  const h = state.h.get(c), ev = state.events.find((e) => e.id === evId);
  if (!h || !ev) return;
  const hist = eventHistory(ev).filter((e) => e.d < todayStr());
  const rows = hist.map((e) => ({ d: e.d, sub: e.desc, attr: `data-evrx="${esc(e.id)}"`, id: e.id }));
  const html = `<p class="sheet-desc">${esc(holdName(c))}（普段の1日の値動き ±${h.vol.toFixed(2)}%）が「${esc(seriesName(ev))}」の反応日にどう動いたか</p>`
    + historyHtml(`${holdName(c)} の反応`, rows, [
      { h: holdName(c).slice(0, 8), f: (x) => evR(h, x.id) },
      { h: "日経平均", f: (x) => nkR(x.id) },
      { h: "日経との差", f: (x) => (evR(h, x.id) != null && nkR(x.id) != null ? evR(h, x.id) - nkR(x.id) : null) },
    ], { note: "反応日の終値騰落率。行をタップでその回の詳細" });
  openSheet(`${seriesName(ev)} × ${holdName(c)}`, html, () => openHoldSeries(c, evId));
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
    return `<tr data-hser="${esc(c)}|${esc(ev.id)}"><th>${esc(holdName(c))}</th><td>${pct(r)}</td><td class="num">${st ? `${st.up}/${st.n}` : "—"}</td><td class="num">${st ? st.abs.toFixed(1) + "%" : "—"}</td></tr>`;
  }).join("");
  return rows ? `<h4 class="sheet-h">保有銘柄の反応</h4><table class="rxtable hist"><thead><tr><th></th><th>この回</th><th>過去の上昇</th><th>過去の振れ幅</th></tr></thead><tbody>${rows}</tbody></table>` : "";
}

function holdNewsHtml(id) {
  if (!state.hold.size || !state.hidx) return "";
  const rows = [...state.hold].map((c) => {
    const r = newsR(state.h.get(c), id);
    return r ? `<tr data-hold="${esc(c)}"><th>${esc(holdName(c))}</th><td>${pct(r[0])}</td><td>${pct(r[1])}</td><td>${pct(r[2])}</td></tr>` : "";
  }).join("");
  return rows ? `<h4 class="sheet-h">保有銘柄の反応</h4><table class="rxtable hist"><thead><tr><th></th><th>反応日</th><th>1週間後</th><th>1か月後</th></tr></thead><tbody>${rows}</tbody></table>` : "";
}

function renderAll() {
  renderWeek(); renderCalendar(); renderDay(); renderSearch(); renderHold(); renderIpo(); renderNews();
  renderMonth();
  if ($("#sheet").open && state.sheetFn) state.sheetFn();
}

// ---------- 操作 ----------
function setSeg(el, v) {
  el.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.v === v));
}

document.addEventListener("click", (ev) => {
  const ph = ev.target.closest("[data-pick-hold]");
  if (ph) { togglePick(ph.dataset.pickHold); return; }
  if (ev.target.closest("#hold-edit")) { openPicker(); return; }
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
    if (box.id === "ipo-mode") { prefs.ipoMode = seg.dataset.v; renderIpo(); }
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

function switchTab(v) {
  document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.v === v));
  document.querySelectorAll(".view").forEach((s) => s.classList.toggle("active", s.id === `view-${v}`));
  window.scrollTo(0, 0);
}

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
$("#cal-sort").value = prefs.calSort;
$("#cal-sort").addEventListener("change", (e) => { prefs.calSort = e.target.value; saveJSON(PREF_KEY, prefs); renderDay(); renderMonth(); });
setSeg($("#ipo-mode"), prefs.ipoMode);
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
