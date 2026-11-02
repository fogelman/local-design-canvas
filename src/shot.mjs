// canvas shot: render one frame to PNG with headless Chrome.
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { LAYOUT, metaOf, readJSON, threadsOf } from "./store.mjs";
import { splitId } from "./threads.mjs";
import { expandFile } from "./components.mjs";
// ---------- shot: PNG of one frame via headless Chrome (no server, no deps) ----------
export function chrome() {
  if (process.env.CANVAS_CHROME) return process.env.CANVAS_CHROME;
  for (const bin of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
    try { return execSync(`command -v ${bin}`, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch {}
  }
  const cache = path.join(process.env.HOME || "", ".cache/ms-playwright");
  const found = fs.existsSync(cache) && fs.readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse()
    .map((d) => path.join(cache, d, "chrome-linux64", "chrome")).find((f) => fs.existsSync(f));
  if (found) return found;
  throw new Error("no Chrome found; set CANVAS_CHROME=/path/to/chrome");
}
// target: a frame ("login", "login.html", "checkout/cart") or a thread id ("c4", "checkout/c2")
export function shot(dir, target, out, scale) {
  let rel = target;
  if (/^(?:[^/]+\/)?c\d+$/.test(target)) {
    const [pd, id] = splitId(dir, target);
    const t = threadsOf(pd).threads.find((x) => x.id === id);
    if (!t?.frame) throw new Error(`${target} isn't on a frame`);
    rel = path.join(path.relative(dir, pd), t.frame);
  }
  if (!rel.endsWith(".html")) rel += ".html";
  const file = path.join(dir, rel);
  if (!fs.existsSync(file)) throw new Error(`no frame ${rel}`);
  const pd = path.dirname(file), name = path.basename(file);
  const pos = readJSON(path.join(pd, LAYOUT), { frames: {} }).frames?.[name] || {};
  const meta = metaOf(file);
  const w = pos.w || meta.w, h = pos.h || meta.h;
  out ||= path.join("/tmp/canvas-shots", `${path.basename(dir)}-${rel.replace(/[/\\]/g, "-").replace(/\.html$/, "")}.png`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const raw = fs.readFileSync(file, "utf8"), expanded = raw.includes("<ds-") ? expandFile(file, dir) : null;
  const shotFile = expanded ? path.join(pd, `.shot-${process.pid}-${name}`) : file;
  if (expanded) fs.writeFileSync(shotFile, expanded);
  try {
    execSync(`"${chrome()}" --headless=new --no-sandbox --disable-gpu --hide-scrollbars --force-device-scale-factor=${scale} --virtual-time-budget=2000 --window-size=${w},${h} --screenshot="${out}" "file://${shotFile}"`, { stdio: "ignore", timeout: 30000 });
  } finally { if (expanded) fs.rmSync(shotFile, { force: true }); }
  return { out, w, h };
}
