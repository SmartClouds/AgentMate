# E31 Studio foundation

Milestone: standalone (Studio). Depends on: none.

## Goal

Start Studio, the section where a user makes videos for a project or on their own. This epic lays
the ground every later Studio epic stands on: a module that could leave AgentMate as an app of its
own, a library of videos kept outside every project's source in a folder the user picks per
project, and a video document whose every change is saved the moment it is made and kept forever,
with undo that survives a crash.

## Design

- **A module of its own.** `packages/studio` (`@agentmat/studio`) holds everything Studio knows,
  with no Electron, React or better-sqlite3 in it. Its root export is pure and runs in the
  renderer; `@agentmat/studio/node` holds the Node services. The desktop app reaches the app's own
  modules through one file per side: `main/studio/host.ts` builds the `StudioHost` port, and
  `components/studio/kit.ts` (with `client.ts` for the bridge) is the renderer's door. Boundary
  tests in the package and in the app hold both sides to that, so a split later means rewriting two
  files.
- **The document.** One zod-checked document per video: the scenario (scenes with narration,
  on-screen text, length, visual kind, transition, music cue), the timeline (tracks and clips) and
  the render settings. Times are whole flicks (1/705,600,000 s), which divide exactly by every frame
  rate and sample rate used, so nothing drifts. Each aspect ratio has one fixed design size;
  resolution only scales it.
- **Edits are ops.** Every change, by hand or (later) from an AI, is a list of typed edit ops.
  Applying a list gives the new document and the inverse list, all or nothing, and checked against
  the schema.
- **History never forgets.** `studio.db` (SQLite in the video's folder) is the source of truth: one
  entry per change with its ops and inverse, a full snapshot every 100 entries, named milestones.
  Triggers refuse UPDATE and DELETE on the history tables. Undo appends the inverse and redo appends
  it again, so the history stays linear and the undo stacks are rebuilt from the log after a
  restart. Restore appends a whole earlier version as a new entry. `document.json` is a copy written
  a moment after each edit and rebuilt from the history when it is behind or torn; if the history
  file is lost, the history restarts from `document.json`.
- **Storage.** The library folder defaults to `Videos/AgentMate Studio` (not Documents, which is
  often under OneDrive). Standalone videos go in `Standalone`, each project in `Projects/<name>`
  unless the user picks another folder in the project's Studio tab. A folder is checked on its real
  path through symlinks and junctions: inside the project, inside the app, a system folder or one
  that cannot be written is refused; a synced folder (OneDrive, Dropbox, iCloud, Google Drive), a
  network folder or a nearly full drive gets a warning.
- **One writer.** A `.studio.lock` (app, host, pid, heartbeat) keeps a second copy of AgentMate
  (the dev build, another computer on a shared drive) out of an open video, with "Open in another
  AgentMate" and Take over only once the heartbeat goes quiet. A holder on the same machine whose
  process is gone is taken over at once. SQLite's exclusive locking mode is the backstop.
- **Studio's own settings** live in `userData/data/studio/` (settings and the registry of known
  videos), not in the app settings, so the module stays separable.

## Tasks

- [x] T1 Package scaffold (`packages/studio`, exports `.` and `./node`), wiring in the root
  scripts, CI and CD workflows and the coverage summary; desktop dependency.
- [x] T2 Boundary tests: `packages/studio/src/boundary.test.ts` and
  `apps/desktop/src/studioBoundary.test.ts`, each with a fixture that proves it fails; the
  no-Chinese-content scan `apps/desktop/src/studioNoChineseContent.test.ts`.
- [x] T3 Flicks (`time/flicks.ts`), the document schema with design sizes and output sizes
  (`document/schema.ts`), content languages with Chinese filtered out (`text/languages.ts`), ids and
  folder names (`text/names.ts`).
- [x] T4 Edit ops with inverses (`document/ops.ts`) and the undo stacks over an append-only log
  (`document/undo.ts`).
- [x] T5 Node stores: the `SqlDriver` port, `HistoryDb` with append-only triggers and snapshots,
  atomic writes, the folder lock, the storage-root rules, the video store with crash recovery, the
  JSON store for Studio's own files.
- [x] T6 The service (`node/service.ts`): settings, per-project folders, the library (create, list,
  add existing, locate, remove, move with a verified copy), open with the lock, edits, undo, redo,
  history, versions, restore, shutdown.
- [x] T7 Desktop main: `main/studio/{host,db,index}.ts`, `IPC.studio` with every input checked
  against `studioInputs`, main-window guard, `preload/studio.ts`, startup and project-delete
  pruning, shutdown on quit.
- [x] T8 Renderer: Studio in the Build menu group, `/studio` and `/studio/:videoId`, the library
  (filters, cards with Open folder, Move, Remove, Locate), New video, the folder field with live
  checks, the editor (title, scenario by hand, undo and redo with Ctrl+Z, the History panel with
  Restore, the locked, missing and failed states), the project's Studio tab with its folder, the
  Settings card, the help article.
- [x] T9 e2e: `studio.e2e.ts` (make and edit a video, kill the app, every edit back and undo still
  working; a folder inside the project refused; a second app kept out of an open video).

## Acceptance criteria

- AC1 A standalone video and a project video are made in the right folders; a folder inside the
  project, also through a symlink or junction, is refused with a plain reason.
- AC2 After the app is killed during editing, every acknowledged edit is back and undo works across
  the restart.
- AC3 The History panel lists every change with who made it and when; Restore adds a new entry;
  UPDATE or DELETE on the history tables is refused.
- AC4 A moved or renamed video folder is found again with Locate, history included.
- AC5 A second copy of AgentMate shows "Open in another AgentMate" and can take over only once the
  first stops answering.
- AC6 Both boundary tests and the no-Chinese-content scan fail on a forbidden fixture.

## Implementation notes

- The SQLite port is positional-parameter only, which better-sqlite3 and `node:sqlite` take the
  same way; package tests run on `node:sqlite`, the app on better-sqlite3.
- `pnpm install` deduplicated `packages/protocol`'s vitest from 5.0.0 to 5.0.4 when the package was
  added; protocol's tests and coverage pass on it.
- Two bugs were caught by tests while building: the library's "Standalone" and "All" filters shared
  a query key, and a bridge method named `apply` collided with `Function.prototype.apply` on the
  test bridge's callable proxies (renamed `applyEdits`).
- The S1 capture spike planned as E31 T0 moved to the start of E33, where the capture host is
  first built, so its measurements decide that code directly.
- The content-addressed blob store moved to E33 as well, where code trees first need it.

## Known limits

- Studio's settings, registry and (later) sealed keys are not in the app backup yet, like the
  Health and Relay stores; each video folder carries its manifest, so Add existing folder rebuilds
  the library after a reinstall. E39 adds the settings and recipes to the backup.
- No read-only view of a video held by another copy of AgentMate: SQLite's exclusive lock keeps a
  second reader out too.
