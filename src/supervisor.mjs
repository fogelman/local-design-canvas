// `canvas open` runs the server in a child process and keeps it on the canvas tool's current code: when the tool's
// own files (src/) change on disk, an update or a fix, the server restarts on the same port. Open viewers reconnect
// by themselves and re-read everything (the viewer's files are read per request, so they never need a restart).
// Without this, a running server keeps old code while the viewer loads new code, and the two stop understanding
// each other. A server that fails to start (say, a half-saved file) is retried on the next change.
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { watchTree } from "./watch.mjs";

const SRC = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(SRC, "cli.mjs");

export function supervise(dir, port, open) {
  let child = null, restart = false, stopping = false, startedAt = 0, first = true;
  const start = () => {
    const args = [CLI, "open", dir, "--port", String(port), ...(first && open ? [] : ["--no-open"])];
    first = false;
    startedAt = Date.now();
    // ipc: the child exits when this process is gone, even killed outright, so a server is never left orphaned
    child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "inherit", "ipc"], env: { ...process.env, CANVAS_WORKER: "1" } });
    child.stdout.on("data", (d) => {
      process.stdout.write(d);
      const m = String(d).match(/http:\/\/localhost:(\d+)\//);
      if (m) port = +m[1]; // the port it got (it moves on when one is busy): restarts keep it
    });
    child.on("exit", (code, signal) => {
      child = null;
      if (stopping) return;
      if (restart) { restart = false; return start(); }
      if (Date.now() - startedAt > 5000) { console.error(`canvas: the server stopped (${signal || `exit ${code}`}), starting it again`); return start(); }
      console.error("canvas: the server didn't start; it's tried again when the canvas tool's files change");
    });
  };
  let t = null;
  watchTree(SRC, (name) => {
    if (!name?.endsWith(".mjs")) return;
    clearTimeout(t);
    t = setTimeout(() => {
      console.log("canvas: the canvas tool was updated, restarting the server");
      if (child) { restart = true; child.kill("SIGTERM"); } else start();
    }, 400); // a burst of saves restarts once
  });
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => { stopping = true; child?.kill("SIGTERM"); process.exit(0); });
  start();
}
