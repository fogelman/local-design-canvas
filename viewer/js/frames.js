// Frames: section titles, live iframes, snapshots, unsaved layout, release-when-hidden and virtualization.
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
