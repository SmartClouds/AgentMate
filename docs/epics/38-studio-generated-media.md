# E38 Studio generated images and video

Milestone: standalone (Studio). Depends on: E35, E36.

## Goal

The timeline can use pictures and short clips made by online models: pictures from OpenAI and
Google Gemini, clips from Google's Gemini Omni Flash. OpenAI's Sora API was shut down on
2026-09-24, and Veo 3.1's preview models on the Gemini API were shut down too, with Gemini Omni
Flash as Google's replacement there.

## Design

- **Models and prices in the catalog** (`STUDIO_GEN`), from the providers' docs and price pages in
  October 2026: OpenAI `gpt-image-2.5-flare` (priced by token; the per-image estimate uses the
  GPT Image 2 figures OpenAI publishes, $0.006, $0.053 or $0.211 by quality), Gemini
  `gemini-nano-banana-2.1` ($0.0336, $0.0504 or $0.113 for a 1K, 2K or 4K picture) and
  `gemini-omni-1.1-flash` for clips (about $0.10 a second at 720p; the model chooses the length,
  so an estimate assumes 8 seconds and says the bill can differ).
- **Nothing is billed without a confirmation.** The Generate dialog shows the estimate and how it
  was reached; Generate asks once more with the price; the request then carries the price the
  person agreed to, and the service refuses to send anything unless it is still the estimate for
  that request. What was spent on the video is summed up in the dialog.
- **The provider calls** (`node/gen/providers.ts`): OpenAI's `POST /v1/images/generations`
  (`b64_json`), Gemini's `POST /v1beta/interactions` with `response_format` `image` for pictures
  and `video` with `delivery: "uri"` for clips. A clip's file is polled at `GET /v1beta/files/{id}`
  until `ACTIVE`, then downloaded from `files/{id}:download?alt=media` with Range requests, so a
  dropped connection carries on. A declined prompt is recorded in the provider's own words.
- **Jobs that survive a restart** (`node/gen/genJobs.ts`, `<userData>/data/studio/generations.json`):
  a clip's file id is saved before polling starts, so after a restart polling and the download
  carry on from where they were. A request cut off before the provider answered is marked
  interrupted (it may have billed) and is never sent again on its own.
- **Into the media library**: a finished picture or clip is imported like any file (copied into
  the video, probed, previewed), named `Generated picture N.png` or `Generated clip N.mp4`, and added
  to the timeline from the Media list. One that finishes while its video is closed waits and comes
  in when the video opens. Each job keeps the prompt, the model and the price with what it made.

## Tasks

- [x] T0 Spike S4b: the request and poll shapes and prices, from the official docs (no paid calls);
  this found Veo 3.1's previews gone and Gemini Omni Flash in their place. Live calls not done.
- [x] T1 Catalog entries.
- [x] T2 The three provider calls, with resumable clip polling and download.
- [x] T3 The cost confirmation and spend summary.
- [x] T4 Generate from the Media panel, then insert; `IPC.studioGen`.
- [x] T5 e2e `studioGen.e2e.ts` against fake servers in the providers' shapes.

## Acceptance criteria

- AC1 An image and an 8-second clip reach the media library and the timeline.
- AC2 A restart during Veo polling still completes the clip (now Gemini Omni's file polling).
- AC3 Nothing is billed without confirmation.

Status: all three pass against fake providers; no live call has been made. AC1: the e2e asks for
a picture in the built app, confirms its price, finds it in Media and lays it on the timeline; the
clip it asks for comes back as a real 8-second MP4 the real ffmpeg probes. AC2: the e2e kills the
app (SIGKILL) while the clip is still being prepared; the restarted app polls on, downloads it and
imports it when the video opens, with one clip request in all; the package tests do the same with a
quit and a download that drops half way. AC3: a start whose price is not the current estimate is
refused before any request (package, IPC and the dialog, which asks once more and sends only the
agreed figure).

## Known limits

- No call has gone to the real OpenAI or Gemini APIs; the shapes come from their docs.
- A clip's length is the model's choice; the estimate assumes 8 seconds.
- Pictures go into the media library and onto the timeline; a scene of a generated kind (its
  picture as the scene itself) is not built.
- Editing a picture or extending a clip (both providers can) is not offered.
