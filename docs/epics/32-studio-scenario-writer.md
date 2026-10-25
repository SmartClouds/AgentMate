# E32 Studio scenario writer

Milestone: standalone (Studio). Depends on: E31.

## Goal

Turn a user's request into a movie scenario with an AI CLI installed on the machine (Claude Code,
Codex, Gemini, Grok, Cursor, OpenCode), with the CLI, model and effort the user picks, in Persian,
English or any offered language. The user edits the scenario by hand or by typing what to change,
and every generation is recorded so the same method can be used again.

## Design

- **Every run works from a file.** Each generation gets `work/<genId>/` in the video folder with
  `request.md` (the request, the current document as compact JSON, the rules, the schema, the style
  guide). The command line only says "Read request.md and follow it", which avoids the argv cut
  Grok and Cursor get on Windows.
- **A streaming runner.** `streamHeadlessCliPrompt` beside `runHeadlessCliPrompt` in
  `main/cli/headlessPrompt.ts` shares its CLI resolution and arguments and streams through
  `spawnStreaming`, so the UI shows live output, elapsed time and Cancel. Model and effort come from
  `launchPickArgs` with `strictCli`; OpenCode, outside `LAUNCH_PICK_CLI_IDS`, uses its own
  configured model.
- **JSON with a repair round.** The answer is JSON only: a fenced block, then balanced braces, then
  zod. Up to two repair rounds send the exact zod issues back.
- **Edit by typing.** The AI gets the document with ids and the `EditOp` JSON schema
  (`z.toJSONSchema`) and answers with ops, validated against the live document and shown as a
  readable proposal with Apply and Discard. Apply is one history entry.
- **Generation records.** A `generations` table in `studio.db`: stage, CLI, model, effort, the
  request and output as blobs, timings, the parent generation, status.
- **Recipes.** A saved setup (request template, style, language, format, CLI, model and effort per
  stage, voice) that starts a new video.

## Tasks

- [ ] T0 Spike S2 on all six CLIs here: JSON validity in fa and en over 10 runs, whether
  `request.md` in the working folder is read, whether model and effort flags take effect, a
  write-confinement canary, p95 duration. Writes `ai/cliCapabilities.ts`.
- [ ] T1 Scenario schema, extraction and repair (`packages/studio/src/ai/scenario/`).
- [ ] T2 Prompt templates in fa and en with RTL rules, duration targets and the 15 style families.
- [ ] T3 `streamHeadlessCliPrompt`, the AI job runner, `generations` rows, `IPC.studioAi`.
- [ ] T4 Edit ops for the scenario from typed instructions, with the proposal diff.
- [ ] T5 Renderer: the Brief step with the CLI, model and effort picker (`RunSettingsFields`), the
  progress card, the Ask AI bar, generation records in History.
- [ ] T6 Recipes: save and start from one.
- [ ] T7 e2e `studioScenario.e2e.ts` with a scripted fake CLI returning a scenario, then broken
  JSON, then a repair.

## Acceptance criteria

- AC1 A scenario in Persian and in English comes back from each installed CLI (fakes in tests).
- AC2 Broken JSON is repaired; a final failure shows the CLI's log.
- AC3 An AI edit is one undo step.
- AC4 A request over 20,000 characters works with Grok and Cursor.
- AC5 Each generation shows its CLI, model, effort and prompt.
