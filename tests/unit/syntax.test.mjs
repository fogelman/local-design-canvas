// Every script parses: the Node sources and the viewer's browser scripts (which no other test imports).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT } from "../helpers.mjs";

const files = ["src", "viewer/js", "tests"].flatMap((d) =>
  fs.readdirSync(path.join(ROOT, d), { recursive: true }).filter((f) => /\.m?js$/.test(f)).map((f) => path.join(d, f)));

for (const f of files) {
  test(`node --check ${f}`, () => {
    const r = spawnSync(process.execPath, ["--check", path.join(ROOT, f)], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  });
}
