"use strict";

// ---------- storage (ウォッチリスト・表示設定は端末内) ----------
const WATCH_KEY = "kabucal.watch.v1";
const PREF_KEY = "kabucal.prefs.v1";
function loadJSON(key, def) {
  try { return JSON.parse(localStorage.getItem(key)) ?? def; } catch { return def; }
}
function saveJSON(key, v) {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* private mode 等 */ }
}

const prefs = Object.assign({ calSort: "imp", calMode: "day", evMode: "week", ipoMode: "up" }, loadJSON(PREF_KEY, {}));

const state = {
  earnings: [], stocks: [], events: [], themes: [], meta: null,
  stock: new Map(),      // code -> stock {c,n,mkt,sec,w,sz,th,imp}
  theme: new Map(),      // id -> theme
  byDate: new Map(),     // "YYYY-MM-DD" -> [earning]
  evByDate: new Map(),   // "YYYY-MM-DD" -> [event]
  nextByCode: new Map(), // code -> 直近の今後の決算 (なければ最新)
  watch: new Set(loadJSON(WATCH_KEY, [])),
  month: null, selected: null, weekStart: null,
  evTheme: "", calTheme: "",
  rx: { events: {}, earnings: {} }, // 株価の反応（reactions.json）
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
  renderThemeBars();
  renderAll();
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
  }
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
  const watched = state.watch.has(e.c);
  const q = e.q ? `<span class="badge">${esc(Q_LABEL[e.q] || e.q)}</span>` : "";
  const when = showDate ? (e.d ? fmtDay(e.d) + (e.d < todayStr() ? " 発表済" : "") : "日付未定") : null;
  const sub = q + sizeBadge(e.sz) + [when, e.sec || e.mkt].filter(Boolean).map(esc).join(" · ");
  const rxKey = e.d ? `${e.c}@${e.d}` : "";
  const rx = rxKey && state.rx.earnings[rxKey];
  const rxb = rx ? `<div class="rxline">${pct(rx.r, { label: rx.day === e.d ? "当日 " : "翌日 " })}<span class="rxhint">チャート ›</span></div>` : "";
  return `<li class="${watched ? "watch" : ""}${rx ? " has-rx" : ""}" ${rx ? `data-rx="${esc(rxKey)}"` : ""}>
    <div class="lead"><span class="code">${esc(e.c)}</span>${stars(e.imp)}</div>
    <div class="main"><div class="name">${esc(e.n)}</div><div class="sub">${sub}</div>${rxb}
      ${e.th.length ? `<div class="chips">${themeChips(e.th)}</div>` : ""}</div>
    <button class="star ${watched ? "on" : ""}" data-code="${esc(e.c)}" aria-label="ウォッチ${watched ? "解除" : "登録"}">★</button>
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
    return { kind: "earn", ...ev, c: ev.code, rxKey: `${ev.code}@${day}`, watched: state.watch.has(ev.code),
      impact: Math.max(ev.impact, s.imp || 1), themes: ev.themes?.length ? ev.themes : (s.th || []) };
  });
  for (const x of state.ipoByDate.get(day) || []) {
    if (x.tech) continue; // テクニカル上場は新規公開ではないので出さない
    const price = x.price ? `公開価格 ${x.price.toLocaleString()}円` : x.range ? `仮条件 ${x.range}円` : "価格未定";
    items.push({ kind: "ipo", c: x.c, d: day, t: "09:00", country: "JP", impact: x.imp || 1, themes: [], ipo: x,
      title: `IPO ${x.n}（${x.c}）`, desc: [x.mkt, price, x.size ? `吸収 ${x.size}億円` : ""].filter(Boolean).join(" · ") });
  }
  const covered = new Set(items.filter((it) => it.c && it.kind !== "ipo").map((it) => it.c));
  for (const e0 of state.byDate.get(day) || []) {
    if (covered.has(e0.c)) continue;
    const e = info(e0);
    const watched = state.watch.has(e.c);
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
  const watch = it.watched ? '<span class="badge wbadge">ウォッチ</span>' : "";
  let rx = "", attr = it.kind === "earn" ? `data-code="${esc(it.c)}"` : "";
  if (it.kind === "ipo") {
    attr = `data-ipo="${esc(it.c)}"`;
    if (it.ipo.first != null) rx = `<div class="rxline">${pct(it.ipo.first_r, { digits: 1, label: "初値 " })}${pct(it.ipo.last_r, { digits: 1, label: "現在 " })}<span class="rxhint">チャート ›</span></div>`;
  } else if (it.kind === "earn" && state.rx.earnings[it.rxKey]) {
    const r = state.rx.earnings[it.rxKey];
    rx = `<div class="rxline">${pct(r.r, { label: r.day === it.d ? "当日 " : "翌日 " })}<span class="rxhint">チャート ›</span></div>`;
    attr = `data-rx="${esc(it.rxKey)}"`;
  } else if (it.kind === "ev" && state.rx.events[it.id]) {
    const r = state.rx.events[it.id];
    const hourly = r.iv === "1h";
    const parts = r.series.map((x) => pct(hourly ? (x.m60 ?? x.end) : (x.m30 ?? x.end), { label: `${x.name} ` }))
      .concat((r.idx || []).map((x) => pct(x.r, { label: `${x.name} ` })));
    if (r.jp?.length) parts.push(pct(r.jp[0].r, { label: `${r.jp[0].n} ` }));
    rx = `<div class="rxline">${parts.slice(0, 3).join("")}<span class="rxhint">${r.series.length ? (hourly ? "1時間後" : "30分後") : r.idx ? "休場明け" : "日本株"} · チャート ›</span></div>`;
    attr = `data-evrx="${esc(it.id)}"`;
  }
  return `<div class="ev imp${it.impact}${it.watched ? " watched" : ""}${rx ? " has-rx" : ""}" ${attr}>
    <span class="flag">${it.kind === "ipo" ? "🆕" : FLAG[it.country] || "🌐"}</span>
    <div class="ev-main">
      <div class="ev-title">${esc(it.title)}${tent}${watch}</div>
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
    const hasWatch = list.some((e) => state.watch.has(e.c));
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
  list.sort((a, b) => (state.watch.has(b.c) - state.watch.has(a.c)) || sorter(a, b));
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
    list = list.filter((e) => e.imp >= 2 || state.watch.has(e.c)); // 大企業（★★以上）＋ウォッチ
    if (state.calTheme) list = list.filter((e) => e.th.includes(state.calTheme));
    if (!list.length) continue;
    list.sort((a, b) => (state.watch.has(b.c) - state.watch.has(a.c)) || sorter(a, b));
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
  const r = state.rx.events[id];
  if (!ev || !r) return;
  const t = new Date(r.t);
  const hhmm = `${pad(t.getHours())}:${pad(t.getMinutes())}`;
  let html = `<p class="sheet-desc">${fmtDay(ev.d)} ${esc(ev.t || "")} 発表（日本時間）${ev.desc ? "<br>" + esc(ev.desc) : ""}</p>`;
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
}

