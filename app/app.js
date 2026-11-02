// Canvas viewer: frames are same-origin iframes, so comments can anchor to real DOM elements.
const $ = (s) => document.querySelector(s);
const view = $("#view"), world = $("#world"), framesEl = $("#frames"), pinsEl = $("#pins"), hoverEl = $("#hover"), pop = $("#pop");
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

let NAME = "canvas", ME = "me";
let dirty = new Map(); // file -> unsaved { x, y } and/or { w, h }
let frames = new Map(); // file -> { ...frame, el, iframe }
let threads = [];
let pan = { x: 80, y: 80, k: 0.5 };
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
  renderSections(s.sections);
  renderFrames(s.frames);
  for (const [file, d] of dirty) { const f = frames.get(file); if (!f) dirty.delete(file); else markDirty(f, d); } // drop stale or already-saved entries
  syncBar();
  setThreads(s.threads);
}
async function loadThreads() { setThreads((await api("/_api/state")).threads); }
// Queue state of a thread for Claude: "queued" (sent, not picked up), "working" (claimed by `canvas wait`), or null.
// Mirrors lib/canvas.mjs: a claim older than 30 min counts as abandoned, so the thread is queued again.
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
  const x = Math.min(...fs.map((f) => f.x)), y = Math.min(...fs.map((f) => f.y));
  fitRect({ x, y, w: Math.max(...fs.map((f) => f.x + f.w)) - x, h: Math.max(...fs.map((f) => f.y + f.h)) - y });
}
function centerOn(wx, wy, k = Math.min(1.5, Math.max(0.6, pan.k))) {
  pan = { k, x: innerWidth / 2 - wx * k, y: innerHeight / 2 - wy * k };
  apply();
}

// ---------- sections: group titles on the canvas (canvas.json "sections": [{ title, sub, x, y }]) ----------
function renderSections(list = []) {
  $("#sections").innerHTML = list.map((s) => `<div class="section" style="left:${s.x}px;top:${s.y}px"><div class="st">${esc(s.title)}</div>${s.sub ? `<div class="ss">${esc(s.sub)}</div>` : ""}</div>`).join("");
}

// ---------- frames ----------
function renderFrames(list) {
  const seen = new Set();
  for (const f of list) {
    seen.add(f.file);
    let cur = frames.get(f.file);
    if (!cur) {
      const el = document.createElement("div");
      el.className = "frame";
      el.dataset.file = f.file;
      el.innerHTML = `<div class="label"><span class="title"></span><a href="${src(f.file)}" target="_blank" title="Open in new tab">↗</a><button class="play" title="Play from here (P)"><svg viewBox="0 0 24 24"><path d="M8 5.5v13l10-6.5z"/></svg></button></div>
        <div class="box"><div class="ph"></div><div class="shield"></div></div>
        <div class="grip"></div><div class="size"></div>`;
      framesEl.appendChild(el);
      cur = { el, iframe: null };
      frames.set(f.file, cur);
    }
    cur.base = { x: f.x, y: f.y, w: f.w, h: f.h };
    Object.assign(cur, f, dirty.get(f.file)); // unsaved local moves survive a refresh from disk
    placeFrame(cur);
  }
  for (const [file, cur] of frames) if (!seen.has(file)) { cur.el.remove(); frames.delete(file); }
  scheduleCull();
  queueSnaps();
}

// ---------- snapshots ----------
// Unloaded frames show a static picture: the frame's DOM + CSS serialized into an SVG <foreignObject> image.
// Cheap to paint at any zoom; external images/fonts inside don't load in SVG images, so it's an approximation.
function snap(f, doc) {
  if (!doc?.documentElement) return;
  try {
    const css = [...doc.styleSheets].map((ss) => { try { return [...ss.cssRules].map((r) => r.cssText).join("\n"); } catch { return ""; } }).join("\n");
    const root = doc.documentElement.cloneNode(true);
    root.querySelectorAll("script, link, iframe, video, audio, object, embed").forEach((n) => n.remove());
    root.querySelectorAll("style").forEach((n) => n.remove());
    const style = doc.createElement("style");
    style.textContent = css;
    (root.querySelector("head") || root).appendChild(style);
    const win = doc.defaultView, sy = win?.scrollY || 0;
    if (sy) root.style.marginTop = `${-sy}px`;
    const xhtml = new XMLSerializer().serializeToString(root);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${f.w}" height="${f.h}"><foreignObject x="0" y="0" width="${f.w}" height="${f.h}">${xhtml}</foreignObject></svg>`;
    if (f.snapUrl) URL.revokeObjectURL(f.snapUrl);
    f.snapUrl = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    f.snapStale = false;
    const ph = f.el.querySelector(".ph");
    ph.innerHTML = `<img src="${f.snapUrl}" alt="" draggable="false">`;
    ph.classList.add("has-img");
  } catch (e) { console.warn("snapshot failed", f.file, e); }
}
// one hidden iframe at a time renders frames that have no (or a stale) snapshot
let snapping = false;
function queueSnaps() {
  if (snapping || released || document.hidden) return; // no background work in a hidden tab
  const a = toWorld(innerWidth / 2, innerHeight / 2);
  const next = [...frames.values()].filter((f) => !f.iframe && (!f.snapUrl || f.snapStale))
    .sort((p, q) => Math.hypot(p.x - a.x, p.y - a.y) - Math.hypot(q.x - a.x, q.y - a.y))[0];
  if (!next) return;
  snapping = true;
  const ifr = document.createElement("iframe");
  ifr.className = "snapper";
  Object.assign(ifr.style, { width: `${next.w}px`, height: `${next.h}px` });
  const done = () => { clearTimeout(guard); ifr.remove(); snapping = false; setTimeout(queueSnaps, 30); };
  const guard = setTimeout(() => { next.snapStale = false; done(); }, 8000);
  ifr.addEventListener("load", () => setTimeout(() => { if (!next.iframe) { if (next.scroll) ifr.contentWindow.scrollTo(next.scroll.x, next.scroll.y); snap(next, ifr.contentDocument); } done(); }, 250));
  ifr.src = src(next.file);
  document.body.appendChild(ifr);
}

