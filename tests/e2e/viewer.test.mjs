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

test("sending a reply: once per send, kept when the server refuses, never undone by a late answer", { skip }, async () => {
  const msgs = () => page.evaluate(() => threads.find((t) => t.id === "c4").msgs.map((m) => m.body));
  await page.click(".pin[data-id='c4']");
  await composerFocused();

  // a slow server: Enter pressed twice while the first send is on its way posts once
  let posts = 0;
  await page.route("**/_api/threads/c4/reply*", async (route) => { posts++; await sleep(400); await route.continue(); });
  await page.keyboard.type("one reply");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => threads.find((t) => t.id === "c4").msgs.at(-1).body === "one reply");
  assert.equal(posts, 1);
  assert.equal((await msgs()).filter((b) => b === "one reply").length, 1);
  assert.equal(await page.inputValue("#pop textarea"), "", "sent, so the box is empty");
  await page.unroute("**/_api/threads/c4/reply*");

  // the server refuses: the text stays in the box and the person is told
  await page.route("**/_api/threads/c4/reply*", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "disk full" }) }));
  await page.keyboard.type("not saved");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => /disk full/.test(document.body.textContent));
  assert.equal(await page.inputValue("#pop textarea"), "not saved");
  assert.ok(!(await msgs()).includes("not saved"));
  await page.unroute("**/_api/threads/c4/reply*");

  // two loads of the comments overlap and the older answer arrives last: it must not replace the newer one
  let delivered;
  const late = new Promise((r) => (delivered = r));
  await page.route("**/_api/state*", async (route) => { // only the next request: the rest go through untouched
    const old = await route.fetch(); // the comments as they are now…
    await sleep(700); // …delivered after a newer load
    await route.fulfill({ response: old });
    delivered();
  }, { times: 1 });
  await page.evaluate(() => { window.__late = loadThreads(); });
  await sleep(150);
  canvas(["reply", "c4", "Claude answered meanwhile", "--dir", dir]);
  await page.evaluate(() => loadThreads());
  await late; // the old answer has arrived (whichever request it was)
  const after = await page.evaluate(async () => { await window.__late; await new Promise((r) => setTimeout(r, 50)); return threads.find((t) => t.id === "c4").msgs.map((m) => m.body); });
  assert.ok(after.includes("Claude answered meanwhile"), "the late, older answer didn't erase Claude's reply");
  assert.equal(await page.inputValue("#pop textarea"), "not saved", "and the text being typed is still there");
  await page.unroute("**/_api/state*");
  await page.fill("#pop textarea", "");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  assert.deepEqual(errors, []);
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
      img.src = (await render(capture(ifr.contentDocument, { w, h }))).url;
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
    await snap(f, doc, false, f.key);
    const has = f.el.querySelector(".ph").classList.contains("has-img");
    el.remove();
    await snap(f, doc, false, f.key);
    return [has, f.el.querySelector(".ph").classList.contains("has-img")];
  });
  assert.deepEqual(shown, [false, true]);
  assert.deepEqual(errors, []);
});

test("comment mode outlines and anchors on a screen's picture, as on the live page, without loading it", { skip }, async () => {
  const expected = await page.evaluate(async () => {
    closePop(); select(null); setTool("comment"); // a clean start: no open thread keeping the screen live
    const f = frames.get("inbox.html"), doc = docOf(f), h1 = doc.querySelector("h1");
    await snap(f, doc, true, f.key); // picture + zones, as the page loads
    const r = h1.getBoundingClientRect();
    const want = { sel: cssPath(h1, doc), text: labelOf(h1), cx: f.x + r.left + r.width / 2, cy: f.y + r.top + r.height / 2, w: r.width };
    unmount(f, false);
    pan = { k: 0.4, x: 700 - want.cx * 0.4, y: 450 - want.cy * 0.4 }; // zoomed out: a screen with its picture stays a picture
    apply();
    return want;
  });
  await page.waitForFunction(() => !moving);
  await page.mouse.move(700, 450);
  await page.waitForSelector("#hover.on", { timeout: 3000 });
  const state = await page.evaluate(() => ({ live: !!frames.get("inbox.html").iframe, w: parseFloat(hoverEl.style.width) }));
  assert.equal(state.live, false, "the picture was enough");
  assert.ok(Math.abs(state.w - expected.w) < 1, "outlines the heading");
  await page.mouse.down(); await page.mouse.up();
  const d = await page.evaluate(() => draft && { sel: draft.sel, text: draft.text, frame: draft.frame });
  assert.deepEqual(d, { sel: expected.sel, text: expected.text, frame: "inbox.html" });
  await page.evaluate(() => { closePop(); setTool("move"); fitRect(frames.get("inbox.html"), 1); });
  assert.deepEqual(errors, []);
});

