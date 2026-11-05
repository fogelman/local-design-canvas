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

// Zones: where each element of a page sits, with the anchor a comment on it gets (as anchorAt() builds it from the
// live page). Recorded with a screen's picture, so comment mode outlines elements and attaches comments on a
// picture without loading the page. Built in one pass that carries paths, components, clipping and layers down.
// Hit-testing follows the browser's: clipped by overflow, positioned elements over in-flow ones, inline elements
// by their line boxes, an icon as its <svg>.
function zonesOf(doc) {
  const body = doc.body, win = doc.defaultView;
  if (!body) return [];
  const ids = new Map(), tagIdx = new Map(), tagCount = new Map(), sib = new Map();
  for (const el of doc.querySelectorAll("[id]")) ids.set(el.id, (ids.get(el.id) || 0) + 1);
  for (const el of doc.getElementsByTagName("*")) { const n = tagCount.get(el.localName) || 0; tagIdx.set(el, n); tagCount.set(el.localName, n + 1); }
  const typeOf = (el) => { // [position among same-tag siblings, how many]
    const parent = el.parentElement;
    if (!sib.has(parent)) {
      const m = new Map(), counts = new Map();
      for (const c of parent.children) { const n = counts.get(c.localName) || 0; m.set(c, n); counts.set(c.localName, n + 1); }
      for (const c of parent.children) m.set(c, [m.get(c), counts.get(c.localName)]);
      sib.set(parent, m);
    }
    return sib.get(parent).get(el);
  };
  const cut = (a, b) => { const l = Math.max(a[0], b[0]), t = Math.max(a[1], b[1]), r = Math.min(a[0] + a[2], b[0] + b[2]), bt = Math.min(a[1] + a[3], b[1] + b[3]); return r > l && bt > t ? [l, t, r - l, bt - t] : null; };
  const round = (r) => r.map((v) => Math.round(v * 10) / 10);
  const all = [-1e6, -1e6, 2e6, 2e6];
  const info = new Map([[body, { path: "", ds: "", nth: 0, dsId: "", clip: all, layer: 0, zi: -1 }]]), dsCount = new Map(), zones = [];
  let order = 0;
  for (const el of body.querySelectorAll("*")) {
    const p = info.get(el.parentElement);
    if (!p) continue; // inside an <svg> icon or skipped content: the icon (or the parent) is the target
    let path;
    if (el.id && ids.get(el.id) === 1) path = `#${CSS.escape(el.id)}`;
    else {
      let seg = el.localName;
      const cls = [...el.classList].find((c) => !/^(hover|active|focus|is-|js-)/.test(c));
      if (cls) seg += `.${CSS.escape(cls)}`;
      const [i, n] = typeOf(el);
      if (n > 1) seg += `:nth-of-type(${i + 1})`;
      path = p.path ? `${p.path} > ${seg}` : seg;
    }
    let { ds, nth } = p;
    const id = el.getAttribute("data-ds");
    if (id) { nth = (dsCount.get(id) || 0) + 1; dsCount.set(id, nth); ds = ds ? `${ds} › ${id}` : id; }
    const cs = win.getComputedStyle(el);
    const box = el.getBoundingClientRect(), rect = [box.left, box.top, box.width, box.height];
    const positioned = cs.position !== "static", z = parseInt(cs.zIndex, 10);
    // positioned elements paint over in-flow ones; a z-index lifts (or sinks) the element and what's inside it
    const layer = positioned ? (Number.isNaN(z) ? Math.max(p.layer, 0) + 0.5 : z + 0.5) : p.layer;
    const clips = cs.overflowX !== "visible" || cs.overflowY !== "visible";
    const clip = cs.position === "fixed" ? all : p.clip;
    const me = { path, ds, nth, dsId: id || p.dsId, clip: clips ? cut(clip, rect) || [0, 0, 0, 0] : clip, layer, zi: p.zi };
    if (el.localName !== "svg") info.set(el, me); // an icon's insides aren't targets of their own
    if (cs.display === "contents") continue;
    let hit = cut(rect, clip);
    if (!hit || hit[2] < 1 || hit[3] < 1 || cs.visibility !== "visible" || cs.pointerEvents === "none") continue;
    // inline: hit by its line boxes, which are as tall as the line, not the text
    let rects = null;
    if (cs.display === "inline") {
      const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2;
      rects = [...el.getClientRects()].map((r) => cut([r.left, r.top - Math.max(0, (lh - r.height) / 2), r.width, Math.max(r.height, lh)], clip)).filter(Boolean).map(round);
      if (!rects.length) continue;
    }
    const cid = el.getAttribute("data-cid");
    const radii = ["borderTopLeftRadius", "borderTopRightRadius", "borderBottomRightRadius", "borderBottomLeftRadius"].map((k) => parseFloat(cs[k]) || 0);
    zones.push({
      r: round(hit), ...(rects && { rs: rects }), ...(!rects && radii.some(Boolean) && { b: rect.map((v) => Math.round(v * 10) / 10), br: radii }), l: layer, o: order++,
      sel: cid ? `[data-cid="${cid}"]` : path, text: labelOf(el),
      anchor: cid ? { cid } : { tag: el.localName, tagIndex: tagIdx.get(el), tagCount: tagCount.get(el.localName) },
      ds: ds ? `${ds}#${nth}` : null, dsId: me.dsId || "",
      p: p.zi, // the zone of the closest ancestor that has one
    });
    me.zi = zones.length - 1;
  }
  return zones;
}
// inside its box (or line boxes), and not in a rounded corner's cut-out
function inZone(z, x, y) {
  if (!(z.rs || [z.r]).some(([zx, zy, w, h]) => x >= zx && y >= zy && x < zx + w && y < zy + h)) return false;
  if (!z.br) return true;
  const [bx, by, bw, bh] = z.b, corners = [[bx, by, 1, 1], [bx + bw, by, -1, 1], [bx + bw, by + bh, -1, -1], [bx, by + bh, 1, -1]];
  return corners.every(([cx, cy, sx, sy], i) => {
    const r = Math.min(z.br[i], bw / 2, bh / 2), dx = (x - cx) * sx, dy = (y - cy) * sy;
    return !(r && dx < r && dy < r) || (r - dx) ** 2 + (r - dy) ** 2 <= r * r;
  });
}
// the zone on top at a point: highest layer, then latest in the page
function zoneAt(zones, x, y) {
  let best = null;
  for (const z of zones) if (inZone(z, x, y) && (!best || z.l > best.l || (z.l === best.l && z.o > best.o))) best = z;
  return best;
}
// What the mouse is over in a frame: the live page's element once it's showing, else the picture's zone.
// { rect (frame px), dsId, el? (live), zone? (picture) }, or null over nothing / the page background.
// Something too small to aim at on screen at this zoom (an icon seen from far) gives way to the closest
// enclosing element that's big enough; zoomed in, it's exactly what's under the mouse. Live and picture alike.
const MIN_TARGET_PX = 8;
const tooSmall = (w, h) => Math.min(w, h) * pan.k < MIN_TARGET_PX;
function hitAt(f, wx, wy) {
  const lx = wx - f.x, ly = wy - f.y;
  if (f.el.classList.contains("loaded")) {
    const doc = docOf(f);
    let el = elementAt(f, wx, wy);
    if (!el || el === doc.body) return null;
    let r = el.getBoundingClientRect();
    while (tooSmall(r.width, r.height) && el.parentElement && el.parentElement !== doc.body) { el = el.parentElement; r = el.getBoundingClientRect(); }
    return { rect: r, dsId: el.closest("[data-ds]")?.dataset.ds || "", el };
  }
  if (!f.zones || !f.snapUrl) return null;
  let z = zoneAt(f.zones, lx, ly);
  if (!z) return null;
  while (tooSmall(z.r[2], z.r[3]) && z.p >= 0) z = f.zones[z.p];
  const [x, y, w, h] = z.r;
  return { rect: { left: x, top: y, width: w, height: h }, dsId: z.dsId, zone: z };
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
  const lx = w.x - f.x, ly = w.y - f.y, hit = hitAt(f, w.x, w.y);
  const win = hit?.el ? f.iframe.contentWindow : null, doc = docOf(f), el = hit?.el;
  const a = { frame: f.file, x: Math.round(lx + (win?.scrollX || 0)), y: Math.round(ly + (win?.scrollY || 0)) };
  if (hit?.zone) { // on the picture: the anchor recorded with it
    const z = hit.zone, r = hit.rect;
    Object.assign(a, { sel: z.sel, text: z.text, ex: +((lx - r.left) / (r.width || 1)).toFixed(3), ey: +((ly - r.top) / (r.height || 1)).toFixed(3), anchor: { ...z.anchor } });
    if (z.ds) a.ds = z.ds;
  } else if (el) {
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
  } else if (!doc && t.sel && f.zones && f.snapUrl) { // a picture: where its element is in it
    const z = f.zones.find((z) => z.sel === t.sel) || (t.alt && f.zones.find((z) => z.sel === t.alt));
    if (z) { const [x, y, w, h] = z.r; px = x + (t.ex ?? 0.5) * w; py = y + (t.ey ?? 0.5) * h; }
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
// Times are saved in UTC as "YYYY-MM-DD HH:MM" and shown as "now", "5m", "3h", "2d" (full date and time on hover).
const whenOf = (at) => (at ? Date.parse(`${String(at).replace(" ", "T")}${String(at).length <= 16 ? ":00Z" : ""}`) || 0 : 0);
const fullTime = (at) => { const w = whenOf(at); return w ? new Date(w).toLocaleString() : at || ""; };
function ago(w) {
  if (!w) return "";
  const s = (Date.now() - w) / 1000;
  if (s < 45) return "now";
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  if (s < 7 * 86400) return `${Math.round(s / 86400)}d`;
  return new Date(w).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
const AVATAR_COLORS = ["#2e9e6b", "#3b82c4", "#8a5cc7", "#c2577a", "#5b6ee1", "#2f9c9c"]; // no orange: that dot is Claude
function avatar(name) {
  if (name === "Claude") return `<span class="av claude"></span>`;
  const h = [...String(name)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  return `<span class="av" style="background:${AVATAR_COLORS[h % AVATAR_COLORS.length]}">${esc(String(name).trim()[0]?.toUpperCase() || "?")}</span>`;
}
const placeholderOf = (t) => (t.draft ? (toClaude ? "What do you want to change?" : "Add a comment") : "Reply");
// A reply that's slow to come: say so, and what to do when no Claude session is picking comments up.
const SLOW_MS = 2 * 60 * 1000;
const STATUS = { working: "Working…", queued: "Queued" };
const SLOW = {
  working: "This is taking a while. Claude hasn't replied yet.",
  queued: "Claude hasn't picked this up yet. Ask Claude to answer the canvas comments, or turn on watching.",
};
const statusText = (state, since) => (since && Date.now() - since > SLOW_MS ? SLOW : STATUS)[state];
function tickPop() { // relative times and the slow-reply note move on without a redraw
  if (pop.hidden) return;
  for (const el of pop.querySelectorAll("[data-at]")) el.textContent = ago(+el.dataset.at);
  for (const el of pop.querySelectorAll(".wait .body")) el.textContent = statusText(el.dataset.state, +el.dataset.since);
}
setInterval(tickPop, 15000);

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
  if (attach.key !== key) resetAttach(key); // images waiting to be sent belong to the box they were added to
  const state = !t.draft && queueState(t);
  const since = state === "working" ? Date.parse(t.working) : state ? whenOf(t.msgs.at(-1)?.at) : 0;
  const icon = (d) => `<svg viewBox="0 0 24 24"><path d="${d}"/></svg>`;
  const acts = t.draft ? "" : `<span class="acts">
      <button data-act="status" class="${t.status === "resolved" ? "ok" : ""}" title="${t.status === "resolved" ? "Reopen" : "Resolve"}">${icon("M5 12l5 5L20 7")}</button>
      <button data-act="more" title="More"><svg viewBox="0 0 24 24" class="dots"><circle cx="6" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="18" cy="12" r="1.6"/></svg></button>
      <button data-act="close" title="Close (Esc)">${icon("M6 6l12 12M18 6L6 18")}</button></span>
    <div class="more" hidden><div class="where" title="${esc(t.sel || "")}">#${num(t)} · ${esc(where)}</div><button data-act="delete">Delete thread</button></div>`;
  pop.innerHTML = `${t.msgs.length || state ? `<div class="msgs">${t.msgs.map((m, i) => `<div class="msg${m.by === "Claude" ? " claude" : ""}">
      <div class="by">${avatar(m.by)}<b>${esc(m.by)}</b><span class="at" data-at="${whenOf(m.at)}" title="${esc(fullTime(m.at))}">${ago(whenOf(m.at))}</span>${i === 0 ? acts : ""}</div>
      ${m.body.trim() || m.claude ? `<div class="body">${m.claude ? `<span class="mention">@Claude</span> ` : ""}${esc(m.body)}</div>` : ""}
      ${m.images?.length ? `<div class="imgs">${m.images.map((p) => `<a href="${src(p)}" target="_blank" title="Open the image"><img src="${src(p)}" alt=""></a>`).join("")}</div>` : ""}</div>`).join("")}
    ${state ? `<div class="wait ${state}"><div class="by">${avatar("Claude")}<b>Claude</b><span class="at" data-at="${since}">${ago(since)}</span></div>
      <div class="body" data-state="${state}" data-since="${since}">${statusText(state, since)}</div></div>` : ""}</div>` : ""}
    <form class="${toClaude ? "to-claude" : ""}"><div class="field">
      <div class="line"><span class="mention chip">@Claude</span><textarea rows="1" placeholder="${placeholderOf(t)}"></textarea></div>
      <div class="att"></div>
      <div class="send"><label class="ck"><input type="checkbox" ${toClaude ? "checked" : ""}><span class="box">${icon("M5 12.5l4.5 4.5L19 7.5")}</span>Send to Claude</label>
      <button type="button" class="clip" data-act="attach" title="Add an image (or paste or drop one)">${icon("M20 11.5l-7.8 7.8a5 5 0 01-7.1-7.1l8.5-8.5a3.3 3.3 0 014.7 4.7l-8.5 8.5a1.7 1.7 0 01-2.4-2.4l7.8-7.8")}</button>
      <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden>
      <button class="go" disabled title="Send (Enter)">${icon("M12 19V5M5 12l7-7 7 7")}</button></div></div></form>`;
  pop.hidden = false;
  const msgs = pop.querySelector(".msgs"), ta = pop.querySelector("textarea");
  if (msgs) msgs.scrollTop = !keep || keep.atBottom ? msgs.scrollHeight : keep.scroll;
  if (msgs && (!keep || keep.atBottom)) for (const img of msgs.querySelectorAll("img")) if (!img.complete) img.addEventListener("load", () => (msgs.scrollTop = msgs.scrollHeight), { once: true }); // images add height once loaded
  if (keep) {
    ta.value = keep.value;
    ta.style.height = "auto"; ta.style.height = `${ta.scrollHeight}px`;
    if (keep.focused) { ta.focus(); ta.setSelectionRange(keep.start, keep.end); }
  }
  renderAttach();
  tickPop();
  placePop();
  if (!keep) requestAnimationFrame(() => pop.querySelector("textarea")?.focus()); // focus only when the box first opens
}

// ---------- images in a comment ----------
// Pasted, dropped or picked images upload at once (sending then only names them) and show as thumbnails until sent.
let attach = { key: null, items: [] }; // items: { preview, path (once uploaded), failed }
function resetAttach(key) {
  for (const it of attach.items) URL.revokeObjectURL(it.preview);
  attach = { key, items: [] };
}
const canSend = () => {
  const ta = pop.querySelector("textarea");
  return !!ta && !attach.items.some((i) => !i.path) && (!!ta.value.trim() || attach.items.length > 0);
};
function renderAttach() {
  const box = pop.querySelector(".att"), go = pop.querySelector("form .go"), msgs = pop.querySelector(".msgs");
  if (!box) return;
  const atBottom = msgs && msgs.scrollTop + msgs.clientHeight >= msgs.scrollHeight - 4; // thumbnails make the box taller: keep the end of the thread in view
  box.innerHTML = attach.items.map((it, i) => `<div class="it${it.path ? "" : " up"}" data-i="${i}"><img src="${it.preview}" alt=""><span class="x" data-act="unattach" title="Remove">×</span></div>`).join("");
  if (go) go.disabled = !canSend() || sending;
  if (atBottom) msgs.scrollTop = msgs.scrollHeight;
  fieldState();
  placePop();
}
// The field shows its options (Send to Claude, image, send) while in use: focused, or holding text or images.
function fieldState() {
  const field = pop.querySelector(".field"), ta = pop.querySelector("textarea");
  field?.classList.toggle("has", !!ta?.value.trim() || attach.items.length > 0);
}
function addImages(files) {
  const key = attach.key;
  for (const file of files) {
    if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) { Pill.toast("Only png, jpg, gif or webp images"); continue; }
    if (file.size > 15 * 1024 * 1024) { Pill.toast("That image is over 15 MB"); continue; }
    if (attach.items.length >= 10) { Pill.toast("Up to 10 images per message"); break; }
    const it = { preview: URL.createObjectURL(file) };
    attach.items.push(it);
    fetch(q("/_api/images"), { method: "POST", headers: { "content-type": file.type }, body: file })
      .then(answerOf).then((d) => d.path)
      .then((path) => { it.path = path; }, (e) => { Pill.toast(`Couldn't add the image: ${e.message}`); dropImage(it); })
      .finally(() => { if (attach.key === key) renderAttach(); });
  }
  renderAttach();
}
function dropImage(it) {
  const i = attach.items.indexOf(it);
  if (i >= 0) { attach.items.splice(i, 1); URL.revokeObjectURL(it.preview); }
}
const imagesIn = (dt) => [...(dt?.files || [])].filter((f) => f.type.startsWith("image/"));
pop.addEventListener("paste", (e) => {
  const files = imagesIn(e.clipboardData);
  if (!files.length || !pop.querySelector("form")) return; // text pastes as usual
  e.preventDefault();
  addImages(files);
});
pop.addEventListener("dragover", (e) => {
  if (![...(e.dataTransfer?.types || [])].includes("Files")) return;
  e.preventDefault();
  pop.querySelector(".field")?.classList.add("drop");
});
// a file dropped anywhere else would make the browser leave the canvas to show it
for (const ev of ["dragover", "drop"]) addEventListener(ev, (e) => { if ([...(e.dataTransfer?.types || [])].includes("Files") && !pop.contains(e.target)) e.preventDefault(); });
pop.addEventListener("dragleave", (e) => { if (!pop.contains(e.relatedTarget)) pop.querySelector(".field")?.classList.remove("drop"); });
pop.addEventListener("drop", (e) => {
  pop.querySelector(".field")?.classList.remove("drop");
  const files = imagesIn(e.dataTransfer);
  if (!files.length) return;
  e.preventDefault();
  addImages(files);
});
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
  if (act !== "more") pop.querySelector(".more")?.setAttribute("hidden", ""); // any other click closes the menu
  if (!act) return;
  if (act === "close") return closePop();
  if (act === "attach") return pop.querySelector("input[type=file]").click();
  if (act === "more") { const m = pop.querySelector(".more"); m.hidden = !m.hidden; return; }
  if (act === "unattach") { dropImage(attach.items[+e.target.closest(".it").dataset.i]); return renderAttach(); }
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
// Pressing Send to Claude, the image button or send keeps the typing focus in the box: otherwise an empty box would
// lose focus on the press, hide its options and the click would land on nothing.
pop.addEventListener("mousedown", (e) => { if (e.target.closest(".field .send")) e.preventDefault(); });
pop.addEventListener("change", (e) => {
  if (e.target.type === "file") { addImages([...e.target.files]); e.target.value = ""; return pop.querySelector("textarea").focus(); }
  if (e.target.type !== "checkbox") return;
  toClaude = e.target.checked;
  localStorage.setItem("canvas-to-claude", toClaude ? "1" : "0");
  pop.querySelector("form").classList.toggle("to-claude", toClaude);
  if (draft) pop.querySelector("textarea").placeholder = placeholderOf({ draft: true });
  pop.querySelector("textarea").focus();
});
pop.addEventListener("input", (e) => {
  if (e.target.tagName !== "TEXTAREA") return;
  e.target.style.height = "auto"; e.target.style.height = `${e.target.scrollHeight}px`;
  pop.querySelector("form .go").disabled = !canSend() || sending;
  fieldState();
});
pop.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && e.target.tagName === "TEXTAREA") { e.preventDefault(); pop.querySelector("form").requestSubmit(); }
  if (e.key === "Escape") closePop();
  e.stopPropagation();
});
let sending = false; // Enter pressed twice before the first send returns would post the reply twice
pop.addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = pop.querySelector("textarea").value.trim();
  if (!canSend() || sending) return;
  const key = pop.dataset.for, wasDraft = draft, id = openThread, sent = attach.items.slice(), images = sent.map((i) => i.path);
  sending = true; pop.querySelector("form .go").disabled = true;
  try {
    if (wasDraft) {
      const t = await api("/_api/threads", { ...wasDraft, body, images, by: ME, claude: toClaude });
      if (draft === wasDraft) { draft = null; openThread = t.id; }
    } else await api(`/_api/threads/${id}/reply`, { body, images, by: ME, claude: toClaude });
  } catch (err) { // not saved: keep the text so nothing is lost, and say why
    Pill.toast(`Couldn't send: ${err.message}`);
    return;
  } finally {
    sending = false;
    const btn = pop.querySelector("form .go");
    if (btn) btn.disabled = !canSend();
  }
  // Sent: the redraw below must not bring the text back. Only in the same box, and only if it still holds what was
  // sent: while the request ran the person may have opened another thread or kept typing.
  const ta = pop.querySelector("textarea");
  if (ta && pop.dataset.for === key && ta.value.trim() === body) ta.value = "";
  if (attach.key === key) { for (const it of sent) dropImage(it); } // sent: images added meanwhile stay
  if (draft === null && wasDraft) attach.key = `${openThread}`; // the draft became this thread: same box
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
      <div class="first"><b>${esc(t.msgs[0]?.by)}</b> ${esc(t.msgs[0]?.body)}${t.msgs[0]?.images?.length ? ` <span class="dim">· ${t.msgs[0].images.length === 1 ? "image" : `${t.msgs[0].images.length} images`}</span>` : ""}</div>
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
