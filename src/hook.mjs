// Plugin SessionStart hook: find canvases in a project and tell Claude which have comments waiting.
import fs from "node:fs";
import path from "node:path";
import { LAYOUT, pages, readJSON } from "./store.mjs";
import { allThreads, waiting } from "./threads.mjs";
// ---------- session hook (plugin): tell Claude about canvases in the project ----------
// A canvas root is a directory with canvas.json whose parent has none (its pages are subfolders with their own).
export const SKIP_DIRS = new Set(["node_modules", "dist", "build", "coverage", "vendor", "target", "out"]);
export function findCanvases(root, maxDepth = 6) {
  const found = [];
  const walk = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    if (entries.some((e) => e.isFile() && e.name === LAYOUT) && !fs.existsSync(path.join(path.dirname(dir), LAYOUT))) { found.push(dir); return; }
    if (depth < maxDepth) for (const e of entries) if (e.isDirectory() && !e.name.startsWith(".") && !SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), depth + 1);
  };
  walk(root, 0);
  return found;
}
export function sessionNote(root) {
  const lines = [];
  for (const c of findCanvases(root)) {
    const waitingN = allThreads(c).filter(waiting).length, watch = readJSON(path.join(c, LAYOUT), {}).claudeWatch;
    if (!waitingN && watch !== true) continue;
    const rel = path.relative(root, c) || ".";
    lines.push(`- ${rel}: ${waitingN ? `${waitingN} comment(s) waiting for Claude` : "nothing waiting"}${watch === true ? `; watch is on, so start \`canvas wait --dir ${rel}\` in the background` : ""}`);
  }
  return lines.length ? `Design canvases in this project (see the canvas skill):\n${lines.join("\n")}` : "";
}
