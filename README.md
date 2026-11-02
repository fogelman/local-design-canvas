# Local Design Canvas

An offline design canvas with Figma-style comment threads. It has no dependencies and needs only Node 20 or newer.

A canvas is just a folder:

```
my-design/
  login.html        # every top-level *.html file is a live frame
  home.html
  styles.css        # optional shared styles (a change reloads every frame)
  _ds/ds.css        # optional design system the project installs; `canvas new` links it
  canvas.json       # frame positions (written by the viewer)
  comments.json     # threads (written by the viewer and the CLI)
  checkout/         # each subfolder with html (or a canvas.json) is another page,
    cart.html       #   with its own canvas.json + comments.json
```

## Use

```bash
canvas my-design            # serve + open http://127.0.0.1:4747
canvas new login 390x844    # new frame (size goes in <meta name="canvas:size">)
canvas comments             # threads waiting on Claude (latest message sent with "Send to Claude")
canvas comments --open      # every open thread · --all includes resolved
canvas ds                   # list the project's components (_ds/components) with their usage
canvas watch on|off         # should a Claude session answer comments as they arrive? (asked once per canvas)
canvas wait                 # block until comments are sent to Claude, claim and print them (run in the background)
canvas reply c4 "Done" --resolve
canvas shot c4              # PNG of a thread's frame (or `canvas shot login`), via headless Chrome
canvas resolve c4 / canvas reopen c4   # threads on other pages print as checkout/c2
```

## Viewer

| Key | Action |
|---|---|
| V | Move: drag frames, resize from the corner handle, nudge with the arrow keys, double-click to zoom |
| H / hold Space / middle mouse | Pan |
| C | Comment: click any element in a frame, or empty canvas |
| I | Interact: use the live page (click, scroll, type) |
| Wheel / Ctrl+wheel (pinch) | Pan / zoom |
| Shift+1 · Shift+0 · Shift+2 | Fit all · 100% · zoom to the selected frame |
| P | Present: full-screen frames in reading order, ← → to step through, Esc to exit |
| Esc | Close the menu or thread, then go back to Move |

Page menu (top left): switch pages, or open "…" on a page for Copy link to page, Rename and Delete. Rename and Delete open modals. Delete moves the folder to `.trash/`, and the first page can't be deleted. New page creates a subfolder.

Moving, resizing or nudging frames doesn't save right away. The status pill at the top shows "Unsaved changes · Discard · Save" (Ctrl+S saves), then turns into the "Layout saved" toast, or a red error. Switching pages with unsaved changes shakes the pill instead. Unsaved moves are kept per page in the browser, so a reload brings them back. The app uses only its own modals, never browser dialogs. Claude's replies show as a toast in the same pill. Open viewers reload by themselves when the canvas app is updated. Zoom menu (top right): in/out, fit, selection, 50/100/200%.

## Components (atomic design)

Frames can be composed from reusable components instead of raw markup:

```html
<ds-index-page title="Contas a Pagar" active="Financeiro">
  <template slot="actions"><ds-button size="sm">Adicionar</ds-button></template>
  <ds-data-table columns="Vencimento,Fornecedor,Valor:num"><tr>…</tr></ds-data-table>
</ds-index-page>
```

- **Where components live:** `<canvas>/_ds/components/{atoms,molecules,organisms,templates}/<name>.html`. A page's own `_ds/` is checked first, then the canvas root's.
- **How they expand:** the server expands `<ds-name>` tags when it serves a frame, and so does `canvas shot`. The browser only sees static HTML, so comments, snapshots and live reload work as usual. Changing a component reloads every frame.
- **Writing a component:** it's plain HTML with an optional first-line `<!-- usage -->` comment, which `canvas ds` lists. The syntax:

| Syntax | Meaning |
|---|---|
| `{{prop}}`, `{{prop\|default}}` | An attribute value (escaped). The default also applies when the value is empty |
| `{{?prop}}…{{/prop}}`, `{{!prop}}…{{/prop}}` | Only when the attribute is set (`?`) or not set (`!`) |
| `{{@prop:<th>$</th>}}` | Repeat for each comma-separated item. Items may be `Label:icon` (`$`, `$2`). `{{@prop\|A,B::…}}` sets a default list. `$=active` outputs `on` for the item equal to `active` |
| `<slot></slot>`, `<slot name="x">fallback</slot>` | The tag's children; `<template slot="x">` fills a named slot |

- **Component markers:** each component's root element gets `data-ds="<level>/<name>"`. A comment inside a component records the component path, and comment mode names the component under the cursor.

The tool ships no components: each project brings its own design system.

## Where canvas files live

The canvas tool is only the server, the viewer and the CLI. A canvas is a folder that belongs to the project you design in: its frames, `canvas.json`, `comments.json` and `_ds/` live in that project's repo, and the project (and the Claude session working in it) is responsible for them. The tool never ships or knows any project's files.

