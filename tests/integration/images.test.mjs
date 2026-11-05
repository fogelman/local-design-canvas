// Images in comments: uploads from the browser, `canvas reply --image`, what Claude sees, and cleanup.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { canvas, makeCanvas, cleanup, page, startServer } from "../helpers.mjs";

// a real 1×1 png
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
let dir, server;
before(async () => { dir = makeCanvas({ "a.html": page("A", "<h1>Hi</h1>"), "pg/b.html": page("B") }); server = await startServer(dir); });
after(() => { server?.stop(); cleanup(dir); });
const upload = (buf, type = "image/png", pg = "") => fetch(`${server.url}_api/images${pg ? `?page=${pg}` : ""}`, { method: "POST", headers: { "content-type": type }, body: buf });
const post = (p, body) => fetch(server.url + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const comments = (d = dir) => JSON.parse(fs.readFileSync(path.join(d, "comments.json"), "utf8"));

test("an image uploaded from the browser is stored by content, served, and shown to Claude as a file to Read", async () => {
  const r = await upload(PNG);
  assert.equal(r.status, 200);
  const { path: rel } = await r.json();
  assert.match(rel, /^\.comment-images\/[0-9a-f]{16}\.png$/);
  assert.deepEqual(await (await upload(PNG)).json(), { path: rel }, "the same image is stored once");
  const served = await fetch(server.url + rel);
  assert.equal(served.headers.get("content-type"), "image/png");
  assert.ok(Buffer.from(await served.arrayBuffer()).equals(PNG));

  const t = await (await post("_api/threads", { frame: "a.html", body: "like this", images: [rel], claude: true })).json();
  assert.deepEqual(t.msgs[0].images, [rel]);
  const out = canvas(["comments", "--dir", dir]).out;
  assert.ok(out.includes(`image: ${path.join(dir, rel)}`), out);
  // a reply can be only an image
  assert.equal((await post(`_api/threads/${t.id}/reply`, { body: "", images: [rel] })).status, 200);
  assert.equal((await post(`_api/threads/${t.id}/reply`, { body: "  " })).status, 500, "but not empty");
});

test("only real images are accepted, and a message can't point at other files", async () => {
  for (const [buf, type] of [[Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>"), "image/svg+xml"], [Buffer.from("hello"), "image/png"]]) {
    const r = await upload(buf, type);
    assert.equal(r.status, 500);
    assert.match((await r.json()).error, /not an image/);
  }
  const big = Buffer.alloc(16 * 1024 * 1024); PNG.copy(big);
  assert.equal((await upload(big)).status, 500, "over the size limit");
  const t = await (await post("_api/threads", { frame: "a.html", body: "x", images: ["a.html", "../../etc/passwd", ".comment-images/0000000000000000.png"] })).json();
  assert.equal(t.msgs[0].images, undefined, "unknown, outside or missing paths are dropped");
  assert.ok(!fs.readdirSync(path.join(dir, ".comment-images")).some((f) => f.endsWith(".tmp")));
});

test("images live with their page, and don't change what screens look like", async () => {
  const before_ = (await (await fetch(`${server.url}_api/state`)).json()).assets;
  const { path: rel } = await (await upload(PNG, "image/png", "pg")).json();
  assert.ok(fs.existsSync(path.join(dir, "pg", rel)));
  assert.equal((await (await fetch(`${server.url}_api/state`)).json()).assets, before_, "no screen re-pictured");
  assert.ok(!(await (await fetch(`${server.url}_api/state`)).json()).pages.some((p) => p.id.startsWith(".")), "not a page");
});

test("Claude attaches images with `canvas reply --image`, and deleting a thread deletes its images", async () => {
  const t = await (await post("_api/threads", { frame: "a.html", body: "show me", claude: true })).json();
  const shot = path.join(dir, "..", `${path.basename(dir)}-shot.png`);
  fs.writeFileSync(shot, PNG);
  try {
    const r = canvas(["reply", t.id, "done, see", "--image", shot, "--dir", dir]);
    assert.equal(r.code, 0, r.err);
    const msg = comments().threads.find((x) => x.id === t.id).msgs.at(-1);
    assert.equal(msg.by, "Claude");
    assert.match(msg.images[0], /^\.comment-images\/[0-9a-f]{16}\.png$/);
    fs.writeFileSync(shot, "not a picture");
    const bad = canvas(["reply", t.id, "x", "--image", shot, "--dir", dir]);
    assert.notEqual(bad.code, 0);
    assert.match(bad.err, /not an image/);
  } finally { fs.rmSync(shot, { force: true }); }
  // the png is also used by the first test's thread: deleting this one keeps it; a unique one goes
  const own = Buffer.concat([PNG, Buffer.from("unique")]);
  const { path: mine } = await (await upload(own)).json();
  const u = await (await post("_api/threads", { frame: "a.html", body: "only here", images: [mine] })).json();
  const shared = comments().threads.find((x) => x.id === t.id).msgs.at(-1).images[0];
  await post(`_api/threads/${u.id}/delete`, {});
  await post(`_api/threads/${t.id}/delete`, {});
  assert.ok(!fs.existsSync(path.join(dir, mine)), "its own image is deleted");
  assert.ok(fs.existsSync(path.join(dir, shared)), "an image another thread shows stays");
});
