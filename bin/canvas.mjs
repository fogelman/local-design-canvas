#!/usr/bin/env node
// canvas — offline design canvas: every *.html in a folder is a live frame; comments live in comments.json.
// Zero dependencies. See README.md.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { execSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "app");
const LAYOUT = "canvas.json";
const COMMENTS = "comments.json";
const GAP = 120;
const DEFAULT = { w: 1280, h: 800 };

// ---------- storage ----------
const readJSON = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } };
function writeJSON(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  fs.renameSync(tmp, file);
}
const threadsOf = (dir) => readJSON(path.join(dir, COMMENTS), { threads: [] });
const saveThreads = (dir, data) => writeJSON(path.join(dir, COMMENTS), data);

function me() {
  try { return execSync("git config user.name", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || process.env.USER; } catch { return process.env.USER || "me"; }
}

function htmlFiles(dir) {
  return fs.readdirSync(dir).filter((f) => f.endsWith(".html") && !f.startsWith(".") && !f.startsWith("_")).sort();
}

function metaOf(file) {
  const head = fs.readFileSync(file, "utf8").slice(0, 4000);
  const size = head.match(/<meta\s+name=["']canvas:size["']\s+content=["'](\d+)\s*x\s*(\d+)["']/i);
  const title = head.match(/<title>([^<]*)<\/title>/i);
  return { w: size ? +size[1] : DEFAULT.w, h: size ? +size[2] : DEFAULT.h, title: title ? title[1].trim() : "" };
}

// Pages = the canvas root ("Page 1") + immediate subfolders that hold html or a canvas.json.
const SKIP = (n) => n.startsWith(".") || n.startsWith("_") || n === "node_modules";
function pages(dir) {
  const named = (rel) => readJSON(path.join(dir, rel, LAYOUT), {}).name;
  const subs = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && !SKIP(d.name))
    .filter((d) => fs.existsSync(path.join(dir, d.name, LAYOUT)) || htmlFiles(path.join(dir, d.name)).length).map((d) => d.name).sort();
  return [{ id: "", name: named("") || "Page 1" }, ...subs.map((id) => ({ id, name: named(id) || id }))];
}
function pageDir(dir, page) {
  if (!page) return dir;
  if (page.includes("/") || page.includes("\\") || SKIP(page) || !fs.statSync(path.join(dir, page), { throwIfNoEntry: false })?.isDirectory()) throw new Error(`no page ${page}`);
  return path.join(dir, page);
}

// Frames = html files + positions from canvas.json; new files get placed to the right of the last frame.
function state(dir) {
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

// ---------- threads ----------
const nextId = (threads) => `c${1 + Math.max(0, ...threads.map((t) => +String(t.id).slice(1) || 0))}`;
const now = () => new Date().toISOString().slice(0, 16).replace("T", " ");

// Stable anchors: tag the commented element in the frame's source with data-cid="<thread id>", so the
// comment survives edits that break CSS selectors and Claude finds it with one grep. Only when the live DOM
// still mirrors the source (same count of that tag, so the nth live <tag> is the nth <tag> in the file).
function tagElement(dir, frame, { tag, tagIndex, tagCount }, cid) {
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

function addThread(dir, { frame, sel, text, x, y, ex, ey, body, by, claude, anchor }) {
  const data = threadsOf(dir);
  const id = nextId(data.threads);
  const path_ = sel;
  if (anchor?.cid) sel = `[data-cid="${anchor.cid}"]`;
  else if (anchor && !String(sel || "").startsWith("#") && !readJSON(path.join(dir, LAYOUT), {}).source) { // generated pages: don't tag files a rebuild overwrites
    try { const cid = tagElement(dir, frame, anchor, id); if (cid) sel = `[data-cid="${cid}"]`; } catch {}
  }
  const t = { id, frame, sel, ...(sel !== path_ && { alt: path_ }), text, x, y, ex, ey, status: "open", msgs: [{ by: by || me(), at: now(), body, ...(claude && { claude: true }) }] };
  data.threads.push(t);
  saveThreads(dir, data);
  return t;
}

function updateThread(dir, id, fn) {
  const data = threadsOf(dir);
  const t = data.threads.find((t) => t.id === id);
  if (!t) throw new Error(`no thread ${id}`);
  fn(t, data);
  saveThreads(dir, data);
  return t;
}

// ---------- server ----------
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".woff2": "font/woff2", ".ico": "image/x-icon" };

function body(req) {
  return new Promise((resolve, reject) => {
    let s = "";
    req.on("data", (c) => (s += c));
    req.on("end", () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
  });
}

function sendFile(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, { "content-type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream", "cache-control": "no-store" });
    res.end(buf);
  });
}

function serve(dir, port) {
  const clients = new Set();
  const emit = (ev) => { for (const c of clients) c.write(`data: ${JSON.stringify(ev)}\n\n`); };
  const ownWrites = new Map(); // ignore watcher echo of our own layout saves
  let timer = null; const pending = new Set();
  fs.watch(dir, { recursive: true }, (_, name) => {
    if (!name || name.includes(".tmp") || name.split(path.sep).some((p) => p.startsWith(".") || p === "node_modules")) return;
    if (ownWrites.get(name) > Date.now()) return;
    pending.add(name);
    clearTimeout(timer);
    timer = setTimeout(() => { emit({ type: "change", files: [...pending] }); pending.clear(); }, 80);
  });

  // open viewers reload when the canvas app itself changes
  let appTimer = null;
  fs.watch(APP, () => { clearTimeout(appTimer); appTimer = setTimeout(() => emit({ type: "app" }), 150); });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const p = decodeURIComponent(url.pathname);
    const json = (data, code = 200) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
    try {
      if (p === "/") return sendFile(res, path.join(APP, "index.html"));
      if (p.startsWith("/_app/")) return sendFile(res, path.join(APP, path.normalize(p.slice(6)).replace(/^(\.\.[/\\])+/, "")));
      if (p === "/_api/events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        res.write(": hi\n\n");
        clients.add(res);
        return req.on("close", () => clients.delete(res));
      }
      const page = url.searchParams.get("page") || "";
      const base = pageDir(dir, page);
      if (p === "/_api/state") return json({ ...state(base), name: path.basename(dir), page, pages: pages(dir) });
      if (p === "/_api/pages" && req.method === "POST") {
        const { name } = await body(req);
        const all = pages(dir);
        let id = String(name || "page").toLowerCase().normalize("NFD").replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-") || "page";
        for (let i = 2; fs.existsSync(path.join(dir, id)); i++) id = id.replace(/-\d+$/, "") + `-${i}`;
        fs.mkdirSync(path.join(dir, id));
        writeJSON(path.join(dir, id, LAYOUT), { name: name || `Page ${all.length + 1}`, frames: {} });
        return json({ id });
      }
      if (p === "/_api/pages" && req.method === "DELETE") {
        if (!page) throw new Error("the first page is the canvas folder itself");
        const trash = path.join(dir, ".trash");
        fs.mkdirSync(trash, { recursive: true });
        fs.renameSync(base, path.join(trash, `${page}-${new Date().toISOString().replace(/[:.]/g, "-")}`));
        return json({ ok: true });
      }
      if (p === "/_api/pages" && req.method === "PUT") {
        const { name } = await body(req);
        const f = path.join(base, LAYOUT);
        writeJSON(f, { ...readJSON(f, { frames: {} }), name });
        return json({ ok: true });
      }
      if (p === "/_api/layout" && req.method === "PUT") {
        const b = await body(req);
        const edits = b.frames || { [b.file]: b }; // { frames: { file: {x,y,w,h} } } or one { file, x, y, w, h }
        const file_ = path.join(base, LAYOUT);
        const layout = readJSON(file_, { frames: {} });
        layout.frames ||= {};
        for (const [file, { x, y, w, h }] of Object.entries(edits)) {
          if (!file || file.includes("/") || !file.endsWith(".html")) continue;
          layout.frames[file] = { ...layout.frames[file], ...Object.fromEntries(Object.entries({ x, y, w, h }).filter(([, v]) => v != null).map(([k, v]) => [k, Math.round(v)])) };
        }
        ownWrites.set(path.join(page, LAYOUT), Date.now() + 400);
        writeJSON(file_, layout);
        return json({ ok: true });
      }
      if (p === "/_api/threads" && req.method === "POST") return json(addThread(base, await body(req)));
      const m = p.match(/^\/_api\/threads\/([\w-]+)\/(reply|status|move|delete)$/);
      if (m && req.method === "POST") {
        const b = await body(req);
        if (m[2] === "delete") {
          const data = threadsOf(base); data.threads = data.threads.filter((t) => t.id !== m[1]); saveThreads(base, data); return json({ ok: true });
        }
        return json(updateThread(base, m[1], (t) => {
          if (m[2] === "reply") t.msgs.push({ by: b.by || me(), at: now(), body: b.body, ...(b.claude && { claude: true }) });
          if (m[2] === "status") t.status = b.status;
          if (m[2] === "move") Object.assign(t, { frame: b.frame, sel: b.sel, text: b.text, x: b.x, y: b.y, ex: b.ex, ey: b.ey });
        }));
      }
      if (p === "/_api/me") return json({ name: me() });
      // project files
      const file = path.join(dir, path.normalize(p).replace(/^(\.\.[/\\])+/, ""));
      if (!file.startsWith(dir)) { res.writeHead(403); return res.end(); }
      return sendFile(res, file);
    } catch (e) {
      json({ error: String(e.message || e) }, 500);
    }
  });
  server.listen(port, "127.0.0.1", () => {
    const url = `http://127.0.0.1:${server.address().port}/`;
    console.log(`canvas: ${dir}\n  ${url}`);
    if (!process.argv.includes("--no-open")) {
      const [cmd, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
      try { spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref(); } catch {}
    }
  });
  server.on("error", (e) => {
    if (e.code === "EADDRINUSE") { console.log(`port ${port} busy, trying ${port + 1}`); serve(dir, port + 1); } else throw e;
  });
}