## Generated canvases

A build script can write a canvas instead of a person or Claude. Its `canvas.json` can carry:
- `"sections": [{ "title", "sub", "x", "y" }]`: group titles drawn on the canvas. `(x, y)` is the bottom-left of the title, so leave about 110 units above the row's frames for their names. Below 20% zoom the frame names hide and section titles stay at least 14px on screen.
- `"source": "…"`: a note saying where the frames come from. `canvas comments` prints it above that page's threads, so Claude changes the source rather than the generated html. Comments on such pages aren't written into the files, since a rebuild would wipe them. They anchor by selector instead.


## Performance

Frames are virtualized. Only frames near the viewport get a live iframe, capped at 12 and nearest first (override with `?live=N`). Frames that leave the view unload after 2.5 s and restore their scroll when they come back. Every other frame shows a static snapshot: its DOM and CSS serialized into an SVG image, painted cheaply at any zoom. One hidden iframe works through a queue to create missing snapshots and refresh stale ones, so the zoomed-out overview stays complete. Snapshots don't load external images or web fonts, so treat them as previews.

**Queue.** A thread sent to Claude shows as *Queued for Claude*. When a Claude session watching the canvas picks it up with `canvas wait`, it shows as *Claude is working…*, and Claude's reply clears it. Watching is optional and set per canvas (`canvas watch on|off`); the skill asks once. It's event-driven: a background `canvas wait` costs nothing until a comment arrives and batches a burst of comments into one handoff. A claim older than 30 minutes (for example, the session died) goes back to *Queued*.

Each message has a **Send to Claude** checkbox, shown as an `@Claude` chip, and the choice is remembered. Unchecked messages are notes between people. A thread enters Claude's queue when its latest message is sent to Claude, and leaves it when Claude replies. The panel tags those threads "Waiting on Claude".

When you comment on an element, the canvas writes `data-cid="<thread id>"` onto it in the frame's source, so the pin survives edits and Claude can find it with one grep. If the page's DOM no longer mirrors the source (for example, when JS generated the element), the comment falls back to a CSS selector plus an offset inside that element, so pins follow the element when the layout changes. If the selector stops matching, the pin falls back to the saved frame coordinates. Resolved threads are hidden unless the panel's Resolved tab is open.

## Claude

The canvas skill (`skills/canvas/SKILL.md`, from the plugin or your linked working copy) lets any project can ask Claude to "answer the canvas comments". Claude runs `canvas comments`, edits only the frame each thread names, and replies with `canvas reply <id> "…" --resolve`. The viewer updates live.

## Install

Needs Node 20 or newer. There are no dependencies to install.

### As a Claude Code plugin (recommended for users)

```
/plugin install local-design-canvas --marketplace fogelman/local-design-canvas
```

On older Claude Code, use two steps: `/plugin marketplace add fogelman/local-design-canvas`, then `/plugin install local-design-canvas@local-design-canvas`. The repo is private, so it clones with your git credentials (for example after `gh auth setup-git`).

The plugin adds:
- **the `canvas` command** to Claude's shell
- **the canvas skill**
- **a start-of-session hook:** if a canvas in the project has comments waiting for Claude, or has watching on, the session hears about it right away

The plugin's `canvas` is only on Claude's PATH. To run it yourself in a terminal, also do the CLI install below.

### CLI only, or developing the tool

Point your PATH and Claude at your working copy, so edits are live:

```bash
git clone git@github.com:fogelman/local-design-canvas.git && cd local-design-canvas
npm link                                          # `canvas` in your terminal (lib/canvas.mjs)
ln -s "$PWD/skills/canvas" ~/.claude/skills/canvas  # the skill, from your working copy
```

Don't also install the plugin, or the skill loads twice. For the session hook in this setup, add it to `~/.claude/settings.json` yourself, as a `SessionStart` command hook running `canvas hook session-start`.

`canvas shot` needs Chrome or Chromium. It looks for `google-chrome`, `chromium` and a Playwright download; set `CANVAS_CHROME=/path/to/chrome` to pick one.

### Layout

| Path | What it is |
|---|---|
| `lib/canvas.mjs` | The CLI and server: the real entry point (npm `bin`) |
| `bin/canvas` | Shell wrapper. Plugins put `bin/` on Claude's PATH, so the file name is the command |
| `app/` | The viewer |
| `skills/canvas/SKILL.md` | The skill |
| `hooks/hooks.json` | The plugin's SessionStart hook |
| `.claude-plugin/` | Plugin manifest, plus a marketplace manifest so the repo installs as its own marketplace |

## References

What the design is modelled on (Claude Design, Figma) is recorded in [docs/references.md](docs/references.md).
