# Contributing

Thanks for helping. Bug reports, ideas, docs fixes and code are all welcome.

## Reporting a bug

[Open an issue](../../issues/new/choose) and pick **Bug report**. Include:

- what you did, what you expected and what happened instead
- your Node version (`node --version`), OS and browser
- whether you use the plugin or the command-line install
- a small canvas that shows the problem, if you can. A folder with one or two HTML files and `comments.json` is ideal
- any error from the terminal running `canvas`, or from the browser console

Don't post anything private: no screenshots of real customer data, no tokens, no internal URLs.

## Suggesting a feature

Open an issue and pick **Feature request**. Describe the problem you're trying to solve before the solution you have in mind. That makes it easier to find an approach that keeps the tool small.

## Security issues

Don't open a public issue. Use the repository's **Security → Report a vulnerability** form, or contact the maintainer privately. The server only listens on loopback (`127.0.0.1` and `::1`, as `localhost`), but reports about file access through the server, component expansion or the CLI are taken seriously.

## Development setup

```bash
git clone https://github.com/fogelman/local-design-canvas && cd local-design-canvas
npm link                                            # `canvas` on your PATH, from your working copy
ln -s "$PWD/skills/canvas" ~/.claude/skills/canvas    # the skill, from your working copy
canvas open examples/demo                           # try your changes
```

Edits are live: the viewer reloads itself when files in `viewer/` change. Restart `canvas` after changing `src/`.

Don't also install the plugin while developing, or Claude loads the skill twice. To try the plugin build itself, run `claude plugin validate .` and install from a local path in a separate Claude Code profile.

## Project structure

```
src/                      Node: the CLI and the local server (ES modules, no dependencies)
  cli.mjs                 entry point: argument parsing and every `canvas` command
  server.mjs              HTTP server: viewer, screens (components expanded), JSON API, live-reload events
  store.mjs               files on disk: pages, screens, canvas.json, json helpers
  threads.mjs             comment threads, stable element anchors, the Claude queue (canvas wait)
  components.mjs          <ds-name> expansion from _ds/components, `canvas ds`
  watch.mjs               per-directory file watching
  shot.mjs                `canvas shot` with headless Chrome
  hook.mjs                SessionStart hook: canvases with comments waiting
viewer/                   the browser app, served at /_app/
  index.html              loads the scripts below in order
  viewer.css
  js/                     classic scripts sharing one global scope; main.js boots last
    pill.js core.js frames.js comments.js ui.js input.js main.js
skills/canvas/SKILL.md    how Claude uses the canvas
hooks/hooks.json          plugin hook (calls `canvas hook session-start`)
bin/canvas                plugin entry: Claude Code puts bin/ on its PATH
.claude-plugin/           plugin manifest, and a marketplace manifest so the repo installs as one
examples/demo/            example canvas with its own small design system
assets/                   README screenshots
```

## Principles

Keep these in mind when proposing changes:

- **Zero dependencies, no build step.** Node built-ins on the server, plain JavaScript and CSS in the viewer.
- **The tool is project-agnostic.** It serves canvases and handles comments. It ships no design system, and no project's files, paths or names. Projects bring their own `_ds/`.
- **Cheap for Claude.** Commands print only what Claude needs, in a compact form. Screens stay plain HTML, and components keep them short.
- **Files are the source of truth.** Everything lives in the canvas folder (HTML, `canvas.json`, `comments.json`), so git, other tools and Claude can read it.
- **No browser dialogs.** Use the viewer's own modals (`openModal`), never `alert`, `confirm`, `prompt` or a "Leave site?" prompt.
- **Don't interrupt the person.** Live reloads must keep typing, scroll and unsaved changes.

## Testing your change

```bash
npm test             # unit + integration tests and a syntax check of every script (no install needed)
npm run test:e2e     # browser tests of the viewer (needs Playwright, see below)
```

- **Unit tests** (`tests/unit/`): component expansion, threads and the Claude queue, element anchors, pages and path safety, the session hook, the plugin files.
- **Integration tests** (`tests/integration/`): the real `canvas` command against a temporary canvas, and the real server (API, component expansion, path safety, live-reload events).
- **Browser tests** (`tests/e2e/`): the viewer running on a copy of `examples/demo`. They skip themselves unless Playwright is available. To run them, use `npm install --no-save playwright && npx playwright install chromium`, or point `CANVAS_PLAYWRIGHT` at an existing playwright install (and `CANVAS_CHROME` at a browser).

CI runs all of it on pull requests into `master` (releases): Node 20, 22 and 24 on Linux, Node 22 on macOS, the browser tests, and `claude plugin validate`. Run `npm test` yourself before opening a pull request into `develop`.

Add a test with your change: a unit test for logic, an integration test for commands and the server, and a browser test for viewer behaviour. If you changed how something looks, also put before and after screenshots in the pull request.

## Pull requests

- Branch from **`develop`** and open your pull request against `develop`. `master` holds releases; `develop` is merged into it when a version ships. Both are protected: changes land through pull requests. CI runs on pull requests into `master`.
- One topic per pull request, with a clear description of what changed and why.
- Match the existing style: two-space indentation, double quotes, small functions, comments that explain why rather than what.
- Update the README, the skill (`skills/canvas/SKILL.md`) or `canvas --help` when behaviour changes.
- Keep commits focused, with messages that say what changed for the user.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