// A picture is shown only for the version of the screen it was taken of. Waits until `file` shows a picture of its
// current version, with the screen not live (so the picture is what's on screen).
async function pictured(file) {
  await page.evaluate((file) => { const f = frames.get(file); if (f.iframe) unmount(f, false); }, file);
  await page.waitForFunction((file) => { const f = frames.get(file); return !f.iframe && f.snapUrl && f.snapKey === f.key && f.shownUrl === f.snapUrl; }, file, { timeout: 15000 });
}

test("when a shared file changes, a screen's old picture gives way to stripes at once, then to a picture of the new version", { skip }, async () => {
  await page.evaluate(() => { setTool("move"); fitRect(frames.get("new-ticket.html"), 0.3); });
  await pictured("new-ticket.html");
  // watch every frame from here on: once the new version is known, the old picture must never be on screen
  await page.evaluate(() => {
    const f = frames.get("new-ticket.html"), old = f.shownUrl, before = ASSETS;
    window.__seen = { oldAfterChange: 0, stripes: 0 };
    const watch = () => {
      if (ASSETS !== before) {
        const img = f.el.querySelector(".ph.has-img img");
        if (img?.src === old) window.__seen.oldAfterChange++;
        if (!img) window.__seen.stripes++;
      }
      if (!window.__stop) requestAnimationFrame(watch);
    };
    window.__old = old; window.__stop = false;
    requestAnimationFrame(watch);
  });
  fs.appendFileSync(path.join(dir, "_ds", "ds.css"), "\n/* changed */\n");
  await page.waitForFunction(() => { const f = frames.get("new-ticket.html"); return f.snapUrl && f.snapKey === f.key && f.shownUrl === f.snapUrl && f.snapUrl !== window.__old; }, null, { timeout: 15000 });
  const seen = await page.evaluate(() => { window.__stop = true; return window.__seen; });
  assert.equal(seen.oldAfterChange, 0, "the old picture was never shown for the new version");
  assert.ok(seen.stripes > 0, "stripes in between");
  assert.deepEqual(errors, []);
});

test("a picture follows the screen's size, and a page loaded before a change is never pictured as the new one", { skip }, async () => {
  await pictured("new-ticket.html");
  const r = await page.evaluate(async () => {
    const f = frames.get("new-ticket.html");
    f.w += 40; placeFrame(f); // resized: the picture was of the old size
    const resized = f.el.querySelector(".ph").classList.contains("has-img");
    f.w -= 40; placeFrame(f);
    // a live page whose files changed after it loaded (its key is from before): no picture of it is taken
    const g = frames.get("inbox.html");
    mount(g);
    await new Promise((res) => { const t = setInterval(() => { if (g.el.classList.contains("loaded")) { clearInterval(t); res(); } }, 50); });
    const url = g.snapUrl;
    await snap(g, g.iframe.contentDocument, true, "an older version");
    return { resized, untouched: g.snapUrl === url };
  });
  assert.equal(r.resized, false, "resizing drops the picture (stripes) rather than stretch it");
  assert.ok(r.untouched, "a page of an older version wasn't pictured");
  assert.deepEqual(errors, []);
});

test("a picture waits for the page to finish drawing, and a page that never settles keeps the stripes", { skip }, async () => {
  const shell = (title, script) => `<!doctype html><html><head><meta name="canvas:size" content="400x300"><title>${title}</title></head><body><p id="t">loading</p><script>${script}</script></body></html>`;
  fs.writeFileSync(path.join(dir, "late.html"), shell("Late", `setTimeout(() => { document.getElementById("t").textContent = "Loaded late"; }, 700);`));
  fs.writeFileSync(path.join(dir, "never.html"), shell("Never", `let n = 0; setInterval(() => { document.getElementById("t").textContent = "tick " + n++; }, 60);`));
  await page.waitForFunction(() => frames.has("late.html") && frames.has("never.html"));
  await page.waitForFunction(() => { const f = frames.get("late.html"); return f.snapUrl && f.snapKey === f.key && f.zones; }, null, { timeout: 15000 });
  const texts = await page.evaluate(() => frames.get("late.html").zones.map((z) => z.text).join(" | "));
  assert.match(texts, /Loaded late/, "pictured after the script filled it in");
  assert.doesNotMatch(texts, /\bloading\b/);
  await sleep(5500); // longer than a page may take to settle
  const never = await page.evaluate(() => { const f = frames.get("never.html"); return { live: !!f.iframe, saved: f.snapKey === f.key && !!f.snapUrl, shown: f.el.querySelector(".ph").classList.contains("has-img") }; });
  assert.equal(never.saved, false, "no saved picture of a page that never stops changing");
  if (!never.live) assert.equal(never.shown, false, "stripes");
  assert.deepEqual(errors, []);
});

