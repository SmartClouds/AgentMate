# E37 Studio local voices and cloning

Milestone: standalone (Studio). Depends on: E36.

## Goal

Clone the user's own voice and speak with it, locally with OmniVoice (an optional engine the user
installs) or online with ElevenLabs, with consent recorded for every cloned voice.

## Design

- **OmniVoice is optional and not bundled.** It installs from Dev Setup into its own Python
  environment, after a notice that its weights are CC BY-NC 4.0, so voices made with it are for
  non-commercial use only. Its voices carry a badge, and a render that uses one says so.
- **Built for a slow, dropping connection.** Pinned lock files (with hashes) per platform and
  graphics card; every wheel and the weights download with `ResumableDownload` into a wheelhouse
  that survives restarts; uv then installs offline. Manual placement is the last resort.
- **A sidecar of our own** (`resources/studio/omnivoice_server.py`, calling only OmniVoice's public
  API) speaks JSON lines over stdio with UTF-8 forced, supervised like the speech host: a ready
  handshake, a per-job watchdog, a crash fails only the job in flight, idle shutdown frees VRAM.
- **Voice profiles** need a consent record ("this is my own voice, or I have permission") before any
  cloning engine accepts them.

## Tasks

- [ ] T0 Spike S3: the offline install through the real proxy and a server that drops every two
  minutes; OmniVoice on Windows with the RTX 3050 (4 GB) on CUDA 12.8 and on CPU, in Persian and
  English, cloned from 8 seconds: speed and VRAM. Decides whether and how OmniVoice is offered.
- [ ] T1 Dev Setup types (`studio-python-env`, `studio-model-files`, the `studio-tool` resolver)
  and the OmniVoice items with consent.
- [ ] T2 The lock script and lock files, with a schema test.
- [ ] T3 The environment and model-file runners and the GPU probe.
- [ ] T4 The supervised sidecar and the OmniVoice adapter.
- [ ] T5 Voice profiles with consent; cloning through OmniVoice and ElevenLabs.
- [ ] T6 e2e `devSetupStudio.e2e.ts` with fake uv, Python and sidecar.

## Acceptance criteria

- AC1 The install finishes through a dropping server and survives an app restart.
- AC2 OmniVoice clones from an 8-second recording, if S3 passes; otherwise it is hidden with the
  reason.
- AC3 A sidecar crash fails only the job in flight.
- AC4 No voice is cloned without a consent record.
