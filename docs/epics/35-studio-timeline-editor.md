# E35 Studio timeline editor

Milestone: standalone (Studio). Depends on: E34.

## Goal

A real video editor in the app: tracks for scenes, video, images, text, voice, music and sound
effects; trim, split, reorder, transitions, volume and fades; a preview that stays smooth; and the
same edits by typing what to change.

## Design

- **Media** is imported into the blob store (hashed in a worker thread), probed with ffprobe, and
  given derivatives in the local cache: 540p short-GOP proxies, sprite thumbnails, waveform peaks.
- **The timeline** draws only the clips in view (pure viewport maths), a canvas ruler and
  precomputed waveforms; every change is an edit op, so undo and history work as they do for the
  scenario.
- **The preview** keeps two scene iframes at most, plays proxies for imported clips, and mixes
  audio with Web Audio gains locked to one clock. Transitions are approximated in CSS; the render is
  exact.
- **Captions** come from a built-in caption composition rendered with alpha, so Chromium shapes
  Persian; splitting keeps ZWNJ, with optional Persian digits.

## Tasks

- [ ] T1 Media import and derivative jobs.
- [ ] T2 Timeline ops: add, move, trim, split, ripple, snap, transitions, fades, track flags.
- [ ] T3 The timeline UI, the Inspector, keyboard shortcuts.
- [ ] T4 Preview sync of scenes, clips and audio.
- [ ] T5 Assembly additions: overlays, captions with alpha, the audio chain, loudnorm.
- [ ] T6 Timeline ops in Ask AI.
- [ ] T7 e2e `studioTimeline.e2e.ts`.

## Acceptance criteria

- AC1 Import, trim, split, reorder, transitions and volume all render as edited.
- AC2 Every change is undoable and saved.
- AC3 A 500-clip timeline scrolls within its frame budget.
- AC4 Persian captions keep ZWNJ and run right to left.
- AC5 The mix measures -14 LUFS within 1 LU.
