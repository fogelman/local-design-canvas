// The local server: viewer, frames with components expanded, the JSON API, safety and live-reload events.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { makeCanvas, cleanup, page, startServer, sleep, canvas } from "../helpers.mjs";

let dir, server;
before(async () => {
  dir = makeCanvas({
    "inbox.html": page("Inbox", `<ds-hello name="Ana"></ds-hello><h1>Inbox</h1>`),
    "_ds/components/atoms/hello.html": `<p class="hi">Hello {{name}}</p>`,
    "mobile/home.html": page("Home", "", "390x844"),
  });
  fs.writeFileSync(path.join(dir, "..", `${path.basename(dir)}-secret.txt`), "outside");
  server = await startServer(dir);
});
after(() => { server?.stop(); fs.rmSync(path.join(dir, "..", `${path.basename(dir)}-secret.txt`), { force: true }); cleanup(dir); });

const get = (p) => fetch(server.url + p.replace(/^\//, ""));
const post = (p, body) => fetch(server.url + p.replace(/^\//, ""), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
// raw request, so "../" isn't normalised away by the client before it reaches the server
const raw = (p) => new Promise((resolve) => http.get(server.url.replace(/\/$/, "") + p, (res) => { res.resume(); resolve(res.statusCode); }));

test("serves the viewer", async () => {
  const r = await get("/");
  assert.equal(r.status, 200);
  assert.match(await r.text(), /<script src="\/_app\/js\/main.js">/);
  assert.equal((await get("/_app/js/core.js")).status, 200);
});

test("state lists frames and pages", async () => {
  const s = await (await get("/_api/state")).json();
  assert.deepEqual(s.frames.map((f) => f.file), ["inbox.html"]);
  assert.deepEqual(s.pages.map((p) => p.id), ["", "mobile"]);
  const m = await (await get("/_api/state?page=mobile")).json();
  assert.deepEqual(m.frames.map((f) => [f.file, f.w]), [["home.html", 390]]);
});

test("state versions what screens look like, so the viewer can reuse saved snapshots", async () => {
  const state = async () => (await get("/_api/state")).json();
  const s0 = await state();
  assert.match(s0.id, /^[0-9a-f]{12}$/);
  assert.match(s0.frames[0].v, /^\d+-\d+$/);
  const later = new Date(Date.now() + 60000);
  // editing a screen changes that screen's version only
  fs.utimesSync(path.join(dir, "inbox.html"), later, later);
  const s1 = await state();
  assert.notEqual(s1.frames[0].v, s0.frames[0].v);
  assert.equal(s1.assets, s0.assets);
  // anything a screen pulls in (here a component) changes the shared version
  const comp = path.join(dir, "_ds/components/atoms/hello.html");
  fs.utimesSync(comp, later, later);
  const s2 = await state();
  assert.notEqual(s2.assets, s1.assets);
  // so does restoring an older copy of a file (its time goes back, not forward), data a screen loads, and deleting
  fs.utimesSync(comp, new Date(2020, 0, 1), new Date(2020, 0, 1));
  const s3 = await state();
  assert.notEqual(s3.assets, s2.assets, "an older copy counts");
  fs.writeFileSync(path.join(dir, "data.json"), '{"rows":[]}');
  const s4 = await state();
  assert.notEqual(s4.assets, s3.assets, "json a screen may fetch counts");
  fs.rmSync(path.join(dir, "data.json"));
  assert.equal((await state()).assets, s3.assets, "deleting it counts, back to what it was");
  // the canvas's own bookkeeping doesn't: layout and comments change all the time without changing any screen
  fs.utimesSync(path.join(dir, "canvas.json"), later, later);
  fs.writeFileSync(path.join(dir, ".comments.json.lock"), "1"); fs.rmSync(path.join(dir, ".comments.json.lock"));
  assert.equal((await state()).assets, s3.assets);
});

test("frames are served with components expanded", async () => {
  const html = await (await get("/inbox.html")).text();
  assert.match(html, /<p data-ds="atoms\/hello" class="hi">Hello Ana<\/p>/);
  assert.doesNotMatch(html, /<ds-/);
});

test("files outside the canvas are not served", async () => {
  const status = await raw(`/../${path.basename(dir)}-secret.txt`);
  assert.notEqual(status, 200);
  assert.equal((await get("/_api/state?page=..")).status, 500);
});

test("threads: create, reply, resolve, delete", async () => {
  const t = await post("/_api/threads", { frame: "inbox.html", sel: "h1", text: "Inbox", body: "Bigger title", by: "Ana", claude: true });
  assert.equal(t.id, "c1");
  const replied = await post(`/_api/threads/${t.id}/reply`, { body: "Ok", by: "Bo" });
  assert.equal(replied.msgs.length, 2);
  assert.equal((await post(`/_api/threads/${t.id}/status`, { status: "resolved" })).status, "resolved");
  await post(`/_api/threads/${t.id}/delete`, {});
  assert.deepEqual((await (await get("/_api/state")).json()).threads, []);
});

test("replying reopens a resolved thread; sent to Claude, it's back in Claude's queue", async () => {
  const t = await post("/_api/threads", { frame: "inbox.html", body: "Bigger title", by: "Ana", claude: true });
  await post(`/_api/threads/${t.id}/status`, { status: "resolved" });
  const note = await post(`/_api/threads/${t.id}/reply`, { body: "One more thing", by: "Bo" });
  assert.equal(note.status, "open", "any reply reopens it");
  assert.doesNotMatch(canvas(["comments", "--dir", dir]).out, new RegExp(`^${t.id} `, "m"), "a note between people isn't for Claude");
  await post(`/_api/threads/${t.id}/status`, { status: "resolved" });
  const again = await post(`/_api/threads/${t.id}/reply`, { body: "Actually, a bit smaller", by: "Ana", claude: true });
  assert.equal(again.status, "open");
  assert.match(canvas(["comments", "--dir", dir]).out, new RegExp(`^${t.id} inbox\\.html[\\s\\S]*Actually, a bit smaller`, "m"), "back in Claude's queue");
  await post(`/_api/threads/${t.id}/delete`, {});
});

test("layout saves positions in a batch", async () => {
  const r = await fetch(server.url + "_api/layout", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ frames: { "inbox.html": { x: 40.4, y: 80 } } }) });
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "canvas.json"))).frames["inbox.html"], { x: 40, y: 80 });
});