// ---------- unsaved layout (the save bar in the status pill) ----------
function markDirty(f, fields) {
  const next = { ...dirty.get(f.file), ...fields };
  for (const k of Object.keys(next)) if (next[k] === f.base[k]) delete next[k];
  Object.keys(next).length ? dirty.set(f.file, next) : dirty.delete(f.file);
  syncBar();
}
let savingLayout = false;
function syncBar() {
  storeDirty();
  if (dirty.size) Pill.setBar({ saving: savingLayout, onSave: saveLayout, onDiscard: discardLayout });
  else Pill.clearBar();
}
async function saveLayout() {
  if (!dirty.size || savingLayout) return;
  savingLayout = true; syncBar();
  const sent = new Map(dirty);
  try {
    const r = await fetch(q("/_api/layout"), { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ frames: Object.fromEntries(sent) }) });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
    for (const [file, fields] of sent) {
      const f = frames.get(file);
      if (f) Object.assign(f.base, fields);
      if (JSON.stringify(dirty.get(file)) === JSON.stringify(fields)) dirty.delete(file); // keep moves made while saving
    }
    savingLayout = false; syncBar();
    Pill.toast(dirty.size ? "Some changes saved" : "Layout saved");
  } catch (e) {
    savingLayout = false; syncBar();
    Pill.toast(`Could not save layout${e.message ? `: ${e.message}` : ""}`, "error");
  }
}
function discardLayout() {
  for (const file of dirty.keys()) { const f = frames.get(file); if (f) { Object.assign(f, f.base); placeFrame(f); } }
  dirty.clear();
  syncBar();
  renderPins();
  scheduleCull();
}
// No browser "Leave site?" dialog: unsaved moves are kept per page and come back, with the bar, on the next visit.
const dirtyKey = () => `canvas-dirty:${NAME}/${PAGE}`;
function storeDirty() { dirty.size ? localStorage.setItem(dirtyKey(), JSON.stringify([...dirty])) : localStorage.removeItem(dirtyKey()); }

// ---------- release when hidden ----------
// A canvas tab left hidden (another tab, minimized) for RELEASE_MS gives everything back: live frames close,
// snapshot images are dropped (frames show the stripes) and the snapshot queue stops. Coming back loads only what's
// in view again; snapshots refill from the viewport outwards. An unfocused but visible window is left alone.
const RELEASE_MS = 15000;
let released = false, releaseT = null;
function releaseAll() {
  released = true;
  clearTimeout(cullT);
  document.querySelector(".snapper")?.remove();
  for (const f of frames.values()) {
    unmount(f, false);
    if (f.snapUrl) { URL.revokeObjectURL(f.snapUrl); f.snapUrl = null; }
    const ph = f.el.querySelector(".ph");
    ph.innerHTML = ""; ph.classList.remove("has-img");
  }
  renderPins();
}
document.addEventListener("visibilitychange", () => {
  clearTimeout(releaseT);
  if (document.hidden) { releaseT = setTimeout(releaseAll, RELEASE_MS); return; }
  if (!released) return queueSnaps();
  released = false;
  cull();
  queueSnaps();
});

// ---------- virtualization ----------
// Only frames near the viewport get a live iframe, capped at LIVE (nearest to the center first).
// Frames that leave the viewport are unloaded after HIDE_MS so quick pans don't thrash; their scroll is restored on return.
const LIVE = +new URLSearchParams(location.search).get("live") || 12;
const HIDE_MS = 2500, MARGIN = 0.5, MIN_PX = 48;
let cullT = null;
function scheduleCull() { clearTimeout(cullT); cullT = setTimeout(cull, drag ? 250 : 120); }
function mount(f) {
  if (f.iframe) return;
  const ifr = document.createElement("iframe");
  ifr.src = src(f.file);
  ifr.addEventListener("load", () => onFrameLoad(f));
  f.el.querySelector(".box").insertBefore(ifr, f.el.querySelector(".shield"));
  f.iframe = ifr;
  f.el.classList.add("live");
  f.el.classList.remove("loaded"); // stripes (or the snapshot) stay until the page has loaded
}
function unmount(f, keepSnapshot = true) {
  if (!f.iframe) return;
  try { const w = f.iframe.contentWindow; if (w.scrollX || w.scrollY) f.scroll = { x: w.scrollX, y: w.scrollY }; } catch {}
  clearTimeout(f.snapT);
  if (keepSnapshot) snap(f, docOf(f));
  f.iframe.remove();
  f.iframe = null;
  f.hiddenSince = 0;
  f.el.classList.remove("live", "loaded");
}
function cull() {
  if (released) return;
  const mx = innerWidth * MARGIN / pan.k, my = innerHeight * MARGIN / pan.k;
  const a = toWorld(0, 0), b = toWorld(innerWidth, innerHeight);
  const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2, now = Date.now();
  const wanted = [...frames.values()]
    .filter((f) => f.x < b.x + mx && f.x + f.w > a.x - mx && f.y < b.y + my && f.y + f.h > a.y - my && f.w * pan.k >= MIN_PX)
    .map((f) => ({ f, d: Math.hypot(f.x + f.w / 2 - cx, f.y + f.h / 2 - cy) }))
    .sort((p, q) => p.d - q.d).slice(0, LIVE).map((p) => p.f);
  const keep = new Set(wanted);
  if (openThread) keep.add(frames.get(threads.find((t) => t.id === openThread)?.frame));
  if (draft?.frame) keep.add(frames.get(draft.frame));
  for (const f of keep) if (f) { f.hiddenSince = 0; mount(f); }
  const stale = [...frames.values()].filter((f) => f.iframe && !keep.has(f));
  for (const f of stale) f.hiddenSince ||= now;
  // over budget: drop the longest-hidden at once; otherwise wait out the grace period
  const live = [...frames.values()].filter((f) => f.iframe).length;
  stale.sort((p, q) => p.hiddenSince - q.hiddenSince).forEach((f, i) => {
    if (i < live - (LIVE + 4) || now - f.hiddenSince > HIDE_MS) unmount(f);
  });
  if (stale.some((f) => f.iframe)) { clearTimeout(cullT); cullT = setTimeout(cull, HIDE_MS); }
  renderPins();
}
function placeFrame(f) {
  Object.assign(f.el.style, { left: `${f.x}px`, top: `${f.y}px`, width: `${f.w}px`, height: `${f.h}px` });
  f.el.querySelector(".title").textContent = f.title;
  f.el.querySelector(".title").title = f.title;
  f.el.querySelector(".label").style.maxWidth = `calc(${f.w}px * var(--k))`; // never wider than its frame on screen
  f.el.querySelector(".ph").dataset.t = f.title;
  f.el.querySelector(".size").textContent = `${f.w} × ${f.h}`;
  f.el.classList.toggle("sel", selected === f.file);
}
function onFrameLoad(f) {
  f.el.classList.add("loaded");
  const win = f.iframe.contentWindow;
  if (f.scroll) { win.scrollTo(f.scroll.x, f.scroll.y); f.scroll = null; }
  win.addEventListener("scroll", renderPins, { passive: true });
  // keep the canvas shortcuts working while focus is inside a frame (interact mode)
  win.addEventListener("keydown", (e) => { if (e.key === "Escape") setTool("move"); });
  // a link to another frame flies the canvas there instead of navigating inside this frame
  win.document.addEventListener("click", (e) => {
    const target = frameForHref(e.target.closest?.("a[href]")?.href);
    if (!target) return;
    e.preventDefault();
    select(target.file);
    fitRect(target, 2);
  }, true);
  clearTimeout(f.snapT);
  f.snapT = setTimeout(() => f.iframe && snap(f, docOf(f)), 400);
  renderPins();
}
function reloadFrame(f) {
  if (!f.iframe) { f.snapStale = true; return queueSnaps(); } // unloaded frames load fresh when they come back
  try { const w = f.iframe.contentWindow; f.scroll = { x: w.scrollX, y: w.scrollY }; w.location.reload(); } catch { f.iframe.src = f.iframe.src; }
}
function select(file) {
  selected = file;
  for (const f of frames.values()) f.el.classList.toggle("sel", selected === f.file);
}
const docOf = (f) => { try { return f.iframe?.contentDocument || null; } catch { return null; } };

