// The plugin files Claude Code reads: manifests, hook config, skill frontmatter and the bin entry.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../helpers.mjs";

const json = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), "utf8"));

test("plugin and marketplace manifests agree", () => {
  const plugin = json(".claude-plugin/plugin.json"), market = json(".claude-plugin/marketplace.json"), pkg = json("package.json");
  assert.match(plugin.name, /^[a-z0-9-]+$/);
  assert.equal(market.plugins[0].name, plugin.name);
  assert.equal(market.plugins[0].source, "./");
  assert.equal(plugin.version, pkg.version, "plugin.json and package.json versions match");
});

test("hooks.json runs the session hook through the plugin's bin", () => {
  const cmd = json("hooks/hooks.json").hooks.SessionStart[0].hooks[0].command;
  assert.match(cmd, /\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/canvas" hook session-start/);
});

test("the skill has name and description frontmatter", () => {
  const head = fs.readFileSync(path.join(ROOT, "skills/canvas/SKILL.md"), "utf8").match(/^---\n([\s\S]*?)\n---/);
  assert.ok(head, "frontmatter present");
  assert.match(head[1], /^name: canvas$/m);
  assert.match(head[1], /^description: .{40,}/m);
});

test("bin/canvas and src/cli.mjs are executable entry points", () => {
  for (const f of ["bin/canvas", "src/cli.mjs"]) {
    const mode = fs.statSync(path.join(ROOT, f)).mode;
    assert.ok(mode & 0o111, `${f} is executable`);
  }
  assert.equal(json("package.json").bin.canvas, "src/cli.mjs");
});