test("an image pasted into a comment uploads, shows as a thumbnail, sends with the message, and Claude gets its path", { skip }, async () => {
  await page.evaluate(() => { closePop(); setTool("move"); openThreadById("c1"); });
  await composerFocused();
  const paste = (name) => page.evaluate(async (name) => {
    const c = document.createElement("canvas"); c.width = 40; c.height = 30;
    const x = c.getContext("2d"); x.fillStyle = name === "keep" ? "#e33" : "#3a3"; x.fillRect(0, 0, 40, 30);
    const blob = await new Promise((r) => c.toBlob(r, "image/png"));
    const dt = new DataTransfer(); dt.items.add(new File([blob], `${name}.png`, { type: "image/png" }));
    document.querySelector("#pop textarea").dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, name);
  await paste("keep");
  await paste("remove");
  await page.waitForFunction(() => document.querySelectorAll("#pop .att .it:not(.up)").length === 2);
  await page.click("#pop .att .it[data-i='1'] .x"); // changed my mind about the second one
  assert.equal(await page.locator("#pop .att .it").count(), 1);
  assert.equal(await page.isDisabled("#pop form .go"), false, "an image alone can be sent");
  await page.click("#pop textarea");
  await page.keyboard.type("like this red");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => threads.find((t) => t.id === "c1").msgs.at(-1).images?.length === 1);
  await page.waitForFunction(() => { const img = [...document.querySelectorAll("#pop .msg .imgs img")].at(-1); return img?.complete && img.naturalWidth === 40; });
  assert.equal(await page.locator("#pop .att .it").count(), 0, "sent: the thumbnails are cleared");
  const rel = await page.evaluate(() => threads.find((t) => t.id === "c1").msgs.at(-1).images[0]);
  assert.ok(fs.existsSync(path.join(dir, rel)));
  assert.ok(canvas(["comments", "--dir", dir]).out.includes(`image: ${path.join(dir, rel)}`), "Claude is given the file to Read");
  await page.keyboard.press("Escape");
  assert.deepEqual(errors, []);
});

test("the comment box: options only while in use, Claude's progress in the thread, and a note when it's slow", { skip }, async () => {
  await page.evaluate(() => { closePop(); setTool("move"); openThreadById("c2", true); });
  await composerFocused();
  const optionsShown = () => page.isVisible("#pop .field .send");
  assert.ok(await optionsShown(), "focused: Send to Claude, image and send");
  await page.evaluate(() => document.activeElement.blur());
  assert.ok(!(await optionsShown()), "idle and empty: just the field");
  await page.click("#pop textarea");
  await page.keyboard.type("Tighter spacing please");
  await page.evaluate(() => document.activeElement.blur());
  assert.ok(await optionsShown(), "holding text: the options stay");
  await page.click("#pop textarea");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => threads.find((t) => t.id === "c2").msgs.at(-1).body === "Tighter spacing please");
  await page.waitForSelector("#pop .wait.queued", { timeout: 5000 });
  assert.equal(await page.textContent("#pop .wait .body"), "Queued");
  // (just sent: not slow yet)
  // Claude picked it up 3 minutes ago and hasn't replied: the thread says so
  await page.evaluate(() => { const t = threads.find((x) => x.id === "c2"); t.working = new Date(Date.now() - 3 * 60000).toISOString(); renderPop(); });
  assert.equal(await page.textContent("#pop .wait .body"), "This is taking a while. Claude hasn't replied yet.", "one line, in place of Working…");
  await page.evaluate(() => { const t = threads.find((x) => x.id === "c2"); t.working = new Date().toISOString(); renderPop(); });
  assert.equal(await page.textContent("#pop .wait .body"), "Working…");
  await page.evaluate(() => { const t = threads.find((x) => x.id === "c2"); t.working = new Date(Date.now() - 3 * 60000).toISOString(); renderPop(); });
  assert.equal(await page.textContent("#pop .wait .at"), "3m");
  // resolve, close and delete are on the first message; delete is in the ⋯ menu
  await page.click("#pop [data-act='more']");
  assert.ok(await page.isVisible("#pop .more [data-act='delete']"));
  await page.click("#pop .msgs");
  assert.ok(await page.isHidden("#pop .more"), "a click elsewhere closes the menu");
  await page.keyboard.press("Escape");
  assert.deepEqual(errors, []);
});

test("Send to Claude can be turned off before typing: a reply that's a note for people", { skip }, async () => {
  await page.evaluate(() => { closePop(); setTool("move"); toClaude = true; openThreadById("c2", true); });
  await composerFocused();
  await page.click("#pop .ck"); // the box is still empty
  assert.equal(await page.isChecked("#pop .ck input"), false, "unchecked");
  assert.ok(await page.isHidden("#pop .chip"), "no @Claude");
  assert.ok(await page.evaluate(() => document.activeElement?.matches("#pop textarea")), "still typing in the box");
  await page.keyboard.type("A note for the team");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => threads.find((t) => t.id === "c2").msgs.at(-1).body === "A note for the team");
  const last = await page.evaluate(() => threads.find((t) => t.id === "c2").msgs.at(-1));
  assert.ok(!last.claude, "not sent to Claude");
  assert.ok(!/A note for the team/.test(canvas(["comments", "--dir", dir]).out), "nothing queued for Claude");
  await page.click("#pop .ck"); // back on for the next tests
  await page.keyboard.press("Escape");
  assert.deepEqual(errors, []);
});
