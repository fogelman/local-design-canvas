// Frames: section titles, live iframes, snapshots, unsaved layout, release-when-hidden and virtualization.
// ---------- sections: group titles on the canvas (canvas.json "sections": [{ title, sub, x, y }]) ----------
function renderSections(list = []) {
  $("#sections").innerHTML = list.map((s) => `<div class="section" style="left:${s.x}px;top:${s.y}px"><div class="st">${esc(s.title)}</div>${s.sub ? `<div class="ss">${esc(s.sub)}</div>` : ""}</div>`).join("");
}

// ---------- frames ----------
const restoring = [];
function renderFrames(list) {
  const opening = frames.size === 0; // the page is opening (not a screen added later)
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
      cur = { el, iframe: null, store: storeUrl(f.file) };
      frames.set(f.file, cur);
    }
    cur.base = { x: f.x, y: f.y, w: f.w, h: f.h };
    Object.assign(cur, f, dirty.get(f.file)); // unsaved local moves survive a refresh from disk
    const first = !cur.key;
    placeFrame(cur); // and re-keys it
    if (first && opening) restoring.push(cur.restored);
  }
  // Screens appear together once their saved pictures are ready (a moment), not as stripes that then fill in.
  if (restoring.length) {
    framesEl.classList.add("pending");
    const all = Promise.race([Promise.all(restoring), new Promise((r) => setTimeout(r, 800))]);
    restoring.length = 0;
    all.then(() => framesEl.classList.remove("pending"));
  }
  for (const [file, cur] of frames) if (!seen.has(file)) { cur.el.remove(); frames.delete(file); }
  scheduleCull();
  queueSnaps();
}

// ---------- what a screen looks like ----------
// A screen's key says what it looks like: its file, every shared file it can pull in, the canvas app (the server's
// versions), and its size. A picture is shown only under the key it was taken at. When the key changes the picture
// goes at once, and the frame shows stripes until a new one is ready: never a picture of what the screen no longer
// is. A live screen whose files changed reloads (or, while the person is busy, gets the amber "stale" mark).
const looks = (f) => `${f.v}|${ASSETS}`;
function rekey(f) {
  const key = `${looks(f)}|${f.w}x${f.h}`;
  if (f.key === key) return;
  const was = f.key, sameFiles = !!was && was.startsWith(`${looks(f)}|`);
  f.key = key;
  if (was) {
    f.snapSeq = (f.snapSeq || 0) + 1; // a picture still rendering is of the old screen
    f.snapped = false; f.snapStale = false; f.zones = null;
    setSnap(f, null);
    if (f.iframe && !sameFiles) requestReload(f); // a new size alone needs no reload: the live page reflows
  }
  if (!sameFiles) f.restored = restoreSnap(f); // the browser may hold a picture under the new key already
}
// A page can keep changing after it loads: an entrance animation, data a script fills in, a font arriving. A picture
// to keep waits until the page has been still for STILL_MS: no DOM change, no finite animation running, fonts in,
// and nothing pending (timers and requests, counted by the script the server adds to every screen).
// A page that doesn't settle within SETTLE_MAX_MS resolves false: it isn't pictured rather than caught half-drawn.
const STILL_MS = 300, SETTLE_MAX_MS = 4000;
function settled(doc) {
  return new Promise((resolve) => {
    const start = performance.now();
    let last = start, mo = null;
    const finish = (ok) => { mo?.disconnect(); resolve(ok); };
    try { mo = new MutationObserver(() => (last = performance.now())); mo.observe(doc, { subtree: true, childList: true, attributes: true, characterData: true }); } catch { return finish(false); }
    const tick = () => {
      if (!doc.defaultView) return finish(false); // closed meanwhile
      let busy = doc.fonts?.status === "loading" || doc.defaultView.__canvasPending?.() > 0; // timers and requests (see the server's PENDING)
      try { busy ||= doc.getAnimations().some((a) => a.playState === "running" && a.effect?.getComputedTiming().endTime !== Infinity); } catch {}
      const now = performance.now();
      if (busy) last = now;
      if (now - last >= STILL_MS) return finish(true);
      if (now - start > SETTLE_MAX_MS) return finish(false);
      setTimeout(tick, 50);
    };
    setTimeout(tick, 50);
  });
}

