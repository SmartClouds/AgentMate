# E34 Studio render and export

Milestone: standalone (Studio). Depends on: E33.

## Goal

Render a video to a file at the size, frame rate and quality the user picks, without freezing or
crashing the app, and carry on after a crash or a restart from where it stopped. ffmpeg, the tool
it needs, installs from Agent Tools > Dev Setup.

## Design

- **Capture** as S1 decided: frames from the capture host written raw (BGRA) to ffmpeg's stdin,
  two at most in flight, with watchdogs (heartbeat, a memory cap that recycles the window between
  chunks).
- **Scene mezzanines** cached by a hash of the code tree, runtime, fonts, design size, scale, frame
  rate and parameters, rendered in chunks of about 2 seconds, each made durable before the next. A
  resumed render reuses every finished chunk. Changing one scene re-renders that scene only.
- **Assembly** is one ffmpeg filter graph built by pure, golden-tested code and passed in a file:
  trims, scaling, transitions (`xfade`), overlays, captions, the audio chain and two-pass loudnorm.
- **Presets:** YouTube, Shorts and Reels, square, feed, 4K master, custom; 720p to 2160p; 24, 30
  or 60 fps; Draft, Standard, High, Master; H.264, H.265 or VP9; hardware encoders when they pass a
  test encode; a size and time estimate and a free-space check on both the cache and the output
  drive.
- **One render at a time**, persisted; ffmpeg below normal priority; interrupted renders resume on
  start (a setting).

## Tasks

- [ ] T1 Dev Setup `studio` stack with ffmpeg (winget `Gyan.FFmpeg`, brew, apt/dnf/pacman) and
  ffprobe; the version parser hardened for nightly builds; the Setup card in Studio.
- [ ] T2 Render settings, the plan, mezzanine and encode arguments, the assembly graph, the
  progress parser.
- [ ] T3 The job store, queue, runner, resume and free-space check.
- [ ] T4 The capture implementation from S1 (with the worker entry and bootstrap if chosen).
- [ ] T5 `IPC.studioRender`, the Render dialog, the queue, the startup resume.
- [ ] T6 CI: ffmpeg in the e2e runner's required packages (needs a one-time install on the
  self-hosted runner, which has no passwordless sudo).
- [ ] T7 e2e `studioRender.e2e.ts` at a tiny size, with a kill and resume.

## Acceptance criteria

- AC1 A three-scene H.264 1080p30 render matches its length to a frame and its size exactly
  (ffprobe); missing encoders are disabled with a reason.
- AC2 Killing the worker or the app mid-render and resuming gives the same frames as an
  uninterrupted render, with no finished chunk redone.
- AC3 One changed scene re-renders alone.
- AC4 Cancel takes 2 seconds or less and the UI stays responsive throughout.
- AC5 A memory overrun recycles the capture window instead of crashing.