// ---------- anchors ----------
function cssPath(el, doc) {
  const parts = [];
  while (el && el.nodeType === 1 && el !== doc.body && el !== doc.documentElement) {
    if (el.id && doc.querySelectorAll(`#${CSS.escape(el.id)}`).length === 1) { parts.unshift(`#${CSS.escape(el.id)}`); break; }
    let seg = el.localName;
    const cls = [...el.classList].find((c) => !/^(hover|active|focus|is-|js-)/.test(c));
    if (cls) seg += `.${CSS.escape(cls)}`;
    const same = el.parentElement ? [...el.parentElement.children].filter((c) => c.localName === el.localName) : [];
    if (same.length > 1) seg += `:nth-of-type(${same.indexOf(el) + 1})`;
    parts.unshift(seg);
    el = el.parentElement;
  }
  return parts.join(" > ");
}
const labelOf = (el) => (el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("alt") || el.innerText || el.value || "").trim().replace(/\s+/g, " ").slice(0, 60);

// the components an element sits in, outermost first, with which use of the innermost it is: "templates/app-shell › organisms/sidebar#1"
function dsPath(el, doc) {
  const chain = [];
  for (let n = el.closest("[data-ds]"); n; n = n.parentElement?.closest("[data-ds]")) chain.unshift(n);
  if (!chain.length) return null;
  const inner = chain.at(-1), id = inner.dataset.ds;
  const nth = [...doc.querySelectorAll(`[data-ds="${CSS.escape(id)}"]`)].indexOf(inner) + 1;
  return chain.map((n) => n.dataset.ds).join(" › ") + `#${nth}`;
}

function frameAt(sx, sy) {
  const el = document.elementsFromPoint(sx, sy).find((n) => n.classList?.contains("frame"));
  return el ? frames.get(el.dataset.file) : null;
}
function elementAt(f, wx, wy) {
  const doc = docOf(f);
  if (!doc) return null;
  const el = doc.elementFromPoint(wx - f.x, wy - f.y);
  return el && el !== doc.documentElement ? el : null;
}
function anchorAt(sx, sy) {
  const w = toWorld(sx, sy);
  const f = frameAt(sx, sy);
  if (!f) return { frame: null, x: Math.round(w.x), y: Math.round(w.y) };
  const lx = w.x - f.x, ly = w.y - f.y, win = f.iframe?.contentWindow, doc = docOf(f);
  const el = elementAt(f, w.x, w.y);
  const a = { frame: f.file, x: Math.round(lx + (win?.scrollX || 0)), y: Math.round(ly + (win?.scrollY || 0)) };
  if (el && el !== doc.body) {
    const r = el.getBoundingClientRect();
    const cid = el.getAttribute("data-cid"), same = doc.getElementsByTagName(el.localName);
    Object.assign(a, {
      sel: cid ? `[data-cid="${cid}"]` : cssPath(el, doc), text: labelOf(el),
      ex: +((lx - r.left) / (r.width || 1)).toFixed(3), ey: +((ly - r.top) / (r.height || 1)).toFixed(3),
      // lets the server tag this element in the source with data-cid (a stable anchor), see tagElement()
      anchor: cid ? { cid } : { tag: el.localName, tagIndex: [...same].indexOf(el), tagCount: same.length },
    });
    const ds = dsPath(el, doc);
    if (ds) a.ds = ds;
  }
  return a;
}
// world position of a thread's pin, or null when it's scrolled out of its frame
function pinPos(t) {
  if (!t.frame) return { x: t.x, y: t.y };
  const f = frames.get(t.frame);
  if (!f) return null;
  const doc = docOf(f), win = f.iframe?.contentWindow, sc = win ? { x: win.scrollX, y: win.scrollY } : f.scroll || { x: 0, y: 0 };
  let px = t.x - sc.x, py = t.y - sc.y;
  if (doc && t.sel) {
    let el = null;
    try { el = doc.querySelector(t.sel) || (t.alt && doc.querySelector(t.alt)); } catch {}
    if (el) { const r = el.getBoundingClientRect(); px = r.left + (t.ex ?? 0.5) * r.width; py = r.top + (t.ey ?? 0.5) * r.height; }
  }
  if (px < 0 || py < 0 || px > f.w || py > f.h) return null;
  return { x: f.x + px, y: f.y + py };
}

