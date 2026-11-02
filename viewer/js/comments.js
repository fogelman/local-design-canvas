// Comments: element anchors (data-cid, components), pins, the thread popover and the comments panel.
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
  if (!draft && panelFilter === "resolved") { // replying reopened the thread: follow it to the Open tab
    panelFilter = "open";
    document.querySelectorAll(".ptabs button").forEach((x) => x.classList.toggle("on", x.dataset.f === "open"));
  }
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