// 国内決算の反応チャート（日足）
function openEarnRx(key) {
  const r = state.rx.earnings[key];
  if (!r) return;
  const [c, d] = key.split("@");
  const s = state.stock.get(c) || { n: c };
  const xl = [[0, r.pts[0][0].replace("-", "/")], [r.k, r.pts[r.k][0].replace("-", "/")], [r.pts.length - 1, r.pts[r.pts.length - 1][0].replace("-", "/")]];
  const pts = r.pts.map((p, i) => [i, p[1]]);
  const html = `<div class="rx-big">${pct(r.r)}<span>${r.day === d ? "発表当日" : "発表翌営業日"}（${fmtDay(r.day)}）の騰落率</span></div>
    <div class="chart-box"><div class="chart-h"><b>${esc(s.n)}（${esc(c)}）</b><span>決算 ${fmtDay(d)}</span></div>
    ${lineChart(pts, { x0: r.k - 0.5, x0Label: "決算", xLabels: xl })}</div>
    <p class="note">反応日の前日終値を 0% とした終値の推移（データ: Yahoo Finance）</p>
    <ul class="list">${stockRow({ ...s, ...(state.nextByCode.get(c) || {}), c, n: s.n }, { showDate: true })}</ul>`;
  openSheet(`${s.n} 決算の反応`, html, () => openEarnRx(key));
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

function renderWatch() {
  const today = todayStr();
  const items = [...state.watch].map((c) => {
    const e = state.nextByCode.get(c);
    const s = state.stock.get(c);
    return e ? { ...e, past: e.d && e.d < today } : { c, n: s?.n || c, d: "" };
  });
  // 今後の予定が近い順 → 未定 → 過去
  const rank = (x) => (!x.d ? "2" : x.past ? "3" + x.d : "1" + x.d);
  items.sort((a, b) => rank(a).localeCompare(rank(b)));
  $("#watch-list").innerHTML = items.length
    ? items.map((e) => stockRow(e, { showDate: true })).join("")
    : `<li class="empty">検索タブで ★ を押すとここに表示されます</li>`;
}

function renderAll() {
  renderWeek(); renderCalendar(); renderDay(); renderSearch(); renderWatch(); renderIpo();
  renderMonth();
  if ($("#sheet").open && state.sheetFn) state.sheetFn();
}

// ---------- 操作 ----------
function setSeg(el, v) {
  el.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.v === v));
}

document.addEventListener("click", (ev) => {
  const star = ev.target.closest(".star");
  if (star) {
    const c = star.dataset.code;
    state.watch.has(c) ? state.watch.delete(c) : state.watch.add(c);
    saveJSON(WATCH_KEY, [...state.watch]);
    renderAll();
    return;
  }
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
$("#sheet").addEventListener("close", () => { state.sheetFn = null; });
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
