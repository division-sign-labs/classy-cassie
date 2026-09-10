// packages/runtime-node/src/dashboard/ui/app.js
// The dashboard page. Pure helpers are exported for tests; DOM code runs only
// when a document exists. CSP is script-src 'self': nothing inline.

const HAS_DOM = typeof document !== "undefined";

// theme (before first paint)
if (HAS_DOM) {
  let theme = "dark";
  try { const s = localStorage.getItem("q-theme"); if (s === "light" || s === "dark") theme = s; } catch {}
  document.documentElement.setAttribute("data-theme", theme);
}

// constants
export const RANGES = ["24h", "7d", "30d", "all"];
export const TABS = ["overview", "positions", "performance", "metrics", "logs"];
export const LEVELS = ["error", "warn", "info", "debug"];
const DEFAULT_REFRESH = 30;
const STORAGE_KEY = "cassie.dashboard";
const PERP_VENUES = new Set(["hyperliquid", "lighter"]);
const MINUS = "−";
const DASH = "—";

// formatters
function finite(n) { return typeof n === "number" && Number.isFinite(n); }
function group(abs, dp) {
  return abs.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}
export function fmtMoney(n, opts = {}) {
  if (!finite(n)) return DASH;
  const dp = opts.dp ?? 2;
  const body = `$${group(Math.abs(n), dp)}`;
  if (n < 0 && Math.round(Math.abs(n) * 10 ** dp) > 0) return `${MINUS}${body}`;
  if (opts.sign && n > 0) return `+${body}`;
  return body;
}
export function fmtPct(n, opts = {}) {
  if (!finite(n)) return DASH;
  const dp = opts.dp ?? 1;
  const sign = opts.sign ?? true;
  const body = `${Math.abs(n).toFixed(dp)}%`;
  if (n < 0 && Number(Math.abs(n).toFixed(dp)) > 0) return `${MINUS}${body}`;
  if (sign && n > 0) return `+${body}`;
  return body;
}
export function fmtNum(n, dp = 4) {
  if (!finite(n)) return DASH;
  const v = Math.round(n * 10 ** dp) / 10 ** dp;
  return v < 0 ? `${MINUS}${String(Math.abs(v))}` : String(v);
}
export function fmtPrice(venue, n) {
  if (!finite(n)) return DASH;
  if (PERP_VENUES.has(venue) && Math.abs(n) >= 1000) return group(n, 2);
  return fmtNum(n, 4);
}
export function fmtInt(n) { return finite(n) ? Math.round(n).toLocaleString("en-US") : DASH; }
export function fmtMs(n) {
  if (!finite(n)) return DASH;
  return n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${Math.round(n)} ms`;
}
export function toMs(v) {
  if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
  if (typeof v === "string") { const t = Date.parse(v); return Number.isFinite(t) ? t : undefined; }
  return undefined;
}
export function fmtAgo(ts, now = Date.now()) {
  if (ts === undefined || ts === null) return "never";
  const ms = now - toMs(ts);
  if (!Number.isFinite(ms)) return "unknown";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m ago`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h ago`;
}
export function fmtDuration(ts, now = Date.now()) {
  const ago = fmtAgo(ts, now);
  if (ago === "never" || ago === "unknown") return DASH;
  return ago === "just now" ? "0m" : ago.replace(/ ago$/, "");
}
const TIME_OPTS = { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false };
export function fmtTime(ts, opts = TIME_OPTS) {
  const ms = toMs(ts);
  return ms === undefined ? DASH : new Date(ms).toLocaleString(undefined, opts);
}
export function fmtTimeFull(ts) { return fmtTime(ts, { ...TIME_OPTS, year: "numeric", second: "2-digit" }); }
export function fmtClock(ts) { return new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false }); }
export function fmtDay(ts) { return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" }); }
export function shortRef(ref) { return ref.length > 20 ? `${ref.slice(0, 10)}…${ref.slice(-6)}` : ref; }
export function signClass(n) { return !finite(n) || n === 0 ? "" : n > 0 ? "pos" : "neg"; }

// math
export function niceStep(span, count) {
  const raw = span / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const r = raw / mag;
  const f = r <= 1 ? 1 : r <= 2 ? 2 : r <= 2.5 ? 2.5 : r <= 5 ? 5 : 10;
  return f * mag;
}
export function niceTicks(min, max, count = 4) {
  let lo = Math.min(min, max), hi = Math.max(min, max);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) { lo = 0; hi = 1; }
  if (hi === lo) { const pad = lo === 0 ? 1 : Math.abs(lo) * 0.01; lo -= pad; hi += pad; }
  const pad = (hi - lo) * 0.08;
  lo -= pad; hi += pad;
  const step = niceStep(hi - lo, count);
  const first = Math.ceil(lo / step) * step;
  const ticks = [];
  for (let t = first; t <= hi + step * 1e-9; t += step) ticks.push(Number(t.toFixed(10)));
  return { ticks, lo, hi };
}
const H = 3_600_000, D = 24 * H;
const TICK_STEPS = [H, 2 * H, 3 * H, 6 * H, 12 * H, D, 2 * D, 7 * D, 14 * D, 30 * D];
export function timeTicks(t0, t1, width) {
  const span = Math.max(1, t1 - t0);
  const want = Math.max(2, Math.floor(width / 90));
  let step = TICK_STEPS[TICK_STEPS.length - 1];
  for (const s of TICK_STEPS) if (span / s <= want) { step = s; break; }
  const useDay = span >= 2 * D;
  const ticks = [];
  const first = new Date(t0);
  if (useDay) first.setHours(0, 0, 0, 0); else first.setMinutes(0, 0, 0);
  let t = first.getTime();
  const align = step >= D ? D : step;
  while (t < t0) t += align;
  for (; t <= t1; t += step) {
    ticks.push({ ts: t, label: useDay ? (span > 300 * D ? `${fmtDay(t)} ${new Date(t).getFullYear()}` : fmtDay(t)) : fmtClock(t) });
  }
  return ticks;
}
export function thin(points, max) {
  if (points.length <= max || max < 2) return points;
  const out = [];
  const step = (points.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(points[Math.round(i * step)]);
  return out;
}
export function nearestIndex(xs, x) {
  let lo = 0, hi = xs.length - 1;
  if (hi < 0) return -1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (xs[mid] < x) lo = mid + 1; else hi = mid; }
  if (lo > 0 && Math.abs(xs[lo - 1] - x) < Math.abs(xs[lo] - x)) return lo - 1;
  return lo;
}
export function dailyStats(points) {
  const days = new Map();
  for (const p of points) days.set(new Date(p.ts).toDateString(), p);
  const ends = [...days.values()];
  if (ends.length < 2) return null;
  let best = null, worst = null;
  for (let i = 1; i < ends.length; i++) {
    const prev = ends[i - 1].equity, cur = ends[i].equity;
    const row = { day: ends[i].ts, changeUsd: cur - prev, changePct: prev > 0 ? ((cur - prev) / prev) * 100 : 0 };
    if (!best || row.changeUsd > best.changeUsd) best = row;
    if (!worst || row.changeUsd < worst.changeUsd) worst = row;
  }
  return { best, worst };
}
export function botStatus(entry) {
  if (!entry) return "unreachable";
  if (entry.pending && !entry.snapshot) return "loading";
  if (entry.source === "offline") return "offline";
  const bot = entry.snapshot?.bot;
  if (!bot) return "unreachable";
  if (bot.halted) return "halted";
  if (bot.paused) return "paused";
  if (bot.active) return "running";
  return "stopped";
}
export function cadenceText(bot) {
  const secs = bot.positionCheckSeconds ?? (bot.tickIntervalMin ? bot.tickIntervalMin * 60 : undefined);
  const parts = [];
  if (finite(secs)) parts.push(`positions every ${fmtNum(secs, 2)}s`);
  if (finite(bot.signalCheckMinutes)) parts.push(`signals every ${fmtNum(bot.signalCheckMinutes, 2)}m`);
  return parts.join(", ");
}
export function parseHash(hash) {
  const raw = (hash || "").replace(/^#/, "");
  const [tab, query = ""] = raw.split("?");
  const params = new URLSearchParams(query);
  return { tab: tab || undefined, bot: params.get("bot") || undefined, range: params.get("range") || undefined };
}
export function buildHash(state) {
  const params = new URLSearchParams();
  if (state.selectedId) params.set("bot", state.selectedId);
  if (state.range) params.set("range", state.range);
  const q = params.toString();
  return `#${state.tab || "overview"}${q ? `?${q}` : ""}`;
}
export function filterLogs(rows, levels, query) {
  const q = (query || "").trim().toLowerCase();
  return rows.filter((r) => levels.has(r.level) && (!q || `${r.message} ${r.code}`.toLowerCase().includes(q)));
}
export function sortRows(rows, key, dir) {
  const sign = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = a[key], bv = b[key];
    if (av === bv) return a.key < b.key ? -1 : 1;
    if (av === undefined || av === null) return 1;
    if (bv === undefined || bv === null) return -1;
    return (av < bv ? -1 : 1) * sign;
  });
}
function rangeLabel(range) { return range === "all" ? "Since start" : range; }
function historySummary(points) {
  if (!points.length) return { highWater: 0, maxDrawdownPct: 0, changeUsd: 0, changePct: 0 };
  let peak = -Infinity, dd = 0;
  for (const p of points) { peak = Math.max(peak, p.equity); if (peak > 0) dd = Math.max(dd, ((peak - p.equity) / peak) * 100); }
  const first = points[0].equity, last = points[points.length - 1].equity;
  return { highWater: peak, maxDrawdownPct: dd, changeUsd: last - first, changePct: first > 0 ? ((last - first) / first) * 100 : 0 };
}