// ---------- pins ----------
const num = (t) => String(t.id).replace(/^c/, "");
function renderPins() {
  const all = draft ? [...threads, { id: "draft", draft: true, ...draft }] : threads;
  pinsEl.innerHTML = all.map((t) => {
    const p = pinPos(t);
    if (!p) return "";
    const cls = ["pin", t.status === "resolved" && "resolved", openThread === t.id && "active", t.draft && "draft"].filter(Boolean).join(" ");
    return `<div class="${cls}" data-id="${t.id}" style="left:${p.x}px;top:${p.y}px;transform:scale(var(--inv))">${t.draft ? "+" : num(t)}</div>`;
  }).join("");
  placePop();
}

// ---------- popover ----------
function renderPop() {
  const t = draft ? { ...draft, id: "draft", msgs: [], draft: true } : threads.find((x) => x.id === openThread);
  if (!t) { pop.hidden = true; return; }
  const where = [t.frame && frames.get(t.frame)?.title, t.text && `“${t.text}”`].filter(Boolean).join(" › ") || "Canvas";
  // Redraws happen whenever comments or frames change on disk (e.g. Claude replying). If this same thread or draft is
  // already open, keep what the user is typing: text, cursor, focus and the message list's scroll.
  const key = t.draft ? `draft:${t.frame}:${t.x}:${t.y}` : t.id;
  const same = !pop.hidden && pop.dataset.for === key;
  const ta0 = pop.querySelector("textarea"), list0 = pop.querySelector(".msgs");
  const keep = same && ta0 ? { value: ta0.value, start: ta0.selectionStart, end: ta0.selectionEnd, focused: document.activeElement === ta0,
    atBottom: !list0 || list0.scrollTop + list0.clientHeight >= list0.scrollHeight - 4, scroll: list0?.scrollTop || 0 } : null;
  pop.dataset.for = key;
  pop.innerHTML = `<header><span class="t" title="${esc(t.sel || "")}">${t.draft ? "New comment" : `#${num(t)}`} · ${esc(where)}</span>
      ${t.draft ? "" : `<button data-act="status" class="${t.status === "resolved" ? "ok" : ""}" title="${t.status === "resolved" ? "Reopen" : "Resolve"}"><svg viewBox="0 0 24 24"><path d="M5 12l5 5L20 7"/></svg></button>
      <button data-act="delete" title="Delete thread"><svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/></svg></button>`}
      <button data-act="close" title="Close (Esc)"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></header>
    ${t.msgs.length ? `<div class="msgs">${t.msgs.map((m) => `<div class="msg"><div class="by">${esc(m.by)}<span class="at">${esc(m.at)}</span></div><div class="body">${m.claude ? `<span class="mention">@Claude</span> ` : ""}${esc(m.body)}</div></div>`).join("")}</div>` : ""}
    ${!t.draft && queueState(t) ? `<div class="qstate ${queueState(t)}">${queueState(t) === "working" ? `<svg class="spin" viewBox="0 0 24 24"><path d="M21 12a9 9 0 11-6.2-8.6"/></svg>` : ""}${QUEUE_LABEL[queueState(t)]}</div>` : ""}
    <form class="${toClaude ? "to-claude" : ""}"><div class="chip"><span class="mention">@Claude</span></div>
      <textarea rows="1" placeholder="${t.draft ? "Add a comment" : "Reply"}"></textarea>
      <div class="send"><label class="ck"><input type="checkbox" ${toClaude ? "checked" : ""}><span class="box"><svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></span>Send to Claude</label>
      <button disabled title="Send (Enter)"><svg viewBox="0 0 24 24"><path d="M12 19V5M5 12l7-7 7 7"/></svg></button></div></form>`;
  pop.hidden = false;
  const msgs = pop.querySelector(".msgs"), ta = pop.querySelector("textarea");
  if (msgs) msgs.scrollTop = !keep || keep.atBottom ? msgs.scrollHeight : keep.scroll;
  if (keep) {
    ta.value = keep.value;
    ta.style.height = "auto"; ta.style.height = `${ta.scrollHeight}px`;
    pop.querySelector("form button").disabled = !keep.value.trim();
    if (keep.focused) { ta.focus(); ta.setSelectionRange(keep.start, keep.end); }
  }
  placePop();
  if (!keep) requestAnimationFrame(() => pop.querySelector("textarea")?.focus()); // focus only when the box first opens
}
function placePop() {
  if (pop.hidden) return;
  const id = draft ? "draft" : openThread;
  const t = draft || threads.find((x) => x.id === id);
  const p = t && pinPos(t);
  if (!p) return;
  const sx = p.x * pan.k + pan.x, sy = p.y * pan.k + pan.y;
  const r = pop.getBoundingClientRect();
  let left = sx + 36, top = sy - 30;
  const right = $("#panel").hidden ? innerWidth - 10 : $("#panel").getBoundingClientRect().left - 10;
  if (left + r.width > right) left = sx - r.width - 12;
  pop.style.left = `${Math.max(10, left)}px`;
  pop.style.top = `${Math.min(Math.max(10, top), innerHeight - r.height - 70)}px`;
}
function closePop() { draft = null; openThread = null; if (pop.contains(document.activeElement)) document.activeElement.blur(); pop.hidden = true; renderPins(); renderPanel(); }
function openThreadById(id, fly) {
  draft = null; openThread = id;
  const t = threads.find((x) => x.id === id);
  if (fly && t) {
    let p = pinPos(t);
    if (!p && t.frame && frames.get(t.frame)) { // scrolled out of view: bring the element into the frame first
      const f = frames.get(t.frame), doc = docOf(f);
      try { doc?.querySelector(t.sel)?.scrollIntoView({ block: "center" }); } catch { f.iframe?.contentWindow?.scrollTo(0, Math.max(0, t.y - f.h / 2)); }
      p = pinPos(t) || { x: f.x + f.w / 2, y: f.y + f.h / 2 };
    }
    if (p) centerOn(p.x, p.y);
  }
  renderPins(); renderPanel(); renderPop();
}
pop.addEventListener("click", async (e) => {
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (!act) return;
  if (act === "close") return closePop();
  const t = threads.find((x) => x.id === openThread);
  if (act === "status") await api(`/_api/threads/${t.id}/status`, { status: t.status === "resolved" ? "open" : "resolved" });
  if (act === "delete") {
    return openModal({
      title: "Delete thread", confirm: "Delete", danger: true,
      body: `<p>Delete thread <b>#${esc(num(t))}</b> and its ${t.msgs.length} message${t.msgs.length === 1 ? "" : "s"}? This can't be undone.</p>`,
      onConfirm: async () => { await api(`/_api/threads/${t.id}/delete`, {}); openThread = null; await loadThreads(); },
    });
  }
  await loadThreads();
});
pop.addEventListener("change", (e) => {
  if (e.target.type !== "checkbox") return;
  toClaude = e.target.checked;
  localStorage.setItem("canvas-to-claude", toClaude ? "1" : "0");
  pop.querySelector("form").classList.toggle("to-claude", toClaude);
  pop.querySelector("textarea").focus();
});
pop.addEventListener("input", (e) => {
  if (e.target.tagName !== "TEXTAREA") return;
  e.target.style.height = "auto"; e.target.style.height = `${e.target.scrollHeight}px`;
  pop.querySelector("form button").disabled = !e.target.value.trim();
});
pop.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && e.target.tagName === "TEXTAREA") { e.preventDefault(); pop.querySelector("form").requestSubmit(); }
  if (e.key === "Escape") closePop();
  e.stopPropagation();
});
pop.addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = pop.querySelector("textarea").value.trim();
  if (!body) return;
  if (draft) {
    const t = await api("/_api/threads", { ...draft, body, by: ME, claude: toClaude });
    draft = null; openThread = t.id;
  } else await api(`/_api/threads/${openThread}/reply`, { body, by: ME, claude: toClaude });
  pop.querySelector("textarea").value = ""; // sent: the redraw below must not bring it back
  await loadThreads();
});

