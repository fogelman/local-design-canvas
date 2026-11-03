// Running servers: each `canvas open` writes <pid>.json to a per-user folder while it runs, so `canvas list` can find them.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readJSON, writeJSON } from "./store.mjs";

const uid = typeof process.getuid === "function" ? process.getuid() : os.userInfo().username;
export const REGISTRY = process.env.XDG_RUNTIME_DIR
  ? path.join(process.env.XDG_RUNTIME_DIR, "local-design-canvas")
  : path.join(os.tmpdir(), `local-design-canvas-${uid}`);

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };

export function register(entry) {
  fs.mkdirSync(REGISTRY, { recursive: true, mode: 0o700 });
  const file = path.join(REGISTRY, `${process.pid}.json`);
  writeJSON(file, { pid: process.pid, started: new Date().toISOString(), ...entry });
  const drop = () => { try { fs.unlinkSync(file); } catch {} };
  process.on("exit", drop);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => process.exit(0));
}

// Live servers, oldest first; entries left behind by a crash or kill -9 are removed on the way.
export function running() {
  let names;
  try { names = fs.readdirSync(REGISTRY).filter((f) => /^\d+\.json$/.test(f)); } catch { return []; }
  const list = [];
  for (const f of names) {
    const file = path.join(REGISTRY, f), e = readJSON(file, null);
    if (e && alive(e.pid)) list.push(e);
    else try { fs.unlinkSync(file); } catch {}
  }
  return list.sort((a, b) => a.started.localeCompare(b.started));
}