// dom
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "hidden") el.hidden = Boolean(v);
    else if (k === "dataset") Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) if (c !== undefined && c !== null) el.append(typeof c === "string" ? document.createTextNode(c) : c);
  return el;
}
function svg(tag, attrs = {}, text) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined) el.setAttribute(k, String(v));
  if (text !== undefined) el.textContent = text;
  return el;
}
function clear(el) { el.replaceChildren(); }
function byId(id) { return document.getElementById(id); }
function stat(label, value, opts = {}) {
  return h("div", { class: "stat" },
    h("span", { class: "stat-label" }, label),
    h("span", { class: `stat-value ${opts.small ? "is-small" : ""} ${opts.cls || ""}` }, value),
    opts.sub ? h("span", { class: "stat-sub" }, opts.sub) : null);
}
function table(spec) {
  const cols = spec.columns;
  const colgroup = h("colgroup", {}, cols.map(() => h("col")));
  const head = h("tr", {}, cols.map((c) => {
    const th = h("th", { scope: "col", class: c.num ? "num" : undefined });
    if (spec.onSort) {
      th.setAttribute("aria-sort", spec.sort?.key === c.key ? (spec.sort.dir === "asc" ? "ascending" : "descending") : "none");
      const b = h("button", { type: "button" }, c.label);
      b.addEventListener("click", () => spec.onSort(c.key));
      th.append(b);
    } else th.textContent = c.label;
    return th;
  }));
  const body = h("tbody", {}, spec.rows.map((r) => h("tr", {}, cols.map((c) => {
    const cell = c.render ? c.render(r) : String(r[c.key] ?? DASH);
    const td = h("td", { class: `${c.num ? "num" : ""} ${c.cls ? c.cls(r) : ""}` });
    if (cell instanceof Node) td.append(cell); else td.textContent = cell;
    if (c.title) td.title = c.title(r);
    return td;
  }))));
  const t = h("table", {}, colgroup, h("thead", {}, head), body);
  for (const [i, c] of cols.entries()) if (c.width) colgroup.children[i].setAttribute("width", c.width);
  return h("div", { class: "table-wrap" }, t);
}
function emptyLine(text) { return h("div", { class: "empty" }, text); }
function sideChip(side, outcome) {
  const word = outcome ? `${side} ${outcome}` : side;
  const cls = (outcome || side || "").toLowerCase();
  return h("span", { class: `side ${cls}` }, word);
}

