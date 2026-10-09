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

const prefs = Object.assign({ evImp: "2", calImp: "2", calSort: "imp" }, loadJSON(PREF_KEY, {}));

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
  return `<li class="${watched ? "watch" : ""}">
    <div class="lead"><span class="code">${esc(e.c)}</span>${stars(e.imp)}</div>
    <div class="main"><div class="name">${esc(e.n)}</div><div class="sub">${sub}</div>
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
    return { kind: "earn", ...ev, c: ev.code, watched: state.watch.has(ev.code),
      impact: Math.max(ev.impact, s.imp || 1), themes: ev.themes?.length ? ev.themes : (s.th || []) };
  });
  const covered = new Set(items.filter((it) => it.c).map((it) => it.c));
  for (const e0 of state.byDate.get(day) || []) {
    if (covered.has(e0.c)) continue;
    const e = info(e0);
    const watched = state.watch.has(e.c);
    if (e.imp < 3 && !watched) continue;
    items.push({
      kind: "earn", c: e.c, d: day, t: e.t, country: "JP", watched,
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
  return `<div class="ev imp${it.impact}${it.watched ? " watched" : ""}" ${it.kind === "earn" ? `data-code="${esc(it.c)}"` : ""}>
    <span class="flag">${FLAG[it.country] || "🌐"}</span>
    <div class="ev-main">
      <div class="ev-title">${esc(it.title)}${tent}${watch}</div>
      ${it.desc ? `<div class="ev-desc">${esc(it.desc)}</div>` : ""}
      <div class="ev-meta">${stars(it.impact)}${themeChips(it.themes)}</div>
    </div>
    <div class="ev-time">${time}</div>
  </div>`;
}

function renderWeek() {
  const start = parse(state.weekStart);
  const end = new Date(start); end.setDate(start.getDate() + 6);
  $("#week-label").textContent = `${start.getMonth() + 1}/${start.getDate()}(月)〜${end.getMonth() + 1}/${end.getDate()}(日)`;
  const minImp = Number(prefs.evImp);
  const today = todayStr();
  let html = "";
  for (let i = 0; i < 7; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    const key = ymd(d);
    let items = weekItems(key).filter((it) => it.impact >= minImp || it.watched);
    if (state.evTheme) items = items.filter((it) => (it.themes || []).includes(state.evTheme) || (!it.themes?.length && it.impact === 3 && it.kind === "ev"));
    if (!items.length) continue;
    items.sort((a, b) => (a.t || "99").localeCompare(b.t || "99") || b.impact - a.impact);
    html += `<section class="day wd${d.getDay()}${key === today ? " is-today" : ""}">
      <div class="day-date"><b>${d.getMonth() + 1}/${d.getDate()}</b><span>(${WD[d.getDay()]})</span>${key === today ? "<em>今日</em>" : ""}</div>
      <div class="day-items">${items.map(evRow).join("")}</div>
    </section>`;
  }
  $("#week").innerHTML = html || `<p class="empty-msg">この週の該当イベントはありません</p>`;
}

function shiftWeek(delta) {
  const d = parse(state.weekStart); d.setDate(d.getDate() + 7 * delta);
  state.weekStart = ymd(d);
  renderWeek();
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
  renderCalendar();
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
  const f = prefs.calImp;
  if (f === "w") list = list.filter((e) => state.watch.has(e.c));
  else list = list.filter((e) => e.imp >= Number(f) || state.watch.has(e.c));
  if (state.calTheme) list = list.filter((e) => e.th.includes(state.calTheme));
  const sorter = SORTERS[prefs.calSort] || SORTERS.imp;
  // ウォッチ銘柄は常に先頭
  list.sort((a, b) => (state.watch.has(b.c) - state.watch.has(a.c)) || sorter(a, b));
  const big = all.filter((e) => e.imp === 3).length;
  $("#day-label").textContent = `${fmtDay(key)}　決算 ${all.length}社${big ? `（★★★ ${big}社）` : ""}`;
  const hidden = all.length - list.length;
  let html = list.map((e) => stockRow(e)).join("");
  if (!html) html = `<li class="empty">${all.length ? "条件に合う銘柄はありません" : "予定はありません"}</li>`;
  if (hidden > 0 && f !== "1") html += `<li class="more"><button data-showall>ほか ${hidden}社を表示</button></li>`;
  $("#day-list").innerHTML = html;
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

function openTheme(id) {
  const t = state.theme.get(id);
  if (!t) return;
  $("#sheet-title").textContent = `テーマ: ${t.name}`;
  // 関連イベント（今後30日）
  const today = todayStr();
  const lim = new Date(); lim.setDate(lim.getDate() + 30);
  const evs = state.events.filter((e) => e.d >= today && e.d <= ymd(lim) && (e.themes || []).includes(id));
  $("#sheet-desc").innerHTML = esc(t.desc)
    + (evs.length ? `<span class="sheet-evs">${evs.map((e) => `${fmtDay(e.d)} ${esc(e.title)}`).join("<br>")}</span>` : "");
  const rows = t.codes.map((c) => {
    const nx = state.nextByCode.get(c);
    const s = state.stock.get(c) || { c, n: c };
    return { ...s, ...(nx || { d: "" }), c, n: s.n };
  }).map(info).sort(SORTERS.w);
  $("#sheet-list").innerHTML = rows.map((e) => stockRow(e, { showDate: true })).join("");
  const dlg = $("#sheet");
  if (!dlg.open) dlg.showModal();
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
  renderWeek(); renderCalendar(); renderDay(); renderSearch(); renderWatch();
  if ($("#sheet").open) openTheme($("#sheet").dataset.theme);
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
  const th = ev.target.closest("[data-theme]");
  if (th) { $("#sheet").dataset.theme = th.dataset.theme; openTheme(th.dataset.theme); return; }
  const pick = ev.target.closest("[data-pick]");
  if (pick) {
    const inEv = !!pick.closest("#ev-themes");
    const v = pick.dataset.pick;
    if (inEv) state.evTheme = v; else state.calTheme = v;
    renderThemeBars();
    inEv ? renderWeek() : renderDay();
    return;
  }
  const seg = ev.target.closest(".seg button");
  if (seg) {
    const box = seg.parentElement;
    setSeg(box, seg.dataset.v);
    if (box.id === "ev-imp") { prefs.evImp = seg.dataset.v; renderWeek(); }
    else { prefs.calImp = seg.dataset.v; renderDay(); }
    saveJSON(PREF_KEY, prefs);
    return;
  }
  if (ev.target.closest("[data-showall]")) {
    prefs.calImp = "1"; setSeg($("#cal-imp"), "1"); saveJSON(PREF_KEY, prefs); renderDay();
    return;
  }
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
$("#sheet").addEventListener("click", (e) => { if (e.target.id === "sheet") $("#sheet").close(); });
$("#prev").onclick = () => shiftMonth(-1);
$("#next").onclick = () => shiftMonth(1);
$("#wprev").onclick = () => shiftWeek(-1);
$("#wnext").onclick = () => shiftWeek(1);
$("#thisweek").onclick = () => { state.weekStart = mondayOf(todayStr()); renderWeek(); };
$("#today-btn").onclick = () => {
  state.selected = todayStr(); state.month = state.selected.slice(0, 7);
  renderCalendar(); renderDay();
};
$("#q").addEventListener("input", renderSearch);
$("#cal-sort").value = prefs.calSort;
$("#cal-sort").addEventListener("change", (e) => { prefs.calSort = e.target.value; saveJSON(PREF_KEY, prefs); renderDay(); });
setSeg($("#ev-imp"), prefs.evImp);
setSeg($("#cal-imp"), prefs.calImp);

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
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

load();
