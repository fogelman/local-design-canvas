// Comment threads (comments.json): add/update, stable data-cid anchors, and the Claude queue (waiting, claims, canvas wait).
import fs from "node:fs";
import path from "node:path";
import { COMMENTS, LAYOUT, me, pageDir, pages, readJSON, saveThreads, threadsOf } from "./store.mjs";
import { watchTree } from "./watch.mjs";
import { body } from "./server.mjs";
// ---------- threads ----------
export const nextId = (threads) => `c${1 + Math.max(0, ...threads.map((t) => +String(t.id).slice(1) || 0))}`;
export const now = () => new Date().toISOString().slice(0, 16).replace("T", " ");

// Stable anchors: tag the commented element in the frame's source with data-cid="<thread id>", so the
// comment survives edits that break CSS selectors and Claude finds it with one grep. Only when the live DOM
// still mirrors the source (same count of that tag, so the nth live <tag> is the nth <tag> in the file).
export function tagElement(dir, frame, { tag, tagIndex, tagCount }, cid) {
  if (!frame || !tag || !/^[a-z][a-z0-9-]*$/i.test(tag) || tagIndex == null) return null;
  const file = path.join(dir, frame);
  if (!fs.existsSync(file)) return null;
  const src = fs.readFileSync(file, "utf8");
  // blank out comments, scripts, styles, templates and textareas so a "<div" inside them isn't counted
  const masked = src.replace(/<!--[\s\S]*?-->|<(script|style|template|textarea)\b[\s\S]*?<\/\1\s*>/gi, (m) => " ".repeat(m.length));
  const re = new RegExp(`<${tag}(?=[\\s/>])`, "gi");
  const hits = [...masked.matchAll(re)];
  if (hits.length !== tagCount || !hits[tagIndex]) return null;
  const at = hits[tagIndex].index + 1 + tag.length;
  const open = masked.slice(at, masked.indexOf(">", at));
  const had = open.match(/\sdata-cid="([^"]+)"/);
  if (had) return had[1];
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${src.slice(0, at)} data-cid="${cid}"${src.slice(at)}`);
  fs.renameSync(tmp, file);
  return cid;
}

export function addThread(dir, { frame, sel, text, x, y, ex, ey, body, by, claude, anchor, ds }) {
  const data = threadsOf(dir);
  const id = nextId(data.threads);
  const path_ = sel;
  if (ds) anchor = null; // inside a component: the element isn't in the frame's source, so there's nothing to tag
  if (anchor?.cid) sel = `[data-cid="${anchor.cid}"]`;
  else if (anchor && !String(sel || "").startsWith("#") && !readJSON(path.join(dir, LAYOUT), {}).source) { // generated pages: don't tag files a rebuild overwrites
    try { const cid = tagElement(dir, frame, anchor, id); if (cid) sel = `[data-cid="${cid}"]`; } catch {}
  }
  const t = { id, frame, sel, ...(sel !== path_ && { alt: path_ }), ...(ds && { ds }), text, x, y, ex, ey, status: "open", msgs: [{ by: by || me(), at: now(), body, ...(claude && { claude: true }) }] };
  data.threads.push(t);
  saveThreads(dir, data);
  return t;
}

export function updateThread(dir, id, fn) {
  const data = threadsOf(dir);
  const t = data.threads.find((t) => t.id === id);
  if (!t) throw new Error(`no thread ${id}`);
  fn(t, data);
  saveThreads(dir, data);
  return t;
}

// The queue. A thread waits on Claude when it's open and its latest message was sent with "Send to Claude".
// `canvas wait` claims what it hands to a session (t.working = time); a reply clears it. A claim older than
// CLAIM_TTL is treated as abandoned (the session died) and the thread queues again.
export const CLAIM_TTL = 30 * 60 * 1000;
export const waiting = (t) => t.status === "open" && t.msgs.at(-1)?.claude;
export const claimed = (t) => !!t.working && Date.now() - Date.parse(t.working) < CLAIM_TTL;
export const allThreads = (dir) => pages(dir).flatMap((pg) => threadsOf(pageDir(dir, pg.id)).threads.map((t) => ({ ...t, page: pg.id })));
export const queued = (dir) => allThreads(dir).filter((t) => waiting(t) && !claimed(t));

export function claim(dir, list) {
  const at = new Date().toISOString();
  for (const pg of new Set(list.map((t) => t.page))) {
    const ids = new Set(list.filter((t) => t.page === pg).map((t) => t.id));
    const pd = pageDir(dir, pg), data = threadsOf(pd);
    for (const t of data.threads) if (ids.has(t.id)) t.working = at;
    saveThreads(pd, data);
  }
}

// Block until something is queued for Claude, let a burst of comments settle into one batch, then return it.
// Costs nothing while idle: Claude Code runs this in the background and is woken when it exits.
export function waitForQueue(dir, settleMs, timeoutMs) {
  return new Promise((resolve) => {
    const now = queued(dir);
    if (now.length) return resolve(now);
    let settle = null, timeout = null;
    const finish = (list) => { watcher.close(); clearTimeout(settle); clearTimeout(timeout); resolve(list); };
    const watcher = watchTree(dir, (name) => {
      if (!name || !name.endsWith(COMMENTS) || name.split(path.sep).some((p) => p.startsWith("."))) return;
      if (!queued(dir).length) return;
      clearTimeout(settle);
      settle = setTimeout(() => finish(queued(dir)), settleMs);
    });
    if (timeoutMs) timeout = setTimeout(() => finish([]), timeoutMs);
  });
}

// "checkout/c3" → [<dir>/checkout, "c3"]; "c3" → [<dir>, "c3"]
export const splitId = (dir, id) => { const i = String(id).lastIndexOf("/"); return i < 0 ? [dir, id] : [pageDir(dir, id.slice(0, i)), id.slice(i + 1)]; };