// api
class ApiError extends Error {
  constructor(status, message, body) { super(message); this.status = status; this.body = body; }
}
async function api(path, { method = "GET", body, signal } = {}) {
  const res = await fetch(path, {
    method, signal, credentials: "same-origin",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || `HTTP ${res.status}`, data);
  return data;
}
const Api = {
  session: (s) => api("/api/session", { signal: s }),
  bots: (s) => api("/api/bots", { signal: s }),
  bot: (id, range, s) => api(`/api/bots/${encodeURIComponent(id)}?range=${range}`, { signal: s }),
  login: (password) => api("/api/login", { method: "POST", body: { password } }),
  logout: () => api("/api/logout", { method: "POST" }),
};

// state
const state = {
  view: "loading", session: null, bots: [], loaded: false, refreshSeconds: DEFAULT_REFRESH,
  selectedId: null, tab: "overview", range: "24h", entry: null,
  lastRefreshAt: null, stale: false, netError: null,
  metricsScope: "last24h", metricsSort: { key: "calls", dir: "desc" },
  logLevels: new Set(LEVELS), logQuery: "",
};
function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    if (TABS.includes(p.tab)) state.tab = p.tab;
    if (RANGES.includes(p.range)) state.range = p.range;
    if (typeof p.selectedId === "string") state.selectedId = p.selectedId;
    if (p.metricsScope === "sinceStart" || p.metricsScope === "last24h") state.metricsScope = p.metricsScope;
    if (Array.isArray(p.logLevels)) state.logLevels = new Set(p.logLevels.filter((l) => LEVELS.includes(l)));
  } catch {}
}
function savePrefs() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      tab: state.tab, range: state.range, selectedId: state.selectedId,
      metricsScope: state.metricsScope, logLevels: [...state.logLevels],
    }));
  } catch {}
}
function setState(patch) { Object.assign(state, patch); render(); }
function navigate(patch) {
  Object.assign(state, patch);
  history.replaceState(null, "", buildHash(state));
  savePrefs();
  render();
}

// router
function applyHash() {
  const { tab, bot, range } = parseHash(location.hash);
  const patch = {};
  if (TABS.includes(tab)) patch.tab = tab;
  if (RANGES.includes(range)) patch.range = range;
  if (bot) patch.selectedId = bot;
  const changed = (patch.selectedId && patch.selectedId !== state.selectedId) || (patch.range && patch.range !== state.range);
  Object.assign(state, patch);
  savePrefs();
  if (state.view !== "app") return;
  render();
  // A new bot or range in the URL needs its own entry, not the one on screen.
  if (changed && state.bots.length > 0) refreshEntry();
}

// polling
let timer = null, inflight = null;
function schedule() {
  clearTimeout(timer);
  if (document.hidden || state.view !== "app") return;
  // A bot still being read answers within seconds; poll it quickly instead of waiting a full interval.
  const seconds = state.bots.some((b) => b.pending && !b.snapshot) ? 3 : state.refreshSeconds;
  timer = setTimeout(() => refresh(), seconds * 1000);
}
function pickSelected(bots, wanted) {
  if (wanted && bots.some((b) => b.id === wanted)) return wanted;
  return bots[0]?.id ?? null;
}
async function refresh(entryOnly = false) {
  inflight?.abort();
  const c = (inflight = new AbortController());
  setState({ stale: true });
  try {
    const patch = { stale: false, netError: null, lastRefreshAt: Date.now() };
    if (entryOnly) {
      if (state.selectedId) patch.entry = await Api.bot(state.selectedId, state.range, c.signal);
    } else {
      const list = await Api.bots(c.signal);
      const bots = list.bots ?? [];
      const selectedId = bots.some((b) => b.id === state.selectedId) ? state.selectedId : bots[0]?.id ?? null;
      let entry = bots.find((b) => b.id === selectedId) ?? null;
      if (entry && state.range !== "24h") entry = await Api.bot(selectedId, state.range, c.signal);
      Object.assign(patch, { bots, selectedId, entry, loaded: true, refreshSeconds: Number(list.refreshSeconds) > 0 ? Number(list.refreshSeconds) : DEFAULT_REFRESH });
    }
    if (c !== inflight) return;
    setState(patch);
    history.replaceState(null, "", buildHash(state));
  } catch (err) {
    if (err.name === "AbortError") return;
    if (err.status === 401 && state.session?.mode === "hosted") return showLogin();
    setState({ stale: false, netError: err.message });
  } finally {
    if (c === inflight) schedule();
  }
}
const refreshEntry = () => refresh(true);