// ---------- cli ----------
let CSS = '<link rel="stylesheet" href="styles.css">';
const FRAME = (title, w, h) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="canvas:size" content="${w}x${h}">
<title>${title}</title>
${CSS}
</head>
<body>
  <main>
    <h1>${title}</h1>
  </main>
</body>
</html>
`;

// A thread waits on Claude when it's open and its latest message was sent with "Send to Claude".
const waiting = (t) => t.status === "open" && t.msgs.at(-1)?.claude;
function printThreads(dir, mode) {
  const keep = { all: () => true, open: (t) => t.status === "open", claude: waiting }[mode];
  const list = pages(dir).flatMap((pg) => threadsOf(pageDir(dir, pg.id)).threads.map((t) => ({ ...t, page: pg.id }))).filter(keep);
  if (!list.length) return console.log({ all: "no comments", open: "no open comments", claude: "nothing waiting on Claude" }[mode]);
  const noted = new Set();
  for (const t of list) {
    const pre = t.page ? `${t.page}/` : "";
    const source = readJSON(path.join(pageDir(dir, t.page), LAYOUT), {}).source;
    if (source && !noted.has(t.page)) { noted.add(t.page); console.log(`# ${t.page || "page 1"}: ${source}`); }
    const where = [t.frame ? pre + t.frame : `${pre || "page 1 "}canvas (${t.x},${t.y})`, t.sel].filter(Boolean).join(" › ");
    console.log(`${pre}${t.id}${mode === "all" ? ` [${t.status}]` : ""} ${where}${t.text ? ` "${t.text}"` : ""}`);
    for (const m of t.msgs) console.log(`  ${m.by}${m.claude ? " @Claude" : ""}: ${m.body.replace(/\n/g, "\n    ")}`);
  }
}

