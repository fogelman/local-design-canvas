// Per-directory file watching (recursive fs.watch on Linux misses files replaced by rename).
import fs from "node:fs";
import path from "node:path";
import { pages } from "./store.mjs";
// ---------- watching ----------
// One non-recursive watch per directory. Node's recursive fs.watch on Linux watches each file's inode, so once a
// file is replaced by rename (how every save here works: tmp + rename) later in-place writes to it go unseen.
// A directory watch reports by name, whatever replaced the file. New subdirectories (pages) get a watch too.
export function watchTree(root, onChange) {
  const watchers = new Map();
  const skip = (name) => name.startsWith(".") || name === "node_modules";
  const add = (dir) => {
    if (watchers.has(dir)) return;
    try {
      watchers.set(dir, fs.watch(dir, (_, name) => {
        if (!name) return;
        const full = path.join(dir, name);
        if (!skip(name) && !watchers.has(full) && fs.statSync(full, { throwIfNoEntry: false })?.isDirectory()) add(full);
        onChange(path.relative(root, full));
      }));
      for (const d of fs.readdirSync(dir, { withFileTypes: true })) if (d.isDirectory() && !skip(d.name)) add(path.join(dir, d.name));
    } catch {}
  };
  add(root);
  return { close: () => { for (const w of watchers.values()) w.close(); watchers.clear(); } };
}
