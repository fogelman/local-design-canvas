// Comments written at the same time by several processes: the server (people in the browser) and Claude's
// `canvas` commands. Every change reads, edits and writes comments.json, so without a lock two at once keep one.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { CLI, ROOT, canvas, makeCanvas, cleanup, page, startServer, sleep } from "../helpers.mjs";

const comments = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "comments.json"), "utf8"));
const thread = (id, body, extra = {}) => ({ id, frame: "a.html", status: "open", msgs: [{ by: "Ana", at: "", body, ...extra }] });
const run = (args) => new Promise((resolve) => {
  const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.on("exit", (code) => resolve({ code, out }));
});
// a process that adds `n` replies to c1 as fast as it can, the way `canvas reply` does
const writer = (dir, who, n) => run(["--input-type=module", "-e", `
  import { updateThread } from ${JSON.stringify(path.join(ROOT, "src", "threads.mjs"))};
  for (let i = 0; i < ${n}; i++) updateThread(${JSON.stringify(dir)}, "c1", (t) => t.msgs.push({ by: "${who}", body: "${who} " + i }));
`]);

test("people and Claude replying at the same moment: every reply is kept, in order", async () => {
  const dir = makeCanvas({ "a.html": page("A"), "comments.json": { threads: [thread("c1", "start")] } });
  const server = await startServer(dir);
  try {
    const reply = (i) => fetch(`${server.url}_api/threads/c1/reply`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body: `web ${i}`, by: "web" }) });
    const N = 60;
    const results = await Promise.all([
      writer(dir, "p1", N), writer(dir, "p2", N), writer(dir, "p3", N),
      (async () => { for (let i = 0; i < N; i++) assert.equal((await reply(i)).status, 200); })(),
    ]);
    for (const r of results.slice(0, 3)) assert.equal(r.code, 0);
    const msgs = comments(dir).threads[0].msgs;
    assert.equal(msgs.length, 1 + 4 * N, "no reply lost");
    for (const who of ["p1", "p2", "p3", "web"]) {
      assert.deepEqual(msgs.filter((m) => m.by === who).map((m) => m.body), Array.from({ length: N }, (_, i) => `${who} ${i}`), `${who}'s replies, in order`);
    }
    assert.ok(!fs.readdirSync(dir).some((f) => f.endsWith(".lock") || f.endsWith(".tmp")), "no lock or temp file left behind");
  } finally { server.stop(); cleanup(dir); }
});

test("two Claude sessions waiting at once never take the same thread", async () => {
  const ids = ["c1", "c2", "c3", "c4", "c5", "c6"];
  const dir = makeCanvas({ "a.html": page("A"), "comments.json": { threads: ids.map((id) => thread(id, `do ${id}`, { claude: true })) } });
  try {
    const wait = () => run([CLI, "wait", "--settle", "0", "--timeout", "2", "--dir", dir]);
    const sessions = await Promise.all([wait(), wait(), wait()]);
    const got = sessions.map((s) => [...s.out.matchAll(/^(c\d+) a\.html/gm)].map((m) => m[1]));
    const all = got.flat();
    assert.equal(new Set(all).size, all.length, `a thread was handed to two sessions: ${JSON.stringify(got)}`);
    assert.deepEqual(all.sort(), ids, "and every thread went to one of them");
    for (const s of sessions) assert.ok(s.code === 0 || (s.code === 2 && /timed out/.test(s.out)));
  } finally { cleanup(dir); }
});

test("a reply sent while Claude works stays queued: Claude's answer doesn't bury it, the next wait returns it", async () => {
  const dir = makeCanvas({ "a.html": page("A"), "comments.json": { threads: [thread("c1", "make it blue", { claude: true })] } });
  const server = await startServer(dir);
  try {
    assert.equal(canvas(["wait", "--settle", "0", "--dir", dir]).code, 0);
    // the person adds to the thread from the browser while Claude is working on it
    const r = await fetch(`${server.url}_api/threads/c1/reply`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body: "and bigger", by: "Ana", claude: true }) });
    assert.equal(r.status, 200);
    const done = canvas(["reply", "c1", "made it blue", "--resolve", "--dir", dir]);
    assert.match(done.out, /queued again \(not resolved\)[\s\S]*Ana: and bigger/, "Claude is told about the newer message");
    const t = comments(dir).threads[0];
    assert.deepEqual(t.msgs.map((m) => m.body), ["make it blue", "made it blue", "and bigger"]);
    assert.equal(t.status, "open");
    const next = canvas(["wait", "--settle", "0", "--timeout", "2", "--dir", dir]);
    assert.equal(next.code, 0, "the next wait hands the thread back");
    assert.match(next.out, /Ana @Claude: and bigger/);
  } finally { server.stop(); cleanup(dir); }
});

test("a comments.json that can't be read is reported, never overwritten", async () => {
  const broken = '{ "threads": [ { "id": "c1", ';
  const dir = makeCanvas({ "a.html": page("A"), "comments.json": broken });
  const server = await startServer(dir);
  try {
    const r = await fetch(`${server.url}_api/threads/c1/reply`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body: "hi" }) });
    assert.equal(r.status, 500);
    assert.match((await r.json()).error, /isn't valid JSON/);
    const add = await fetch(`${server.url}_api/threads`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ frame: "a.html", body: "new" }) });
    assert.equal(add.status, 500);
    assert.notEqual(canvas(["reply", "c1", "hi", "--dir", dir]).code, 0);
    assert.equal(fs.readFileSync(path.join(dir, "comments.json"), "utf8"), broken, "the threads in it weren't erased");
  } finally { server.stop(); cleanup(dir); }
});

test("a lock waits for its owner, and one left by a crashed process is taken over", async () => {
  const dir = makeCanvas({ "a.html": page("A"), "comments.json": { threads: [thread("c1", "start")] } });
  const lock = path.join(dir, ".comments.json.lock");
  try {
    fs.writeFileSync(lock, String(process.pid)); // held by a live process (this one)
    const pending = run([CLI, "reply", "c1", "after the lock", "--dir", dir]);
    await sleep(400);
    assert.equal(comments(dir).threads[0].msgs.length, 1, "waits while the lock is held");
    fs.rmSync(lock);
    assert.equal((await pending).code, 0);
    assert.equal(comments(dir).threads[0].msgs.at(-1).body, "after the lock");

    const dead = spawnSync(process.execPath, ["-e", ""]).pid; // a process that has exited
    fs.writeFileSync(lock, String(dead));
    const t0 = Date.now();
    assert.equal(canvas(["reply", "c1", "after a crash", "--dir", dir]).code, 0);
    assert.ok(Date.now() - t0 < 2000, "didn't wait for the stale lock to expire");
    assert.equal(comments(dir).threads[0].msgs.at(-1).body, "after a crash");
    assert.ok(!fs.existsSync(lock));
  } finally { cleanup(dir); }
});
