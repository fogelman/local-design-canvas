// State, API calls, the comment queue states and the pan/zoom view.
const $ = (s) => document.querySelector(s);
const view = $("#view"), world = $("#world"), framesEl = $("#frames"), pinsEl = $("#pins"), hoverEl = $("#hover"), pop = $("#pop");
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

let NAME = "canvas", ME = "me", CANVAS_ID = "", ASSETS = "";
let dirty = new Map(); // file -> unsaved { x, y } and/or { w, h }
let frames = new Map(); // file -> { ...frame, el, iframe }
let threads = [];
let pan = { x: 80, y: 80, k: 0.5 };
let SECTIONS = []; // group titles of the current page (canvas.json "sections")
let PAGE = decodeURIComponent((location.hash.match(/page=([^&]*)/) || [])[1] || ""), PAGES = [];
let toClaude = localStorage.getItem("canvas-to-claude") !== "0";
let tool = "move", spaceDown = false, selected = null, openThread = null, draft = null, panelFilter = "open";

// ---------- api ----------
const q = (p) => PAGE ? `${p}${p.includes("?") ? "&" : "?"}page=${encodeURIComponent(PAGE)}` : p;
const src = (file) => `/${PAGE ? `${encodeURIComponent(PAGE)}/` : ""}${encodeURI(file)}`;
// Rejects when the server reports an error, so callers don't take a failed save for a done one. An answer that
// isn't JSON comes from a server older than this page (it doesn't know the address): say so, not a parse error.
async function answerOf(r) {
  const d = await r.json().catch(() => { throw new Error(r.status === 404 ? "the canvas server is older than this page. Restart it (canvas open) and try again" : `unexpected answer from the canvas server (${r.status})`); });
  if (!r.ok || d?.error) throw new Error(d?.error || `${r.status}`);
  return d;
}
const api = (p, body, method = "POST") => fetch(p.startsWith("/_api/") && p !== "/_api/me" ? q(p) : p, body === undefined ? undefined : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(answerOf);

// State requests overlap (a change on disk, a sent reply and Claude's answer each fetch it) and answers can come back
// out of order. Each request is numbered, and an answer older than one already applied is dropped, so a stale list
// never replaces a newer one (a just-sent reply would vanish until the next change).
let stateAsked = 0, framesShown = 0, threadsShown = 0;
async function loadState() {
  const n = ++stateAsked;
  const s = await api("/_api/state");
  if (n < framesShown) return;
  framesShown = n;
  NAME = s.name;
  PAGES = s.pages;
  if (ASSETS && s.assets !== ASSETS) inlined.clear(); // shared files changed: nothing embedded in pictures may be reused
  CANVAS_ID = s.id || ""; ASSETS = s.assets || "";
  if (!dirty.size) { try { dirty = new Map(JSON.parse(localStorage.getItem(dirtyKey())) || []); } catch { dirty = new Map(); } }
  const pg = PAGES.find((x) => x.id === PAGE) || PAGES[0];
  document.title = `${pg.name} · ${s.name}`;
  $("#pageName").textContent = pg.name;
  SECTIONS = s.sections || [];
  renderSections(SECTIONS);
  renderFrames(s.frames);
  for (const [file, d] of dirty) { const f = frames.get(file); if (!f) dirty.delete(file); else markDirty(f, d); } // drop stale or already-saved entries
  syncBar();
  if (n >= threadsShown) { threadsShown = n; setThreads(s.threads); }
}
async function loadThreads() {
  const n = ++stateAsked;
  const s = await api("/_api/state");
  if (n >= threadsShown) { threadsShown = n; setThreads(s.threads); }
}
// Queue state of a thread for Claude: "queued" (sent, not picked up), "working" (claimed by `canvas wait`), or null.
// Mirrors src/threads.mjs: a claim older than 30 min counts as abandoned, so the thread is queued again.
const queueState = (t) => t.status === "open" && t.msgs.at(-1)?.claude
  ? (t.working && Date.now() - Date.parse(t.working) < 30 * 60 * 1000 ? "working" : "queued") : null;
const QUEUE_LABEL = { queued: "Queued for Claude", working: "Claude is working…" };
let seenClaude = null, seenWorking = null; // to toast new replies and new pick-ups
function setThreads(list) {
  const counts = new Map(list.map((t) => [t.id, t.msgs.filter((m) => m.by === "Claude").length]));
  const working = new Set(list.filter((t) => queueState(t) === "working").map((t) => t.id));
  if (seenClaude) {
    const fresh = list.filter((t) => counts.get(t.id) > (seenClaude.get(t.id) || 0));
    const picked = [...working].filter((id) => !seenWorking.has(id));
    if (fresh.length) Pill.toast(fresh.length === 1 ? `Claude replied on #${num(fresh[0])}` : `Claude replied on ${fresh.length} threads`);
    else if (picked.length) Pill.toast(picked.length === 1 ? `Claude picked up #${String(picked[0]).replace(/^c/, "")}` : `Claude picked up ${picked.length} comments`);
  }
  seenClaude = counts; seenWorking = working;
  threads = list;
  if (openThread && !threads.find((t) => t.id === openThread)) openThread = null;
  renderPins(); renderPanel(); renderPop();
}

// ---------- motion ----------
// While the view moves, nothing heavy runs: screens don't load or unload and snapshots wait until it settles.
// A zoom scales what's already drawn (will-change keeps the browser from redrawing every screen at each step);
// once the view settles it's redrawn sharp at the new size.
const SETTLE_MS = 160;
let moving = false, settleT = null, lastK = null;
const settleWaiters = [];
function moved() {
  if (!moving) { moving = true; document.body.classList.add("moving"); dropSnapIn?.(); }
  if (lastK !== null && lastK !== pan.k) world.style.willChange = "transform";
  lastK = pan.k;
  clearTimeout(settleT);
  settleT = setTimeout(settle, SETTLE_MS);
}
function settle() {
  moving = false;
  document.body.classList.remove("moving");
  world.style.willChange = "";
  localStorage.setItem(`canvas-view:${NAME}/${PAGE}`, JSON.stringify(pan));
  settleWaiters.splice(0).forEach((r) => r());
  cull(); // what's now in view goes live without waiting for an idle moment
  queueSnaps();
}
// resolves once the view is still (right away if it is)
const still = () => (moving ? new Promise((r) => settleWaiters.push(r)) : Promise.resolve());
// background work runs one piece at a time in idle moments of a still view
const idle = (fn) => (window.requestIdleCallback ? requestIdleCallback(fn, { timeout: 400 }) : setTimeout(fn, 30));
async function quiet() { // an idle moment of a still view
  do { await still(); await new Promise((r) => idle(r)); } while (moving);
}

// ---------- view ----------
function apply() {
  world.style.transform = `translate(${pan.x}px,${pan.y}px) scale(${pan.k})`;
  world.style.setProperty("--inv", 1 / pan.k);
  world.style.setProperty("--k", pan.k);
  document.body.classList.toggle("far", pan.k < 0.2);
  document.body.classList.toggle("farther", pan.k < 0.05);
  $("#zoomPct").textContent = `${Math.round(pan.k * 100)}%`;
  placePop();
  moved();
}
const toWorld = (sx, sy) => ({ x: (sx - pan.x) / pan.k, y: (sy - pan.y) / pan.k });
function zoomAt(k, sx = innerWidth / 2, sy = innerHeight / 2) {
  k = Math.min(4, Math.max(0.03, k));
  pan.x = sx - (sx - pan.x) * (k / pan.k);
  pan.y = sy - (sy - pan.y) * (k / pan.k);
  pan.k = k;
  apply();
}
function fitRect(r, max = 1) {
  const k = Math.min((innerWidth - 160) / r.w, (innerHeight - 180) / r.h, max);
  pan = { k, x: (innerWidth - r.w * k) / 2 - r.x * k, y: (innerHeight - r.h * k) / 2 - r.y * k + 10 };
  apply();
}
function fitAll() {
  const fs = [...frames.values()];
  if (!fs.length) return;
  // section titles sit above their row (y is the title's bottom edge), so count about 100 units above it
  const tops = [...fs.map((f) => f.y), ...SECTIONS.map((sec) => sec.y - 100)];
  const x = Math.min(...fs.map((f) => f.x), ...SECTIONS.map((sec) => sec.x)), y = Math.min(...tops);
  fitRect({ x, y, w: Math.max(...fs.map((f) => f.x + f.w)) - x, h: Math.max(...fs.map((f) => f.y + f.h)) - y });
}
function centerOn(wx, wy, k = Math.min(1.5, Math.max(0.6, pan.k))) {
  pan = { k, x: innerWidth / 2 - wx * k, y: innerHeight / 2 - wy * k };
  apply();
}
