// Creating, opening and listing canvases: `canvas create`, `canvas open` (and the short `canvas <dir>`), `canvas list`.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { ROOT, canvas, cleanup, makeCanvas, page, sleep, startServer } from "../helpers.mjs";

test("create makes the folder and canvas.json, and refuses an existing canvas", () => {
  const root = makeCanvas();
  try {
    const dir = path.join(root, "docs", "checkout");
    const r = canvas(["create", dir]);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "canvas.json"))), { frames: {} });
    assert.match(r.out, /canvas open/);
    assert.equal(canvas(["new", "cart", "--dir", dir]).code, 0, "a new canvas takes screens right away");
    const again = canvas(["create", dir]);
    assert.equal(again.code, 1);
    assert.match(again.err, /already a canvas/);
    assert.equal(canvas(["create"]).code, 1, "needs a folder");
  } finally { cleanup(root); }
});

test("open, and the short form, never create a missing folder", () => {
  const root = makeCanvas();
  try {
    for (const args of [["open", path.join(root, "typo")], [path.join(root, "typo")], ["--dir", path.join(root, "typo")]]) {
      const r = canvas(args);
      assert.equal(r.code, 1, args.join(" "));
      assert.match(r.err, /no canvas folder at .*typo[\s\S]*canvas create/);
    }
    assert.ok(!fs.existsSync(path.join(root, "typo")));
    const word = canvas(["commnets"], { cwd: root });
    assert.match(word.err, /canvas --help/, "a bare word may be a mistyped command");
    assert.ok(!fs.existsSync(path.join(root, "commnets")));
  } finally { cleanup(root); }
});

test("list shows running servers with comments waiting, and forgets them when they stop", async () => {
  const runtime = makeCanvas(), env = { XDG_RUNTIME_DIR: runtime };
  const a = makeCanvas({ "a.html": page("A"), "comments.json": { threads: [{ id: "c1", frame: "a.html", status: "open", msgs: [{ by: "Ana", at: "", body: "x", claude: true }] }] } });
  const b = makeCanvas({ "b.html": page("B") });
  let sa, sb;
  try {
    assert.equal(canvas(["list"], { env }).out, "no canvases open");
    sa = await startServer(a, { env });
    sb = await startServer(b, { env });
    const out = canvas(["list"], { env }).out.split("\n");
    assert.equal(out.length, 2);
    assert.ok(out.some((l) => l.startsWith(sa.url) && l.includes(a) && /1 waiting on Claude/.test(l)), out.join("\n"));
    assert.ok(out.some((l) => l.startsWith(sb.url) && l.includes(b) && !/waiting/.test(l)), out.join("\n"));
    const json = JSON.parse(canvas(["list", "--json"], { env }).out);
    assert.deepEqual(json.map((e) => e.dir).sort(), [a, b].sort());

    sa.stop(); // SIGTERM: the server removes its own entry
    process.kill(sb.pid, "SIGKILL"); // no chance to clean up: list drops the stale entry
    for (let i = 0; i < 50 && canvas(["list"], { env }).out !== "no canvases open"; i++) await sleep(100);
    assert.equal(canvas(["list"], { env }).out, "no canvases open");
    assert.deepEqual(fs.readdirSync(path.join(runtime, "local-design-canvas")), []);
  } finally { sa?.stop(); sb?.stop(); for (const d of [runtime, a, b]) cleanup(d); }
});

test("open restarts its server on the same port when the canvas tool is updated, and never leaves one orphaned", async () => {
  // a copy of the tool, so the test can "update" it
  const tool = makeCanvas(), runtime = makeCanvas(), env = { XDG_RUNTIME_DIR: runtime };
  const dir = makeCanvas({ "a.html": page("A") });
  fs.cpSync(path.join(ROOT, "src"), path.join(tool, "src"), { recursive: true });
  fs.cpSync(path.join(ROOT, "viewer"), path.join(tool, "viewer"), { recursive: true });
  fs.copyFileSync(path.join(ROOT, "package.json"), path.join(tool, "package.json"));
  const entries = () => JSON.parse(canvas(["list", "--json"], { env }).out || "[]");
  const child = spawn(process.execPath, [path.join(tool, "src", "cli.mjs"), "open", dir, "--no-open", "--port", "0"], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  try {
    for (let i = 0; i < 50 && !/localhost:\d+/.test(out); i++) await sleep(100);
    const url = out.match(/http:\/\/localhost:\d+\//)[0];
    for (let i = 0; i < 30 && !entries().length; i++) await sleep(100);
    const [before] = entries();
    assert.equal(before.url, url);

    // an update to the tool: the server answers a new route only after a restart
    const server = path.join(tool, "src", "server.mjs");
    fs.writeFileSync(server, fs.readFileSync(server, "utf8").replace(`if (p === "/_api/me")`, `if (p === "/_api/updated") return json({ ok: true });\n      if (p === "/_api/me")`));
    let r = null;
    for (let i = 0; i < 60; i++) { await sleep(100); r = await fetch(url + "_api/updated").then((x) => x.json()).catch(() => null); if (r?.ok) break; }
    assert.deepEqual(r, { ok: true }, "the new code answers, on the same port");
    const after = entries();
    assert.equal(after.length, 1);
    assert.equal(after[0].url, url);
    assert.notEqual(after[0].pid, before.pid, "a new server process");

    // the `canvas open` process killed outright: its server goes too
    child.kill("SIGKILL");
    for (let i = 0; i < 50 && entries().length; i++) await sleep(100);
    assert.deepEqual(entries(), []);
    assert.equal(await fetch(url + "_api/me").then(() => "up", () => "down"), "down");
  } finally { child.kill("SIGKILL"); for (const d of [tool, runtime, dir]) cleanup(d); }
});
