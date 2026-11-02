# References: what the canvas is modelled on

## Claude Design (Anthropic)

The look and the comment workflow follow Claude Design, Anthropic's design tool on claude.ai, as observed from its UI. No code was copied. What we adopted, and where it lives:

| In Claude Design | In this canvas |
|---|---|
| Floating pills: page menu and tools at the top left, play / panel / zoom at the top right; dark canvas | `app/index.html`, `app/app.css` |
| Page "…" menu with Copy link / Rename / Delete; rename and delete in modals | `renderPageMenu`, `openPageActions` and `openModal` in `app/app.js` |
| Comment composer with an `@Claude` chip and a **Send to Claude** checkbox | `renderPop` in `app/app.js`; the per-message `claude` flag and the waiting-on-Claude queue (`canvas comments`) in `bin/canvas.mjs` |
| One file per artboard, rendered in a same-origin iframe the host can reach into, under an overlay; titles counter-scaled to stay readable | `renderFrames`, `mount` and the shield in `app/app.js`; `--inv` in `app/app.css` |
| Stable ids on authored elements, so edits and comments can target them | `data-cid="<thread id>"`, written into the frame's source when a comment is created (`tagElement` in `bin/canvas.mjs`) |
| Artboards linking to each other, with ▷ Play per artboard | `frameForHref`, the label's play button and present mode in `app/app.js` |
| A shared design-system stylesheet across artboards | Convention: a project may install `_ds/ds.css` in its canvas, and `canvas new` links it |
| Export artboard | `canvas shot <frame or thread>` |
| Design-system components (`psd-badge`, `data-slot`, component markers) | Atomic components expanded by the server from the project's `_ds/components/` (`expandComponents` in `bin/canvas.mjs`); roots marked `data-ds`, so comments name their component |
| Unloaded artboards drawn as diagonal stripes | `.ph` stripes in `app/app.css` |

**Deliberately different:**
- **Static HTML frames:** frames are plain static HTML, not a component framework, which is cheaper for Claude to read and edit.
- **No sandbox hardening:** frames are local files, not hosted untrusted content.
- **Viewport-based lazy loading:** only frames near the viewport run live, capped at 12, and the rest show SVG snapshots (`snap` / `cull` in `app/app.js`).
- **Files and a CLI instead of hosted state:** edits go through comment threads that Claude Code reads with `canvas comments`.

## Figma

Interaction conventions:
- keys V / H / C / I, and hold Space to pan
- wheel to pan, Ctrl+wheel or pinch to zoom
- Shift+1 / Shift+0 / Shift+2 for fit / 100% / selection
- a resize handle and a size badge on the selected frame
- frame names hidden when zoomed far out
