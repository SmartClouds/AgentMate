# E33 Studio motion graphics

Milestone: standalone (Studio). Depends on: E32.

## Goal

Scenes become motion graphics written as HTML, CSS and JS by the AI CLIs, saved as code with every
version kept, previewed live in a sandbox, and drawn the same way frame by frame for the render.
Fifteen style presets of our own give the AI a look to follow.

## Design

- **The runtime.** A page draws any moment on demand: `window.renderAt(t)`. A prelude injected
  before the author's code makes time virtual (Date, performance.now, requestAnimationFrame,
  timers) and seeds random numbers per frame, so a frame is the same every time. Adapters seek CSS
  and Web Animations, lottie-web and the author's canvas or three.js drawing. Fonts and images are
  awaited. Built to one file with Vite library mode (`@agentmat/studio/runtime`).
- **Two locked-down schemes.** `studio-scene://t-<treeHash>/` serves one immutable code tree from
  the blob store with a CSP that allows no network; `studio-media://<token>/` serves media with
  seeking, by token, so the renderer never sends a path. Main CSP gains `frame-src studio-scene:`
  and media entries only. Scene responses send `Access-Control-Allow-Origin: *`, since the
  preview iframe runs at an opaque origin.
- **Scene code** is written by the CLI in a work folder (or returned as fenced files for CLIs that
  cannot write safely, per S2), imported through an extension and size allowlist into the blob
  store as a code revision, then validated: the ready handshake, frames at the start, middle and
  end, the same frame twice, no blank frame, no errors and no blocked requests. Two auto-fix rounds,
  then Fix with AI and the Monaco code view.
- **Styles.** Line boil, isometric, flat vector, line art, soft 3D, shape morph, sticker explainer,
  HUD, collage, aurora glass, Bauhaus, synthwave VHS, pixel art, liquid and variety captions, each
  with palette, an Arabic-script font stack, motion rules and one reference scene with Persian and
  English copy. mg-styles-15 is a visual reference; anything adapted keeps its MIT notice and has
  its Chinese content removed.

## Tasks

- [ ] T0 Spike S1, capture: hidden window `capturePage` against an offscreen window's `paint`, in
  main against a child render worker, measured on the RTX 3050 (throughput at 1080p30, frame
  exactness, memory over 15 minutes, main event-loop lag, DPR, alpha, packaged build, xvfb, which
  GPU was used). Decides the capture method, process model, mezzanine codec and caption path.
- [ ] T1 The runtime with its prelude and adapters, and its build; OFL fonts (Vazirmatn, Noto
  Naskh Arabic, Inter).
- [ ] T2 The blob store, code trees, code revisions and the read-only mirror in `scenes/`.
- [ ] T3 Both schemes and the CSP edits; first test: a sandboxed iframe loads the runtime and a
  font.
- [ ] T4 The 15 presets and reference scenes.
- [ ] T5 Scene generation (agentic or text mode) and validation in the capture host.
- [ ] T6 The preview player (two live iframes at most), the Monaco code panel with revisions.
- [ ] T7 A per-project network allowlist, empty by default.
- [ ] T8 e2e `studioScenes.e2e.ts`.

## Acceptance criteria

- AC1 All 15 reference scenes validate: deterministic, never blank, no errors.
- AC2 A scene from a fake CLI previews.
- AC3 Scene code cannot fetch, reach the parent window, navigate or open windows, and every attempt
  is reported.
- AC4 A code edit is a new revision and old revisions still preview.
- AC5 Persian renders right to left in Vazirmatn.
- AC6 The presets and reference scenes pass the no-Chinese-content scan.
