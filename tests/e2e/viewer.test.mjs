// Browser tests of the viewer against a copy of examples/demo. Needs Playwright, which the project doesn't depend on:
// CI installs it (`npm install --no-save playwright && npx playwright install chromium`); locally, point
// CANVAS_PLAYWRIGHT at any playwright or playwright-core install, or the tests skip.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT, canvas, startServer, sleep } from "../helpers.mjs";

let pw = null;
try { pw = await import(process.env.CANVAS_PLAYWRIGHT || "playwright"); } catch {}
const skip = pw ? false : "Playwright isn't installed (see the comment at the top of this file)";

let dir, server, browser, page, errors;
before(async () => {
  if (skip) return;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-e2e-"));
  fs.cpSync(path.join(ROOT, "examples", "demo"), dir, { recursive: true });
  server = await startServer(dir);
  const chromium = pw.chromium || pw.default?.chromium;
  browser = await chromium.launch({ executablePath: process.env.CANVAS_CHROME || undefined, args: ["--no-sandbox"] });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(server.url);
  await page.waitForFunction(() => document.querySelectorAll(".frame").length === 4);
  await page.evaluate(() => fitRect(frames.get("inbox.html"), 1));
  await page.waitForFunction(() => frames.get("inbox.html")?.el.classList.contains("loaded"));
});
after(async () => { await browser?.close(); server?.stop(); if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

const inbox = () => page.frameLocator(".frame[data-file='inbox.html'] iframe");
const composerFocused = () => page.waitForFunction(() => document.activeElement?.matches("#pop textarea")); // focus lands a frame later

test("the viewer boots with the example's screens and pins, without errors", { skip }, async () => {
  assert.deepEqual(await page.evaluate(() => [...frames.keys()].sort()), ["inbox-mobile.html", "inbox.html", "new-ticket.html", "ticket.html"]);
  assert.ok(await page.locator(".pin").count() >= 2);
  assert.equal(await page.textContent("#pageName"), "Helpdesk");
  assert.deepEqual(errors, []);
});

test("a comment sent from the browser reaches `canvas comments`", { skip }, async () => {
  await page.keyboard.press("c");
  const box = await inbox().locator("text=Filters").boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await composerFocused();
  await page.keyboard.type("Make Filters a dropdown");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => threads.some((t) => t.msgs[0].body === "Make Filters a dropdown"));
  const out = canvas(["comments", "--dir", dir]).out;
  assert.match(out, /inbox\.html › ⟨atoms\/button#\d+⟩ "Filters"/, "Filters is a component, so the thread names it");
  assert.match(out, /@Claude: Make Filters a dropdown/);
  await page.keyboard.press("Escape");
});

test("text being typed survives Claude replying", { skip }, async () => {
  await page.click(".pin[data-id='c4']");
  await composerFocused();
  await page.keyboard.type("also add a badge");
  canvas(["reply", "c4", "Done, it's a dropdown now.", "--dir", dir]);
  await page.waitForFunction(() => document.querySelectorAll("#pop .msg").length === 2);
  assert.equal(await page.inputValue("#pop textarea"), "also add a badge");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
});

test("reloads wait while the person is busy, and R applies them", { skip }, async () => {
  const mark = () => page.evaluate(() => { frames.get("inbox.html").iframe.contentWindow.__mark = 1; });
  const kept = () => page.evaluate(() => frames.get("inbox.html").iframe?.contentWindow?.__mark === 1);
  await page.keyboard.press("i"); // interact mode = busy
  await mark();
  fs.appendFileSync(path.join(dir, "inbox.html"), "\n<!-- edit -->");
  await page.waitForSelector("#staleBtn:not([hidden])");
  assert.ok(await kept(), "the screen was not reloaded under the person");
  assert.ok(await page.locator(".frame[data-file='inbox.html'].stale").count());
  await page.keyboard.press("Escape");
  await page.keyboard.press("r");
  await page.waitForSelector("#staleBtn", { state: "hidden" });
  await sleep(300);
  assert.ok(!(await kept()), "R reloaded it");
  assert.deepEqual(errors, []);
});

test("replying in a resolved thread reopens it and the panel follows it to Open", { skip }, async () => {
  await page.click("#panelBtn");
  await page.click(".ptabs [data-f='resolved']");
  await page.click("#plist .pitem[data-id='c1']");
  await composerFocused();
  await page.keyboard.type("Make the badge grey instead");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => threads.find((t) => t.id === "c1")?.status === "open");
  assert.equal(await page.getAttribute(".ptabs .on", "data-f"), "open");
  assert.match(canvas(["comments", "--dir", dir]).out, /^c1 inbox\.html[\s\S]*Make the badge grey instead/m, "sent to Claude, so it's queued");
  assert.deepEqual(errors, []);
});

// Renders `file` live in an iframe and as its snapshot in an <img>, both at the frame's size, and returns
// the share of pixels that differ visibly (antialiasing at glyph edges stays under the threshold).
async function snapshotDiff(file) {
  const f = await page.evaluate((file) => { const f = frames.get(file); return { w: f.w, h: f.h, url: src(file) }; }, file);
  await page.setViewportSize({ width: f.w, height: f.h * 2 });
  const failed = await page.evaluate(async ({ w, h, url }) => {
    const box = document.createElement("div");
    box.id = "cmp";
    Object.assign(box.style, { position: "fixed", inset: 0, zIndex: 99, background: "#fff" });
    document.body.appendChild(box);
    const ifr = document.createElement("iframe");
    Object.assign(ifr.style, { width: `${w}px`, height: `${h}px`, border: 0, display: "block" });
    ifr.src = url;
    box.appendChild(ifr);
    await new Promise((r) => (ifr.onload = r));
    await new Promise((r) => setTimeout(r, 300));
    try {
      const img = new Image();
      img.src = await render(capture(ifr.contentDocument, { w, h }));
      await img.decode();
      Object.assign(img.style, { width: `${w}px`, height: `${h}px`, display: "block" });
      box.appendChild(img);
    } catch (e) { return String(e.message || e); }
  }, f);
  try {
    assert.equal(failed, undefined, `${file} could not be pictured`);
    const [live, shot] = [await page.locator("#cmp iframe").screenshot(), await page.locator("#cmp img").screenshot()];
    return await page.evaluate(async ([a, b]) => {
      const px = async (b64) => {
        const i = new Image(); i.src = `data:image/png;base64,${b64}`; await i.decode();
        const c = new OffscreenCanvas(i.width, i.height).getContext("2d"); c.drawImage(i, 0, 0);
        return c.getImageData(0, 0, i.width, i.height).data;
      };
      const [p, q] = await Promise.all([px(a), px(b)]);
      let n = 0;
      for (let k = 0; k < p.length; k += 4) if (Math.max(Math.abs(p[k] - q[k]), Math.abs(p[k + 1] - q[k + 1]), Math.abs(p[k + 2] - q[k + 2])) > 80) n++;
      return n / (p.length / 4);
    }, [live.toString("base64"), shot.toString("base64")]);
  } finally {
    await page.evaluate(() => document.getElementById("cmp")?.remove());
    await page.setViewportSize({ width: 1440, height: 900 });
  }
}

test("a screen's snapshot looks like the live screen: :root variables, stylesheets, components", { skip }, async () => {
  for (const file of ["inbox.html", "ticket.html", "inbox-mobile.html"]) {
    const diff = await snapshotDiff(file);
    assert.ok(diff < 0.005, `${file}: ${(diff * 100).toFixed(2)}% of pixels differ`); // a broken snapshot differs on tens of percent
  }
  assert.deepEqual(errors, []);
});

test("a screen scrolled inside keeps the stripes instead of a snapshot that differs", { skip }, async () => {
  const shown = await page.evaluate(async () => {
    const f = frames.get("inbox.html"), doc = f.iframe.contentDocument;
    const el = doc.createElement("div");
    Object.assign(el.style, { height: "40px", overflow: "auto" });
    el.innerHTML = '<div style="height:400px">tall</div>';
    doc.body.appendChild(el);
    el.scrollTop = 100;
    await snap(f, doc);
    const has = f.el.querySelector(".ph").classList.contains("has-img");
    el.remove();
    await snap(f, doc);
    return [has, f.el.querySelector(".ph").classList.contains("has-img")];
  });
  assert.deepEqual(shown, [false, true]);
  assert.deepEqual(errors, []);
});
