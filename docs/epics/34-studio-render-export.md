# E34 Studio render and export

Milestone: standalone (Studio). Depends on: E33.

## Goal

Render a video to a file at the size, frame rate and quality the user picks, without freezing or
crashing the app, and carry on after a crash or a restart from where it stopped. ffmpeg, the tool
it needs, installs from Agent Tools > Dev Setup.

## Design

- **The plan** (`packages/studio/src/render/plan.ts`, pure): each scene's frames at the video's
  frame rate, rounded to the nearest frame, in chunks of about 2 seconds; the transitions between
  scenes in frames; the output size (the design size times the resolution's scale); and every
  reason the video cannot render yet, all at once (no scenes, a scene without animation, a
  transition as long as a scene it joins). The Render dialog shows the same numbers the render
  uses: length, size, frames, an estimated file size and time, and a free-space warning for the
  cache drive and the video's drive.
- **Capture** in the main process, through the same hardened offscreen windows as the checks, at
  the output size (page zoom keeps the layout at the design size). A frame is asked for only when
  ffmpeg has taken the one before, so memory stays at a frame or two. A window is replaced every 15
  chunks and whenever the scene pages use more than a quarter of the memory (3 GB at most), so a
  scene that leaks cannot grow without end. Frames a scaled display draws larger are scaled back by
  ffmpeg, so the size is always exact.
- **Chunks** are lossless (FFV1, every frame a key frame) and live in the cache
  (`<cache>/<videoId>/scenes/<key>/chunk-NNNN.mkv`). The key is a hash of everything that shows in
  the frames: the code tree, the runtime bundle and fonts, the scene's config (size, length,
  language, params, seed), the output size and frame rate. Quality and codec are not in it, since
  they change only the encode. A chunk is written beside itself, flushed, counted with ffprobe and
  only then renamed into place, so a chunk file that exists is a whole one. A resumed render, a
  retry, or a render after changing one scene captures only what is missing.
- **Assembly** is one ffmpeg run with a filter graph built by pure, golden-tested code and passed
  in a file (`-/filter_complex` on ffmpeg 7.1 and later, `-filter_complex_script` before), which
  keeps a long video clear of the Windows command-line limit. Each scene is joined from its chunks
  with the concat demuxer, put on one time base, then joined to the next with its `xfade`
  transition (the offset counted in frames, so the overlap comes out of both scenes) or a cut. The
  file gets a silent stereo track until voice arrives (E36). The finished file is checked with
  ffprobe (frames within one, exact size, a sound track) before it is renamed into the video's
  `renders` folder.
- **Encoders:** libx264 and libx265 (tagged `hvc1`) with a preset and CRF per quality, libvpx-vp9
  with Opus in WebM; NVENC, Quick Sync, AMF or VideoToolbox when the setting allows it and a test
  frame encodes, falling back to the software encoder (which only redoes the join) if the GPU
  encoder fails on the real video. A codec this ffmpeg cannot write is disabled in the dialog with
  the reason.