// render
function render() {
  if (state.view !== "app") return;
  renderHeader();
  renderBanners();
  renderTabs();
  const empty = state.loaded && state.bots.length === 0;
  const entry = state.entry;
  const waiting = !state.loaded || (entry?.pending && !entry.snapshot);
  byId("empty-bots").hidden = !empty;
  for (const t of TABS) byId(`panel-${t}`).hidden = empty || waiting || t !== state.tab;
  if (empty || waiting) return;
  ({ overview: renderOverview, positions: renderPositions, performance: renderPerformance, metrics: renderMetrics, logs: renderLogs })[state.tab](entry);
  for (const el of document.querySelectorAll(".chart")) el.classList.toggle("is-stale", state.stale);
}
function renderHeader() {
  const sel = byId("bot-select");
  const many = state.bots.length > 1 && state.session?.mode !== "hosted";
  sel.hidden = !many;
  if (many) {
    const want = state.bots.map((b) => b.id).join("|");
    if (sel.dataset.ids !== want) {
      clear(sel);
      for (const b of state.bots) sel.append(h("option", { value: b.id }, b.id));
      sel.dataset.ids = want;
    }
    if (state.selectedId) sel.value = state.selectedId;
  }
  byId("bot-name").textContent = many ? "" : state.selectedId || "";
  byId("bot-name").hidden = many;
  const e = state.entry;
  byId("source-badge").textContent = !e ? "" : e.source === "droplet" ? `droplet · ${e.host || ""}` : e.source;
  const status = e ? botStatus(e) : "";
  const dot = byId("status-dot");
  dot.className = `dot is-${status}`;
  byId("status-text").textContent = status;
  byId("status-pill").hidden = !e;
  byId("refresh-info").textContent = state.lastRefreshAt ? `Updated ${fmtAgo(state.lastRefreshAt)} · every ${state.refreshSeconds} s` : "";
  byId("theme-btn").textContent = document.documentElement.getAttribute("data-theme") === "dark" ? "Light" : "Dark";
  document.title = state.selectedId ? `cassie · ${state.selectedId}` : "cassie";
}
function renderBanners() {
  const el = byId("banners");
  clear(el);
  const e = state.entry;
  const rows = [];
  if (state.netError) rows.push(["Could not refresh. " + state.netError, true]);
  if (e?.source === "offline" && e.snapshot) rows.push([`Offline. Last snapshot ${fmtTime(e.fetchedAt)}.`, false]);
  if (e?.pending && !e.snapshot) rows.push([e.source === "droplet" ? "Reading over SSH." : "Reading.", false]);
  else if (e?.error && !e.snapshot) rows.push([`${e.id} is unreachable. ${e.error}`, true]);
  else if (e?.error) rows.push([`Partial data. ${e.error}`, true]);
  if (e?.degraded) rows.push([`Degraded snapshot. ${e.degradedReason || ""}`, false]);
  if (e?.snapshot?.portfolioError) rows.push([`Portfolio unavailable. ${e.snapshot.portfolioError}`, true]);
  if (e?.snapshot?.bot.halted) rows.push([`Halted. ${e.snapshot.bot.haltReason || ""}`, true]);
  for (const [text, alert] of rows) el.append(h("div", { class: `banner ${alert ? "is-alert" : ""}` }, text));
}
function renderTabs() {
  for (const t of TABS) {
    const a = byId(`tab-${t}`);
    const active = t === state.tab;
    a.setAttribute("aria-selected", String(active));
    a.tabIndex = active ? 0 : -1;
    a.href = buildHash({ ...state, tab: t });
  }
}
function segControl(el, options, current, onPick) {
  const key = options.map((o) => o.value).join("|") + "|" + current;
  if (el.dataset.key === key) return;
  clear(el);
  for (const o of options) {
    const b = h("button", { type: "button", "aria-pressed": String(o.value === current) }, o.label);
    b.addEventListener("click", () => onPick(o.value));
    el.append(b);
  }
  el.dataset.key = key;
}
function rangeControl(el) {
  segControl(el, RANGES.map((r) => ({ value: r, label: r === "all" ? "All" : r })), state.range, (range) => {
    navigate({ range });
    refreshEntry();
  });
}
function equitySeries(points) { return points.map((p) => ({ ts: p.ts, v: p.equity })); }
function latestPoint(snap) { return snap?.history.points[snap.history.points.length - 1]; }

function renderOverview(entry) {
  const snap = entry?.snapshot;
  const hero = byId("ov-hero"), sub = byId("ov-hero-sub"), stats = byId("ov-stats"), engine = byId("ov-engine");
  clear(stats); clear(engine);
  rangeControl(byId("ov-range"));
  if (!snap) {
    hero.textContent = DASH; hero.className = "hero-value"; sub.textContent = "";
    lineChart(byId("ov-chart"), [], { tableEl: byId("ov-chart-table") });
    return;
  }
  const p = snap.portfolio, last = latestPoint(snap), sum = snap.history.summary;
  const equity = p ? p.equity : last?.equity;
  hero.textContent = fmtMoney(equity);
  hero.className = `hero-value ${signClass(sum.changeUsd)}`;
  sub.textContent = snap.history.points.length > 1
    ? `${rangeLabel(snap.history.range)} ${fmtMoney(sum.changeUsd, { sign: true })} · ${fmtPct(sum.changePct)}`
    : p ? "" : `from last sample, ${fmtAgo(last?.ts)}`;
  const uPnl = p ? p.unrealizedPnl : last?.unrealizedPnl;
  const rPnl = p ? p.realizedPnl : last?.realizedPnl;
  const dd = equity && sum.highWater > 0 ? (equity / sum.highWater - 1) * 100 : 0;
  stats.append(
    stat("Unrealized", fmtMoney(uPnl, { sign: true }), { cls: signClass(uPnl) }),
    stat("Realized", fmtMoney(rPnl, { sign: true }), { cls: signClass(rPnl) }),
    stat("Positions", fmtInt(p ? p.positions.length : last?.positions)),
    stat("Resting", fmtInt(p ? p.openOrders.length : last?.resting)),
    stat("Drawdown", fmtPct(dd, { sign: false }), { sub: sum.highWater > 0 ? `high water ${fmtMoney(sum.highWater)}` : undefined }),
  );
  lineChart(byId("ov-chart"), [{ label: "Equity", cls: signClass(sum.changeUsd) === "neg" ? "loss" : "gain", area: true, baseline: true, points: equitySeries(snap.history.points) }], { tableEl: byId("ov-chart-table") });
  const b = snap.bot;
  const parts = [b.strategy, b.venue, `${b.version}${b.region ? ` in ${b.region}` : ""}`, `last tick ${fmtAgo(b.lastTickAt)}`];
  const cadence = cadenceText(b);
  if (cadence) parts.push(cadence);
  if (b.active && !entry.degraded) parts.push(`up ${fmtDuration(b.startedAt)}`);
  if (b.lifecycle) parts.push(b.lifecycle);
  for (const t of parts) engine.append(h("span", {}, t));
}

