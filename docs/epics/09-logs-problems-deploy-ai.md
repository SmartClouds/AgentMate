# E09 Logs center, problems feed and Deploy AI

Milestone: M2 Docker, apps and AI. Depends on: E07.

## Goal

Every error is one click away from a fix: a unified log viewer, a problems feed that surfaces what
is broken, and a Deploy AI that diagnoses and repairs over the core's WebSocket with the same
approval experience as the SSH AI, but safer.

## Tasks

- [x] T1 Unified log viewer: sources (container, whole stack with a color per service, journald
  units, core audit; nginx is added in E10), follow, search and highlight, level detection, time
  range, download; untrusted text is rendered as text only.
- [x] T2 Problems feed: crash loops, unhealthy containers, failed deploys, disk pressure, exposed
  ports; each card offers "Diagnose with AI" and "Fix in project".
- [x] T3 Characterization tests for `apps/desktop/src/main/agents/sshTaskRunner.ts` before any
  change, so the SSH AI keeps behaving exactly as today.
- [x] T4 Refactor the loop so it takes a command executor; the SSH and local targets keep the marker
  based executor.
- [x] T5 Core executor over hub `StreamExec`; modes "approve every command" (default) and "auto-run
  diagnostics" (strict read-only allowlist parser, step-up to enable); approvals signed by the
  device key over the command text and a nonce.
- [x] T6 Core side: `StreamExec` refuses any AI-tagged command that is neither allowlisted nor
  carrying a valid approval; audit tags every AI step; output redacted with the stack's env values
  before it is returned.
- [x] T7 Prompt builder: server facts, stack and container context, log excerpt wrapped as
  delimited untrusted data; no env values.
- [x] T8 Assistant drawer on every Deploy screen: context chips, step timeline, approve and skip,
  streamed output, stop, follow-up questions.

## Acceptance criteria

1. The SSH AI characterization suite passes unchanged after the refactor.
2. A non-allowlisted command without a valid approval is refused by the core itself (integration
   test calling the hub directly).
3. Log text containing instructions cannot cause any command to run without approval (test with an
   injected log line and a fake model that obeys it).
4. No env value of the stack reaches the model (test with seeded secrets).

## Implementation notes

Server core:

- `StreamExec` (Admin) is the one shell entry point. Without an approval it runs only a command
  the read-only allowlist accepts (`Assistant/CommandAllowlist.cs`: one command, only letters,
  digits, spaces and `._/:=,@+-`, a known program and subcommand, and flags that only read; no
  following, no writing, no killing). From the assistant it also needs the session's "auto-run
  diagnostics" mode. Anything else needs an `ExecApproval`: a single-use nonce from
  `NewExecApproval` (two minutes, bound to the session and device) signed by the enrolled P-256
  device key over `runova-core/exec/v1`, the nonce id, the nonce, the device, the session and
  the exact command. The nonce is spent before anything is checked.
- An allowlisted command runs from its own words; an approved one through `/bin/sh -c`. Both run in
  a collected transient unit (`systemd-run --collect --wait --pipe`, `SystemdExecRunner`), so a
  stopped stream or a timeout ends every process the command started. Output is capped (5000
  lines, 1 MB) and redacted with every stack's env values (every revision on disk) and every
  container's secret-looking or long env values, since `docker inspect` can print any of them.
- Audit: `exec.run` for every run and every refusal (with `assistant` and how it was let through:
  `allowlist`, `signed`, `invalid` or `none`), and `exec.exit` with the exit code or `cancelled`;
  `assistant.mode` when the mode changes.
- `EnableAutoRunDiagnostics` needs Admin and a step-up; `DisableAutoRunDiagnostics` and
  `GetAssistantMode` need Admin. Deviation: the mode is kept in memory per session, not in the
  database, so a core restart puts every session back on approving every command. No migration.
