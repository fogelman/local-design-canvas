// Shared test helpers: throwaway canvases, running the CLI, and starting a real server.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CLI = path.join(ROOT, "src", "cli.mjs");

/** A temp canvas folder with the given files ({ "inbox.html": "<html>…" }); removed by cleanup(). */
export function makeCanvas(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-test-"));
  for (const [name, body] of Object.entries(files)) {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body, null, 2));
  }
  return dir;
}
export const cleanup = (dir) => fs.rmSync(dir, { recursive: true, force: true });

export const page = (title, body = "", size = "1280x800") =>
  `<!doctype html><html><head><meta name="canvas:size" content="${size}"><title>${title}</title></head><body>${body}</body></html>`;

/** Run `canvas …args` synchronously; returns { code, out, err }. */
export function canvas(args, opts = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", input: opts.input, env: { ...process.env, ...opts.env }, cwd: opts.cwd });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

/** Start `canvas <dir>` on a free port; resolves { url, stop }. */
export function startServer(dir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, dir, "--no-open", "--port", "0"], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error(`server did not start: ${out}`)); }, 5000);
    child.stdout.on("data", (d) => {
      out += d;
      const m = out.match(/http:\/\/127\.0\.0\.1:\d+\//);
      if (m) { clearTimeout(timer); resolve({ url: m[0], stop: () => child.kill() }); }
    });
    child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`server exited ${code}: ${out}`)); });
  });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