function renderPositions(entry) {
  const snap = entry?.snapshot;
  const pos = byId("pos-table"), ord = byId("ord-table"), bal = byId("pos-balances");
  clear(pos); clear(ord); bal.textContent = "";
  const p = snap?.portfolio;
  if (!p) { pos.append(emptyLine("No open positions.")); ord.append(emptyLine("No resting orders.")); return; }
  const venue = snap.bot.venue, perp = PERP_VENUES.has(venue);
  const market = { key: "marketRef", label: "Market", width: "34%", render: (r) => {
    const el = h("span", { class: "cell-market" }, r.label || shortRef(r.marketRef));
    if (r.label) el.append(h("span", { class: "ref code" }, shortRef(r.marketRef)));
    return el;
  }, title: (r) => r.marketRef };
  const rows = [...p.positions].sort((a, b) => Math.abs(b.value ?? 0) - Math.abs(a.value ?? 0));
  if (!rows.length) pos.append(emptyLine("No open positions."));
  else pos.append(table({ columns: [
    market,
    { key: "side", label: "Side", render: (r) => sideChip(r.side) },
    { key: "size", label: "Size", num: true, render: (r) => fmtNum(r.size) },
    { key: "avgPrice", label: "Avg", num: true, render: (r) => fmtPrice(venue, r.avgPrice) },
    { key: "markPrice", label: "Mark", num: true, render: (r) => fmtPrice(venue, r.markPrice ?? r.currentPrice) },
    { key: "value", label: perp ? "Notional" : "Value", num: true, render: (r) => fmtMoney(r.value) },
    { key: "unrealizedPnl", label: "uPnL", num: true, render: (r) => fmtMoney(r.unrealizedPnl, { sign: true }), cls: (r) => signClass(r.unrealizedPnl) },
    ...(perp
      ? [{ key: "leverage", label: "Leverage", num: true, render: (r) => finite(r.leverage) ? `${fmtNum(r.leverage, 1)}×` : DASH },
         { key: "liquidationPrice", label: "Liq. price", num: true, render: (r) => fmtPrice(venue, r.liquidationPrice) }]
      : [{ key: "redeemable", label: "Status", render: (r) => r.redeemable ? "redeemable" : "" }]),
  ], rows }));
  const orders = p.openOrders ?? snap.orders ?? [];
  if (!orders.length) ord.append(emptyLine(rows.length ? "No resting orders." : "Flat, no orders."));
  else ord.append(table({ columns: [
    market,
    { key: "side", label: "Side", render: (r) => {
      const chip = sideChip(r.side, r.outcome);
      if (r.isTrigger) chip.append(` ${(r.triggerKind || "trigger").toUpperCase()}`);
      return chip;
    } },
    { key: "price", label: "Price", num: true, render: (r) => fmtPrice(venue, r.price) },
    { key: "size", label: "Size", num: true, render: (r) => fmtNum(r.size) },
    { key: "filledSize", label: "Filled", num: true, render: (r) => fmtNum(r.filledSize) },
    { key: "createdAt", label: "Age", render: (r) => r.createdAt ? fmtAgo(r.createdAt).replace(/ ago$/, "") : DASH },
    { key: "status", label: "Status", render: (r) => r.status || DASH },
  ], rows: orders }));
  bal.textContent = (p.balances || []).map((b) => `${b.asset} ${group(b.total, 2)} total, ${group(b.available, 2)} available`).join(" · ");
}

function renderPerformance(entry) {
  const snap = entry?.snapshot;
  rangeControl(byId("pf-range"));
  const stats = byId("pf-stats"), sample = byId("pf-sample");
  clear(stats);
  const points = snap?.history.points ?? [];
  const sum = snap?.history.summary ?? historySummary(points);
  lineChart(byId("pf-equity"), points.length ? [{ label: "Equity", cls: signClass(sum.changeUsd) === "neg" ? "loss" : "gain", area: true, baseline: true, points: equitySeries(points) }] : [], { height: 280, tableEl: byId("pf-equity-table") });
  if (points.length) {
    const first = points[0], last = points[points.length - 1];
    stats.append(
      stat("Start", fmtMoney(first.equity), { small: true }),
      stat("Now", fmtMoney(last.equity), { small: true }),
      stat("Change", `${fmtMoney(sum.changeUsd, { sign: true })} · ${fmtPct(sum.changePct)}`, { small: true, cls: signClass(sum.changeUsd) }),
      stat("High water", fmtMoney(sum.highWater), { small: true }),
      stat("Max drawdown", fmtPct(sum.maxDrawdownPct, { sign: false }), { small: true }),
    );
    const days = dailyStats(points);
    if (days) stats.append(stat("Best day", fmtMoney(days.best.changeUsd, { sign: true }), { small: true, cls: "pos" }), stat("Worst day", fmtMoney(days.worst.changeUsd, { sign: true }), { small: true, cls: "neg" }));
  }
  lineChart(byId("pf-pnl"), points.length ? [
    { label: "Realized", cls: "ink", points: points.map((p) => ({ ts: p.ts, v: p.realizedPnl })) },
    { label: "Unrealized", cls: "accent", points: points.map((p) => ({ ts: p.ts, v: p.unrealizedPnl })) },
  ] : [], { tableEl: byId("pf-pnl-table") });
  lineChart(byId("pf-cash"), points.length ? [
    { label: "Cash", cls: "ink", points: points.map((p) => ({ ts: p.ts, v: p.cash })) },
    { label: "Positions", cls: "accent", points: points.map((p) => ({ ts: p.ts, v: p.equity - p.cash })) },
  ] : [], { tableEl: byId("pf-cash-table") });
  const minutes = sum.sampleMinutes ?? snap?.history.summary.sampleMinutes;
  sample.textContent = finite(minutes)
    ? `Sampled every ${fmtNum(minutes, 2)} minutes${points.length ? `, ${fmtInt(points.length)} samples` : ""}`
    : "";
}

