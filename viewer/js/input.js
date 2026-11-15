// Pointer and keyboard input, and live reload from the server.
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
  mouse = { x: e.clientX, y: e.clientY };
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
  if (f && !f.iframe && !(f.zones && f.snapUrl)) focusFrame(f); // nothing recorded for it yet: load the page
  const w = toWorld(e.clientX, e.clientY);
  const hit = f && hitAt(f, w.x, w.y);
  if (!hit) return hoverEl.classList.remove("on");
  const r = hit.rect;
  Object.assign(hoverEl.style, { left: `${f.x + r.left}px`, top: `${f.y + r.top}px`, width: `${r.width}px`, height: `${r.height}px`, outlineWidth: `${1.5 / pan.k}px` });
  hoverEl.dataset.ds = hit.dsId;
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
// The zoom a Ctrl/⌘ + wheel step asks for. A trackpad pinch sends many small steps and follows the fingers; a mouse
// wheel notch is one big step (100 px or 3 lines), capped so each notch zooms about 1.2× and in/out mirror each other.
function wheelZoom(e) {
  const dy = e.deltaMode ? e.deltaY * 20 : e.deltaY;
  return pan.k * Math.exp(-Math.max(-20, Math.min(20, dy)) * 0.01);
}
view.addEventListener("wheel", (e) => {
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) zoomAt(wheelZoom(e), e.clientX, e.clientY);
  else { const m = e.deltaMode ? 20 : 1; pan.x -= (e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX) * m; pan.y -= (e.shiftKey && !e.deltaX ? 0 : e.deltaY) * m; apply(); }
}, { passive: false });
// Ctrl/⌘ + wheel (and a trackpad pinch) anywhere else, such as the comment box, the panel or the toolbars, would
// zoom the browser tab around its corner instead of the canvas at the pointer: zoom the canvas there too.
addEventListener("wheel", (e) => {
  if (!(e.ctrlKey || e.metaKey) || view.contains(e.target)) return;
  e.preventDefault();
  if ($("#modal").hidden && presenting < 0) zoomAt(wheelZoom(e), e.clientX, e.clientY);
}, { passive: false });
// the same from inside a live screen (interact mode): its point, mapped to the window
function zoomFromFrame(f, e) {
  if (!(e.ctrlKey || e.metaKey)) return;
  e.preventDefault();
  mouseInFrame(f, e);
  zoomAt(wheelZoom(e), mouse.x, mouse.y);
}
// the mouse over a live screen (interact mode), in window px
function mouseInFrame(f, e) {
  const r = f.el.querySelector(".box").getBoundingClientRect();
  mouse = { x: r.left + e.clientX * pan.k, y: r.top + e.clientY * pan.k };
}

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
  else if (k === "r" && (stale.size || staleApp)) applyStale();
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
// A screen loading (live, or hidden for its picture) can take the focus by itself: an autofocus field, a script.
// Outside interact mode the keys belong to the canvas, so the focus goes back where it was (the comment box, say).
let lastFocus = null;
document.addEventListener("focusin", (e) => { if (e.target.localName !== "iframe") lastFocus = e.target; });
addEventListener("blur", () => setTimeout(() => {
  const a = document.activeElement;
  if (a?.localName !== "iframe" || tool === "interact" || presenting >= 0) return;
  a.blur();
  if (lastFocus?.isConnected) lastFocus.focus({ preventScroll: true }); else window.focus();
}));
addEventListener("resize", () => { placePop(); if (presenting >= 0) present(presenting); });

// ---------- live reload ----------
function connect() {
  const es = new EventSource("/_api/events");
  let lost = false; // changes made while disconnected weren't announced: on reconnecting, re-read everything
  es.onopen = () => { $("#status").textContent = ""; if (lost) { lost = false; inlined.clear(); loadState(); } };
  es.onerror = () => { lost = true; $("#status").textContent = "disconnected — is `canvas` still running?"; };
  es.onmessage = async (m) => {
    const ev = JSON.parse(m.data);
    if (ev.type === "app") { // the canvas app itself was updated (unsaved moves survive: they're stored)
      if (busy()) { staleApp = true; return renderStale(); }
      return location.reload();
    }
    const all = ev.files;
    if (all.some((f) => !f.endsWith(".json"))) inlined.clear(); // files inlined into snapshots may have changed
    const pageIds = new Set(PAGES.map((x) => x.id).filter(Boolean));
    const mine = (f) => PAGE ? f.startsWith(`${PAGE}/`) : !pageIds.has(f.split("/")[0]);
    const files = all.filter(mine).map((f) => (PAGE ? f.slice(PAGE.length + 1) : f));
    if (all.some((f) => !mine(f) && /(\.html|canvas\.json)$/.test(f)) || files.some((f) => f.includes("/") && /(\.html|canvas\.json)$/.test(f))) refreshPages();
    const top = files.filter((f) => !f.includes("/"));
    if (top.includes("comments.json")) await loadThreads();
    // Anything else can change how screens look (a screen, a stylesheet, an image, data, a component). The state's
    // versions say which screens: re-keying them drops their pictures and reloads the live ones (see rekey).
    if (all.some((f) => !/(^|\/)comments\.json$/.test(f))) await loadState();
  };
}
