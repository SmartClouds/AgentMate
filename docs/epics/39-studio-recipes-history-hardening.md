# E39 Studio recipes, history browser and hardening

Milestone: standalone (Studio). Depends on: E31 to E38.

## Goal

Make the method behind a video reusable, make its whole history browsable, and prove Studio holds
up under long sessions and crashes.

## Design

- **Recipes** are versioned and never pruned; applying one to a new request reproduces its stage
  choices (CLI, model, effort, style, voice, format). Export and import as `.amrecipe.json`.
- **The history browser** shows a structural diff of the scenario and timeline between any two
  versions, a code diff (Monaco DiffEditor) for scenes, restore, and branching a version into a new
  video.
- **Backup** gains Studio's settings and recipes (not media, which are the user's own files).
- **Hardening:** a 15-minute soak with a memory trend and the main event loop measured; crash
  drills during an edit, a render and a voice job; a pass over all four themes and reduced motion.
  If main event-loop p99 goes above 50 ms, the service moves to a utility process (a transport
  change behind `StudioHost`).

## Tasks

- [ ] T1 The recipe model and store.
- [ ] T2 Save, apply, export and import recipes.
- [ ] T3 The history browser: diffs, restore, branch.
- [ ] T4 Backup of Studio's settings and recipes.
- [ ] T5 Soak, crash drills, themes and reduced motion.
- [ ] T6 Docs.

## Acceptance criteria

- AC1 A recipe reproduces its stage choices on a new request.
- AC2 Every generation's prompt, CLI, model and effort can be browsed and compared.
- AC3 The soak shows no memory leak trend and main event-loop p99 at 50 ms or less.
- AC4 No acknowledged edit is lost in the crash drills.
