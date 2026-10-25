# E35 Studio timeline editor

Milestone: standalone (Studio). Depends on: E34.

## Goal

A real video editor in the app: tracks for scenes, video, images, text, voice, music and sound
effects; trim, split, reorder, transitions, volume and fades; a preview that stays smooth; and the
same edits by typing what to change.

## Design

- **The scene track is the scenario.** It is not stored as clips: it is laid out from the scene
  list the way the render lays it out (each scene on whole frames, each transition overlapping the
  two scenes it joins; `timeline/layout.ts`, tested to agree with the render plan to the frame).
  Dragging a scene block is `scene.move`, dragging its right edge sets its length (and makes the
  length fixed), so there is one source of truth and no schema change. Every other track holds
  clips over the scenes: video and pictures (fitted full frame, with bars where the shape
  differs), captions, voice, music and sound effects.
- **Edits** are the existing ops: every gesture builds one labelled list (`timeline/edits.ts`:
  add, move, trim, split, delete with or without closing the gap, volume and fades, scene order and
  length), checked against the video (the right kind of track, no two clips overlapping on a track,
  at least a frame long, a trimmed clip never reaching past its file), so a gesture is one undo
  step and one history entry.
- **Media** is copied into the video's blob store as a stream (the video keeps working when the
  original moves), probed with ffprobe (video, sound or still; a music file's cover art is not a
  video), recorded in the video's history (no deletes) and given preview files in the local cache
  one at a time: a 540p proxy with a key frame every half second, a poster, a thumbnail strip and
  waveform peaks. The editor reads them through `studio-media://m/<video>/<hash>/<variant>`: the
  page names a file of an open video, never a path, and range requests pass through so video
  seeks. The main window's CSP gains `studio-media:` for images, media and fetch.
- **The timeline** draws only what is in view (ruler ticks, scene blocks and clips in the visible
  range), with waveforms and thumbnail strips. Dragging snaps to the playhead, scene edges and
  other clips. Keyboard: Space plays, S splits, Delete removes (with Shift it closes the gap), the
  arrow keys step a frame (with Shift a second), Home and End.
- **The preview** keeps the scene at the playhead and the next one loaded, plays the proxies of
  video and sound in step with the playhead (re-seeking when they drift), and draws captions with
  the same look as the render. Transitions show as cuts; the render draws them exactly.
- **The render** lays each video, picture and caption over the scenes for its own stretch of time
  (`overlay` with `enable`, the clip's timestamps shifted to its start, alpha fades), and mixes
  every sound (fades, volume, delay, `amix` without its division, padded or cut to the video's
  length) to the loudness target with two-pass `loudnorm`: a measuring pass, then a linear pass
  with the measurements. A muted track is left out; when a track is soloed only soloed tracks are
  heard. A video with no sound keeps its silent track.
- **Captions** are drawn once each by a built-in caption page (`assets/captions/`) in a scene
  window with a see-through background, so Chromium shapes Persian and runs it right to left, and
  kept as a PNG in the cache. Chromium hands the frame over premultiplied; it is unpremultiplied in
  code before the PNG is written (ffmpeg's `unpremultiply` filter did not do it for this input).
  "Captions from narration" cuts a scene's narration into lines at spaces only, never inside a word
  joined by a ZWNJ, one sentence per caption at least, and times them over the scene by length
  (word timings from the voice come in E36). Persian digits are an option.
- **Edits by typing** gained clips and tracks: add a file by its name or a caption, change or
  remove a clip, caption a scene from its narration, mute or set a track's volume. The AI sees the
  timeline in seconds, where each scene plays and the video's files.

## Tasks

- [x] T1 Media import, probing and preview files; `studio-media:`; `IPC.studioMedia`.
- [x] T2 Timeline layout and edits: add, move, trim, split, ripple, snap, fades, track flags.
- [x] T3 The timeline view: media list, timeline, inspector, keyboard.
- [x] T4 The preview: scenes, video, pictures, captions and sound at the playhead.
- [x] T5 Render: overlays, captions with alpha, the audio chain, two-pass loudnorm.
- [x] T6 Timeline changes in edits by typing.
- [x] T7 e2e `studioTimeline.e2e.ts`.

## Acceptance criteria

- AC1 Import, trim, split, reorder, transitions and volume all render as edited.
- AC2 Every change is undoable and saved.
- AC3 A 500-clip timeline scrolls within its frame budget.
- AC4 Persian captions keep ZWNJ and run right to left.
- AC5 The mix measures -14 LUFS within 1 LU.

Status: all five pass. AC1: the e2e imports a video and a sound into the built app, places them,
splits the video clip from the keyboard and renders; the file has exactly its 144 frames and the
clip shows only where it was placed (pixels sampled with ffmpeg); the package's integration test
lays a video clip, a still and a caption over the scenes with the real ffmpeg and checks each
stretch by its pixels. Trims, scene order and length are covered by the edit and timeline tests.
AC2: the e2e undoes and redoes the split and reopens the video to find every clip; every gesture is
one op list, tested to undo exactly. AC3: with 500 clips the timeline draws under 120 of them and a
scroll step costs 11.6 ms at the 90th percentile in the built app (the app's work: the handler and
React's render; see the notes). AC4: the e2e types a caption with a ZWNJ, finds it kept in the
timeline and the preview with `dir="rtl"`; the splitter never breaks inside a word. AC5: the e2e
and the integration test measure the rendered mix with `ebur128` between -15 and -13 LUFS.

## Implementation notes

- The first scroll timing in the e2e said a second a step. A trace showed the time in
  `LayerTreeHost::WaitForCommitCompletion` under `ScrollLayer`: once the zoomed timeline is a
  composited scroller, setting `scrollLeft` from script waits for a compositor commit, and the e2e
  window (in the background) commits about once a second. Style and layout took 78 ms over the
  whole run. The test times the app's own work and says why it leaves the setter out.
- `readTool` decoded ffmpeg's output as UTF-8, which mangles raw pixel bytes; pixel checks read
  bytes. It returns stderr when asked, which is where `loudnorm` and `ebur128` print.
- The sine source in ffmpeg plays at an eighth of full scale, so its peaks top out near 32 of 255.
- A caption added near the end runs to the end of the video rather than past it.
- Caption stills sit beside the scene chunks (`<cache>/<video>/captions`), outside the folders the
  cache pruning walks.

## Known limits

- Pictures and video fill the frame (fitted); there is no position, size or crop yet.
- The preview shows transitions as cuts and plays sound through media elements, so a volume above
  100% sounds at 100% there (the render applies it).
- Captions are timed by length until voice brings word timings (E36).
- Media cannot be removed from a video's library (history keeps everything); a file no clip uses
  costs disk space only.
