# E38 Studio generated images and video

Milestone: standalone (Studio). Depends on: E35, E36.

## Goal

Scenes and the timeline can use images and short video clips made by online models: images from
OpenAI and Gemini image models, video from Google Veo 3.1 (OpenAI's Sora API was shut down on
2026-09-24 and is not used).

## Design

- Model ids and prices live only in `packages/core/src/models/catalog.ts` and are checked against
  the live APIs first.
- Every generation that bills asks first, with the estimate, and the spend is summed up.
- Veo runs as a long operation; its name is saved with the job, so polling picks up after a restart,
  and the download resumes.
- Results go into the video's blob store and from there into scenes of a generated kind or onto the
  timeline; refusals and provenance are recorded with the generation.

## Tasks

- [ ] T0 Spike S4b: confirm the Veo 3.1, OpenAI image and Gemini image request and poll shapes and
  prices.
- [ ] T1 Catalog entries.
- [ ] T2 The three adapters, with resumable Veo polling.
- [ ] T3 The cost confirmation and spend summary.
- [ ] T4 Generate from the Media panel or a scene, then insert; `IPC.studioGen`.
- [ ] T5 e2e against fake long-running servers.

## Acceptance criteria

- AC1 An image and an 8-second clip reach the media library and the timeline.
- AC2 A restart during Veo polling still completes the clip.
- AC3 Nothing is billed without confirmation.
