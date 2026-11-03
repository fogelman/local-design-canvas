// Creating, opening and listing canvases: `canvas create`, `canvas open` (and the short `canvas <dir>`), `canvas list`.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { canvas, cleanup, makeCanvas, page, sleep, startServer } from "../helpers.mjs";

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
