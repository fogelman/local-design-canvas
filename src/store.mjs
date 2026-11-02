// Canvas files on disk: json io, pages (subfolders), frames and their layout (canvas.json).
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
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
export const saveThreads = (dir, data) => writeJSON(path.join(dir, COMMENTS), data);

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
    return { file, title: meta.title || file.replace(/\.html$/, ""), x: pos.x, y: pos.y, w: pos.w || meta.w, h: pos.h || meta.h };
  });
  if (changed) writeJSON(layoutFile, layout);
  return { name: path.basename(dir), frames, threads: threadsOf(dir).threads, sections: layout.sections || [], source: layout.source || "" };
}
