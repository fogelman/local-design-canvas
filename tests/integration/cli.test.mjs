// The `canvas` command, end to end against a temp canvas.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { canvas, makeCanvas, cleanup, page } from "../helpers.mjs";

const thread = (id, body, extra = {}) => ({ id, frame: "a.html", status: "open", msgs: [{ by: "Ana", at: "", body, ...extra }] });

test("help and new", () => {
  const dir = makeCanvas();
  try {
    assert.match(canvas(["--help"]).out, /canvas — offline design canvas/);
    const r = canvas(["new", "checkout", "390x844", "--dir", dir]);
    assert.equal(r.code, 0);
    const html = fs.readFileSync(path.join(dir, "checkout.html"), "utf8");
    assert.match(html, /content="390x844"/);
    assert.match(html, /<title>Checkout<\/title>/);
    assert.equal(canvas(["new", "checkout", "--dir", dir]).code, 1, "refuses to overwrite");
  } finally { cleanup(dir); }
});

test("new links the canvas design system when there is one", () => {
  const dir = makeCanvas({ "_ds/ds.css": "" });
  try {
    canvas(["new", "home", "--dir", dir]);
    assert.match(fs.readFileSync(path.join(dir, "home.html"), "utf8"), /href="_ds\/ds.css"/);
    assert.ok(!fs.existsSync(path.join(dir, "styles.css")));
  } finally { cleanup(dir); }
});

test("comments shows only threads waiting for Claude; --open and --all widen it", () => {
  const dir = makeCanvas({
    "a.html": page("A"),
    "comments.json": { threads: [thread("c1", "for Claude", { claude: true }), thread("c2", "note for people"), { ...thread("c3", "old", { claude: true }), status: "resolved" }] },
  });
  try {
    const waiting = canvas(["comments", "--dir", dir]).out;
    assert.match(waiting, /^c1 a\.html/m);
    assert.match(waiting, /Ana @Claude: for Claude/);
    assert.doesNotMatch(waiting, /c2|c3/);
    assert.match(canvas(["comments", "--open", "--dir", dir]).out, /c2/);
    assert.match(canvas(["comments", "--all", "--dir", dir]).out, /c3 \[resolved\]/);
  } finally { cleanup(dir); }
});

test("reply, resolve and reopen; ids on other pages are page/cN", () => {
  const dir = makeCanvas({ "a.html": page("A"), "comments.json": { threads: [thread("c1", "q", { claude: true })] }, "m/b.html": page("B"), "m/comments.json": { threads: [thread("c1", "mobile", { claude: true })] } });
  try {
    assert.match(canvas(["comments", "--dir", dir]).out, /^m\/c1 /m);
    assert.equal(canvas(["reply", "c1", "Done.", "--resolve", "--dir", dir]).code, 0);
    let t = JSON.parse(fs.readFileSync(path.join(dir, "comments.json"))).threads[0];
    assert.equal(t.status, "resolved");
    assert.deepEqual(t.msgs.at(-1).by, "Claude");
    canvas(["reopen", "c1", "--dir", dir]);
    t = JSON.parse(fs.readFileSync(path.join(dir, "comments.json"))).threads[0];
    assert.equal(t.status, "open");
    canvas(["reply", "m/c1", "On it", "--dir", dir]);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "m/comments.json"))).threads[0].msgs.at(-1).body, "On it");
  } finally { cleanup(dir); }
});

test("watch stores the per-canvas preference", () => {
  const dir = makeCanvas({ "a.html": page("A") });
  try {
    assert.equal(canvas(["watch", "--dir", dir]).out, "unset");
    assert.equal(canvas(["watch", "on", "--dir", dir]).out, "on");
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "canvas.json"))).claudeWatch, true);
    assert.equal(canvas(["watch", "off", "--dir", dir]).out, "off");
  } finally { cleanup(dir); }
});

test("wait claims queued threads, or times out with exit code 2", () => {
  const dir = makeCanvas({ "a.html": page("A") });
  try {
    const empty = canvas(["wait", "--timeout", "1", "--dir", dir]);
    assert.equal(empty.code, 2);
    fs.writeFileSync(path.join(dir, "comments.json"), JSON.stringify({ threads: [thread("c1", "go", { claude: true })] }));
    const r = canvas(["wait", "--dir", dir]);
    assert.equal(r.code, 0);
    assert.match(r.out, /^c1 a\.html/m);
    assert.match(r.out, /1 thread\(s\) claimed/);
    assert.ok(JSON.parse(fs.readFileSync(path.join(dir, "comments.json"))).threads[0].working, "claimed");
  } finally { cleanup(dir); }
});

test("ds lists components with their usage line", () => {
  const dir = makeCanvas({ "_ds/components/atoms/button.html": "<!-- <ds-button>Go</ds-button> -->\n<button><slot></slot></button>" });
  try {
    assert.match(canvas(["ds", "--dir", dir]).out, /^atoms\/button\s+<ds-button>Go<\/ds-button>$/m);
  } finally { cleanup(dir); }
});

test("hook session-start reads the project from stdin and stays silent when there is nothing to say", () => {
  const project = makeCanvas({ "docs/c/canvas.json": { frames: {} }, "docs/c/comments.json": { threads: [thread("c1", "x", { claude: true })] } });
  try {
    const env = { CLAUDE_PROJECT_DIR: "" };
    assert.match(canvas(["hook", "session-start"], { input: JSON.stringify({ cwd: project }), env }).out, /docs\/c: 1 comment\(s\) waiting for Claude/);
    const empty = makeCanvas();
    try { assert.equal(canvas(["hook", "session-start"], { input: JSON.stringify({ cwd: empty }), env }).out, ""); } finally { cleanup(empty); }
  } finally { cleanup(project); }
});