// ---------- panel ----------
function renderPanel() {
  const open = threads.filter((t) => t.status !== "resolved").length;
  $("#openCount").textContent = open || "";
  document.body.classList.toggle("hide-resolved", $("#panel").hidden || panelFilter !== "resolved");
  if ($("#panel").hidden) return;
  const list = threads.filter((t) => (panelFilter === "resolved") === (t.status === "resolved")).reverse();
  $("#plist").innerHTML = list.length ? list.map((t) => `<div class="pitem${openThread === t.id ? " on" : ""}" data-id="${t.id}">
      <div class="where">#${num(t)} · ${esc([t.frame && frames.get(t.frame)?.title || t.frame, t.text && `“${t.text}”`].filter(Boolean).join(" › ") || "Canvas")}</div>
      <div class="first"><b>${esc(t.msgs[0]?.by)}</b> ${esc(t.msgs[0]?.body)}</div>
      ${queueState(t) ? `<div class="n"><span class="mention ${queueState(t)}">${QUEUE_LABEL[queueState(t)]}</span></div>` : ""}
      ${t.msgs.length > 1 ? `<div class="n">${t.msgs.length - 1} repl${t.msgs.length > 2 ? "ies" : "y"} · last ${esc(t.msgs.at(-1).by)}</div>` : ""}</div>`).join("")
    : `<div class="empty">No ${panelFilter} comments</div>`;
}
$("#panelBtn").addEventListener("click", () => { $("#panel").hidden = !$("#panel").hidden; $("#panelBtn").classList.toggle("on", !$("#panel").hidden); placePop(); renderPanel(); renderPins(); });
$(".ptabs").addEventListener("click", (e) => {
  const b = e.target.closest("[data-f]");
  if (!b) return;
  panelFilter = b.dataset.f;
  document.querySelectorAll(".ptabs button").forEach((x) => x.classList.toggle("on", x === b));
  renderPanel(); renderPins();
});
$("#plist").addEventListener("click", (e) => { const it = e.target.closest(".pitem"); if (it) openThreadById(it.dataset.id, true); });

// ---------- tools ----------
function setTool(t) {
  tool = t;
  document.body.dataset.tool = t;
  document.querySelectorAll("[data-tool]").forEach((b) => b.classList.toggle("on", b.dataset.tool === t));
  if (t !== "comment") hoverEl.classList.remove("on");
  if (t === "interact") select(null);
}
$("#left").addEventListener("click", (e) => { const b = e.target.closest("[data-tool]"); if (b) setTool(b.dataset.tool); });

// ---------- menus ----------
function closeMenus(except) { for (const m of document.querySelectorAll(".menu")) if (m !== except) m.hidden = true; }
function toggleMenu(m) { const open = m.hidden; closeMenus(); m.hidden = !open; return open; }
addEventListener("pointerdown", (e) => { if (!e.target.closest(".menu, #pageBtn, #zoomBtn")) closeMenus(); else if (!e.target.closest("#pageCtx, [data-more]")) $("#pageCtx").hidden = true; }, true);

