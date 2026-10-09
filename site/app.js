"use strict";

// ---------- storage (ウォッチリストは端末内) ----------
const WATCH_KEY = "kabucal.watch.v1";
function loadWatch() {
  try { return new Set(JSON.parse(localStorage.getItem(WATCH_KEY) || "[]")); }
  catch { return new Set(); }
}
function saveWatch() {
  try { localStorage.setItem(WATCH_KEY, JSON.stringify([...state.watch])); } catch { /* private mode 等 */ }
}

const state = {
  earnings: [], stocks: [], events: [], meta: null,
  byDate: new Map(),     // "YYYY-MM-DD" -> [earning]
  usByDate: new Map(),   // "YYYY-MM-DD" -> [event]
  nextByCode: new Map(), // code -> 直近の今後の決算 (なければ最新)
  watch: loadWatch(),
  month: null, selected: null, filter: "all",
};

const $ = (s) => document.querySelector(s);
const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayStr = () => ymd(new Date());
const WD = "日月火水木金土";
const Q_LABEL = { "1Q": "1Q", "2Q": "2Q", "3Q": "3Q", "4Q": "4Q", "FY": "本決算" };
const norm = (s) => (s || "").normalize("NFKC").toLowerCase();
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function fmtDay(s) {
  const d = new Date(s + "T00:00:00");
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
    const [earnings, stocks, events, meta] = await Promise.all(
      ["earnings.json", "stocks.json", "events.json", "meta.json"].map(getJSON));
    Object.assign(state, { earnings, stocks, events, meta });
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
  renderAll();
}

function index() {
  state.byDate.clear(); state.usByDate.clear(); state.nextByCode.clear();
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
    if (!state.usByDate.has(ev.d)) state.usByDate.set(ev.d, []);
    state.usByDate.get(ev.d).push(ev);
  }
  for (const list of state.usByDate.values()) list.sort((a, b) => (a.t || "").localeCompare(b.t || ""));
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

// ---------- calendar ----------
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
    const us = state.usByDate.get(key) || [];
    const hasWatch = list.some((e) => state.watch.has(e.c));
    const cell = document.createElement("button");
    cell.className = "cell"
      + (d.getMonth() !== m - 1 ? " out" : "")
      + (d.getDay() === 0 ? " sun" : d.getDay() === 6 ? " sat" : "")
      + (key === today ? " today" : "")
      + (key === state.selected ? " sel" : "")
      + (hasWatch ? " has-watch" : "");
    cell.setAttribute("aria-label", `${key} 決算${list.length}社${us.length ? " 米国イベントあり" : ""}`);
    cell.innerHTML = `<span class="dn">${d.getDate()}</span>`
      + (list.length ? `<span class="cnt">${list.length}</span>` : "")
      + `<span class="marks">${hasWatch ? '<i class="dot watch"></i>' : ""}${us.length ? '<i class="dot us"></i>' : ""}</span>`;
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

// ---------- lists ----------
function stockRow(e, { showDate = false } = {}) {
  const watched = state.watch.has(e.c);
  const q = e.q ? `<span class="badge">${esc(Q_LABEL[e.q] || e.q)}</span>` : "";
  const when = showDate ? (e.d ? fmtDay(e.d) + (e.d < todayStr() ? " 発表済" : "") : "日付未定") : null;
  const sub = q + [when, e.mkt, e.sec].filter(Boolean).map(esc).join(" · ");
  return `<li class="${watched ? "watch" : ""}">
    <span class="code">${esc(e.c)}</span>
    <div class="main"><div class="name">${esc(e.n)}</div>${sub ? `<div class="sub">${sub}</div>` : ""}</div>
    <button class="star ${watched ? "on" : ""}" data-code="${esc(e.c)}" aria-label="ウォッチ${watched ? "解除" : "登録"}">★</button>
  </li>`;
}

function eventRow(ev) {
  return `<li class="us">
    <span class="time">${esc(ev.t || "—")}</span>
    <div class="main"><div class="name">${esc(ev.title)}${ev.tentative ? '<span class="badge tent">予定</span>' : ""}</div>
    ${ev.note ? `<div class="sub">${esc(ev.note)}</div>` : ""}</div>
  </li>`;
}