// ---------- snapshots ----------
// Frames that aren't live show a picture of the page: its DOM and CSS rendered by the browser as an SVG
// <foreignObject> image, then rasterized. An SVG image can't load anything and its :root is the <svg>, so every
// stylesheet, image and font is inlined and :root is retargeted; CSS is taken as written, because the browser's
// re-serialization loses values (`font: 700 15px var(--x)` plus a font longhand comes back empty).
// A picture never shows something the live page doesn't: when a page holds state a picture can't (scrolled, an
// open modal, canvas/video/frames, shadow DOM, a file that can't be read), the frame keeps the stripes instead.
const inlined = new Map(); // url -> Promise<data URL or text | null>, shared by all snapshots; cleared when files change
function fetchOnce(url, as) {
  const key = `${as} ${url}`;
  if (!inlined.has(key)) inlined.set(key, fetch(url).then((r) => (r.ok ? (as === "text" ? r.text() : r.blob()) : null))
    .then((b) => (as === "text" || !b ? b : new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => res(null); fr.readAsDataURL(b); })))
    .catch(() => null));
  return inlined.get(key);
}
class Unsnappable extends Error {}
const URL_RE = /url\(\s*(['"]?)([^'")]*)\1\s*\)/g;
async function inlineUrls(text, base) {
  const urls = new Set();
  for (const m of text.matchAll(URL_RE)) if (m[2] && !/^(data:|#)/.test(m[2])) urls.add(m[2]);
  const map = new Map();
  await Promise.all([...urls].map(async (u) => { try { const d = await fetchOnce(new URL(u, base).href, "data"); if (d) map.set(u, d); } catch {} }));
  return text.replace(URL_RE, (m, q, u) => (map.has(u) ? `url("${map.get(u)}")` : m)); // a missing file stays missing, as it is live
}
async function sheetText(text, base, depth = 0) {
  text = text.replace(/\/\*[\s\S]*?\*\//g, "");
  const imports = [...text.matchAll(/@import\s+(?:url\(\s*)?(['"]?)([^'")\s;]+)\1\s*\)?\s*([^;]*);/g)];
  for (const m of imports) {
    if (depth > 8 || /\b(layer|supports)\b/.test(m[3])) throw new Unsnappable("@import with layer/supports");
    const href = new URL(m[2], base).href, inner = await fetchOnce(href, "text");
    if (inner == null) throw new Unsnappable(`stylesheet ${href}`);
    const css = await sheetText(inner, href, depth + 1);
    text = text.replace(m[0], () => (m[3].trim() ? `@media ${m[3].trim()} {\n${css}\n}` : css));
  }
  return inlineUrls(text, base);
}
// Synchronous part: everything read from the live document, so the frame can be torn down right after.
function capture(doc, f) {
  const win = doc.defaultView;
  if (win.scrollX || win.scrollY) throw new Unsnappable("page scrolled");
  const de = doc.documentElement, barY = win.innerWidth > de.clientWidth, barX = win.innerHeight > de.clientHeight;
  if (doc.querySelector("iframe, frame, video, object, embed, dialog:modal, :popover-open, :fullscreen")) throw new Unsnappable("element a picture can't hold");
  const sheets = [];
  for (const ss of [...doc.styleSheets, ...(doc.adoptedStyleSheets || [])]) {
    if (ss.disabled) continue;
    const node = ss.ownerNode, media = ss.media?.mediaText || "";
    if (node?.localName === "link") sheets.push({ href: ss.href, media });
    else if (node?.localName === "style" && (node.textContent.trim() || !ss.cssRules.length)) sheets.push({ text: node.textContent, base: doc.baseURI, media });
    else sheets.push({ text: [...ss.cssRules].map((r) => r.cssText).join("\n"), base: doc.baseURI, media }); // rules added by script
  }
  const root = doc.documentElement.cloneNode(true);
  const src = [doc.documentElement, ...doc.documentElement.querySelectorAll("*")], dst = [root, ...root.querySelectorAll("*")];
  const images = [];
  src.forEach((s, i) => {
    const d = dst[i];
    if (s.scrollTop || s.scrollLeft) throw new Unsnappable("scrolled inside");
    if (s.shadowRoot) throw new Unsnappable("shadow DOM");
    const tag = s.localName;
    if (tag === "input") { if (s.type === "checkbox" || s.type === "radio") d.toggleAttribute("checked", s.checked); else if (s.type !== "file") d.setAttribute("value", s.value); }
    else if (tag === "textarea") d.textContent = s.value;
    else if (tag === "select") [...s.options].forEach((o, j) => d.options[j].toggleAttribute("selected", o.selected));
    else if (tag === "canvas") {
      const img = doc.createElement("img");
      for (const a of s.attributes) img.setAttribute(a.name, a.value);
      img.src = s.toDataURL(); // throws when tainted: unsnappable
      d.replaceWith(img);
    } else if (tag === "img" && (s.currentSrc || s.src)) {
      if (s.complete && !s.naturalWidth) return; // broken live too
      images.push({ el: d, attr: "src", url: s.currentSrc || s.src });
      d.removeAttribute("srcset"); d.removeAttribute("loading");
    } else if ((tag === "image" || tag === "use" || tag === "feImage") && (s.getAttribute("href") || s.getAttribute("xlink:href"))) {
      const u = s.getAttribute("href") || s.getAttribute("xlink:href");
      if (u.startsWith("#")) return;
      if (tag === "use") throw new Unsnappable("external <use>"); // can't be inlined
      images.push({ el: d, attr: "href", url: new URL(u, doc.baseURI).href });
    } else if (tag === "source" && s.parentNode?.localName === "picture") d.remove();
    if (s.getAttribute?.("style")?.includes("url(")) images.push({ el: d, attr: "style", text: s.getAttribute("style") });
  });
  root.querySelectorAll("script, link, style, noscript").forEach((n) => n.remove());
  root.setAttribute("data-snap-root", "");
  const zones = zonesOf(doc); // read now, while the page is here
  // the live page's own scrollbars take room from the layout: the root element carries them in the picture
  if (barX || barY) Object.assign(root.style, { width: `${f.w}px`, height: `${f.h}px`, overflowX: barX ? "scroll" : "hidden", overflowY: barY ? "scroll" : "hidden" });
  return { root, sheets, images, base: doc.baseURI, w: f.w, h: f.h, zones };
}
// Asynchronous part: inline files, render, rasterize.
async function render({ root, sheets, images, base, w, h }) {
  const css = await Promise.all(sheets.map(async (s) => {
    let text = s.text;
    if (s.href) { text = await fetchOnce(s.href, "text"); if (text == null) throw new Unsnappable(`stylesheet ${s.href}`); }
    text = await sheetText(text, s.href || s.base);
    return s.media && s.media !== "all" ? `@media ${s.media} {\n${text}\n}` : text;
  }));
  await Promise.all(images.map(async (im) => {
    if (im.attr === "style") return im.el.setAttribute("style", await inlineUrls(im.text, base));
    const d = await fetchOnce(im.url, "data");
    if (!d) throw new Unsnappable(`image ${im.url}`);
    im.el.setAttribute(im.attr, d);
    if (im.attr === "href") im.el.removeAttribute("xlink:href");
  }));
  const style = document.createElementNS("http://www.w3.org/1999/xhtml", "style");
  style.textContent = css.join("\n").replace(/:root\b/g, "[data-snap-root]"); // same specificity as :root
  (root.querySelector("head") || root).appendChild(style);
  const xhtml = new XMLSerializer().serializeToString(root);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><foreignObject x="0" y="0" width="${w}" height="${h}">${xhtml}</foreignObject></svg>`;
  // loaded from a data: URL, not a blob: one, so the browser lets it be drawn to a canvas and kept as an image,
  // which is far lighter to keep and paint than an SVG carrying its own fonts; where that's refused, keep the SVG
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await quiet(); // drawing a heavy page takes the main thread for a moment: never while the view moves
  try { await img.decode(); } catch { throw new Unsnappable("render failed"); }
  await quiet();
  try {
    const s = Math.min(Math.max(devicePixelRatio, 1), 2, 16384 / Math.max(w, h), Math.sqrt(32e6 / (w * h)));
    const c = document.createElement("canvas");
    c.width = Math.round(w * s); c.height = Math.round(h * s);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    // lossless WebP: the same pixels as PNG at about half the size, and much faster to encode
    // (grainy backgrounds barely compress); a browser that can't encode it gives a PNG
    const bmp = await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej()), "image/webp", 1));
    return { url: URL.createObjectURL(bmp), blob: bmp };
  } catch { const blob = new Blob([svg], { type: "image/svg+xml" }); return { url: URL.createObjectURL(blob), blob }; }
}
// `key`: the picture shows the screen exactly as its files are (not a state someone left it in)
// A new picture replaces the old one only once it's decoded, so the screen never shows an empty image in between.
// Resolves when it's on screen.
function setSnap(f, url, key = null) {
  f.snapUrl = url;
  f.snapKey = url ? key : null;
  const ph = f.el.querySelector(".ph");
  const show = () => {
    if (f.shownUrl && f.shownUrl !== url) URL.revokeObjectURL(f.shownUrl);
    f.shownUrl = url;
    ph.classList.toggle("has-img", !!url);
  };
  if (!url) { ph.replaceChildren(); show(); return Promise.resolve(); }
  const img = new Image();
  img.alt = ""; img.draggable = false; img.src = url;
  return img.decode().catch(() => {}).then(() => {
    if (f.snapUrl !== url) return URL.revokeObjectURL(url); // a newer picture (or none) took its place meanwhile
    ph.replaceChildren(img);
    show();
  });
}
// `fresh`: the page as it loads, untouched, so the picture can be saved for the next visit.
// `docKey`: the key the page was loaded under. A page loaded before its files changed isn't pictured: the frame was
// re-keyed (stripes) and the queue pictures the new version.
async function snap(f, doc, fresh, docKey) {
  if (!doc?.documentElement || !doc.defaultView || docKey !== f.key) return;
  // half-loaded (panned away or reloaded mid-load): its stylesheets may not be in yet, so the queue pictures it fresh
  if (doc.readyState !== "complete") { f.snapStale = true; return; }
  const seq = f.snapSeq = (f.snapSeq || 0) + 1; // a newer snapshot, a release or a re-key wins over this one
  const key = docKey;
  f.snapStale = false;
  f.snapped = true; // tried: a page that can't be pictured isn't retried until it changes
  try {
    const cap = capture(doc, f);
    const { url, blob } = await render(cap);
    if (seq !== f.snapSeq || released) return URL.revokeObjectURL(url);
    if (fresh) saveSnap(f, blob, key, cap.zones);
    f.zones = cap.zones;
    await setSnap(f, url, fresh && key === f.key ? key : null);
  } catch (e) {
    if (seq !== f.snapSeq) return;
    setSnap(f, null); // stripes, never a picture that differs from the page
    if (!(e instanceof Unsnappable) && e?.name !== "SecurityError") console.warn("snapshot failed", f.file, e);
  }
}
// Saved snapshots: kept in the browser per canvas, page and screen with the key they were taken at, so
// reopening a page (or coming back to a released tab) shows every picture at once without rendering anything.
const SNAP_STORE = "canvas-snapshots-v3";
const storeUrl = (file) => `/_snapshots/${encodeURIComponent(PAGE)}/${encodeURIComponent(file)}`;
const snapStore = () => (window.caches && CANVAS_ID ? caches.open(`${SNAP_STORE}:${CANVAS_ID}`) : Promise.reject());
function saveSnap(f, blob, key, zones) {
  snapStore().then((c) => Promise.all([
    c.put(f.store, new Response(blob, { headers: { "content-type": blob.type, "x-key": key } })),
    c.put(`${f.store}?zones`, new Response(JSON.stringify(zones), { headers: { "content-type": "application/json", "x-key": key } })),
  ])).catch(() => {});
}
async function restoreSnap(f) {
  const key = f.key;
  f.restoring = true;
  try {
    const store = await snapStore();
    const [r, z] = await Promise.all([store.match(f.store), store.match(`${f.store}?zones`)]);
    if (r?.headers.get("x-key") !== key) return;
    const [blob, zones] = await Promise.all([r.blob(), z?.headers.get("x-key") === key ? z.json().catch(() => null) : null]);
    if (f.key !== key || released || (f.snapUrl && f.snapKey === key)) return;
    f.snapSeq = (f.snapSeq || 0) + 1;
    f.zones = zones;
    f.snapped = true; f.snapStale = false;
    await setSnap(f, URL.createObjectURL(blob), key);
  } catch {} finally { f.restoring = false; queueSnaps(); }
}
// one hidden iframe at a time renders frames that have no (or a stale) snapshot, nearest first, in idle moments
let snapping = false;
function queueSnaps() {
  if (snapping || released || document.hidden || moving) return; // no background work in a hidden tab or a moving view
  if (![...frames.values()].some((f) => !f.iframe && !f.restoring && (!f.snapped || f.snapStale))) return;
  snapping = true;
  idle(() => {
    snapping = false;
    if (released || document.hidden || moving) return; // settle() and visibilitychange start it again
    const a = toWorld(innerWidth / 2, innerHeight / 2);
    const next = [...frames.values()].filter((f) => !f.iframe && !f.restoring && (!f.snapped || f.snapStale))
      .sort((p, q) => Math.hypot(p.x - a.x, p.y - a.y) - Math.hypot(q.x - a.x, q.y - a.y))[0];
    if (next) { snapping = true; snapIn(next); }
  });
}
// The person comes first: if the view starts moving while the page is still loading, the load is dropped (the frame
// goes back in the queue). Once captured, the page is closed right away; drawing the picture waits for a still view.
let dropSnapIn = null;
function snapIn(next) {
  const ifr = document.createElement("iframe");
  ifr.className = "snapper";
  Object.assign(ifr.style, { width: `${next.w}px`, height: `${next.h}px` });
  let finished = false;
  const done = () => { if (finished) return; finished = true; dropSnapIn = null; clearTimeout(guard); ifr.remove(); snapping = false; setTimeout(queueSnaps, 30); };
  const key = next.key; // what it's loaded as; if the files change meanwhile, the picture isn't taken
  const guard = setTimeout(() => { next.snapStale = false; next.snapped = true; done(); }, 8000 + SETTLE_MAX_MS);
  dropSnapIn = done;
  ifr.addEventListener("load", async () => {
    const still = await settled(ifr.contentDocument);
    if (finished) return; // dropped for the person meanwhile
    dropSnapIn = null; // captured from here on: nothing left to drop
    if (!next.iframe && next.key === key) {
      if (!still) { next.snapped = true; next.snapStale = false; setSnap(next, null); } // never still: stripes
      else {
        if (next.scroll) ifr.contentWindow.scrollTo(next.scroll.x, next.scroll.y);
        const work = snap(next, ifr.contentDocument, !next.scroll, key);
        ifr.remove();
        await work;
      }
    }
    done();
  });
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
  clearTimeout(cullT); clearTimeout(graceT); cullQueued = false;
  document.querySelector(".snapper")?.remove();
  for (const f of frames.values()) {
    unmount(f, false);
    f.snapSeq = (f.snapSeq || 0) + 1; // drop snapshots still rendering
    f.snapped = false;
    setSnap(f, null);
  }
  renderPins();
}
document.addEventListener("visibilitychange", () => {
  clearTimeout(releaseT);
  if (document.hidden) { releaseT = setTimeout(releaseAll, RELEASE_MS); return; }
  if (!released) return queueSnaps();
  released = false;
  for (const f of frames.values()) restoreSnap(f); // saved pictures come back at once; the rest refill in idle time
  scheduleCull(0);
});

// ---------- virtualization ----------
// Only frames near the viewport get a live iframe, capped at LIVE (nearest to the center first). Zoomed out
// (below LIVE_K), a screen whose picture shows it exactly stays a picture: a live page adds nothing there but cost.
// Frames that leave the viewport are unloaded after HIDE_MS so quick pans don't thrash; their scroll is restored on return.
// Loading and unloading pages is the heaviest thing the canvas does, so it never happens while the view moves,
// and a still view does it a little at a time: at most two pages loading at once, one unload per idle moment.
const LIVE = +new URLSearchParams(location.search).get("live") || 12;
const HIDE_MS = 2500, MARGIN = 0.5, MIN_PX = 48, LIVE_K = 0.5;
let cullT = null, graceT = null, cullQueued = false;
function scheduleCull(delay = 60) {
  if (cullQueued || moving || released) return; // settle() runs it once the view is still
  cullQueued = true;
  cullT = setTimeout(() => idle(() => { cullQueued = false; cull(); }), delay);
}
const exact = (f) => f.snapUrl && !f.snapStale && f.snapKey === f.key && !f.touched; // its picture is the page as it is
function mount(f) {
  if (f.iframe) return;
  f.el.classList.remove("loaded", "shown"); // the picture (or stripes) stays until the page has painted
  f.el.classList.add("live");
  load(f);
}
// Loads the screen in a new iframe on top of what's showing (its picture, or the page itself before a reload),
// which is only removed once the new page has painted and faded in: a screen never blinks blank.
function load(f) {
  const ifr = document.createElement("iframe");
  ifr.src = src(f.file);
  ifr.key = f.key; // the version this page is: pictures of it are only taken while that's still the screen's key
  ifr.addEventListener("load", () => { if (f.iframe === ifr) onFrameLoad(f); });
  f.el.querySelector(".box").insertBefore(ifr, f.el.querySelector(".shield"));
  f.iframe = ifr;
  f.touched = false;
}
async function reveal(f, ifr) {
  const win = ifr.contentWindow;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  try { await Promise.race([win.document.fonts.ready, wait(1500)]); } catch {}
  await Promise.race([new Promise((r) => win.requestAnimationFrame(() => win.requestAnimationFrame(r))), wait(300)]); // painted
  if (f.iframe !== ifr) return;
  ifr.classList.add("ready");
  f.el.classList.add("loaded");
  await wait(170); // the fade
  if (f.iframe !== ifr) return;
  f.prev?.remove(); f.prev = null;
  f.el.classList.add("shown");
}
function unmount(f, keepSnapshot = true) {
  if (!f.iframe) return;
  f.prev?.remove(); f.prev = null;
  if (stale.delete(f.file)) { f.el.classList.remove("stale"); renderStale(); } // it loads fresh when it comes back
  try { const w = f.iframe.contentWindow; if (w.scrollX || w.scrollY) f.scroll = { x: w.scrollX, y: w.scrollY }; } catch {}
  if (keepSnapshot && !exact(f)) snap(f, docOf(f), false, f.iframe.key); // keep what it showed (typed text, an opened menu)
  f.iframe.remove();
  f.iframe = null;
  f.hiddenSince = 0;
  f.el.classList.remove("live", "loaded", "shown");
}
function cull() {
  if (released || moving) return;
  const mx = innerWidth * MARGIN / pan.k, my = innerHeight * MARGIN / pan.k;
  const a = toWorld(0, 0), b = toWorld(innerWidth, innerHeight);
  const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2, now = Date.now();
  const wanted = [...frames.values()]
    .filter((f) => f.x < b.x + mx && f.x + f.w > a.x - mx && f.y < b.y + my && f.y + f.h > a.y - my && f.w * pan.k >= MIN_PX)
    .filter((f) => pan.k >= LIVE_K || tool === "interact" || !exact(f))
    .map((f) => ({ f, d: Math.hypot(f.x + f.w / 2 - cx, f.y + f.h / 2 - cy) }))
    .sort((p, q) => p.d - q.d).slice(0, LIVE).map((p) => p.f);
  const keep = new Set([selected && frames.get(selected), openThread && frames.get(threads.find((t) => t.id === openThread)?.frame), draft?.frame && frames.get(draft.frame), ...wanted].filter(Boolean));
  let loads = 2 - [...frames.values()].filter((f) => f.iframe && !f.el.classList.contains("loaded")).length;
  for (const f of keep) { f.hiddenSince = 0; if (!f.iframe && loads-- > 0) mount(f); }
  const stale = [...frames.values()].filter((f) => f.iframe && !keep.has(f));
  for (const f of stale) f.hiddenSince ||= now;
  // over budget: drop the longest-hidden first; otherwise wait out the grace period. One per pass.
  const live = [...frames.values()].filter((f) => f.iframe).length;
  stale.sort((p, q) => p.hiddenSince - q.hiddenSince);
  const drop = stale.find((f, i) => i < live - (LIVE + 4) || now - f.hiddenSince > HIDE_MS);
  if (drop) unmount(drop);
  const more = (loads > 0 && [...keep].some((f) => !f.iframe)) || stale.some((f, i) => f.iframe && (i < live - (LIVE + 4) || now - f.hiddenSince > HIDE_MS));
  clearTimeout(graceT);
  if (more) scheduleCull(0);
  else if (stale.some((f) => f.iframe)) graceT = setTimeout(scheduleCull, HIDE_MS);
  renderPins();
  queueSnaps();
}
function placeFrame(f) {
  Object.assign(f.el.style, { left: `${f.x}px`, top: `${f.y}px`, width: `${f.w}px`, height: `${f.h}px` });
  f.el.querySelector(".title").textContent = f.title;
  f.el.querySelector(".title").title = f.title;
  f.el.querySelector(".label").style.maxWidth = `calc(${f.w}px * var(--k))`; // never wider than its frame on screen
  f.el.querySelector(".ph").dataset.t = f.title;
  f.el.querySelector(".size").textContent = `${f.w} × ${f.h}`;
  f.el.classList.toggle("sel", selected === f.file);
  rekey(f);
}
function onFrameLoad(f) {
  const win = f.iframe.contentWindow;
  reveal(f, f.iframe);
  if (f.scroll) { win.scrollTo(f.scroll.x, f.scroll.y); f.scroll = null; }
  win.addEventListener("scroll", renderPins, { passive: true });
  // keep the canvas shortcuts working while focus is inside a frame (interact mode)
  win.addEventListener("keydown", (e) => { if (e.key === "Escape") setTool("move"); });
  for (const ev of ["pointerdown", "keydown", "input"]) win.addEventListener(ev, () => (f.touched = true), { capture: true, passive: true });
  // a link to another frame flies the canvas there instead of navigating inside this frame
  win.document.addEventListener("click", (e) => {
    const target = frameForHref(e.target.closest?.("a[href]")?.href);
    if (!target) return;
    e.preventDefault();
    select(target.file);
    fitRect(target, 2);
  }, true);
  const ifr = f.iframe;
  if (!exact(f)) settled(ifr.contentDocument).then((still) => { if (still && f.iframe === ifr && !f.touched) snap(f, docOf(f), true, ifr.key); });
  renderPins();
  scheduleCull(); // the next page can load
}
// ---------- stale screens: don't reload under the person's hands ----------
// While someone is writing a comment or using a live screen (interact mode), changes from disk don't reload the
// screens they're looking at. Those screens get an amber mark, and an amber Reload button in the right menu
// (or R) applies everything when they choose. Off-view screens, comments and layout still update on their own.
const stale = new Set();
let staleApp = false; // the viewer itself was updated: a full page reload is waiting
function busy() {
  const ta = pop.hidden ? null : pop.querySelector("textarea");
  return !!draft || !!(ta && ta.value.trim()) || attach.items.length > 0 || tool === "interact";
}
function requestReload(f) {
  if (f.iframe && busy()) { stale.add(f.file); f.el.classList.add("stale"); return renderStale(); }
  reloadFrame(f);
}
function applyStale() {
  if (staleApp) return location.reload();
  for (const file of stale) { const f = frames.get(file); if (f) { f.el.classList.remove("stale"); reloadFrame(f); } }
  stale.clear();
  renderStale();
}
function renderStale() {
  const n = stale.size, btn = $("#staleBtn");
  btn.hidden = !n && !staleApp;
  $("#staleCount").textContent = staleApp ? "" : n > 1 ? n : "";
  btn.title = staleApp ? "The canvas was updated. Reload the page when you're ready (R)"
    : `${n} screen${n === 1 ? "" : "s"} changed on disk. Reload when you're ready (R)`;
}
$("#staleBtn").addEventListener("click", applyStale);

function reloadFrame(f) {
  if (!f.iframe) { f.snapSeq = (f.snapSeq || 0) + 1; f.snapped = false; f.zones = null; setSnap(f, null); return queueSnaps(); } // stripes until pictured again
  try { const w = f.iframe.contentWindow; f.scroll = { x: w.scrollX, y: w.scrollY }; } catch {}
  f.prev?.remove();
  f.prev = f.iframe.classList.contains("ready") ? f.iframe : (f.iframe.remove(), null); // stays on screen until the new one has painted
  load(f);
}
function select(file) {
  selected = file;
  for (const f of frames.values()) f.el.classList.toggle("sel", selected === f.file);
  if (file) focusFrame(frames.get(file));
}
// The screen someone focuses (selects, double-clicks, follows a link to) goes live right away, ahead of anything
// queued; it stays live while selected.
function focusFrame(f) {
  if (!f || released) return;
  f.hiddenSince = 0;
  mount(f);
}
const docOf = (f) => { try { return f.iframe?.contentDocument || null; } catch { return null; } };
