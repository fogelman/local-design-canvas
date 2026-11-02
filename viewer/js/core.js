// State, API calls, the comment queue states and the pan/zoom view.
const $ = (s) => document.querySelector(s);
const view = $("#view"), world = $("#world"), framesEl = $("#frames"), pinsEl = $("#pins"), hoverEl = $("#hover"), pop = $("#pop");
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

let NAME = "canvas", ME = "me";
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
const api = (p, body, method = "POST") => fetch(p.startsWith("/_api/") && p !== "/_api/me" ? q(p) : p, body === undefined ? undefined : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());

async function loadState() {
  const s = await api("/_api/state");
  NAME = s.name;
  PAGES = s.pages;
  if (!dirty.size) { try { dirty = new Map(JSON.parse(localStorage.getItem(dirtyKey())) || []); } catch { dirty = new Map(); } }
  const pg = PAGES.find((x) => x.id === PAGE) || PAGES[0];
  document.title = `${pg.name} · ${s.name}`;
  $("#pageName").textContent = pg.name;
  SECTIONS = s.sections || [];
  renderSections(SECTIONS);
  renderFrames(s.frames);
  for (const [file, d] of dirty) { const f = frames.get(file); if (!f) dirty.delete(file); else markDirty(f, d); } // drop stale or already-saved entries
  syncBar();
  setThreads(s.threads);
}
async function loadThreads() { setThreads((await api("/_api/state")).threads); }
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

// ---------- view ----------
function apply() {
  world.style.transform = `translate(${pan.x}px,${pan.y}px) scale(${pan.k})`;
  world.style.setProperty("--inv", 1 / pan.k);
  world.style.setProperty("--k", pan.k);
  document.body.classList.toggle("far", pan.k < 0.2);
  document.body.classList.toggle("farther", pan.k < 0.05);
  $("#zoomPct").textContent = `${Math.round(pan.k * 100)}%`;
  placePop();
  scheduleCull();
  localStorage.setItem(`canvas-view:${NAME}/${PAGE}`, JSON.stringify(pan));
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
