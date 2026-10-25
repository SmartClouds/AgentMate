# E33 Studio motion graphics

Milestone: standalone (Studio). Depends on: E32.

## Goal

Scenes become motion graphics written as HTML, CSS and JS by the AI CLIs, saved as code with every
version kept, previewed live in a sandbox, and drawn the same way frame by frame for the render.
Fifteen style presets of our own give the AI a look to follow.

## Design

- **The runtime.** A page draws any moment on demand: `window.renderAt(t)`. A prelude installed
  before the author's code makes time virtual (Date, performance.now, requestAnimationFrame,
  timers, with the browser's nested-timer clamp so a polling loop cannot starve later timers) and
  seeds `Math.random` per frame, so a frame is the same every time. CSS and Web Animations and
  lottie-web are paused and seeked; canvas, WebGL and DOM drawing go through `render(t, ctx)`.
  Fonts and images are awaited. `ctx` carries progress, size, language, params, seeded random,
  noise, easing, tween, keyframes and a closed-form spring. `__studio.afterPaint()` waits for real
  paints. A page is ready once its scene has registered and set up. Built to one 13 kB file with
  Vite library mode (`dist/bundle/studio-runtime.js`).
- **One locked-down scheme.** `studio-scene://t-<treeHash>/` serves one immutable code tree with a
  CSP that allows no network, no frames and no forms; each tree is its own origin. `index.html`
  gets the scene's config, the fonts stylesheet and the runtime at the top of its head. Responses
  send `Access-Control-Allow-Origin: *`, since the preview iframe runs at an opaque origin. The
  main window's CSP gains `frame-src studio-scene:`, and scene responses keep their own CSP instead
  of the app's (which allows the loopback websocket). Media serving (`studio-media:`) comes with
  imported media in E35.
- **Scene code** comes back from the CLI as fenced files (text mode, for every CLI: it needs no
  write permission and nothing can land outside the scene). Files pass an extension and size
  allowlist and become a tree in the blob store; each scene change is a code revision (append-only)
  and one history entry, so undo covers code too. Every video folder keeps a copy of each scene's
  current code in `scenes/`.
- **Checks.** A hidden offscreen window in a session of its own (no permission, no preload, every
  request but `studio-scene:` cancelled) loads the scene at a quarter of its design size, draws a
  warm-up frame, then frames at the start, a quarter, the middle and the end. Blank frames, a frame
  that differs when drawn again, errors, blocked requests, navigation and new windows all fail the
  check; up to two fix rounds send the problems back. The middle frame becomes the thumbnail.
- **Styles.** Line boil, isometric, flat vector, line art, soft 3D, shape morph, sticker
  explainer, HUD, collage, aurora glass, Bauhaus, synthwave VHS, pixel art, liquid and bold
  captions, each with a palette, motion rules, do and avoid, and one reference scene of our own in
  Persian and English. A video's style reference goes into the scene request as a worked example.
  Nothing was adapted from mg-styles-15, so no notice is needed.
- **Fonts.** Vazirmatn, Inter and Noto Naskh Arabic (all SIL OFL 1.1, licenses beside them in
  `packages/studio/assets/fonts`), served offline to every scene.
- **Network allowlist.** Per project, empty by default; widens the scene CSP and the check
  window's request filter together, https only.

## Tasks

- [x] T0 Spike S1, capture (results below).
- [x] T1 The runtime with its prelude and adapters, its build, and the OFL fonts.
- [x] T2 The blob store (from E32), code trees, append-only code revisions, the `scenes/` copy.
- [x] T3 The scheme, the CSP edits (`main/appCsp.ts`, with a test that spells out the policy),
  first checked by a sandboxed iframe loading the runtime and a font.
- [x] T4 The 15 presets with original reference scenes.
- [x] T5 Scene generation (text mode for every CLI) and checks in the offscreen window, with fix
  rounds; `IPC.studioScenes`.
- [x] T6 The preview player (one iframe per open preview, latest-frame-wins), the code dialog with
  versions, the styles gallery.
- [x] T7 The per-project network allowlist.
- [x] T8 e2e `studioScenes.e2e.ts`.

## Acceptance criteria

