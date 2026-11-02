// Status pill: one pill, top centre:
// it shows the save bar ("Unsaved changes · Discard · Save"), turns into the toast its save raises
// (its width easing from one to the other), goes red on failure, rises out when it closes,
// and shakes when a leave is blocked while the bar is open.
const Pill = (() => {
  const TOAST_MS = 4000, SAVE_SETTLE_MS = 1000, HOLD_MS = 1500, MORPH_MS = 250, LEAVE_MS = 200, SHAKE_MS = 700;
  const SHAKE = [0, -14, 14, -14, 14, -14, 14, -14, 8, -4, 0].map((x) => ({ transform: `translateX(${x}px)` }));
  const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  const X = `<svg viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg>`;
  const SPIN = `<svg class="spin" viewBox="0 0 24 24"><path d="M21 12a9 9 0 11-6.2-8.6"/></svg>`;
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  const host = document.createElement("div");
  host.className = "spill-host";
  document.body.appendChild(host);

  let bar = null, held = null, heldT = null, lastSaving = 0;
  let toast = null, toastT = null, seq = 0;
  let surface = null, key = null;

  function barHTML(b) {
    return `<div class="spill-bar"><span class="spill-t">${esc(b.label || "Unsaved changes")}</span>
      <button type="button" class="spill-sec" data-a="discard" ${b.saving ? "disabled" : ""}>${esc(b.discardLabel || "Discard")}</button>
      ${b.saving ? `<button type="button" class="spill-pri" disabled>${SPIN}Please wait</button>` : `<button type="button" class="spill-pri" data-a="save">Save</button>`}</div>`;
  }
  function toastHTML(t) {
    return `<div class="spill-toast">${t.type === "loading" ? SPIN : ""}<span>${esc(t.text)}</span>
      <button type="button" class="spill-x" data-a="dismiss" aria-label="Dismiss">${X}</button></div>`;
  }

  function render() {
    let view = null;
    if (toast) view = { key: `toast:${toast.id}:${toast.type}`, html: toastHTML(toast), failed: toast.type === "error", role: toast.type === "error" ? "alert" : "status" };
    else if (bar) view = { key: "bar", html: barHTML(bar) };
    else if (held) view = { key: "bar", html: barHTML(held) };

    if (!view) {
      if (!surface) return;
      const leaving = surface; // what left stays a moment, rising out
      surface = null; key = null;
      leaving.classList.add("leaving");
      setTimeout(() => leaving.remove(), LEAVE_MS);
      return;
    }
    if (!surface) {
      surface = document.createElement("div");
      surface.className = "spill";
      surface.addEventListener("click", onClick);
      host.appendChild(surface);
    }
    surface.classList.toggle("failed", !!view.failed);
    view.role ? surface.setAttribute("role", view.role) : surface.removeAttribute("role");
    const previous = key === null ? null : surface.offsetWidth;
    const changed = key !== view.key;
    surface.innerHTML = `<div class="spill-c${changed ? " fade" : ""}">${view.html}</div>`;
    key = view.key;
    const next = surface.offsetWidth;
    if (changed && previous !== null && previous !== next && !reduced()) {
      surface.animate([{ width: `${previous}px` }, { width: `${next}px` }], { duration: MORPH_MS, easing: "cubic-bezier(0.2, 0.8, 0, 1)" });
    }
  }

  function onClick(e) {
    const a = e.target.closest("[data-a]")?.dataset.a;
    if (a === "dismiss") return dismiss();
    const b = bar || held;
    if (a === "save") b?.onSave?.();
    if (a === "discard") b?.onDiscard?.();
  }

  /** Open or update the save bar: { saving, onSave, onDiscard, label?, discardLabel? }. */
  function setBar(next) {
    if (next.saving) lastSaving = Date.now();
    bar = next;
    held = null; clearTimeout(heldT);
    render();
  }
  /** Close the bar. Closed by its own save, it's held a moment for the save's toast to turn it into. */
  function clearBar() {
    if (!bar) return;
    const last = bar;
    bar = null;
    if (last.saving || Date.now() - lastSaving < SAVE_SETTLE_MS) {
      held = { ...last, saving: true };
      clearTimeout(heldT);
      heldT = setTimeout(() => { held = null; render(); }, HOLD_MS);
    }
    render();
  }
  /** One toast at a time; a newer one replaces it. type: "success" | "error" | "loading". */
  function show(text, type = "success", ms = TOAST_MS) {
    toast = { id: ++seq, text, type };
    held = null; clearTimeout(heldT);
    clearTimeout(toastT);
    if (type !== "loading" && ms !== Infinity) toastT = setTimeout(dismiss, ms);
    render();
  }
  function dismiss() { toast = null; clearTimeout(toastT); render(); }
  /** The nudge on a blocked leave while the bar is open. */
  function shake() {
    if (!surface || reduced()) return;
    for (const a of surface.getAnimations()) a.cancel();
    surface.animate(SHAKE, { duration: SHAKE_MS, easing: "ease-in-out" });
  }

  return { setBar, clearBar, toast: show, dismiss, shake, get open() { return !!bar; } };
})();
