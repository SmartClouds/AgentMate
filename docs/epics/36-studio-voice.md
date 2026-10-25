# E36 Studio voice

Milestone: standalone (Studio). Depends on: E35.

## Goal

Videos get sound: the user records narration in the app or has it spoken by a voice engine, online
(OpenAI, ElevenLabs, Google Gemini, Azure Speech) or local (Piper), and scenes fit their length to
the narration.

## Design

- **One engine interface** (`TtsEngine`): voices per language, chunked synthesis aware of Persian
  sentences, 48 kHz mono output with its length read from the WAV header, so timing is
  sample-exact. Chunk progress is saved, so a restart redoes only what was unfinished.
- **Keys.** OpenAI and Gemini reuse the keys the app already has. ElevenLabs and Azure keys are
  sealed with the vault (`encryptSecret`, `registerSealedSecretStore`); a locked vault says so with
  Unlock instead of skipping the engine.
- **Recording** reuses the voice input pieces (level meter, `VoiceRecordingStrip`), with a
  teleprompter showing the scene's narration, retake and punch-in.
- **Voice profiles** are kept in Studio's data folder and reused across videos, with the transcript
  filled in by the existing Whisper host.
- **Narration-first timing:** a scene set to follow its narration takes the narration's length plus
  padding; music ducks under the voice.
- Every engine's voice and language list drops Chinese entries.

## Tasks

- [ ] T0 Spike S4a: confirm each engine's live API with real keys and record sanitized fixtures.
- [ ] T1 Chunking and WAV handling.
- [ ] T2 OpenAI, Gemini, ElevenLabs and Azure adapters; ids and prices in `catalog.ts`.
- [ ] T3 Sealed keys for ElevenLabs and Azure.
- [ ] T4 Dev Setup: uv, the Piper environment and Persian and English Piper voices (resumable).
- [ ] T5 The Piper adapter.
- [ ] T6 The recorder, voice profiles, the narration panel.
- [ ] T7 Narration-first timing, word-timed captions, ducking and mixing; TTS jobs; `IPC.studioAudio`.
- [ ] T8 e2e `studioVoice.e2e.ts` against fake engine servers and the Chromium fake microphone.

## Acceptance criteria

- AC1 Persian narration from each engine (fakes in tests; real runs listed until done by hand).
- AC2 Scene lengths follow the narration exactly.
- AC3 A restart during synthesis redoes only the unfinished chunks.
- AC4 No Chinese voice or language is ever listed.