$("#zoomBtn").addEventListener("click", () => toggleMenu($("#zoomMenu")));
$("#zoomMenu").addEventListener("click", (e) => {
  const z = e.target.closest("[data-z]")?.dataset.z;
  if (!z) return;
  if (z === "in") zoomAt(pan.k * 1.25); else if (z === "out") zoomAt(pan.k / 1.25);
  else if (z === "fit") fitAll(); else if (z === "sel") { if (selected) fitRect(frames.get(selected), 2); }
  else zoomAt(+z);
  closeMenus();
});

const DOTS = `<svg viewBox="0 0 24 24" class="fill"><circle cx="6" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="18" cy="12" r="1.4"/></svg>`;
function renderPageMenu() {
  $("#pageMenu").innerHTML = PAGES.map((pg) => `<div class="row" data-page="${esc(pg.id)}">
      <span class="nm">${esc(pg.name)}</span>
      ${pg.id === PAGE ? `<svg class="check" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>` : ""}
      <button class="more" data-more="${esc(pg.id)}" title="More">${DOTS}</button></div>`).join("")
    + `<hr><button data-new>New page</button>`;
}
async function refreshPages() {
  PAGES = (await api("/_api/state")).pages;
  $("#pageName").textContent = (PAGES.find((x) => x.id === PAGE) || PAGES[0]).name;
  if (!$("#pageMenu").hidden) renderPageMenu();
}
const pageApi = (id, method, body) => fetch(`/_api/pages${id ? `?page=${encodeURIComponent(id)}` : ""}`, { method, headers: { "content-type": "application/json" }, body: body && JSON.stringify(body) })
  .then(async (r) => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || r.statusText); return j; });
$("#pageBtn").addEventListener("click", () => { if (toggleMenu($("#pageMenu"))) renderPageMenu(); });
$("#pageMenu").addEventListener("click", async (e) => {
  const more = e.target.closest("[data-more]");
  if (more) { e.stopPropagation(); return openPageActions(more); }
  if (e.target.closest("[data-new]")) {
    if (dirty.size) return Pill.shake();
    const { id } = await pageApi("", "POST", { name: `Page ${PAGES.length + 1}` });
    closeMenus(); return switchPage(id);
  }
  const row = e.target.closest("[data-page]");
  if (row) { closeMenus(); switchPage(row.dataset.page); }
});

// "…" on a page row: Copy link to page · Rename (modal) · Delete (modal; the root page can't be deleted)
function openPageActions(btn) {
  const id = btn.dataset.more, pg = PAGES.find((x) => x.id === id), m = $("#pageCtx");
  m.innerHTML = `<button data-act="link">Copy link to page</button><button data-act="rename">Rename</button>
    <button data-act="delete" class="danger" ${id === "" ? "disabled title=\"The first page is the canvas folder itself\"" : ""}>Delete</button>`;
  const r = btn.getBoundingClientRect();
  Object.assign(m.style, { left: `${r.right - 8}px`, top: `${r.bottom + 4}px` });
  m.hidden = false;
  m.onclick = async (e) => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (!act) return;
    m.hidden = true;
    closeMenus();
    if (act === "link") {
      const url = `${location.origin}/${id ? `#page=${encodeURIComponent(id)}` : ""}`;
      try { await navigator.clipboard.writeText(url); Pill.toast("Link copied"); } catch { Pill.toast("Could not copy link", "error"); }
    }
    if (act === "rename") { closeMenus(); renamePage(pg); }
    if (act === "delete") { closeMenus(); deletePage(pg); }
  };
}

// ---------- modal ----------
// openModal({ title, body, confirm, danger, init(el), onConfirm(el) → truthy to keep open })
function openModal({ title, body, confirm, danger, init, onConfirm }) {
  const ovl = $("#modal");
  ovl.innerHTML = `<div class="dlg" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <header><h2>${esc(title)}</h2><button class="x" data-m="close" aria-label="Close"><svg viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg></button></header>
      <form><div class="dbody">${body}</div><div class="err" hidden></div>
      <footer><button type="button" class="btn2" data-m="close">Cancel</button><button type="submit" class="btn1${danger ? " danger" : ""}">${esc(confirm)}</button></footer></form></div>`;
  ovl.hidden = false;
  const close = () => { ovl.hidden = true; ovl.innerHTML = ""; removeEventListener("keydown", onKey, true); };
  const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
  addEventListener("keydown", onKey, true);
  ovl.onpointerdown = (e) => { if (e.target === ovl) close(); };
  ovl.onclick = (e) => { if (e.target.closest("[data-m='close']")) close(); };
  ovl.querySelector("form").onsubmit = async (e) => {
    e.preventDefault();
    const btn = ovl.querySelector(".btn1");
    btn.disabled = true;
    try { await onConfirm(ovl); close(); }
    catch (err) { const box = ovl.querySelector(".err"); box.textContent = err.message; box.hidden = false; btn.disabled = false; }
  };
  init?.(ovl);
  (ovl.querySelector("input") || ovl.querySelector(".btn1")).focus();
}
function renamePage(pg) {
  openModal({
    title: "Rename page", confirm: "Rename",
    body: `<input name="name" value="${esc(pg.name)}" spellcheck="false" autocomplete="off">`,
    init: (el) => el.querySelector("input").select(),
    onConfirm: async (el) => {
      const name = el.querySelector("input").value.trim();
      if (!name) throw new Error("Give the page a name");
      if (name !== pg.name) { await pageApi(pg.id, "PUT", { name }); await refreshPages(); }
    },
  });
}
function deletePage(pg) {
  openModal({
    title: "Delete page", confirm: "Delete", danger: true,
    body: `<p>Delete <b>${esc(pg.name)}</b>? Its folder moves to <code>.trash/</code> in the canvas, so you can still recover it.</p>`,
    onConfirm: async () => {
      if (pg.id === PAGE && dirty.size) throw new Error("Save or discard this page's layout changes first");
      await pageApi(pg.id, "DELETE");
      if (pg.id === PAGE) await switchPage("");
      await refreshPages();
      Pill.toast("Page deleted");
    },
  });
}