function renderMetrics(entry) {
  const snap = entry?.snapshot;
  const m = snap?.metrics;
  const hourly = m?.last24h.hourly ?? [];
  barChart(byId("mt-hourly"), fillHours(hourly));
  segControl(byId("mt-scope"), [{ value: "last24h", label: "Last 24h" }, { value: "sinceStart", label: "Since start" }], state.metricsScope, (metricsScope) => navigate({ metricsScope }));
  byId("mt-scope-note").textContent = m && state.metricsScope === "sinceStart" ? `since ${fmtTime(m.sinceStart.startedAt)}` : "";
  const tbl = byId("mt-table");
  clear(tbl);
  const rows = m ? (state.metricsScope === "sinceStart" ? m.sinceStart.rows : m.last24h.rows) : [];
  if (!rows.length) tbl.append(emptyLine("No API calls recorded."));
  else tbl.append(table({
    columns: [
      { key: "key", label: "Key", width: "34%", render: (r) => r.key },
      { key: "calls", label: "Calls", num: true, render: (r) => fmtInt(r.calls) },
      { key: "errors", label: "Errors", num: true, render: (r) => fmtInt(r.errors), cls: (r) => r.errors > 0 ? "neg" : "" },
      { key: "avgMs", label: "Avg", num: true, render: (r) => fmtMs(r.avgMs) },
      { key: "maxMs", label: "Max", num: true, render: (r) => fmtMs(r.maxMs) },
      { key: "lastErrorAt", label: "Last error", render: (r) => r.lastErrorAt ? fmtAgo(r.lastErrorAt) : "", title: (r) => r.lastError || "" },
    ],
    rows: sortRows(rows, state.metricsSort.key, state.metricsSort.dir),
    sort: state.metricsSort,
    onSort: (key) => setState({ metricsSort: { key, dir: state.metricsSort.key === key && state.metricsSort.dir === "desc" ? "asc" : "desc" } }),
  }));
  const eng = byId("mt-engine"), al = byId("mt-alerts"), hl = byId("mt-hl"), hls = byId("mt-hl-stats");
  clear(eng); clear(al); clear(hls);
  const e = m?.engine;
  if (e) {
    for (const [label, key, bad] of [["Ticks", "ticks"], ["Tick errors", "tickErrors", 1], ["Orders placed", "ordersPlaced"], ["Orders canceled", "ordersCanceled"], ["Orders skipped", "ordersSkipped"], ["Alerts sent", "alertsSent"], ["Alerts failed", "alertsFailed", 1]])
      eng.append(stat(label, fmtInt(e[key]), { small: true, cls: bad && e[key] > 0 ? "neg" : "" }));
    const kinds = Object.entries(e.alertsByKind || {}).sort((a, b) => b[1] - a[1]);
    if (!kinds.length) al.append(h("span", { class: "meta" }, "None"));
    for (const [k, n] of kinds) al.append(stat(k, fmtInt(n), { small: true }));
  }
  const s = m?.hyperliquidScheduler;
  hl.hidden = !s;
  if (s) {
    for (const [label, key] of [["Queued", "queued"], ["Active", "active"], ["Background", "backgroundActive"], ["Weight in window", "weightInWindow"], ["Cooldown", "cooldownRemainingMs"], ["Requests", "requests"], ["Coalesced", "coalesced"], ["Rejected", "rejected"], ["Rate limited", "rateLimited"]])
      hls.append(stat(label, key === "cooldownRemainingMs" ? fmtMs(s[key]) : fmtInt(s[key]), { small: true, cls: key === "rateLimited" && s[key] > 0 ? "neg" : "" }));
  }
  byId("mt-sampler").textContent = m ? `Sampler · last sample ${fmtAgo(m.sampler.lastSampleAt)} · ${fmtInt(m.sampler.errors)} errors` : "";
}
function fillHours(hourly) {
  const now = Date.now();
  const start = Math.floor((now - 23 * H) / H) * H;
  const byHour = new Map(hourly.map((b) => [b.hourTs, b]));
  const out = [];
  for (let t = start; t <= now; t += H) out.push({ ts: t, calls: byHour.get(t)?.calls ?? 0, errors: byHour.get(t)?.errors ?? 0 });
  return out;
}

function renderLogs(entry) {
  const snap = entry?.snapshot;
  const chips = byId("lg-levels");
  const key = [...state.logLevels].join("|");
  if (chips.dataset.key !== key) {
    clear(chips);
    for (const l of LEVELS) {
      const b = h("button", { type: "button", "aria-pressed": String(state.logLevels.has(l)) }, l);
      b.addEventListener("click", () => {
        const next = new Set(state.logLevels);
        if (next.has(l)) next.delete(l); else next.add(l);
        navigate({ logLevels: next });
      });
      chips.append(b);
    }
    chips.dataset.key = key;
  }
  const list = byId("lg-list");
  clear(list);
  const all = snap?.errors ?? [];
  const rows = filterLogs(all, state.logLevels, state.logQuery);
  if (!all.length) { list.append(emptyLine("No recorded errors.")); return; }
  if (!rows.length) { list.append(emptyLine("No entries match.")); return; }
  const tpl = byId("tpl-log-row");
  for (const r of rows) {
    const row = tpl.content.firstElementChild.cloneNode(true);
    const time = row.querySelector(".log-time");
    time.textContent = fmtTimeFull(r.ts);
    time.setAttribute("datetime", new Date(toMs(r.ts) ?? 0).toISOString());
    row.querySelector(".log-ago").textContent = fmtAgo(r.ts);
    row.querySelector(".log-level").classList.add(r.level);
    row.querySelector(".log-level-text").textContent = r.level;
    row.querySelector(".log-code").textContent = r.code;
    row.querySelector(".log-venue").textContent = r.venue || "";
    row.querySelector(".log-tick").textContent = finite(r.tickSeq) ? `tick ${r.tickSeq}` : "";
    row.querySelector(".log-msg").textContent = r.message;
    const ctx = row.querySelector(".log-ctx");
    if (r.context !== undefined && r.context !== null) { ctx.hidden = false; ctx.querySelector("pre").textContent = JSON.stringify(r.context, null, 2); }
    list.append(row);
  }
}

