# E36 Studio voice

Milestone: standalone (Studio). Depends on: E35.

## Goal

Videos get sound: the user records narration in the app or has it spoken by an online voice
engine (OpenAI, ElevenLabs, Google Gemini, Azure Speech), and scenes fit their length to the
narration.

## Design

- **Four engines behind one call** (`speak` in `node/voice/engines.ts`), each in its own shape:
  OpenAI `/v1/audio/speech` (24 kHz WAV), Gemini `/v1beta/interactions` (base64 WAV in the model
  output step), ElevenLabs `with-timestamps` (48 kHz PCM plus character timings, `eleven_v3`, the
  model that speaks Persian) and Azure SSML (48 kHz WAV, `fa-IR-DilaraNeural` and
  `fa-IR-FaridNeural`). Model ids, voices and prices are in `catalog.ts` (`STUDIO_TTS`). A refused
  key says so plainly; rate limits, server errors and dropped connections are tried again.
- **Pieces and the cache.** Narration is cut at sentence ends (`Intl.Segmenter`, aware of Persian)
  into pieces of at most 600 characters. Each piece is cached by a hash of engine, voice, model,
  language and text, so speaking again, or after a crash, sends only the pieces still missing.
  The pieces are joined by ffmpeg into one 48 kHz mono WAV whose length comes from its sample count.
- **The narrator** (`node/voice/narrator.ts`) runs one job per video. Each scene lands in one edit
  (one undo step, actor `system`): the old narration clip goes, the scene takes its voice, a scene
  set to follow its narration takes the voice's length plus half a second (rounded up to a frame,
  at least a second), and the voice clip is placed at the scene's start.
- **Narration is tied to its scene.** Voice and caption clips made for a scene carry its tag in
  their ids (`nv-<scene>-…`, `nc-<scene>-…`), and every edit that moves a scene (a length change
  before it, a reorder) moves them with it (`followScenes`, applied in `VideoStore.apply`).
- **Word-timed captions.** Word timings from ElevenLabs are kept with the narration
  (`words:<hash>`); **Caption** lays each line where its first word is spoken and ends it at its
  last. Without timings, lines share the scene by length.
- **Recording.** The Voice view records through the microphone with a level meter and the scene's
  narration shown large, plays the take back, and sends it over IPC; ffmpeg turns it into the
  48 kHz narration WAV.
- **Ducking.** Music drops by about 10 dB under voice clips in the render. The voice clips' times
  are known, so it is a volume curve on the music (ramps of a quarter second, voices less than half
  a second apart joined) rather than a compressor listening to the voice: the same every render.
  The video's `renderSettings.audio.duck` turns it off.
- **Keys.** OpenAI and Gemini use the keys in Settings > AI. ElevenLabs and Azure keys are sealed
  with the vault in `<userData>/data/studio/secrets.json` and move with a passkey change
  (`registerSealedSecretStore`); a locked vault shows Unlock instead of skipping the engine.
- Every engine's voice list drops Chinese voices (`voicesWithoutChinese`, built on the language
  filter), including the voices of an ElevenLabs account.

## Tasks

- [ ] T0 Spike S4a: confirm each engine's live API with real keys and record sanitized fixtures.
  Not done: built against the documented shapes (October 2026) and fake servers. See Known limits.
- [x] T1 Pieces, WAV reading and writing, word timings.
- [x] T2 OpenAI, Gemini, ElevenLabs and Azure adapters; ids and prices in `catalog.ts`.
- [x] T3 Sealed keys for ElevenLabs and Azure.
- [ ] T4, T5 Piper and its Dev Setup items: moved to E37, which builds the Python environment
  installer Piper needs.
- [x] T6 The recorder and the Voice view; voice profiles moved to E37 with cloning and consent.
- [x] T7 Narration-first timing, word-timed captions, ducking; narration jobs; `IPC.studioAudio`.
- [x] T8 e2e `studioVoice.e2e.ts` against fake engine servers and the Chromium fake microphone.

## Acceptance criteria

- AC1 Persian narration from each engine (fakes in tests; real runs listed until done by hand).
- AC2 Scene lengths follow the narration exactly.
- AC3 A restart during synthesis redoes only the unfinished chunks.
- AC4 No Chinese voice or language is ever listed.

Status: AC2, AC3 and AC4 pass; AC1 passes against fakes, real runs not done. AC1: each engine's
request and answer are tested against a fake server in its own shape (`engines.test.ts`), the
narrator speaks Persian scenes through Azure and ElevenLabs fakes, and the e2e speaks two Persian
scenes through a fake OpenAI in the built app. AC2: the narrator tests and the e2e check each
scene's length is its voice's length plus half a second on a whole frame, the voice clip starts at
its scene, and the e2e render has exactly the frames of the narrated scenes. AC3: the engine fails
for good after the first piece of a two-piece scene; speaking again sends one request and reuses
one piece; the e2e speaks a scene again with no request at all. AC4: the catalog test, the voice
filter test (by locale and by Han characters) and the ElevenLabs account list (a Chinese voice in
the fake answer) all come out without one.

## Implementation notes

- `sidechaincompress` with the voice as its key hung ffmpeg 8 (an `asplit` of the voices, padded
  with `apad`, then `amix` and an infinite `apad` before `atrim`). Bounded pads ended the hang but
  cut the mix short when the music ended early. The volume curve avoids both and needs no
  listening.
- The fake ffmpeg joins narration WAVs byte for byte and labels them 48 kHz, so tests feed it
  48 kHz pieces; `narrator.int.test.ts` checks the real ffmpeg resamples 24 kHz OpenAI pieces
  without changing their length.
- The no-Chinese-content scan holds test fixtures too; the tests that prove the filter build the
  language tags from character codes (`src/test/chineseTags.ts`).
- Closing a video stops its narration run and waits for it, keeping the pieces already spoken.

## Known limits

- No engine has been called with a real key (S4a). OpenAI's `gpt-4o-mini-tts` retires on
  2027-01-06, which the Voice view says.
- Gemini and Azure give no word timings here, so their captions are timed by line length.
- No punch-in: a take replaces the whole scene's narration.
- Piper, local voices, voice profiles and cloning are E37.