async function switchPage(id) {
  if (id === PAGE && frames.size) return;
  if (dirty.size) return Pill.shake(); // a blocked leave shakes the bar instead of asking
  closePop();
  for (const f of frames.values()) { if (f.snapUrl) URL.revokeObjectURL(f.snapUrl); f.el.remove(); }
  frames = new Map(); threads = []; selected = null;
  PAGE = id;
  history.replaceState(null, "", id ? `#page=${encodeURIComponent(id)}` : location.pathname);
  await loadState();
  restoreView();
}
function restoreView() {
  const saved = localStorage.getItem(`canvas-view:${NAME}/${PAGE}`);
  if (saved) { pan = JSON.parse(saved); apply(); } else if (frames.size) fitAll(); else { pan = { x: innerWidth / 2, y: innerHeight / 2, k: 1 }; apply(); }
}

// ---------- present ----------
let presenting = -1;
const order = () => [...frames.values()].sort((a, b) => (Math.abs(a.y - b.y) > 200 ? a.y - b.y : a.x - b.x));
function present(i) {
  const list = order();
  if (!list.length) return;
  if (i === undefined) {
    const c = toWorld(innerWidth / 2, innerHeight / 2);
    i = selected ? list.findIndex((f) => f.file === selected) : list.map((f, j) => [Math.hypot(f.x + f.w / 2 - c.x, f.y + f.h / 2 - c.y), j]).sort((a, b) => a[0] - b[0])[0][1];
  }
  presenting = (i + list.length) % list.length;
  const f = list[presenting], ifr = $("#present iframe");
  const k = Math.min((innerWidth - 48) / f.w, (innerHeight - 96) / f.h, 1);
  Object.assign(ifr.style, { width: `${f.w}px`, height: `${f.h}px`, transform: `translate(-50%, -50%) scale(${k})` });
  if (ifr.dataset.file !== f.file) { ifr.dataset.file = f.file; ifr.src = src(f.file); }
  $("#pTitle").textContent = `${f.title} · ${presenting + 1}/${list.length}`;
  $("#present").hidden = false;
}
function stopPresent() { presenting = -1; $("#present").hidden = true; const ifr = $("#present iframe"); ifr.src = "about:blank"; ifr.dataset.file = ""; }
$("#presentBtn").addEventListener("click", () => present());
framesEl.addEventListener("click", (e) => {
  const b = e.target.closest(".label .play");
  if (!b) return;
  const f = frames.get(b.closest(".frame").dataset.file);
  present(order().indexOf(f));
});
$("#present .bar").addEventListener("click", (e) => {
  const a = e.target.closest("[data-p]")?.dataset.p;
  if (a === "prev") present(presenting - 1); if (a === "next") present(presenting + 1); if (a === "close") stopPresent();
});
$("#present iframe").addEventListener("load", (e) => {
  try {
    const win = e.target.contentWindow;
    win.addEventListener("keydown", presentKeys);
    // links between frames play like a prototype: follow them, then sync size, title and position
    const f = frameForHref(win.location.href);
    const list = order(), i = f ? list.indexOf(f) : -1;
    if (i >= 0 && i !== presenting) { e.target.dataset.file = f.file; present(i); }
  } catch {}
});
// a URL inside the canvas → the frame on this page it shows (or null)
function frameForHref(href) {
  if (!href) return null;
  try {
    const u = new URL(href, location.href);
    if (u.origin !== location.origin) return null;
    const p = decodeURIComponent(u.pathname).replace(/^\//, "");
    const file = PAGE ? (p.startsWith(`${PAGE}/`) ? p.slice(PAGE.length + 1) : null) : p;
    return (file && frames.get(file)) || null;
  } catch { return null; }
}
function presentKeys(e) {
  if (presenting < 0) return false;
  if (e.key === "Escape") stopPresent();
  else if (e.key === "ArrowRight" || e.key === "PageDown") present(presenting + 1);
  else if (e.key === "ArrowLeft" || e.key === "PageUp") present(presenting - 1);
  else return true;
  e.preventDefault();
  return true;
}

// ---------- pointer ----------
let drag = null;
view.addEventListener("pointerdown", (e) => {
  if (e.target.closest(".pin, .label .play")) return;
  const frameEl = e.target.closest(".frame");
  const panMode = e.button === 1 || spaceDown || tool === "hand" || (tool === "move" && !frameEl) || (tool === "interact" && !frameEl);
  if (panMode) {
    drag = { kind: "pan", sx: e.clientX, sy: e.clientY, px: pan.x, py: pan.y };
    if (tool === "move" && !frameEl) select(null);
  } else if (tool === "move" && frameEl) {
    const f = frames.get(frameEl.dataset.file);
    select(f.file);
    drag = { kind: e.target.classList.contains("grip") ? "resize" : "move", f, sx: e.clientX, sy: e.clientY, x: f.x, y: f.y, w: f.w, h: f.h };
  } else if (tool === "comment") {
    if (openThread || draft) { closePop(); return; }
    e.preventDefault();
    draft = anchorAt(e.clientX, e.clientY);
    openThread = null;
    renderPins(); renderPop();
    return;
  } else return;
  view.setPointerCapture(e.pointerId);
  document.body.classList.add("panning");
  e.preventDefault();
});
view.addEventListener("pointermove", (e) => {
  if (drag) {
    const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
    if (drag.kind === "pan") { pan.x = drag.px + dx; pan.y = drag.py + dy; apply(); }
    else if (drag.kind === "move") { drag.f.x = Math.round(drag.x + dx / pan.k); drag.f.y = Math.round(drag.y + dy / pan.k); placeFrame(drag.f); renderPins(); }
    else { drag.f.w = Math.max(120, Math.round(drag.w + dx / pan.k)); drag.f.h = Math.max(120, Math.round(drag.h + dy / pan.k)); placeFrame(drag.f); renderPins(); }
    return;
  }
  if (tool !== "comment") return;
  const f = frameAt(e.clientX, e.clientY);
  const w = toWorld(e.clientX, e.clientY);
  const el = f && elementAt(f, w.x, w.y);
  if (!el || el === docOf(f).body) return hoverEl.classList.remove("on");
  const r = el.getBoundingClientRect();
  Object.assign(hoverEl.style, { left: `${f.x + r.left}px`, top: `${f.y + r.top}px`, width: `${r.width}px`, height: `${r.height}px`, outlineWidth: `${1.5 / pan.k}px` });
  hoverEl.dataset.ds = el.closest("[data-ds]")?.dataset.ds || "";
  hoverEl.classList.add("on");
});
view.addEventListener("pointerup", () => {
  if (drag?.moved && drag.f) {
    const { file, x, y, w, h } = drag.f;
    markDirty(drag.f, drag.kind === "resize" ? { w, h } : { x, y });
  }
  drag = null;
  document.body.classList.remove("panning");
});
view.addEventListener("dblclick", (e) => {
  const fe = e.target.closest(".frame");
  if (fe && tool === "move") { const f = frames.get(fe.dataset.file); fitRect(f, 2); }
});
pinsEl.addEventListener("pointerdown", (e) => {
  const p = e.target.closest(".pin");
  if (!p || p.dataset.id === "draft") return;
  e.stopPropagation();
  openThread === p.dataset.id ? closePop() : openThreadById(p.dataset.id);
});
view.addEventListener("wheel", (e) => {
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) zoomAt(pan.k * Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.01)), e.clientX, e.clientY);
  else { const m = e.deltaMode ? 20 : 1; pan.x -= (e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX) * m; pan.y -= (e.shiftKey && !e.deltaX ? 0 : e.deltaY) * m; apply(); }
}, { passive: false });