- **The queue** (`renders.json` in Studio's data folder): one render at a time, in order. ffmpeg
  runs below normal priority. Progress goes to the UI a few times a second and to disk every 2
  seconds. A render the app stopped in the middle of stays "running" on disk; on the next start,
  once the main window has loaded, it is queued again (or marked stopped, with Resume, when the
  user turned auto-resume off). Finished, failed and resumed renders raise an OS notification that
  opens the video. While a render of a closed video runs, the scene server reads that video's code
  from its folder.
- **The cache** is kept under its cap (Settings): scene folders are removed oldest first by when a
  render last used them, never the ones the last render used. History, blobs and finished videos
  are never touched.
- **Dev Setup** has a Studio stack with ffmpeg (winget `Gyan.FFmpeg`, Homebrew, apt/dnf/pacman,
  with the RPM Fusion note for Fedora) and ffprobe. Studio finds both through Dev Setup's own
  detection, WinGet's link folder included, so the two never disagree. A link
  (`/tools?tab=dev-setup&stack=studio`) switches the stack on without touching the stacks already
  chosen; Studio's home and the Render dialog show it when ffmpeg is missing.

## Tasks

- [x] T1 Dev Setup `studio` stack with ffmpeg and ffprobe; the version read from the first line
  only (a nightly build names its compiler's version on the next); the Setup card and the link.
- [x] T2 The plan, chunk and encoder arguments, the assembly graph, the progress parser, the
  capability probe.
- [x] T3 The job runner (chunks, verification, assembly), the queue, resume, free-space checks,
  cache pruning.
- [x] T4 Capture through the offscreen windows in the main process, with recycling and the memory
  cap.
- [x] T5 `IPC.studioRender`, the Render dialog, the render list and progress strip, the startup
  resume, OS notifications.
- [x] T6 CI: an e2e step that installs ffmpeg where the runner can, and warns otherwise (the spec
  skips itself without ffmpeg).
- [x] T7 e2e `studioRender.e2e.ts`: render from the dialog, kill the app, resume on the next start.

## Acceptance criteria

- AC1 A three-scene H.264 1080p30 render matches its length to a frame and its size exactly
  (ffprobe); missing encoders are disabled with a reason.
- AC2 Killing the app mid-render and resuming gives the same frames as an uninterrupted render,
  with no finished chunk redone.
- AC3 One changed scene re-renders alone.
- AC4 Cancel takes 2 seconds or less and the UI stays responsive throughout.
- AC5 A memory overrun recycles the capture window instead of crashing.

Status: all five pass. AC1 runs against the real ffmpeg at 1920x1080, 30 fps, three scenes with a
fade and a cut (90 frames, exact), and at a small size with VP9 and a scaled display; the e2e
renders 720p24 in the built app to exactly 132 frames. Disabled codecs are covered by the queue
and dialog tests. AC2: the e2e kills the app with SIGKILL after two of four chunks; on the next
start the render resumes by itself, reuses the finished chunks and the file has the exact frame
count. Frame equality with an uninterrupted render (`framemd5`) is checked against the real ffmpeg
in the package's integration tests, after a cancel in the middle of a scene. AC3: integration test
(2 chunks captured, 5 reused). AC4: integration test, cancel in the middle of drawing and of
encoding, both under 2 seconds; responsiveness rests on S1's main event-loop p99 of 24 ms at 1080p
(see Known limits for 4K). AC5: the job tests drive the memory cap with a leaking stand-in and the
window is replaced at each chunk boundary.

## Implementation notes

- An offscreen page paints only when something on it changed, so one `invalidate()` gives one
  paint. E33's check waited for four paints after a single invalidate and sat out its 1 second
  limit on every frame; that went unnoticed with six frames per check, but rendered under one
  frame a second. Asking for paints quickly instead made frames fast but sometimes stale: paints
  asked for while a heavy page (canvas with shadows, blur) is still drawing repeat the moment
  before, and 13 of the 15 reference scenes then failed their "same frame twice" check. A frame
  is now taken once the page has painted the change by itself (up to 80 ms; a moment that looks
  like the one before paints nothing and costs only that), and its pixels have stayed the same
  for 25 ms. The e2e render went from 3.4 minutes to under a minute, and every reference scene
  passes again (three runs in a row).
- The startup resume used to open its hidden scene window before the main window existed, which
  made it "the first window" for Playwright (and for anything else that takes the first window to
  be the main one); it now waits for the main window's first load.
- When ffmpeg dies while frames are still being written, the pipe only says "EOF"; the chunk
  writer waits for ffmpeg's exit and reports what ffmpeg printed instead.
- `events.once(stream, 'drain')` rejects when the stream errors, so a dead ffmpeg surfaced as a
  write error rather than its own message until the drain wait stopped rejecting.
- The package tests run everything against a stand-in ffmpeg written in Node
  (`packages/studio/src/test/fakeFfmpeg.mjs`, started through `process.execPath`), so coverage does
  not depend on the CI machine having ffmpeg; `renderJob.int.test.ts` runs the same paths against
  the real one wherever it is installed and is skipped elsewhere.
- `safeFolderName` (E31) let a backslash through, so on Windows a title like `a\b` would have
  made a subfolder; it is stripped now, for folders and render file names alike.

## Known limits

- **No render worker process.** The plan considered one (S1 measured main event-loop p99 near
  100 ms at 4K). Rendering runs in the main process instead: a packaged app can only start a
  windowed worker by branching the shared `main/index.ts` before anything else loads, which is a
  larger change than this epic. At 1080p the main process stays at about 24 ms p99; at 4K the app
  can stutter while a render runs. E39's soak decides whether the worker comes.
- No audio beyond a silent track until E36; no captions or overlays until E35.
- The render list is one global queue; there is no reordering or pausing.
- The CI e2e runners need ffmpeg installed once on the host (the self-hosted Linux runner has no
  passwordless sudo); until then the render spec is skipped there with a warning.
