// Canvas files on disk: json io, pages (subfolders), frames and their layout (canvas.json).
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
export const LAYOUT = "canvas.json";
export const COMMENTS = "comments.json";
export const GAP = 120;
export const DEFAULT = { w: 1280, h: 800 };


// ---------- storage ----------
export const readJSON = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } };
export function writeJSON(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  fs.renameSync(tmp, file);
}
export const threadsOf = (dir) => readJSON(path.join(dir, COMMENTS), { threads: [] });

// Changing comments. The server (the person) and Claude's `canvas` commands are separate processes writing the same
// comments.json, so each change reads, edits and writes it under a lock file: without it, two changes at once keep
// only one of them. The lock is a dotfile (watchers and the snapshot version skip those) holding the owner's pid; a
// lock whose owner is gone, or older than STALE_LOCK_MS, is from a crash and is taken over.
const STALE_LOCK_MS = 10000;
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
export function withLock(file, fn) {
  const lock = path.join(path.dirname(file), `.${path.basename(file)}.lock`);
  for (const start = Date.now(); ;) {
    try { fs.writeFileSync(lock, String(process.pid), { flag: "wx" }); break; } catch (e) { if (e.code !== "EEXIST") throw e; }
    try {
      const owner = +fs.readFileSync(lock, "utf8"), age = Date.now() - fs.statSync(lock).mtimeMs;
      if ((owner && owner !== process.pid && !alive(owner)) || age > STALE_LOCK_MS) { fs.rmSync(lock, { force: true }); continue; }
    } catch {} // released between our two looks: try again
    if (Date.now() - start > 2 * STALE_LOCK_MS) throw new Error(`comments are locked by another process (${lock})`);
    pause(5);
  }
  try { return fn(); } finally { fs.rmSync(lock, { force: true }); }
}
// Read, change and save a page's comments in one locked step. A comments.json that can't be read is an error here,
// not an empty list: saving over it would erase every thread.
export function editThreads(dir, fn) {
  const file = path.join(dir, COMMENTS);
  return withLock(file, () => {
    let data = { threads: [] };
    if (fs.existsSync(file)) {
      try { data = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { throw new Error(`${file} isn't valid JSON (${e.message}); fix it before changing comments`); }
      data.threads ||= [];
    }
    const out = fn(data);
    writeJSON(file, data);
    return out;
  });
}

export function me() {
  try { return execSync("git config user.name", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || process.env.USER; } catch { return process.env.USER || "me"; }
}

export function htmlFiles(dir) {
  return fs.readdirSync(dir).filter((f) => f.endsWith(".html") && !f.startsWith(".") && !f.startsWith("_")).sort();
}

export function metaOf(file) {
  const head = fs.readFileSync(file, "utf8").slice(0, 4000);
  const size = head.match(/<meta\s+name=["']canvas:size["']\s+content=["'](\d+)\s*x\s*(\d+)["']/i);
  const title = head.match(/<title>([^<]*)<\/title>/i);
  return { w: size ? +size[1] : DEFAULT.w, h: size ? +size[2] : DEFAULT.h, title: title ? title[1].trim() : "" };
}

// A version of everything a screen can pull in (stylesheets, scripts, images, fonts, data, components). With each
// screen's own version it keys the pictures the viewer saves, so reopening a page shows them at once. It hashes the
// name, time and size of every file, so adding, deleting, renaming or restoring an older copy of one all count, not
// only the newest edit. Screens (html in the root or a page folder) are left out so editing one doesn't invalidate
// the others, and so are the canvas's own canvas.json and comments.json; any other json may be data a screen loads.
export function assetsVersion(dir) {
  const h = createHash("sha1");
  let n = 0;
  const walk = (d, depth) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (e.name.startsWith(".") || e.name === "node_modules" || e.name.endsWith(".tmp") || ++n > 20000) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (depth < 8) walk(p, depth + 1); continue; }
      if (e.name === LAYOUT || e.name === COMMENTS || (depth <= 1 && e.name.endsWith(".html") && !e.name.startsWith("_"))) continue;
      try { const st = fs.statSync(p); h.update(`${path.relative(dir, p)}\0${st.mtimeMs}\0${st.size}\n`); } catch {}
    }
  };
  walk(dir, 0);
  return h.digest("hex").slice(0, 16);
}
// A screen's own version: its file's time and size.
export const fileVersion = (file) => { const st = fs.statSync(file); return `${Math.round(st.mtimeMs)}-${st.size}`; };

// Pages = the canvas root ("Page 1") + immediate subfolders that hold html or a canvas.json.
export const SKIP = (n) => n.startsWith(".") || n.startsWith("_") || n === "node_modules";
export function pages(dir) {
  const named = (rel) => readJSON(path.join(dir, rel, LAYOUT), {}).name;
  const subs = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && !SKIP(d.name))
    .filter((d) => fs.existsSync(path.join(dir, d.name, LAYOUT)) || htmlFiles(path.join(dir, d.name)).length).map((d) => d.name).sort();
  return [{ id: "", name: named("") || "Page 1" }, ...subs.map((id) => ({ id, name: named(id) || id }))];
}
export function pageDir(dir, page) {
  if (!page) return dir;
  if (page.includes("/") || page.includes("\\") || SKIP(page) || !fs.statSync(path.join(dir, page), { throwIfNoEntry: false })?.isDirectory()) throw new Error(`no page ${page}`);
  return path.join(dir, page);
}

// Frames = html files + positions from canvas.json; new files get placed to the right of the last frame.
export function state(dir) {
  const layoutFile = path.join(dir, LAYOUT);
  const layout = readJSON(layoutFile, { frames: {} });
  layout.frames ||= {};
  const files = htmlFiles(dir);
  let right = Math.max(0, ...Object.entries(layout.frames).filter(([f]) => files.includes(f)).map(([f, p]) => p.x + (p.w || metaOf(path.join(dir, f)).w)));
  let changed = false;
  const frames = files.map((file) => {
    const meta = metaOf(path.join(dir, file));
    let pos = layout.frames[file];
    if (!pos) {
      pos = layout.frames[file] = { x: right ? right + GAP : 0, y: 0 };
      right = pos.x + meta.w;
      changed = true;
    }
    const v = fileVersion(path.join(dir, file)); // the viewer keys its saved snapshot on this
    return { file, title: meta.title || file.replace(/\.html$/, ""), x: pos.x, y: pos.y, w: pos.w || meta.w, h: pos.h || meta.h, v };
  });
  if (changed) writeJSON(layoutFile, layout);
  return { name: path.basename(dir), frames, threads: threadsOf(dir).threads, sections: layout.sections || [], source: layout.source || "" };
}
