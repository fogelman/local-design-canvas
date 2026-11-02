import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { addThread, updateThread, waiting, claimed, queued, claim, splitId, waitForQueue } from "../../src/threads.mjs";
import { pages, pageDir, state, threadsOf } from "../../src/store.mjs";
import { findCanvases, sessionNote } from "../../src/hook.mjs";
import { makeCanvas, cleanup, page } from "../helpers.mjs";

test("addThread numbers threads and tags the commented element in the source with data-cid", () => {
  const dir = makeCanvas({ "a.html": page("A", `<main><h1>Title</h1><button>Go</button><button>Stop</button></main>`) });
  try {
    const t = addThread(dir, { frame: "a.html", sel: "main > button:nth-of-type(2)", text: "Stop", body: "Make it red", by: "Ana", claude: true, anchor: { tag: "button", tagIndex: 1, tagCount: 2 } });
    assert.equal(t.id, "c1");
    assert.equal(t.sel, `[data-cid="c1"]`);
    assert.equal(t.alt, "main > button:nth-of-type(2)", "the css path stays as a fallback");
    assert.match(fs.readFileSync(path.join(dir, "a.html"), "utf8"), /<button>Go<\/button><button data-cid="c1">Stop/);
    assert.equal(addThread(dir, { frame: "a.html", body: "second" }).id, "c2");
  } finally { cleanup(dir); }
});

test("tagging is skipped when the source no longer mirrors the page, inside components, and on generated pages", () => {
  const dir = makeCanvas({ "a.html": page("A", `<p>x</p>`), "gen/canvas.json": { source: "built by a script" }, "gen/b.html": page("B", "<p>y</p>") });
  try {
    const mismatch = addThread(dir, { frame: "a.html", sel: "p", body: "m", anchor: { tag: "p", tagIndex: 0, tagCount: 3 } });
    assert.equal(mismatch.sel, "p");
    const inComponent = addThread(dir, { frame: "a.html", sel: "p", body: "m", ds: "atoms/badge#1", anchor: { tag: "p", tagIndex: 0, tagCount: 1 } });
    assert.equal(inComponent.ds, "atoms/badge#1");
    assert.equal(inComponent.sel, "p");
    const generated = addThread(path.join(dir, "gen"), { frame: "b.html", sel: "p", body: "m", anchor: { tag: "p", tagIndex: 0, tagCount: 1 } });
    assert.equal(generated.sel, "p");
    assert.ok(!fs.readFileSync(path.join(dir, "gen/b.html"), "utf8").includes("data-cid"));
  } finally { cleanup(dir); }
});

test("the Claude queue: waiting, claims, replies and expiry", () => {
  const dir = makeCanvas({ "a.html": page("A") });
  try {
    addThread(dir, { frame: "a.html", body: "for Claude", claude: true });
    addThread(dir, { frame: "a.html", body: "a note for people" });
    let list = queued(dir);
    assert.deepEqual(list.map((t) => t.id), ["c1"]);
    claim(dir, list);
    assert.equal(queued(dir).length, 0, "claimed threads leave the queue");
    assert.ok(claimed(threadsOf(dir).threads[0]));
    updateThread(dir, "c1", (t) => { t.working = new Date(Date.now() - 31 * 60 * 1000).toISOString(); });
    assert.equal(queued(dir).length, 1, "an abandoned claim (30 min+) queues again");
    updateThread(dir, "c1", (t) => { t.msgs.push({ by: "Claude", body: "done" }); delete t.working; });
    assert.ok(!waiting(threadsOf(dir).threads[0]), "Claude's reply ends the wait");
  } finally { cleanup(dir); }
});

test("waitForQueue resolves with a batch once comments arrive, and times out empty", async () => {
  const dir = makeCanvas({ "a.html": page("A") });
  try {
    assert.deepEqual(await waitForQueue(dir, 50, 300), []);
    const pending = waitForQueue(dir, 200, 5000);
    setTimeout(() => addThread(dir, { frame: "a.html", body: "one", claude: true }), 50);
    setTimeout(() => addThread(dir, { frame: "a.html", body: "two", claude: true }), 120);
    const batch = await pending;
    assert.deepEqual(batch.map((t) => t.id), ["c1", "c2"], "a burst arrives as one batch");
  } finally { cleanup(dir); }
});

test("pages are subfolders; page names can't escape the canvas", () => {
  const dir = makeCanvas({ "a.html": page("A"), "mobile/b.html": page("B"), "_ds/x.html": "", "node_modules/c.html": "" });
  try {
    assert.deepEqual(pages(dir).map((p) => p.id), ["", "mobile"]);
    assert.equal(pageDir(dir, "mobile"), path.join(dir, "mobile"));
    for (const bad of ["../etc", "mobile/../..", "_ds", ".git", "missing"]) assert.throws(() => pageDir(dir, bad), /no page/);
    assert.deepEqual(splitId(dir, "mobile/c3"), [path.join(dir, "mobile"), "c3"]);
    assert.deepEqual(splitId(dir, "c3"), [dir, "c3"]);
  } finally { cleanup(dir); }
});

test("state places new frames left to right and reads size and title from the html", () => {
  const dir = makeCanvas({ "a.html": page("Alpha", "", "390x844"), "b.html": page("Beta"), "_partial.html": "" });
  try {
    const s = state(dir);
    assert.deepEqual(s.frames.map((f) => [f.file, f.title, f.w, f.h, f.x]), [["a.html", "Alpha", 390, 844, 0], ["b.html", "Beta", 1280, 800, 510]]);
    assert.ok(fs.existsSync(path.join(dir, "canvas.json")), "positions are saved");
  } finally { cleanup(dir); }
});

test("the session hook finds canvases and only speaks when something is waiting or watch is on", () => {
  const project = makeCanvas({
    "docs/a/canvas/canvas.json": { frames: {} },
    "docs/a/canvas/p/canvas.json": { frames: {} },
    "docs/b/canvas/canvas.json": { frames: {}, claudeWatch: true },
    "node_modules/x/canvas.json": { frames: {} },
  });
  try {
    assert.deepEqual(findCanvases(project).map((d) => path.relative(project, d)).sort(), ["docs/a/canvas", "docs/b/canvas"]);
    assert.match(sessionNote(project), /docs\/b\/canvas: nothing waiting; watch is on/);
    assert.doesNotMatch(sessionNote(project), /docs\/a\/canvas/);
    addThread(path.join(project, "docs/a/canvas"), { body: "hi", claude: true });
    assert.match(sessionNote(project), /docs\/a\/canvas: 1 comment\(s\) waiting for Claude/);
  } finally { cleanup(project); }
});
