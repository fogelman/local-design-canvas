// Comment threads (comments.json): add/update, stable data-cid anchors, and the Claude queue (waiting, claims, canvas wait).
import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { COMMENTS, LAYOUT, editThreads, me, pageDir, pages, readJSON, threadsOf } from "./store.mjs";
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

// ---------- images in comments ----------
// Images people paste or attach (and Claude attaches with `canvas reply --image`) are saved next to the page's
// comments, in .comment-images/, named by their content. A dot folder: it isn't a page, doesn't reload screens
// and doesn't change what screens look like. Messages list them as paths relative to the page folder.
export const IMAGES = ".comment-images";
export const MAX_IMAGE = 15 * 1024 * 1024;
const IMAGE_PATH = /^\.comment-images\/[0-9a-f]{16}\.(png|jpg|gif|webp)$/;
// The type from the bytes, not from a name or header: only formats a browser shows as a plain picture (no SVG).
export function imageType(buf) {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.subarray(0, 6).toString("latin1"))) return "gif";
  if (buf.length >= 12 && buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  return null;
}
export function saveImage(dir, buf) {
  const type = imageType(buf);
  if (!type) throw new Error("not an image (png, jpg, gif or webp)");
  if (buf.length > MAX_IMAGE) throw new Error(`image over ${MAX_IMAGE / 1024 / 1024} MB`);
  const rel = `${IMAGES}/${createHash("sha1").update(buf).digest("hex").slice(0, 16)}.${type}`, file = path.join(dir, rel);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.join(dir, IMAGES), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, file);
  }
  return rel;
}
// Only images saved here, that exist: a message can't point at other files.
export const cleanImages = (dir, list) => [...new Set(Array.isArray(list) ? list : [])].filter((p) => typeof p === "string" && IMAGE_PATH.test(p) && fs.existsSync(path.join(dir, p))).slice(0, 10);
export const message = (dir, { by, body, claude, images }) => {
  const imgs = cleanImages(dir, images);
  if (!String(body || "").trim() && !imgs.length) throw new Error("empty message");
  return { by: by || me(), at: now(), body: String(body || ""), ...(imgs.length && { images: imgs }), ...(claude && { claude: true }) };
};

export const addThread = (dir, input) => editThreads(dir, (data) => {
  let { frame, sel, text, x, y, ex, ey, anchor, ds } = input;
  const msg = message(dir, input); // first: an empty message changes nothing (not even a data-cid tag)
  const id = nextId(data.threads);
  const path_ = sel;
  if (ds) anchor = null; // inside a component: the element isn't in the frame's source, so there's nothing to tag
  if (anchor?.cid) sel = `[data-cid="${anchor.cid}"]`;
  else if (anchor && !String(sel || "").startsWith("#") && !readJSON(path.join(dir, LAYOUT), {}).source) { // generated pages: don't tag files a rebuild overwrites
    try { const cid = tagElement(dir, frame, anchor, id); if (cid) sel = `[data-cid="${cid}"]`; } catch {}
  }
  const t = { id, frame, sel, ...(sel !== path_ && { alt: path_ }), ...(ds && { ds }), text, x, y, ex, ey, status: "open", msgs: [msg] };
  data.threads.push(t);
  return t;
});

export const updateThread = (dir, id, fn) => editThreads(dir, (data) => {
  const t = data.threads.find((t) => t.id === id);
  if (!t) throw new Error(`no thread ${id}`);
  fn(t, data);
  return t;
});
export const deleteThread = (dir, id) => editThreads(dir, (data) => {
  const gone = data.threads.find((t) => t.id === id);
  data.threads = data.threads.filter((t) => t.id !== id);
  // its images go too, unless another thread on the page shows the same one
  const kept = new Set(data.threads.flatMap((t) => t.msgs.flatMap((m) => m.images || [])));
  for (const p of gone?.msgs.flatMap((m) => m.images || []) || []) if (!kept.has(p)) fs.rmSync(path.join(dir, p), { force: true });
});

// The queue. A thread waits on Claude when it's open and its latest message was sent with "Send to Claude".
// `canvas wait` claims what it hands to a session (t.working = time); a reply clears it. A claim older than
// CLAIM_TTL is treated as abandoned (the session died) and the thread queues again.
export const CLAIM_TTL = 30 * 60 * 1000;
export const waiting = (t) => t.status === "open" && t.msgs.at(-1)?.claude;
export const claimed = (t) => !!t.working && Date.now() - Date.parse(t.working) < CLAIM_TTL;
export const allThreads = (dir) => pages(dir).flatMap((pg) => threadsOf(pageDir(dir, pg.id)).threads.map((t) => ({ ...t, page: pg.id })));
export const queued = (dir) => allThreads(dir).filter((t) => waiting(t) && !claimed(t));

// Claims the threads of `list` that are still waiting and unclaimed when the lock is held, and returns them as they
// are then: another session may have claimed some in the meantime, and new messages may have arrived.
export function claim(dir, list) {
  const at = new Date().toISOString(), out = [];
  for (const pg of new Set(list.map((t) => t.page))) {
    const ids = new Set(list.filter((t) => t.page === pg).map((t) => t.id));
    editThreads(pageDir(dir, pg), (data) => {
      for (const t of data.threads) if (ids.has(t.id) && waiting(t) && !claimed(t)) {
        t.working = at; t.seen = t.msgs.length; // seen: what this session was handed
        out.push({ ...t, page: pg });
      }
    });
  }
  return out;
}

// Claude's answer to a thread. Someone may have replied while Claude was working on it: then the answer goes before
// those newer messages (it answers what Claude was handed), and if one of them was sent to Claude the thread stays
// in the queue, unresolved, instead of the answer burying it. Returns the newer messages Claude hasn't seen.
export function answer(t, msg, resolve) {
  const seen = t.seen ?? t.msgs.length, newer = t.msgs.slice(seen);
  delete t.working; delete t.seen;
  t.msgs.splice(seen, 0, msg);
  if (resolve && !newer.some((m) => m.claude)) t.status = "resolved";
  return newer;
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