function renderDay() {
  const key = state.selected;
  const all = state.byDate.get(key) || [];
  const us = state.usByDate.get(key) || [];
  let list = all;
  if (state.filter === "watch") list = all.filter((e) => state.watch.has(e.c));
  if (state.filter === "prime") list = all.filter((e) => e.mkt === "プライム" || state.watch.has(e.c));
  // ウォッチ銘柄を先頭に、その後コード順
  list = [...list].sort((a, b) => (state.watch.has(b.c) - state.watch.has(a.c)) || a.c.localeCompare(b.c));
  $("#day-label").textContent = `${fmtDay(key)}　決算 ${all.length}社`;
  let html = us.map(eventRow).join("");
  if (us.length && list.length) html += `<li class="sep">国内決算</li>`;
  html += list.map((e) => stockRow(e)).join("");
  if (!html) html = `<li class="empty">${state.filter === "all" ? "予定はありません" : "該当なし"}</li>`;
  $("#day-list").innerHTML = html;
}

function renderSearch() {
  const q = norm($("#q").value.trim());
  const out = $("#search-list");
  if (!q) { out.innerHTML = `<li class="empty">コードか社名を入力してください</li>`; return; }
  const hits = [];
  for (const s of state.stocks) {
    if (s.c.toLowerCase().startsWith(q) || norm(s.n).includes(q)) {
      hits.push(s);
      if (hits.length >= 50) break;
    }
  }
  out.innerHTML = hits.length
    ? hits.map((s) => stockRow({ ...s, ...(state.nextByCode.get(s.c) || { d: "" }), n: s.n, c: s.c }, { showDate: true })).join("")
    : `<li class="empty">見つかりません</li>`;
}

function renderWatch() {
  const today = todayStr();
  const items = [...state.watch].map((c) => {
    const e = state.nextByCode.get(c);
    const s = state.stocks.find((x) => x.c === c);
    return e ? { ...e, past: e.d && e.d < today } : { c, n: s?.n || c, mkt: s?.mkt, d: "" };
  });
  // 今後の予定が近い順 → 未定 → 過去
  const rank = (x) => (!x.d ? "2" : x.past ? "3" + x.d : "1" + x.d);
  items.sort((a, b) => rank(a).localeCompare(rank(b)));
  $("#watch-list").innerHTML = items.length
    ? items.map((e) => stockRow(e, { showDate: true })).join("")
    : `<li class="empty">検索タブで ★ を押すとここに表示されます</li>`;
}

function renderAll() {
  renderCalendar(); renderDay(); renderSearch(); renderWatch();
}

// ---------- events ----------
document.addEventListener("click", (ev) => {
  const star = ev.target.closest(".star");
  if (star) {
    const c = star.dataset.code;
    state.watch.has(c) ? state.watch.delete(c) : state.watch.add(c);
    saveWatch();
    renderAll();
    return;
  }
  const f = ev.target.closest(".filters .chip");
  if (f) {
    state.filter = f.dataset.f;
    document.querySelectorAll(".filters .chip").forEach((b) => b.classList.toggle("on", b === f));
    renderDay();
    return;
  }
  const tab = ev.target.closest(".tabs button");
  if (tab) {
    document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("on", b === tab));
    document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${tab.dataset.v}`));
    if (tab.dataset.v === "search") $("#q").focus();
    window.scrollTo(0, 0);
  }
});
$("#prev").onclick = () => shiftMonth(-1);
$("#next").onclick = () => shiftMonth(1);
$("#today-btn").onclick = () => {
  state.selected = todayStr(); state.month = state.selected.slice(0, 7);
  renderCalendar(); renderDay();
};
$("#q").addEventListener("input", renderSearch);

// 左右スワイプで月送り
let touchX = null;
$("#grid").addEventListener("touchstart", (e) => { touchX = e.touches[0].clientX; }, { passive: true });
$("#grid").addEventListener("touchend", (e) => {
  if (touchX == null) return;
  const dx = e.changedTouches[0].clientX - touchX;
  if (Math.abs(dx) > 60) shiftMonth(dx < 0 ? 1 : -1);
  touchX = null;
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

load();
