# E37 Studio local voices and cloning

Milestone: standalone (Studio). Depends on: E36.

## Goal

Speak narration with local voices, Piper always and OmniVoice when the user installs it, and
clone the user's own voice, locally with OmniVoice or online with ElevenLabs, with consent recorded
for every cloned voice. Piper and voice profiles moved here from E36, since they need this epic's
Python environment installer.

## Design

- **Four Dev Setup items in the Studio stack**, all optional: Piper, Piper voices, OmniVoice and
  the OmniVoice model. Piper and OmniVoice name their licenses before an install (Piper and
  espeak-ng are GPL-3.0; OmniVoice's weights are CC BY-NC 4.0, non-commercial only).
- **Lock files** (`packages/studio/assets/tools/locks`, written by
  `scripts/studio-python-locks.mjs` with uv's `pylock.toml` output): for each engine and platform, a
  python-build-standalone Python 3.12 and every wheel with its address, size and SHA-256. Piper has
  one per platform (Windows, Linux x64 and arm64, macOS arm64 and x64); OmniVoice has CUDA 12.8 and
  CPU builds for Windows and Linux, and the Apple GPU build for macOS arm64. NVIDIA cards with a
  driver from 570 up get the CUDA build (`nvidia-smi`), anything else the CPU one.
- **The installer** (`main/devSetup/runners/studioTools.ts`) downloads each file to a `.part` the
  next try carries on from (so it survives a dropped connection and an app restart), checks it
  against its hash, unpacks Python into `<userData>/studio-tools/python`, makes a venv per engine,
  and runs `pip install --no-index --no-deps --require-hashes` from those files only. uv is needed
  only to write the locks, never on the user's machine. Model files are pinned the same way, at a
  fixed Hugging Face revision. Each install writes a marker last; Dev Setup's `studio-tool` check and
  Studio both read it, so a half-finished install never counts.
- **Piper** runs one process per piece: `python -m piper -m <voice>.onnx -i <text file> -f <out.wav>`.
  The text goes in a UTF-8 file, which no Windows code page can mangle.
- **OmniVoice** runs in a sidecar of our own (`assets/voice/omnivoice_server.py`, calling only
  `OmniVoice.from_pretrained` and `generate`) behind a generic supervisor (`supervisedHost.ts`):
  JSON lines over stdio, a ready handshake, one job at a time with a watchdog, a crash fails only
  the piece in flight and the next one starts a fresh sidecar, and ten idle minutes stop it to free
  the graphics card.
- **Voice profiles** (`<userData>/data/studio/voices`): a take recorded in the Voices dialog,
  trimmed of silence and levelled by ffmpeg to 24 kHz mono, its words filled in by the app's
  Whisper, saved only with the consent statement ticked (and stored with the profile). OmniVoice
  speaks with any profile; a profile without consent is refused. **Upload to ElevenLabs** (after a
  confirmation) makes an instant voice clone in the person's account; deleting the profile removes
  that clone first.
- **Non-commercial marks.** OmniVoice and the non-commercial Piper voices are flagged where they
  are offered, the Render dialog warns before rendering narration made with them, and the render's
  record names them (`nonCommercial`), shown as a chip on the finished file.

## Tasks

- [ ] T0 Spike S3: OmniVoice on Windows with the RTX 3050 (4 GB) and on CPU, in Persian and
  English, cloned from 8 seconds: speed and VRAM. Not done; by the user's choice, OmniVoice is
  built against stand-ins and its real run waits. See Known limits.
- [x] T1 Dev Setup types (`studio-python-env`, `studio-model-files`, the `studio-tool` resolver)
  and the four items with consent.
- [x] T2 The lock script and lock files, with a schema test.
- [x] T3 The environment and model-file installers and the GPU probe.
- [x] T4 The supervised sidecar and the OmniVoice adapter.
- [x] T5 Voice profiles with consent (the transcript filled in by the Whisper host); cloning
  through OmniVoice and ElevenLabs.
- [x] T5b Piper: its environment and voices, and its adapter behind the narrator's engine call.
- [x] T6 e2e `studioLocalVoices.e2e.ts`.

## Acceptance criteria

- AC1 The install finishes through a dropping server and survives an app restart.
- AC2 OmniVoice clones from an 8-second recording, if S3 passes; otherwise it is hidden with the
  reason.
- AC3 A sidecar crash fails only the job in flight.
- AC4 No voice is cloned without a consent record.
- AC5 Persian narration from Piper works offline.

Status: AC1, AC3, AC4 and AC5 pass; AC2 is built against stand-ins and its real run is not done.
AC1: in the built app, Dev Setup installed Piper and its voices for real through this machine's
proxy (346 MB in 18 minutes, the speed falling to about 70 KB/s at times). The connection dropped
once and the download carried on from where it was. The installer's tests drop a download part way,
start a fresh installer on the same disk as an app restart would, and see only the missing file
fetched; they also cover a whole `.part` left by a close, a corrupt file and a cancel. AC3: the
OmniVoice tests crash the sidecar mid-piece; that piece fails, the next one queued behind it
starts a fresh sidecar and succeeds. AC4: a profile cannot be made without the consent box (the
service, the IPC schema and the dialog all refuse), OmniVoice refuses a profile without a consent
record, and ElevenLabs gets a recording only after a confirmation (the e2e checks each step). AC5:
the same real run then narrated a Persian scene with Piper's Amir voice on this computer: a 5.3 s
voice in 14 s, the scene fitted to 5.833 s (voice, half a second, a whole frame). AC2: OmniVoice's
sidecar script ran against stand-in `torch` and `omnivoice` modules (model load, the reference
and transcript passed to `generate`, the WAV written), and everything else against a stand-in
sidecar.

## Implementation notes

- uv's `pylock.toml` output already narrows each package's wheels to the target platform, with
  address, size and hash, which is exactly a lock. It sometimes leaves a size out; the script asks
  the file server.
- Linux CUDA wheels come from NVIDIA's own index (`pypi.nvidia.com`), linked from PyTorch's.
- The supervisor's first version let the next job reuse a process it had just killed (a stopped or
  timed-out piece), which then failed that job with the old process's exit, and a write to a dead
  process's stdin was an unhandled EPIPE. The tests caught both.
- Most English Piper voices are non-commercial (hfc_female and hfc_male are CC BY-NC-SA, lessac
  carries the Blizzard license). The Persian amir, ganji and reza_ibrahim voices are CC0; gyro's
  license is unclear, so it is left out.
- ElevenLabs states no minimum length for an instant clone, so Studio sets none beyond its own
  3 to 60 seconds for a take.

## Known limits

- OmniVoice has never run for real here (S3): its sidecar was run against stand-in `torch` and
  `omnivoice` modules, and everything around it against a stand-in sidecar. Its speed and memory
  on a 4 GB card are unknown.
- ElevenLabs cloning was run against a fake server only.
- No punch-in, and no voice design (OmniVoice speaking without a profile).
