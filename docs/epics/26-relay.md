# E26 Relay

Milestone: standalone (Build). Depends on: Blueprint, Build Prompt, workspace terminals.

## Goal

Break work into tasks that each fit one AI coding session under a context budget (200K tokens by
default), and run them one after another, each in a fresh session, with a written handoff carried
from one session to the next. Each task is a leg, each session a runner, and the handoff file is
the baton.

When a session nears its budget it is told to write its handoff and stop. The relay then starts a
fresh session on the same task from that handoff, so no session crosses the budget and long tasks
still finish.

Tasks and handoffs are Markdown files in the project, the SDD source of truth that agents and
people both read. They are shown on a glass task board and a relay track in the workspace, and the
AI can revise them from the docs. Blueprint and Build Prompt can produce them. A relay can start
right away, at a time, after another task, or after a running session, and can plan first and
switch the session to auto mode once the plan is ready.

## Tasks

- [x] T0 Spike against the real Claude Code CLI. It confirmed:
  - **Plan approval:** PreToolUse and PermissionRequest fire for ExitPlanMode. An approval must
    echo the tool input back as `updatedInput`, and `setMode` to `auto` or `acceptEdits` is
    honoured.
  - **Other hooks:** PostToolUse `additionalContext` reaches the model, Stop `block` works, and
    `--settings` hooks merge with the user's own.
  - **MCP:** `--mcp-config` servers inherit the session environment, and
    `enableAllProjectMcpServers` stops a project `.mcp.json` from blocking a leg.
  - **Prompt:** a positional prompt submits in PowerShell.
- [x] T1 Core format and parse (`packages/core/src/relay`):
  - task files with lenient front matter, where problems become card issues instead of errors;
  - handoffs with loose heading matching;
  - status and field edits that keep the rest of a file intact;
  - the `RELAY.md` guide and the handoff template.
- [x] T2 Dependency order, cycles, queues, schedule triggers and the per-CLI capability matrix.
- [x] T3 The hook gate:
  - plan approval only with no open questions;
  - a context guard capped below the model window;
  - a Stop gate that holds a session until it writes its handoff.
- [x] T4 The relay state machine (`reduceRelay`). It is pure, and each rule is pinned by a test:
  - **Completion:** a leg is complete when the handoff is fresh and the agent has stopped, in
    either order.
  - **Outcomes:** each one is handled, including continuation legs, the leg cap and no-progress
    detection.
  - **Plan first:** plan-first legs and the menu fallback.
  - **Watchdog:** a start watchdog for the folder trust dialog.
  - **Interruptions:** pause, resume, cancel, restarts that never relaunch, and task files that
    change underneath.
- [x] T5 Prompts:
  - leg and continuation prompts that point at files instead of quoting them;
  - decompose and revise requests answered as JSON;
  - proposals applied with fresh ids, done tasks untouched, and dependents moved onto split
    parts;
  - the Blueprint prompt writing `tasks/` instead of a backlog when Relay is on.
- [x] T6 Main store, task files, watcher, planner and IPC.
- [x] T7 Relay hooks settings, the gate route, armed files and the context meter.
- [x] T8 The `agentmate_relay` MCP bridge:
  - `current_leg`, `context_status`, `finish_leg`, `list_tasks`, `get_task`, `propose_tasks`;
  - Claude, Codex and Copilot launch flags;
  - proposals held for approval.
- [x] T9 The relay driver:
  - main-side leg launch;
  - sizing, triggers and notifications;
  - restart reconcile;
  - tasks started on a project with a live relay join its queue.
- [x] T10 Attach-only leg tabs in the workspace, with reconcile after a reload.
- [x] T11 The workspace Tasks panel (relay track, fuel ring, run and schedule controls) and the
  status bar item.
- [x] T12 The glass board:
  - columns, live card moves, drag and keyboard moves;
  - a detail sheet with the baton timeline and leg history;
  - entry points from the project page.
- [x] T13 Run settings per relay and per task, with the capability matrix shown inline.
- [x] T14 Blueprint "Split into Relay tasks" with a budget, the guide written before the run, and
  the Tasks ready banner.
- [x] T15 The AI flows:
  - Split into tasks from Build Prompt and Prompt Builder, with start choices;
  - Revise with AI with a reviewed proposal;
  - approval of proposals agents send over MCP.
- [x] T16 e2e (`e2e/relay.e2e.ts`): a fake Claude (`e2e/fixtures/fakeRelayClaude.cjs`) that parses
  its arguments like the real CLI, runs its hooks, reports context in a transcript and writes
  handoffs. It covers two tasks in order with a rollover, the context guard, a blocked pause, a
  clean plan approved into auto mode, a plan with questions held, and a planner split scheduled
  after a running task.
- [x] T17 Docs and a Help article (`src/shared/help/articles/relay.md`).

## Acceptance criteria

- AC1 With "Split into Relay tasks" on, a Blueprint run leaves task files that the board shows,
  each with an estimate under its budget.
- AC2 Run all runs the tasks in dependency order. Each runs in a new session, and each task ticks
  over to Done when its handoff says done and the session stops.
- AC3 A session that nears its budget writes `outcome: continue` and a new session finishes the
  task from the handoff.
- AC4 Plan first: a plan with no open questions is approved and the session switches to auto mode
  without a key press. A plan with questions waits for the user.
- AC5 Revise with AI proposes changes from the docs, shows them before anything is written, and
  never changes a done task.
- AC6 A split prompt can be scheduled to start after a chosen task is done.

## Implementation notes

- **Handoffs.** Plain Markdown, not a memory server such as Graphiti. Every CLI can read it, a
  write costs nothing, it is reviewed in git next to the code, and it doubles as SDD
  documentation. Graphiti would need Docker, a graph database and an LLM key for every write.
- **Who writes what.** The app writes task status; agents write only handoffs. Personal run
  choices and leg history live in `relay.json` in userData, never in the repository.
- **Single-task runs.** A single task started by hand pastes its prompt and waits for Enter, as
  every other hand-off in the app does. Only relay legs submit by themselves.
- **Where legs launch.** Relay legs start in the main process. The renderer only shows a leg's
  session as an attach-only tab, so a relay runs while the user works in another project or the
  window is closed.
- **Prompt placement.** `--mcp-config` and `--allowedTools` take a list, so a positional prompt
  right after them becomes one more list entry and the session starts empty. A leg's command puts
  them first and `--permission-mode` (always present) right before the prompt.
- **Early hooks.** A fast CLI can run its first hooks before the driver has recorded the leg's
  tab. The gate and status events wait briefly for a launch in flight, and the driver also reads
  the handoff on Stop and on every tick, so a write the file watcher missed (a handoffs folder made
  after the watch began) still finishes the leg.
- **Transcript path.** Claude Code names its transcript on SessionStart, before writing it. The
  status tracker keeps that path even when it cannot watch the file yet, or the context meter would
  never find it.
- **"None" in a plan.** Real plans keep the Open questions heading and write "None." plus a
  reason. A section that opens with None (and asks nothing after it) counts as settled, and the leg
  prompt asks for the heading to be left out when there is nothing to ask.
- **One relay per project.** Tasks started now, or after a task the live relay still has to run,
  join its queue. Other starts are refused until the live relay ends.
- **Per-CLI support.** Claude Code gets everything: hooks for the plan gate, the context guard,
  the Stop gate and exact completion, and a positional prompt. Codex and Copilot get the MCP
  bridge. Every other CLI runs legs, plans first and waits for the user, and finishes from its
  handoff file once its output goes quiet.
