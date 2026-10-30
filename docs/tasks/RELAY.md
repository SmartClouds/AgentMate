# Relay

This project's work is split into tasks that each fit one AI coding session. Runova runs them
one after another, each in a fresh session, and every session leaves a handoff that the next one
reads first. This file is the format. Runova wrote it; keep it as it is.

## Files

- `docs/tasks/T001-short-slug.md`: one task per file, named after its id.
- `docs/tasks/handoffs/T001.md`: the handoff for that task, written by the session working on it.

## Task files

Each task file starts with YAML front matter:

```yaml
id: T001            # T and at least three digits, never reused
title: Short imperative title
status: todo        # todo | in-progress | testing | done | blocked
epic: E01           # optional group label
order: 1            # optional, breaks ties between tasks that are ready together
depends: [T000]     # ids that must be done first
estimate: 90000     # context tokens one session should need
budget: 200000      # context tokens one session may use
specs: [docs/epics/01-example.md]
```

The body has `## Goal`, `## Scope`, `## Acceptance criteria` (a checkbox per criterion) and
`## Test plan`.

Runova sets `status`. A session working on a task never edits its status or its spec; it
reports through the handoff.

### Sizing

A task must fit in one session under its budget, counting everything the session reads: the task,
the handoffs it depends on, the specs, the code it opens, and the output of the commands it runs.
Aim for an `estimate` of at most 60% of the budget. Split anything larger into tasks that each
end with something testable.

## Handoffs

Before a session stops, it writes `docs/tasks/handoffs/<id>.md` with this front matter:

```yaml
task: T001
outcome: done       # done | continue | blocked
tests: passed       # passed | failed | not-run
leg: 1              # the session number the prompt gave you
updated: 2026-01-31T12:00:00Z
```

and these sections, all of them filled in:

- `## Purpose`: What the task is for, in one or two sentences.
- `## Done so far`: What is finished and working, with the files and tests that prove it.
- `## Decisions`: Choices made and why, so the next session does not reopen them.
- `## Tried and rejected`: Approaches that were tried or ruled out, and why. Write "None." if there were none.
- `## Next step`: The exact next action. For a blocked task, the question the user must answer.

Outcomes:

- `outcome: done`: every acceptance criterion is met and the tests pass.
- `outcome: continue`: the work is not finished. Use it when your context nears the budget, or
  when the prompt tells you the budget is reached. Finish the current small step, write the
  handoff so a new session can carry on without rereading everything, then stop.
- `outcome: blocked`: you need the user. Put the question under `## Next step` and stop.

Rewrite the handoff as a whole each time, so it always describes the task as it stands now. Keep
it short: the next session reads it first, and every line costs its context.