- AC1 All 15 reference scenes validate: deterministic, never blank, no errors.
- AC2 A scene from a fake CLI previews.
- AC3 Scene code cannot fetch, reach the parent window, navigate or open windows, and every attempt
  is reported.
- AC4 A code edit is a new revision and old revisions still preview.
- AC5 Persian renders right to left in Vazirmatn.
- AC6 The presets and reference scenes pass the no-Chinese-content scan.

Status: all six pass. AC1, AC2, AC4 and AC5 run in `studioScenes.e2e.ts` against the built app
(the 15 reference scenes also passed in Persian and English and in 9:16 in the spike harness).
AC3: a fetch is refused by the CSP and reported; in the e2e a scene that fetches fails its check
and is repaired. Inside the preview iframe, parent access, `window.open` and top navigation are
refused by the sandbox (`window.open` is also reported by the runtime); in the check window
navigation and new windows are refused and reported by Electron. AC6: the scan now covers
`packages/studio/assets`.

## S1 results (RTX 3050 Laptop, 4 GB, this machine)

- `capturePage` on a hidden window fails here (`UnknownVizError`, the GPU process exits), so the
  offscreen window's `paint` event is the capture method.
- 1080p30, frames at the exact size once the window is resized after creation (a hidden window is
  clipped to the work area at creation):

| Scene | No encoder | x264 lossless | FFV1 | Peak memory |
| --- | --- | --- | --- | --- |
| DOM with Persian text | 22 to 23 fps | 16.7 fps | 19.4 fps | about 500 MB |
| Canvas, 4,000 particles | 17 to 19 fps | 14.5 fps | 12.9 fps | about 500 MB |
| WebGL, about 100k triangles | 20 to 21 fps | 21.5 fps | 20.4 fps | about 550 MB |

- Frame exactness: 0 barcode mismatches on every run; frame hashes identical across two runs
  except the very first frame, so the capture draws a warm-up frame first.
- 15 minute soak (WebGL 1080p, no per-frame hashing): 28,719 frames at 31.9 fps, 0 mismatches,
  memory slope 0.29 MB per minute, peak 569 MB, main event-loop p99 24.4 ms.
- 4K: offscreen windows ignore `force-device-scale-factor`; a window at the output size with page
  zoom 2 (layout stays at the 1920x1080 design size) gives exact 3840x2160 frames, WebGL 9.5 fps,
  DOM 8 fps, peak 833 MB. Main event-loop p99 reaches about 100 ms at 4K, which decides the render
  worker process for E34.
- Alpha: a 50% red rectangle comes back as (128, 0, 0, 128), premultiplied, within the 2/255
  target; E34 un-premultiplies before encoding.
- The WebGL renderer reported `ANGLE (NVIDIA ... RTX 3050 ...)` without forcing the
  high-performance GPU.
- Decisions: offscreen `paint` capture; a render worker process for renders (E34), checks in the
  main process; FFV1 or lossless x264 mezzanines; captions with alpha through Chromium.

## Implementation notes

- The page zoom has to be set when the window is created (`webPreferences.zoomFactor`); set after
  load, the scene's script had already measured the window at the output size and drew into a
  corner.
- Chromium's rasterizer can differ by up to 3 levels per channel for the same picture depending on
  what it drew before, so "the same frame" allows 0.1% of pixels to differ by more than 16 levels.
  Heavy pages (blur filters, large shadows) needed four paints after a frame instead of two.
- The Studio package is bundled into the main process, so it cannot find its own files; the host
  passes the package root (node_modules in dev and e2e, `resources/studio` when packaged, see
  `electron-builder.yml`).
- Electron quits when its last window closes unless told otherwise; the app's main window keeps it
  alive, but a harness that only opens check windows needs a `window-all-closed` handler.
- Gemini runs during E32's spike ended on quota (HTTP 429); its log line "An unexpected critical
  error occurred:[object Object]" is not picked up as an error line yet.

## Known limits

- Scenes are animated one at a time; there is no "animate every scene" yet.
- Monaco shows Persian inside code without bidi reordering, so a Persian string in code can look
  scrambled there while it renders correctly in the scene.
- `studio-media:`, three.js and lottie-web files for scenes come with imported media and rendering
  (E34, E35); scenes draw with HTML, CSS, SVG, canvas and WebGL meanwhile.