// charts
const charts = new WeakMap();
function chartWidth(el) { return el.clientWidth || 640; }
function observe(el, redraw) {
  if (charts.get(el)?.observer) { charts.get(el).redraw = redraw; return; }
  const rec = { redraw, width: chartWidth(el) };
  if (typeof ResizeObserver !== "undefined") {
    rec.observer = new ResizeObserver(() => {
      const w = chartWidth(el);
      if (Math.abs(w - rec.width) > 8) { rec.width = w; requestAnimationFrame(() => rec.redraw()); }
    });
    rec.observer.observe(el);
  }
  charts.set(el, rec);
}
function tipEl(el) {
  let tip = el.querySelector(".chart-tip");
  if (!tip) { tip = byId("tpl-tip").content.firstElementChild.cloneNode(true); tip.hidden = true; el.append(tip); }
  return tip;
}
function showTip(el, tip, px, title, rows) {
  tip.querySelector(".tip-title").textContent = title;
  const ul = tip.querySelector(".tip-rows");
  clear(ul);
  for (const r of rows) ul.append(h("li", {}, h("span", { class: `key f-${r.cls}` }), h("span", { class: "val" }, r.value), r.label ? h("span", { class: "lbl" }, r.label) : null));
  tip.hidden = false;
  const w = el.clientWidth, tw = tip.offsetWidth || 120;
  const x = px + 12 + tw > w ? px - tw - 12 : px + 12;
  tip.style.transform = `translate(${Math.max(0, x)}px, 8px)`;
}
export function lineChart(el, series, opts = {}) {
  const draw = () => {
    const width = chartWidth(el), Hh = opts.height ?? 200;
    const pts = series.map((s) => ({ ...s, points: thin(s.points.filter((p) => finite(p.v)), Math.max(60, Math.floor(width / 2))) }));
    const all = pts.flatMap((s) => s.points);
    clear(el);
    if (!all.length) { el.append(h("p", { class: "chart-empty" }, "No history yet.")); if (opts.tableEl) clear(opts.tableEl); return; }
    const M = { l: 54, r: 16, t: 14, b: 26 };
    const t0 = Math.min(...all.map((p) => p.ts)), t1 = Math.max(...all.map((p) => p.ts));
    const { ticks, lo, hi } = niceTicks(Math.min(...all.map((p) => p.v)), Math.max(...all.map((p) => p.v)), 4);
    const x = (ts) => t1 === t0 ? (M.l + width - M.r) / 2 : M.l + ((ts - t0) / (t1 - t0)) * (width - M.l - M.r);
    const y = (v) => M.t + ((hi - v) / (hi - lo)) * (Hh - M.t - M.b);
    const fmtY = opts.fmtY ?? ((v) => fmtMoney(v, { dp: Math.abs(hi - lo) < 5 ? 2 : 0 }));
    const root = svg("svg", { viewBox: `0 0 ${width} ${Hh}`, height: Hh, role: "img", tabindex: 0, "aria-label": series.map((s) => s.label).join(", ") });
    for (const t of ticks) root.append(svg("text", { class: "axis-text", x: M.l - 8, y: y(t) + 3, "text-anchor": "end" }, fmtY(t)));
    for (const t of timeTicks(t0, t1, width - M.l - M.r)) root.append(svg("text", { class: "axis-text", x: x(t.ts), y: Hh - 8, "text-anchor": "middle" }, t.label));
    const defs = svg("defs");
    root.append(defs);
    pts.forEach((s, i) => {
      if (!s.points.length) return;
      const d = s.points.map((p, j) => `${j ? "L" : "M"}${x(p.ts).toFixed(1)},${y(p.v).toFixed(1)}`).join("");
      if (s.baseline) root.append(svg("line", { class: "baseline", x1: M.l, x2: width - M.r, y1: y(s.points[0].v), y2: y(s.points[0].v) }));
      if (s.area && s.points.length > 1) {
        const id = `fill-${i}-${Math.round(Math.random() * 1e6)}`;
        const g = svg("linearGradient", { id, x1: 0, y1: 0, x2: 0, y2: 1 });
        g.append(svg("stop", { offset: "0%", class: `stop-${s.cls}`, "stop-opacity": 0.2 }), svg("stop", { offset: "100%", class: `stop-${s.cls}`, "stop-opacity": 0 }));
        defs.append(g);
        const area = svg("path", { class: "area", d: `${d}L${x(t1).toFixed(1)},${(Hh - M.b).toFixed(1)}L${x(t0).toFixed(1)},${(Hh - M.b).toFixed(1)}Z`, fill: `url(#${id})` });
        root.append(area);
      }
      if (s.points.length > 1) root.append(svg("path", { class: `series-line s-${s.cls}`, d }));
      const last = s.points[s.points.length - 1];
      root.append(svg("circle", { class: `marker f-${s.cls}`, cx: x(last.ts), cy: y(last.v), r: 4 }));
    });
    const cross = svg("line", { class: "crosshair", y1: M.t, y2: Hh - M.b, x1: -10, x2: -10 });
    root.append(cross);
    const tip = tipEl(el);
    const xs = pts.map((s) => s.points.map((p) => p.ts));
    const hover = (px) => {
      const ts = t0 + ((px - M.l) / Math.max(1, width - M.l - M.r)) * (t1 - t0);
      const rows = [];
      let at = null;
      pts.forEach((s, i) => {
        const k = nearestIndex(xs[i], ts);
        if (k < 0) return;
        const p = s.points[k];
        at = at ?? p.ts;
        rows.push({ cls: s.cls, value: fmtY(p.v), label: pts.length > 1 ? s.label : "" });
      });
      if (at === null) return;
      cross.setAttribute("x1", x(at)); cross.setAttribute("x2", x(at));
      showTip(el, tip, x(at), fmtTime(at), rows);
    };
    root.addEventListener("pointermove", (ev) => hover(ev.offsetX));
    root.addEventListener("pointerleave", () => { tip.hidden = true; cross.setAttribute("x1", -10); cross.setAttribute("x2", -10); });
    root.addEventListener("keydown", (ev) => { if (ev.key === "Escape") tip.hidden = true; });
    el.append(root);
    if (pts.length > 1) el.append(h("div", { class: "legend" }, pts.map((s) => h("span", {}, h("span", { class: `key f-${s.cls}` }), s.label))));
    if (opts.tableEl) chartTable(opts.tableEl, pts, fmtY);
  };
  draw();
  observe(el, draw);
}
function chartTable(el, series, fmtY) {
  clear(el);
  if (!series.length) return;
  const base = series[0].points;
  const rows = thin(base, 200).map((p, i) => {
    const idx = base.indexOf(p);
    const cells = [fmtTime(p.ts)];
    for (const s of series) cells.push(fmtY(s.points[Math.min(idx, s.points.length - 1)]?.v));
    return cells;
  });
  const t = h("table", {}, h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "Time"), series.map((s) => h("th", { scope: "col", class: "num" }, s.label)))),
    h("tbody", {}, rows.map((r) => h("tr", {}, r.map((c, i) => h("td", { class: i ? "num" : "" }, c))))));
  el.append(h("details", { class: "chart-twin" }, h("summary", {}, "Table"), h("div", { class: "table-wrap" }, t)));
}
export function barPath(x, y0, w, hgt, r = 3) {
  const y1 = y0 - hgt, rr = Math.min(r, w / 2, hgt);
  return `M${x},${y0}V${y1 + rr}Q${x},${y1} ${x + rr},${y1}H${x + w - rr}Q${x + w},${y1} ${x + w},${y1 + rr}V${y0}Z`;
}
export function barChart(el, bins, opts = {}) {
  const draw = () => {
    const width = chartWidth(el), Hh = opts.height ?? 150, M = { l: 44, r: 8, t: 12, b: 26 };
    clear(el);
    if (!bins.length || !bins.some((b) => b.calls > 0)) { el.append(h("p", { class: "chart-empty" }, "No calls in the last 24 hours.")); return; }
    const slot = (width - M.l - M.r) / bins.length, bw = Math.min(24, Math.max(2, slot - 2));
    const { ticks, hi } = niceTicks(0, Math.max(1, ...bins.map((b) => b.calls)), 3);
    const top = Math.max(hi, 1);
    const y = (v) => M.t + ((top - v) / top) * (Hh - M.t - M.b), y0 = y(0);
    const root = svg("svg", { viewBox: `0 0 ${width} ${Hh}`, height: Hh, role: "img", "aria-label": "API calls by hour" });
    for (const t of ticks) if (t >= 0) root.append(svg("text", { class: "axis-text", x: M.l - 8, y: y(t) + 3, "text-anchor": "end" }, fmtInt(t)));
    root.append(svg("line", { class: "baseline", x1: M.l, x2: width - M.r, y1: y0, y2: y0 }));
    const tip = tipEl(el);
    bins.forEach((b, i) => {
      const x = M.l + i * slot + (slot - bw) / 2;
      const g = svg("g", { class: "bar" });
      g.append(svg("path", { class: "bar-calls f-ink", d: barPath(x, y0, bw, y0 - y(b.calls)) }));
      if (b.errors > 0) g.append(svg("path", { class: "bar-errors", d: barPath(x, y0, bw, y0 - y(b.errors)) }));
      const hit = svg("rect", { class: "bar-hit", x: M.l + i * slot, y: M.t, width: slot, height: Hh - M.t - M.b });
      hit.addEventListener("pointermove", () => showTip(el, tip, x + bw / 2, `${fmtClock(b.ts)}`, [{ cls: "ink", value: fmtInt(b.calls), label: "calls" }, { cls: "loss", value: fmtInt(b.errors), label: "errors" }]));
      hit.addEventListener("pointerleave", () => { tip.hidden = true; });
      g.append(hit);
      root.append(g);
      if (i % 4 === 0) root.append(svg("text", { class: "axis-text", x: x + bw / 2, y: Hh - 8, "text-anchor": "middle" }, fmtClock(b.ts)));
    });
    el.append(root);
    el.append(h("div", { class: "legend" }, h("span", {}, h("span", { class: "key f-ink" }), "Calls"), h("span", {}, h("span", { class: "key f-loss" }), "Errors")));
  };
  draw();
  observe(el, draw);
}

