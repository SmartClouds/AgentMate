# E18 Ask AI for Remote Desktop

Milestone: standalone (Remote). Depends on: the Remote Desktop client (commit 70c2351) and the SSH
Ask AI runner.

## Goal

Let an AI operate a Remote Desktop session the way "Ask AI" already operates an SSH terminal. Each
step the AI gets a screenshot of the remote desktop and answers with one mouse or keyboard action,
which Runova carries out while the user watches, approves or takes over.

## Tasks

- [x] T1 Spike: capture the IronRDP `Session` by wrapping the `Backend` the element builds it from,
  read the render canvas back, send input through `InputTransaction` and `DeviceEvent`, and check
  which agent CLIs can look at an image in a headless run.
- [x] T2 Core: `promptImageInput`, `promptImageArgs` and `promptImageEnv` on CLI definitions
  (Claude Code, Codex, Gemini CLI), with `supportsPromptImages` and `buildHeadlessImageInput`.
- [x] T3 Headless runs attach images (`runHeadlessCliPrompt` option `images`); a CLI that can't look
  at images is refused before it starts.
- [x] T4 API vision: `runAiPrompt` sends images to OpenAI, Gemini and Ollama.
- [x] T5 Protocol: the action grammar and its parser, risky actions, the prompt, screenshot to
  desktop coordinates, PS/2 scancodes and key combos, and actions turned into input ops.
- [x] T6 Window bridge: main asks the session window for a frame or to apply input, with timeouts,
  and only that window can answer.
- [x] T7 Runner `rdpTaskRunner.ts` beside the SSH one: step and time limits, pause and continue,
  approval modes, questions, history, notifications, unchanged-screen hints.
- [x] T8 IPC and preload `rdpAgent`, stop on window close and on quit.
- [x] T9 Renderer executor: session capture, `applyInputOps`, `captureFrame`, `useRdpAgentBridge`.
- [x] T10 UI: Ask AI button, task dialog (only CLIs that can see images), status bar, input shield
  with Take over and a target marker, history.
- [x] T11 Fixture: xrdp and XFCE test server in Docker and `rdpAiTask.e2e.ts`.
- [x] T12 Docs.

## Acceptance criteria

1. An AI task started from the Remote Desktop window clicks, types, presses keys, scrolls and drags
   on the remote desktop at the exact pixel it named in the screenshot.
2. Every step sends a fresh screenshot to the AI. The CLI picker lists only CLIs that can look at
   one; the Settings provider is offered with a note that it needs a vision model.
3. In "approve risky" mode the run stops before typing text and before dangerous shortcuts (Win,
   Win+R, Win+X, Alt+F4, Ctrl+Alt+Del, Ctrl+Shift+Esc, Shift+Delete, Delete); clicks run freely.
4. The user's own input is blocked during a run, and Take over stops it and releases held keys.
5. Closing the window or quitting the app stops the run. The history lists every action and how
   it went.

## Implementation notes

- Input goes through the IronRDP session itself, not synthetic DOM events. `UserInteraction` has no
  input API, but the element creates its session with `new this.module.SessionBuilder()`, so
  `wrapBackend` hands over the `Session` from `connect()`. Coordinates are remote desktop pixels,
  extended scancodes are one integer with 0xE0 in the high byte (Win is 0xE05B), and wheel units
  are 0 pixel, 1 line, 2 page.
- Screenshots come from the render canvas in the open shadow root (2D `putImageData`, so readback
  works) and are scaled to at most 1280 pixels wide. The window keeps painting while covered
  because the run turns background throttling off for it.
- Verified by hand on 2026-10-02 against an xrdp and XFCE desktop at 1280x800 (fake Ollama giving a
  fixed script): `MOVE 200 150` put the remote pointer at x:200 y:150 (xdotool), `DOUBLE_CLICK 640
  400` at 640,400, a click on the dock opened a terminal, `TYPE "echo rdp-ok > /tmp/rdp-e2e.txt\n"`
  wrote the file, scancode `KEY` sequences typed too, and a title bar `DRAG` moved the window by
  exactly (200, 100). The first drag did nothing: a window manager ignores motion that arrives all
  at once, so a drag now holds 100 ms, pauses 20 ms per step and holds again before release.
- Headless image checks with a test screenshot: `claude -p --allowedTools Read` ("Read ./frame.png
  first") and `gemini -p` with `@frame.png` both answered with the right click point. Gemini refuses
  an untrusted folder such as a temp dir, hence `GEMINI_CLI_TRUST_WORKSPACE=true` for image runs.
  `codex exec` refuses a folder outside a git repo ("Not inside a trusted directory and
  --skip-git-repo-check was not specified"), so image runs pass that flag once (`promptImageArgs`)
  and `--image` per screenshot (`promptImageFlag`). With it Codex got past the check, but the local
  Codex account had no access to its configured model, so a Codex answer is unverified here.
- A real Claude Code run through the app (approve risky, xrdp test server): it clicked the password
  field, typed the password, clicked into the terminal and ran `echo cli-ok > /tmp/cli.txt`, which
  landed on the server, then finished with a summary. Both TYPE steps stopped for approval; the
  clicks did not.
- xrdp does not log in with the credentials the client sends; the session opens on xrdp's own login
  dialog with the password field focused. The AI can type the password there like a person.
- `e2e/rdpAiTask.e2e.ts` runs against `e2e/rdp-server` (Ubuntu 24.04, xrdp, XFCE, an autostarted
  terminal, xdotool) with the fake Ollama provider, so it covers the vision API path. It signs in by
  typing, writes a file from the terminal and drags its window (checked with `docker exec` and
  xdotool), checks a MOVE lands on the exact pixel, and checks each request carried one 1280x800
  PNG. A fresh container per test, because xrdp keeps the desktop across reconnects. The first image
  build takes about 18 minutes without a cache.
- Found while testing and not caused by this epic: against xrdp, the session canvas draws many
  partial updates sheared diagonally (newly typed text, the panel, redrawn regions), and the user
  sees the same in the window. A full repaint draws cleanly. It looks like a row stride mismatch in
  how the viewer applies xrdp's bitmap updates. Scripted steps don't care, but a real vision model
  reading text on an xrdp desktop is hurt by it, so it needs its own fix in the viewer.
