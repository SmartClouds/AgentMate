# E32 Studio scenario writer

Milestone: standalone (Studio). Depends on: E31.

## Goal

Turn a user's request into a movie scenario with an AI CLI installed on the machine (Claude Code,
Codex, Gemini, Grok, Cursor, OpenCode), with the CLI, model and effort the user picks, in Persian,
English or any offered language. The user edits the scenario by hand or by typing what to change,
and every generation is recorded so the same method can be used again.

## Design

- **Every run works from a file.** Each generation gets `work/<genId>/` in the video folder with
  `request.md` (the request, the current scenario as JSON, the rules, the answer's JSON Schema, the
  style guide). CLIs that read their prompt from stdin (Claude Code, Codex, Gemini, OpenCode) get
  the whole request there; the two that take it as an argument (Grok, Cursor) get a short pointer,
  "Read the file request.md ...", which keeps a long request clear of the Windows command-line cap.
  The work folder is removed after a good answer and kept after a failure; every request, answer
  and log is also kept as a blob.
- **A streaming runner.** `streamHeadlessCliPrompt` (`main/cli/headlessStream.ts`) starts a CLI
  exactly as `runHeadlessCliPrompt` does, through the shared `prepareHeadlessRun`, but streams its
  output line by line, keeps the answer (stdout) apart from the progress (stderr), and stops on an
  AbortSignal. Model and effort come from `launchPickArgs` with `strictCli`; no CLI picked means the
  default CLI from Settings.
- **A folder the app made.** A work folder is no git repository and no folder the user ever
  trusted, which three CLIs refuse or stop on. The CLI registry now says what each needs in such a
  folder (`promptTrustArgs`, `promptTrustEnv`): Codex `--skip-git-repo-check`, Cursor `--trust`,
  Gemini `GEMINI_CLI_TRUST_WORKSPACE`. Only Studio's runs set `trustCwd`.
- **JSON with repair rounds.** The answer is JSON only. It is read from a fenced block, then any
  balanced `{...}`, then checked with zod. Near misses are fixed before the check (a transition
  called "fadeout" becomes "fade"), the narration is checked to be in the video's script, and
  Chinese characters are refused. Up to two repair rounds send the exact problems back with the
  first answer; each CLI run is fresh, so a repair request carries the original request too.
- **Edit by typing.** The AI gets the scenario with scene ids and answers in a small dialect:
  scene ids and "after" for placement, seconds instead of flicks. Studio checks it against the live
  scenario step by step, turns it into real edit ops, and shows every change with its text before
  and after. Apply is one history entry with actor AI; Discard changes nothing. A proposal that no
  longer fits after the user's own edits is refused with a plain reason.
- **Generation records.** A `generations` table in `studio.db`: stage, status, CLI, the CLI that
  really answered, model, effort, the user's words, the params, every attempt (request, answer and
  log as blob hashes, the problems found, timings), the proposal, the history entry it made. Status
  changes as a run goes; DELETE is refused. Runs left running by a crash read as interrupted on the
  next open.
- **Runs outlive the editor.** One run per video at a time. Leaving the editor does not stop it:
  the video stays open until the run ends, then closes. Quitting Runova, moving or removing the
  video stops it, recorded as interrupted, with Try again.
- **Recipes.** A saved setup (the brief, style, language, format, length, and the CLI, model and
  effort of the scenario stage) in `recipes.json` beside Studio's settings. New video can start from
  one.
- **The fifteen styles** (`packages/studio/src/styles/presets.ts`) are Runova's own descriptions
  of common motion-design families: palette, motion, fonts with an Arabic-script stack, do and
  avoid, suited formats. E32 puts them in the scenario request; E33 adds their reference scenes.

## Tasks

- [x] T0 Spike S2 on all six CLIs here (results below). It changed the design: stdin for the four
  stdin CLIs instead of a file for all, trust flags for work folders, and Gemini's `-p` fixed.
- [x] T1 Scenario schema, extraction and repair (`packages/studio/src/ai/`: `extractJson`,
  `answerShapes`, `scenario/answer`, `scriptCheck`).
- [x] T2 Request templates (`ai/prompts.ts`): scenario, edit and repair, with Persian rules (ZWNJ,
  Persian punctuation and digits), English rules, general rules for the other languages, RTL notes,
  duration targets from speaking rates, and the fifteen style families.
