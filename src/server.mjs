// The local HTTP server: viewer, frames (components expanded), JSON API and live-reload events (SSE).
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { LAYOUT, me, pageDir, pages, readJSON, saveThreads, state, threadsOf, writeJSON } from "./store.mjs";
import { addThread, now, updateThread } from "./threads.mjs";
import { expandFile } from "./components.mjs";
import { watchTree } from "./watch.mjs";
export const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "viewer");

// ---------- server ----------
export const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".woff2": "font/woff2", ".ico": "image/x-icon" };

export function body(req) {
  return new Promise((resolve, reject) => {
    let s = "";
    req.on("data", (c) => (s += c));
    req.on("end", () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
  });
}

export function sendFile(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, { "content-type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream", "cache-control": "no-store" });
    res.end(buf);
  });
}

export function serve(dir, port) {
  const clients = new Set();
  const emit = (ev) => { for (const c of clients) c.write(`data: ${JSON.stringify(ev)}\n\n`); };
  const ownWrites = new Map(); // ignore watcher echo of our own layout saves
  let timer = null; const pending = new Set();
  watchTree(dir, (name) => {
    if (!name || name.includes(".tmp") || name.split(path.sep).some((p) => p.startsWith(".") || p === "node_modules")) return;
    if (ownWrites.get(name) > Date.now()) return;
    pending.add(name);
    clearTimeout(timer);
    timer = setTimeout(() => { emit({ type: "change", files: [...pending] }); pending.clear(); }, 80);
  });

  // open viewers reload when the canvas app itself changes
  let appTimer = null;
  watchTree(APP, () => { clearTimeout(appTimer); appTimer = setTimeout(() => emit({ type: "app" }), 150); });

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
          if (m[2] === "reply") {
            t.msgs.push({ by: b.by || me(), at: now(), body: b.body, ...(b.claude && { claude: true }) });
            delete t.working;
            t.status = "open"; // replying reopens a resolved thread (and, if sent to Claude, puts it back in Claude's queue)
          }
          if (m[2] === "status") t.status = b.status;
          if (m[2] === "move") Object.assign(t, { frame: b.frame, sel: b.sel, text: b.text, x: b.x, y: b.y, ex: b.ex, ey: b.ey });
        }));
      }
      if (p === "/_api/me") return json({ name: me() });
      // project files
      const file = path.join(dir, path.normalize(p).replace(/^(\.\.[/\\])+/, ""));
      if (file !== dir && !file.startsWith(dir + path.sep)) { res.writeHead(403); return res.end(); } // inside the canvas only
      if (file.endsWith(".html") && !file.split(path.sep).includes("_ds") && fs.existsSync(file)) {
        res.writeHead(200, { "content-type": TYPES[".html"], "cache-control": "no-store" });
        return res.end(expandFile(file, dir));
      }
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