- `StreamJournal` (Admin): `journalctl --output=json` for a checked unit name, redacted like exec
  output, two per connection. New stream kinds `exec` and `journal` (2 each).
- DevHost: a recorded, never-run exec runner with canned answers, a pretend journal, and a
  crash-looping `newsletter-sender-1` (added by the DevHost only, so the core tests' seed is as
  it was).

Desktop:

- T3, T4: `sshTaskRunner.characterization.test.ts` pins the SSH and local AI first (every prompt
  byte for byte in a snapshot, the three modes, skip, NEEDS_INPUT, the CLI and provider paths,
  labels, the step limit, stop messages), and passed before and after the refactor. The loop now
  takes a `CommandExecutor`, an `ApprovalPolicy` and an optional prompt builder through
  `startAgentTask`; `startSshTask` builds the same marker executor and mode policy as before. An
  executor may throw `ApprovalRequiredError`, which the loop turns into an ordinary proposal.
- `main/deploy/assistant/`: the core executor (StreamExec on the lasting link, signed approvals
  only after the user clicks Run), the approval signer, and `DeployAssistant` (one run per server,
  keyed `deploy:<serverId>`; it reads the container's facts and log itself). In "approve every
  command" each command waits; in "auto-run diagnostics" nothing waits on the app side and the
  core decides, so a command it refuses comes back as a proposal.
- `packages/core/src/deploy/assistant.ts`: the prompt. Logs and the transcript go in blocks marked
  as untrusted data, whose `=` markers are longer than any run of `=` inside, after the rules;
  env values never, names only, redacted again on the way in.
- Logs section: Problems (crash loops, dead and unhealthy containers, failed and half-up apps, open
  alerts, certificates within 14 days or expired, containers published to the internet) and the
  log viewer (a container, an app's services together with a colour each, a unit's journal, a
  site's access or error log, the core's audit trail; follow, search with highlight, levels read
  from each line, time range, download; text only). The Deploy AI drawer opens from a corner
  button on every server screen, from "Diagnose with AI" on a problem, or from the viewer.
- Deviations: problems are put together in the app from what the core already reports (no new
  alert kinds), so a crash loop raises no notification. An app's log shows at most four services,
  the core's per-connection limit for container logs. The drawer's AI picker offers the Settings
  provider and installed CLIs with their default model (no model or effort choice). The command
  palette actions of signature interaction 8 are not part of this epic.

Acceptance criteria:

1. The characterization suite and the existing `sshTaskRunner.test.ts` pass on the refactored loop.
2. `AssistantHubTests` call the hub directly: a command without an approval, a wrong signature, a
   replayed nonce, a command other than the signed one, a nonce from another session and an
   expired one are all refused, nothing reaches the runner, and each refusal is audited.
3. `main/deploy/assistant/service.test.ts` feeds a log line telling the model to run `rm -rf /`
   and a model that obeys: in "approve every command" it waits for the user, and in "auto-run
   diagnostics" the core refuses it unsigned. `e2e/deployLogsAi.e2e.ts` runs the same flow
   against the DevHost: crash loop, Diagnose with AI, an allowlisted check that runs by itself,
   then a command that waits for approval.
4. `AssistantRedactionTests` seed a stack's .env and containers outside it with secrets: command
   output, the journal and the audit trail carry none; the prompt test checks names only.

System test: `apps/desktop/src/main/deploy/deployExec.int.test.ts` (RUNOVA_SYSTEM_TESTS=1, the
published core on the Ubuntu 24.04 systemd test server, CI step "Exec and journal on test
servers") runs `df -h` through the real `systemd-run` with its output and exit codes, refuses an
unapproved `touch` with no file left behind, runs a signed command once and refuses its replayed
nonce, stops `sleep 301 & sleep 302` with both processes and the unit gone, and reads the core's
own journal from journalctl. It passed locally; nothing in the core needed changing.

Unverified: the system test runs on Ubuntu only (not Rocky), and the new screens have had no
visual pass in both themes.