// ---------- keys ----------
addEventListener("keydown", (e) => {
  if (!$("#modal").hidden) return; // the modal owns the keyboard
  if (presentKeys(e)) return;
  if (e.target.matches?.("textarea, input")) return;
  if (e.code === "Space" && !spaceDown) { spaceDown = true; document.body.classList.add("space"); e.preventDefault(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); return saveLayout(); }
  if (e.ctrlKey || e.metaKey) { if (e.key === "=" || e.key === "+") { e.preventDefault(); zoomAt(pan.k * 1.25); } if (e.key === "-") { e.preventDefault(); zoomAt(pan.k / 1.25); } if (e.key === "0") { e.preventDefault(); zoomAt(1); } return; }
  const k = e.key.toLowerCase();
  if (e.shiftKey && e.code === "Digit1") return fitAll();
  if (e.shiftKey && e.code === "Digit0") return zoomAt(1);
  if (e.shiftKey && e.code === "Digit2" && selected) return fitRect(frames.get(selected), 2);
  if (k === "v") setTool("move");
  else if (k === "h") setTool("hand");
  else if (k === "c") setTool("comment");
  else if (k === "i") setTool("interact");
  else if (k === "p") present();
  else if (k === "+" || k === "=") zoomAt(pan.k * 1.25);
  else if (k === "-") zoomAt(pan.k / 1.25);
  else if (k === "escape") { if (![...document.querySelectorAll(".menu")].every((m) => m.hidden)) closeMenus(); else if (draft || openThread) closePop(); else if (tool !== "move") setTool("move"); else select(null); }
  else if (selected && k.startsWith("arrow")) {
    const f = frames.get(selected), d = e.shiftKey ? 10 : 1;
    if (k === "arrowleft") f.x -= d; if (k === "arrowright") f.x += d; if (k === "arrowup") f.y -= d; if (k === "arrowdown") f.y += d;
    placeFrame(f); renderPins(); e.preventDefault();
    markDirty(f, { x: f.x, y: f.y });
  }
});
addEventListener("keyup", (e) => { if (e.code === "Space") { spaceDown = false; document.body.classList.remove("space"); } });
addEventListener("resize", () => { placePop(); if (presenting >= 0) present(presenting); });

// ---------- live reload ----------
function connect() {
  const es = new EventSource("/_api/events");
  es.onopen = () => ($("#status").textContent = "");
  es.onerror = () => ($("#status").textContent = "disconnected — is `canvas` still running?");
  es.onmessage = async (m) => {
    const ev = JSON.parse(m.data);
    if (ev.type === "app") return location.reload(); // the canvas app itself was updated (unsaved moves survive: they're stored)
    const all = ev.files;
    const pageIds = new Set(PAGES.map((x) => x.id).filter(Boolean));
    const mine = (f) => PAGE ? f.startsWith(`${PAGE}/`) : !pageIds.has(f.split("/")[0]);
    const files = all.filter(mine).map((f) => (PAGE ? f.slice(PAGE.length + 1) : f));
    if (all.some((f) => !mine(f) && /(\.html|canvas\.json)$/.test(f)) || files.some((f) => f.includes("/") && /(\.html|canvas\.json)$/.test(f))) refreshPages();
    const top = files.filter((f) => !f.includes("/"));
    if (top.includes("comments.json")) await loadThreads();
    const html = top.filter((f) => f.endsWith(".html"));
    if (html.length || top.includes("canvas.json")) await loadState();
    for (const f of html) if (frames.has(f)) reloadFrame(frames.get(f));
    // shared assets (css, js, images, nested files) can affect every frame
    if (files.some((f) => !f.endsWith(".json") && !(f.endsWith(".html") && !f.includes("/")))) for (const f of frames.values()) reloadFrame(f);
  };
}

// ---------- boot ----------
(async () => {
  setTool("move");
  ME = (await api("/_api/me")).name;
  try { await loadState(); } catch { PAGE = ""; history.replaceState(null, "", location.pathname); await loadState(); }
  restoreView();
  connect();
})();