test("pages: create, rename, delete into .trash", async () => {
  const { id } = await post("/_api/pages", { name: "Checkout flow" });
  assert.equal(id, "checkout-flow");
  await fetch(server.url + `_api/pages?page=${id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Checkout" }) });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, id, "canvas.json"))).name, "Checkout");
  await fetch(server.url + `_api/pages?page=${id}`, { method: "DELETE" });
  assert.ok(!fs.existsSync(path.join(dir, id)));
  assert.equal(fs.readdirSync(path.join(dir, ".trash")).length, 1);
  assert.equal((await fetch(server.url + "_api/pages", { method: "DELETE" })).status, 500, "the first page can't be deleted");
});

test("live reload: a changed file is pushed to viewers, even after the file was replaced by rename", async () => {
  const events = [];
  const ctrl = new AbortController();
  const res = await fetch(server.url + "_api/events", { signal: ctrl.signal });
  const reader = res.body.getReader();
  (async () => { try { for (;;) { const { value, done } = await reader.read(); if (done) break; events.push(new TextDecoder().decode(value)); } } catch {} })();
  await sleep(200);
  const file = path.join(dir, "inbox.html");
  fs.writeFileSync(`${file}.tmp`, page("Inbox 2")); fs.renameSync(`${file}.tmp`, file); // how saves happen
  await sleep(400);
  fs.appendFileSync(file, "<!-- edit -->"); // an in-place write after the rename
  await sleep(400);
  ctrl.abort();
  const changes = events.join("").match(/"files":\[[^\]]*inbox\.html[^\]]*\]/g) || [];
  assert.ok(changes.length >= 2, `both changes reported, got: ${events.join("")}`);
});

test("screens are served with the pending-work counter first in <head>, after the doctype; the file is untouched", async () => {
  const html = await (await get("/inbox.html")).text();
  assert.match(html, /^<!doctype html><html><head><script>\/\* canvas: lets the viewer tell/, "standards mode kept: nothing before the doctype");
  assert.equal((html.match(/__canvasPending/g) || []).length, 1);
  assert.doesNotMatch(fs.readFileSync(path.join(dir, "inbox.html"), "utf8"), /__canvasPending/);
});

test("served at localhost, answering on both loopback addresses (whichever localhost resolves to) and nothing else", async () => {
  assert.match(server.url, /^http:\/\/localhost:\d+\/$/);
  const port = new URL(server.url).port;
  for (const host of ["127.0.0.1", "[::1]"]) assert.equal((await fetch(`http://${host}:${port}/_api/me`)).status, 200, host);
  const lan = Object.values((await import("node:os")).networkInterfaces()).flat().find((i) => i && !i.internal && i.family === "IPv4");
  if (lan) assert.equal(await fetch(`http://${lan.address}:${port}/`).then(() => "reachable", () => "refused"), "refused", "not on the network");
});
