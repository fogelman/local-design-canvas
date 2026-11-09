// Toolbar, page and zoom menus, modals and present mode.
// ---------- tools ----------
function setTool(t) {
  tool = t;
  document.body.dataset.tool = t;
  document.querySelectorAll("[data-tool]").forEach((b) => b.classList.toggle("on", b.dataset.tool === t));
  if (t !== "comment") hoverEl.classList.remove("on");
  if (t === "interact") select(null);
  scheduleCull(); // interacting needs live screens even zoomed out
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
  const m = $("#pageMenu");
  m.innerHTML = `<div class="pages">` + PAGES.map((pg) => `<div class="row" data-page="${esc(pg.id)}">
      <span class="nm">${esc(pg.name)}</span>
      ${pg.id === PAGE ? `<svg class="check" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>` : ""}
      <button class="more" data-more="${esc(pg.id)}" title="More">${DOTS}</button></div>`).join("")
    + `</div><hr><button data-new>New page</button>`;
  const list = m.querySelector(".pages");
  list.onscroll = () => { $("#pageCtx").hidden = true; }; // its "…" menu is placed on the row, so it would float off it
  m.querySelector(".row .check")?.closest(".row").scrollIntoView({ block: "nearest" });
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
  if (m.getBoundingClientRect().bottom > innerHeight - 10) m.style.top = `${Math.max(10, r.top - 4 - m.offsetHeight)}px`; // near the bottom: open above the row
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
