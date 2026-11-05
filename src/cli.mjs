#!/usr/bin/env node
// Command-line entry point (npm bin, and bin/canvas for the plugin).
import fs from "node:fs";
import path from "node:path";
import { LAYOUT, pageDir, readJSON, writeJSON } from "./store.mjs";
import { allThreads, answer, message, saveImage, claim, claimed, now, queued, splitId, updateThread, waitForQueue, waiting } from "./threads.mjs";
import { listComponents } from "./components.mjs";
import { sessionNote } from "./hook.mjs";
import { serve } from "./server.mjs";
import { supervise } from "./supervisor.mjs";
import { running } from "./registry.mjs";
import { shot } from "./shot.mjs";
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

function printThreads(dir, mode, given) {
  const keep = { all: () => true, open: (t) => t.status === "open", claude: waiting }[mode];
  const list = given || allThreads(dir).filter(keep);
  if (!list.length) return console.log({ all: "no comments", open: "no open comments", claude: "nothing waiting on Claude" }[mode]);
  const noted = new Set();
  for (const t of list) {
    const pre = t.page ? `${t.page}/` : "";
    const source = readJSON(path.join(pageDir(dir, t.page), LAYOUT), {}).source;
    if (source && !noted.has(t.page)) { noted.add(t.page); console.log(`# ${t.page || "page 1"}: ${source}`); }
    const where = [t.frame ? pre + t.frame : `${pre || "page 1 "}canvas (${t.x},${t.y})`, t.ds ? `⟨${t.ds}⟩` : t.sel].filter(Boolean).join(" › ");
    console.log(`${pre}${t.id}${mode === "all" ? ` [${t.status}]` : claimed(t) && !given ? " [working]" : ""} ${where}${t.text ? ` "${t.text}"` : ""}`);
    for (const m of t.msgs) {
      console.log(`  ${m.by}${m.claude ? " @Claude" : ""}: ${m.body.replace(/\n/g, "\n    ")}`);
      for (const img of m.images || []) console.log(`    image: ${path.join(pageDir(dir, t.page), img)}`); // absolute, to Read
    }
  }
}

function flag(args, name) {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, v && !v.startsWith("--") ? 2 : 1);
  return v && !v.startsWith("--") ? v : true;
}