function flag(args, name) {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, v && !v.startsWith("--") ? 2 : 1);
  return v && !v.startsWith("--") ? v : true;
}

// ---------- shot: PNG of one frame via headless Chrome (no server, no deps) ----------
function chrome() {
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
function shot(dir, target, out, scale) {
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
  execSync(`"${chrome()}" --headless=new --no-sandbox --disable-gpu --hide-scrollbars --force-device-scale-factor=${scale} --virtual-time-budget=2000 --window-size=${w},${h} --screenshot="${out}" "file://${file}"`, { stdio: "ignore", timeout: 30000 });
  return { out, w, h };
}

// "checkout/c3" → [<dir>/checkout, "c3"]; "c3" → [<dir>, "c3"]
const splitId = (dir, id) => { const i = String(id).lastIndexOf("/"); return i < 0 ? [dir, id] : [pageDir(dir, id.slice(0, i)), id.slice(i + 1)]; };

const HELP = `canvas — offline design canvas with comment threads

  canvas [dir] [--port N] [--no-open]   serve dir as a canvas (every *.html = a frame)
  canvas new <name> [WxH] [--dir d]     create <name>.html (default 1280x800; 390x844 for mobile)
  canvas comments [--open|--all] [--dir d]   threads waiting on Claude (default) · all open · everything
  canvas reply <id> <text> [--resolve] [--by name] [--dir d]
  canvas shot <frame|id> [--out f.png] [--scale 2] [--dir d]   PNG of one frame (or a thread's frame)
  canvas resolve <id> [--dir d]         mark thread resolved
  canvas reopen <id> [--dir d]

Files in the canvas dir: *.html frames · canvas.json positions · comments.json threads.
Pages: each subfolder with html (or a canvas.json) is another page with its own files; ids print as page/c1.
Design system: a project may put its own stylesheet at <dir>/_ds/ds.css; \`canvas new\` links it.
Frame size: <meta name="canvas:size" content="390x844"> in the html head.`;

const args = process.argv.slice(2);
const cmd = args[0];
const dirFlag = flag(args, "--dir");
const dirOf = (d) => path.resolve(typeof d === "string" ? d : ".");

if (cmd === "-h" || cmd === "--help" || cmd === "help") console.log(HELP);
else if (cmd === "new") {
  const dir = dirOf(dirFlag);
  const name = args[1];
  if (!name) { console.error("usage: canvas new <name> [WxH]"); process.exit(1); }
  const [w, h] = (args[2] || "1280x800").split("x").map(Number);
  const file = path.join(dir, name.endsWith(".html") ? name : `${name}.html`);
  if (fs.existsSync(file)) { console.error(`${file} exists`); process.exit(1); }
  const ds = fs.existsSync(path.join(path.dirname(file), "_ds", "ds.css")) ? "_ds/ds.css" : fs.existsSync(path.join(dir, "_ds", "ds.css")) ? path.relative(path.dirname(file), path.join(dir, "_ds", "ds.css")) : null;
  if (ds) CSS = `<link rel="stylesheet" href="${ds}">`;
  fs.writeFileSync(file, FRAME(name.replace(/\.html$/, "").replace(/[-_]/g, " ").replace(/^\w/, (c) => c.toUpperCase()), w, h));
  if (!ds && !fs.existsSync(path.join(dir, "styles.css"))) fs.writeFileSync(path.join(dir, "styles.css"), "* { box-sizing: border-box; }\nbody { margin: 0; font: 14px/1.4 system-ui, sans-serif; }\n");
  console.log(file);
} else if (cmd === "comments") {
  printThreads(dirOf(dirFlag), flag(args, "--all") ? "all" : flag(args, "--open") ? "open" : "claude");
} else if (cmd === "reply") {
  const resolve = flag(args, "--resolve");
  const by = flag(args, "--by");
  const [, id, ...text] = args;
  if (!id || !text.length) { console.error("usage: canvas reply <id> <text> [--resolve]"); process.exit(1); }
  const [pd, tid] = splitId(dirOf(dirFlag), id);
  updateThread(pd, tid, (t) => { t.msgs.push({ by: by || "Claude", at: now(), body: text.join(" ") }); if (resolve) t.status = "resolved"; });
  console.log(`${id} replied${resolve ? " + resolved" : ""}`);
} else if (cmd === "shot") {
  const out = flag(args, "--out"), scale = flag(args, "--scale") || 1;
  if (!args[1]) { console.error("usage: canvas shot <frame|thread-id> [--out file.png] [--scale 2]"); process.exit(1); }
  const r = shot(dirOf(dirFlag), args[1], typeof out === "string" ? out : null, scale);
  console.log(`${r.out} (${r.w}x${r.h})`);
} else if (cmd === "resolve" || cmd === "reopen") {
  updateThread(...splitId(dirOf(dirFlag), args[1]), (t) => (t.status = cmd === "resolve" ? "resolved" : "open"));
  console.log(`${args[1]} ${cmd === "resolve" ? "resolved" : "reopened"}`);
} else {
  const port = +(flag(args, "--port") || 4747);
  const dir = dirOf(dirFlag || (cmd && !cmd.startsWith("--") ? cmd : "."));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  serve(dir, port);
}