// login / boot
let lockTimer = null, lockedUntil = 0;
function showLogin() {
  clearTimeout(timer);
  state.view = "login";
  byId("app").hidden = true;
  byId("login").hidden = false;
  byId("login-password").focus();
}
function showError(text) {
  const el = byId("login-error");
  el.textContent = text;
  el.hidden = !text;
}
async function login(ev) {
  ev.preventDefault();
  const input = byId("login-password"), btn = byId("login-submit");
  showError("");
  btn.disabled = true;
  try {
    await Api.login(input.value);
    input.value = "";
    state.session = await Api.session();
    state.view = "app";
    byId("login").hidden = true;
    byId("app").hidden = false;
    byId("signout-btn").hidden = state.session.mode !== "hosted";
    await refresh();
  } catch (err) {
    if (err.status === 429) {
      lockedUntil = Date.now() + (Number(err.body?.retryAfterSeconds) || 60) * 1000;
      clearInterval(lockTimer);
      const tick = () => {
        const left = Math.max(0, Math.ceil((lockedUntil - Date.now()) / 1000));
        showError(left > 0 ? `Too many attempts. Try again in ${left} s.` : "");
        btn.disabled = left > 0;
        if (left <= 0) clearInterval(lockTimer);
      };
      tick();
      lockTimer = setInterval(tick, 1000);
      return;
    }
    showError(err.status === 401 ? "Wrong password." : "Could not reach the server.");
  } finally {
    btn.disabled = Date.now() < lockedUntil;
  }
}
function bindStaticHandlers() {
  byId("login-form").addEventListener("submit", login);
  byId("refresh-btn").addEventListener("click", () => refresh());
  byId("signout-btn").addEventListener("click", async () => { try { await Api.logout(); } catch {} showLogin(); });
  byId("theme-btn").addEventListener("click", () => {
    const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem("q-theme", next); } catch {}
    render();
  });
  byId("bot-select").addEventListener("change", (ev) => { navigate({ selectedId: ev.target.value }); refreshEntry(); });
  byId("lg-search").addEventListener("input", (ev) => { state.logQuery = ev.target.value; if (state.tab === "logs") renderLogs(state.entry); });
  const tablist = document.querySelector(".tabs");
  tablist.addEventListener("keydown", (ev) => {
    const keys = { ArrowLeft: -1, ArrowRight: 1, Home: 0, End: TABS.length - 1 };
    if (!(ev.key in keys)) return;
    const i = TABS.indexOf(state.tab);
    const next = ev.key === "Home" ? 0 : ev.key === "End" ? TABS.length - 1 : (i + keys[ev.key] + TABS.length) % TABS.length;
    ev.preventDefault();
    location.hash = buildHash({ ...state, tab: TABS[next] });
    byId(`tab-${TABS[next]}`).focus();
  });
  window.addEventListener("hashchange", applyHash);
  document.addEventListener("visibilitychange", () => { if (document.hidden) clearTimeout(timer); else if (state.view === "app") refresh(); });
  setInterval(() => { if (state.view === "app" && state.lastRefreshAt) byId("refresh-info").textContent = `Updated ${fmtAgo(state.lastRefreshAt)} · every ${state.refreshSeconds} s`; }, 1000);
}
async function boot() {
  loadPrefs();
  applyHash();
  bindStaticHandlers();
  let session;
  try { session = await Api.session(); }
  catch (err) { if (err.status === 401) return showLogin(); byId("app").hidden = false; setState({ view: "app", netError: err.message }); return; }
  state.session = session;
  state.view = "app";
  byId("app").hidden = false;
  byId("signout-btn").hidden = session.mode !== "hosted";
  await refresh();
}
if (HAS_DOM && document.getElementById("app")) boot();