const HELP = `canvas — offline design canvas with comment threads

  canvas create <dir>                   make <dir> a canvas (creates the folder and canvas.json; doesn't serve it)
  canvas open [dir] [--port N] [--no-open]   serve an existing canvas folder (every *.html = a frame)
  canvas [dir]                          short for \`canvas open [dir]\`
  canvas list [--json]                  canvases being served right now: url, folder, comments waiting on Claude
  canvas new <name> [WxH] [--dir d]     create <name>.html (default 1280x800; 390x844 for mobile)
  canvas comments [--open|--all] [--dir d]   threads waiting on Claude (default) · all open · everything
  canvas watch [on|off] [--dir d]        should Claude answer comments as they arrive? (asked once per canvas)
  canvas hook session-start             (plugin hook) print canvases in the project with comments waiting for Claude
  canvas ds [--dir d]                   list the project's components (<dir>/_ds/components) with their usage
  canvas wait [--settle 8] [--timeout s] [--dir d]   block until comments are queued for Claude, claim and print them
  canvas reply <id> <text> [--image f.png]… [--resolve] [--by name] [--dir d]   (images: png, jpg, gif, webp)
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
else if (cmd === "list" || cmd === "ls") {
  const list = running().map((e) => ({ ...e, waiting: fs.existsSync(e.dir) ? allThreads(e.dir).filter(waiting).length : 0 }));
  if (flag(args, "--json")) console.log(JSON.stringify(list, null, 2));
  else if (!list.length) console.log("no canvases open");
  else {
    const w = Math.max(...list.map((e) => e.url.length));
    for (const e of list) console.log(`${e.url.padEnd(w)}  ${e.dir}${e.waiting ? `  (${e.waiting} waiting on Claude)` : ""}`);
  }
} else if (cmd === "new") {
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
} else if (cmd === "hook") {
  // SessionStart hook: stdin is the hook's JSON ({ cwd, … }); stdout becomes session context (empty when nothing to say)
  let input = {};
  if (!process.stdin.isTTY) { try { input = JSON.parse(fs.readFileSync(0, "utf8") || "{}"); } catch {} }
  const root = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  const note = sessionNote(root);
  if (note) console.log(note);
} else if (cmd === "ds") {
  const rows = listComponents(dirOf(dirFlag));
  if (!rows.length) console.log("no components (a project installs them in <dir>/_ds/components/{atoms,molecules,organisms,templates}/)");
  const w = Math.max(...rows.map((r) => r[0].length), 0);
  for (const [id, usage] of rows) console.log(`${id.padEnd(w)}  ${usage}`);
} else if (cmd === "watch") {
  // per-canvas preference: should a Claude session keep `canvas wait` running and answer comments as they arrive?
  const dir = dirOf(dirFlag), file = path.join(dir, LAYOUT), layout = readJSON(file, { frames: {} });
  if (args[1] === "on" || args[1] === "off") { layout.claudeWatch = args[1] === "on"; writeJSON(file, layout); }
  else if (args[1]) { console.error("usage: canvas watch [on|off] [--dir d]"); process.exit(1); }
  console.log(layout.claudeWatch === undefined ? "unset" : layout.claudeWatch ? "on" : "off");
} else if (cmd === "wait") {
  const dir = dirOf(dirFlag);
  const settle = +(flag(args, "--settle") || 8) * 1000, timeout = +(flag(args, "--timeout") || 0) * 1000;
  let list = [];
  const end = timeout && Date.now() + timeout;
  while (!list.length) { // another session may claim the batch first: then keep waiting
    const left = end ? end - Date.now() : 0;
    if (end && left <= 0) break;
    list = claim(dir, await waitForQueue(dir, settle, left));
  }
  if (!list.length) { console.log("no comments (timed out)"); process.exit(2); }
  printThreads(dir, "claude", list);
  const shown = path.relative(process.cwd(), dir) || ".";
  const where = shown.startsWith("..") ? dir : shown; // relative only when it stays inside the cwd
  console.log(`\n${list.length} thread(s) claimed. Answer each with \`canvas reply <id> "…" [--resolve] --dir ${where}\`, then run \`canvas wait --dir ${where}\` again.`);
} else if (cmd === "reply") {
  const resolve = flag(args, "--resolve");
  const by = flag(args, "--by");
  const files = [];
  for (let f; (f = flag(args, "--image")) !== undefined;) files.push(f);
  const [, id, ...text] = args;
  if (!id || (!text.length && !files.length) || files.some((f) => f === true)) { console.error("usage: canvas reply <id> <text> [--image file.png]… [--resolve]"); process.exit(1); }
  const [pd, tid] = splitId(dirOf(dirFlag), id);
  const images = files.map((f) => { try { return saveImage(pd, fs.readFileSync(f)); } catch (e) { console.error(`${f}: ${e.message}`); process.exit(1); } });
  let newer = [];
  const t = updateThread(pd, tid, (t) => { newer = answer(t, message(pd, { by: by || "Claude", body: text.join(" "), images }), resolve); });
  const again = newer.some((m) => m.claude);
  console.log(`${id} replied${resolve && t.status === "resolved" ? " + resolved" : ""}`);
  if (newer.length) console.log(`\n${newer.length} newer message(s) arrived while you worked${again ? ", so the thread is queued again (not resolved)" : ""}:\n${newer.map((m) => `  ${m.by}: ${m.body}`).join("\n")}`);
} else if (cmd === "shot") {
  const out = flag(args, "--out"), scale = flag(args, "--scale") || 1;
  if (!args[1]) { console.error("usage: canvas shot <frame|thread-id> [--out file.png] [--scale 2]"); process.exit(1); }
  const r = shot(dirOf(dirFlag), args[1], typeof out === "string" ? out : null, scale);
  console.log(`${r.out} (${r.w}x${r.h})`);
} else if (cmd === "resolve" || cmd === "reopen") {
  updateThread(...splitId(dirOf(dirFlag), args[1]), (t) => (t.status = cmd === "resolve" ? "resolved" : "open"));
  console.log(`${args[1]} ${cmd === "resolve" ? "resolved" : "reopened"}`);
} else if (cmd === "create") {
  const target = dirFlag || args[1];
  if (!target || target === true) { console.error("usage: canvas create <dir>"); process.exit(1); }
  const dir = dirOf(target), file = path.join(dir, LAYOUT);
  if (fs.existsSync(dir) && !fs.statSync(dir).isDirectory()) { console.error(`${dir} is a file`); process.exit(1); }
  if (fs.existsSync(file)) { console.error(`${dir} is already a canvas; open it with \`canvas open ${target}\``); process.exit(1); }
  fs.mkdirSync(dir, { recursive: true });
  writeJSON(file, { frames: {} });
  console.log(`${dir}\n  add a screen: canvas new <name> [WxH] --dir ${target}\n  open it:      canvas open ${target}`);
} else {
  // `canvas open [dir]`, or the short form `canvas [dir]`. Never creates folders: a typo or a mistyped command shouldn't make a canvas.
  const port = +(flag(args, "--port") || 4747);
  const rest = (cmd === "open" ? args.slice(1) : args).filter((a) => !a.startsWith("--"));
  const target = typeof dirFlag === "string" ? dirFlag : rest[0] || ".";
  const dir = dirOf(target);
  if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
    const hint = cmd !== "open" && !dirFlag && !/[\\/.]/.test(target) ? ` (if you meant a command, see \`canvas --help\`)` : "";
    console.error(`no canvas folder at ${dir}${hint}\n  create one with: canvas create ${target}`);
    process.exit(1);
  }
  if (process.env.CANVAS_WORKER) { serve(dir, port); process.on("disconnect", () => process.exit(0)); } // the server, under `canvas open`
  else supervise(dir, port, !process.argv.includes("--no-open"));
}
