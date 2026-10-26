# E39 Studio recipes, history browser and hardening

Milestone: standalone (Studio). Depends on: E31 to E38.

## Goal

Make the method behind a video reusable, make its whole history browsable, and prove Studio holds
up under long sessions and crashes.

## Design

- **Recipes are versioned** (`node/recipes/recipeStore.ts`, file format 2). Saving again under the
  same recipe adds a version; nothing is ever pruned. A recipe from E32 (format 1) is read as
  version 1 of itself. A version keeps the brief, style, language, format, the CLI, model and
  effort of each AI stage (scenario, edit, scene code), the voice and the render choices
  (resolution, frame rate, quality, codec).
- **Applying a version** to a new video sets the New video dialog's fields and stage picks; once
  the editor opens it applies the render choices as one undoable edit ("Render choices from
  <name>") and remembers the voice, so the Voice view starts on it.
- **Export and import** as `.amrecipe.json` (`runova-studio-recipe`, format 1), every version
  included. An import is checked against the same rules as a save and always becomes a new recipe,
  so it never overwrites one already here. Files over 5 MB are refused before they are read.
- **The history browser.** Each entry in History has Compare: the changes from that version to the
  current one (or between any two picked), in the same readable list an AI proposal uses (title,
  scenario fields, scenes added, removed, moved or changed, clips and tracks). Scenes count as
  moved only when they left the longest run that kept its order, so swapping two scenes is one
  move, not two. A scene whose animation changed shows a code diff (Monaco DiffEditor, mounted
  after two frames). From there: Restore that version (one undoable edit), or start a new video
  from it (`node/history/branch.ts`): the document as it was and only the files it uses (its media
  with their records and word timings, its scenes' code trees). The new video's history starts at
  that version; the source keeps all of its own.
- **AI runs side by side.** In History's AI runs, two runs can be compared: stage, result, CLI,
  model and effort, style, length asked for, attempts, when, and what was asked or the full request
  as a text diff.
- **Backup** gains a `studio` section with Studio's settings and recipes. Videos and media are the
  user's own files and stay out. Studio checks the section with its own rules before restoring; a
  damaged one is skipped with a warning instead of failing the restore.
- **Hardening.** Crash drills kill the app outright (SIGKILL) right after a burst of acknowledged
  edits and in the middle of narrating (`studioCrashDrills.e2e.ts`); the one in the middle of a
  render is E34's `studioRender.e2e.ts`. The soak (`studioSoak.e2e.ts`, only with
  `RUNOVA_STUDIO_SOAK=<minutes>`) edits, narrates and renders in a loop while the main
  process's event-loop delay and memory are sampled, and writes `test-results/studio-soak.json`.

## Tasks

- [x] T1 The recipe model and store (versions, migration from format 1).
- [x] T2 Save, apply, export and import recipes.
- [x] T3 The history browser: diffs, code diff, restore, branch; AI runs compared.
- [x] T4 Backup of Studio's settings and recipes.
- [x] T5 Soak, crash drills, themes and reduced motion.
- [x] T6 Docs: this file, the help article.

## Acceptance criteria

- AC1 A recipe reproduces its stage choices on a new request.
- AC2 Every generation's prompt, CLI, model and effort can be browsed and compared.
- AC3 The soak shows no memory leak trend and main event-loop p99 at 50 ms or less.
- AC4 No acknowledged edit is lost in the crash drills.

Status: AC1, AC2 and AC4 pass; AC3 passed a 2-minute run, and the 15-minute run is still owed.
AC1: package, IPC and renderer tests save a version with stage picks, voice and render choices,
start a new video from it and find every choice in place; export then import gives the same
versions. AC2: renderer tests compare two runs (CLI, model, effort and the request diff) and two
versions (scene and code changes). AC3: the 2-minute soak in the built app measured main
event-loop p99 at 37.9 ms and a heap slope of -11 MB/min; the 15-minute run was stopped by the
machine running low on memory and has not been repeated. AC4: the built app kept all 60 edits
acknowledged before a SIGKILL, and narration killed part way carried on after the restart,
asking the engine only for what it had not said.

The four themes and reduced motion were looked at in screenshots of the home, Voice, voice
profiles, Timeline, Generate and Compare views; nothing needed changing.

## Known limits

- The 15-minute soak has not been run to the end.
- Compare shows what changed, field by field; it does not merge two versions.
- A new video started from a version does not carry the source's AI run records, only the
  document and its files.
- The utility-process move was not needed, so the service still runs in main.