- [x] T3 `streamHeadlessCliPrompt`, the AI runner (`node/ai/studioAi.ts`), the blob store,
  `generations` rows, `IPC.studioAi` with every input checked, `preload` `studioAi`.
- [x] T4 Edit ops from typed instructions (`ai/edit/answer.ts`) with the proposal's readable
  changes.
- [x] T5 Renderer: the brief card and the New video brief with `RunSettingsFields`, the run card
  (live output, time so far, Cancel, Try again, Details), the Ask AI bar, the proposal card, AI runs
  in the History panel, the run details dialog, scene cards with on-screen text, what the viewer
  sees and the hand-over.
- [x] T6 Recipes: Save as recipe on a scenario run, the Recipes list, Start from in New video.
- [x] T7 e2e `studioScenario.e2e.ts` with `e2e/fixtures/fakeStudioClaude.cjs`: a Persian scenario
  from a brief with a broken first answer repaired, the run's record, an edit by typing applied and
  undone in one step.

## Acceptance criteria

- AC1 A scenario in Persian and in English comes back from each installed CLI (fakes in tests).
- AC2 Broken JSON is repaired; a final failure shows the CLI's log.
- AC3 An AI edit is one undo step.
- AC4 A request over 20,000 characters works with Grok and Cursor.
- AC5 Each generation shows its CLI, model, effort and prompt.

Status: AC2, AC3 and AC5 pass in unit tests and the e2e. AC4 passed for real with Grok (a 25,901
character request read from `request.md`, a valid scenario back); Cursor takes the same path but
could not be run here (see below). AC1 against the real CLIs, two runs per language each, with the
real request and reader:

| CLI | Persian | English | Notes |
| --- | --- | --- | --- |
| Claude Code | 2 of 2 | 2 of 2 | all first try, 32 to 63 s |
| Grok | 2 of 2 | 2 of 2 | through `request.md`; one needed a repair round (an invented transition name, now normalized), 63 to 131 s |
| Codex | 2 of 2 | 2 of 2 | with a model picked (`gpt-6-luna`); the account's configured default is refused by the ChatGPT plan, 38 to 43 s |
| Gemini | 1 of 2 | see note | the good answer took 7.7 minutes, and the other run hit the 10 minute limit: requests through this machine's proxy kept failing ("fetch failed") and Gemini answered 503 "high demand" |
| Cursor | not run | not run | the trust prompt is gone with `--trust`; the stored login has expired ("run 'agent login'") |
| OpenCode | not run | not run | the account's default model needs a privacy setting changed in OpenCode's workspace |

## Implementation notes

- S2 found that a fresh work folder stops three CLIs: Codex ("Not inside a trusted directory and
  --skip-git-repo-check was not specified"), Cursor ("Workspace Trust Required") and Gemini ("not
  running in a trusted directory"). Hence `promptTrustArgs` and `promptTrustEnv` in the registry.
- S2 also found that the installed Gemini CLI refuses a bare `-p` ("Not enough arguments following:
  p"): `-p` now carries a short value, which Gemini appends to the prompt on stdin. This was broken
  for every headless Gemini run in the app (commit messages and the rest), not only Studio's.
- The blob store, planned for E33 in E31's notes, came in here: generation records keep their texts
  as blobs.
- `ai/cliCapabilities.ts` (which CLIs can write scene code in agentic mode) is left to E33, where
  scene code is written; E32's runs never write files.
- The CLI and Model pickers in `RunSettingsFields` had no accessible names; they now do, which the
  e2e uses and screen readers need.
- Tests caught three bugs while building: a run marked done a moment before it let go of the video
  refused the next request as busy; a cancel that landed before the CLI started never reached it;
  and the event that streams output invalidated the history query four times a second.

## Known limits

- Cursor and OpenCode were not run for real here, for account reasons outside Studio; their failures
  surface in the run card in the CLI's own words.
- CLI runs cannot resume after a quit or crash; they are recorded as interrupted and run again with
  Try again.
- Recipes are a flat list; versions, export and import come in E39.
- The run card shows "Default CLI" until a run with no CLI picked answers; the record then names
  the CLI that did.
