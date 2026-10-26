# E22 Project monitoring

Milestone: standalone (Ship). Depends on: none.

## Goal

Show whether the apps and sites behind each project work, on every environment and server they
run on. Each target is a private endpoint in the user's app that answers in the Runova Health
Protocol (built on the IETF `application/health+json` draft): every service it depends on, its
status, and the full error of the ones that fail. Runova polls each target on its own interval,
opens an incident when a failure repeats, runs a read-only AI diagnosis, and hands the failure to
the project's agent to fix. A setup prompt carries the whole protocol, including its security
rules, so the user's AI can build a compatible endpoint into any stack.

## Tasks

- [x] T1 Core protocol module (`packages/core/src/health`): response parser (strict on `status`,
  lenient on malformed checks, every string redacted and trimmed), redaction, intervals and
  confirm delay, the flap filter, the protocol document, and the setup, diagnose and fix prompts.
- [x] T2 Target store: targets with their Bearer key or Basic password sealed in the Vault (a
  registered sealed store, re-sealed on a passkey change), results with 200 samples and 50
  incidents per target, pruned with the project and unlinked from a deleted environment.
- [x] T3 Probe: `net.fetch` with no redirects, a timeout, a 512 KB body cap, plain HTTP refused
  unless loopback or allowed, and the sent key masked in the report.
- [x] T4 Scheduler: per-target intervals with jitter, 4 probes at once, a quick confirming recheck,
  paused and archived targets skipped, the locked Vault waited out.
- [x] T5 Alerts: OS notification and inbox entry on an opened and a resolved incident, and a
  change event for the page.
- [x] T6 Auto-diagnosis: one read-only headless run per incident, debounced, cancellable, its
  redacted text stored on the incident.
- [x] T7 IPC with input validation; no stored secret ever crosses it, the new one shows once.
- [x] T8 Health page: pulse header, filters, targets by project and environment, cards with the
  sample strip, the detail panel (services, errors, diagnosis, incidents, raw report), Fix with
  AI and Copy for AI.
- [x] T9 Target dialog with the one-time key step and rotation, and the Connect a project dialog
  (setup prompt, protocol, send to agent, test connection).
- [x] T10 The project's Health tab, the menu entry with its badge, and the Help article.
- [x] T11 e2e: add a target against a local endpoint, see it healthy, make it fail and see the
  error and the inbox entry, rotate the key and see Key rejected.
- [x] T12 Build with AI: a dialog that builds the setup prompt in the renderer from a project,
  environment, server, sign-in and path before any target exists, sends it to the project's agent
  by name or copies it, and hands over to adding a target. Offered in the toolbar, on first use, and
  in a target's details while it does not answer yet.
- [x] T13 Charts: every check rolled up by local hour for 30 days (`core/health/rollup.ts`, built
  from the samples for older result files), so the 24 hour uptime reads real history. Availability
  by day (7 or 30 days, across the targets in view) on the page, and response time (median and
  95th percentile, incidents shaded) for the last 24 hours in a target's details.

## Acceptance criteria

- AC1 A target that answers a valid report shows each service with its status; a failing service
  shows its message, code, detail, hint and stack.
- AC2 The endpoint's key never reaches the renderer except once after it is made, never goes over
  plain HTTP to another machine unless allowed, and is never sent after a redirect.
- AC3 An incident opens only after a failure repeats, and resolves the same way, with one
  notification each.
- AC4 The setup prompt alone is enough for an agent to build an endpoint that passes AC1 and
  answers `401` without credentials.

## Implementation notes

- The protocol keeps the draft's field names so existing health libraries fit, and adds an
  `runova` object per failing check for error detail and one at the top for the protocol id.
- A pass with a failing check reads as warn, and a pass on a 5xx reads as fail, so an endpoint
  cannot hide a problem by mistake.
- The feature is called Monitoring in the app (menu, page, project tab, route `/monitoring`). The
  endpoint and the protocol keep the name health check, the standard term an agent or developer
  knows, and code identifiers keep `health`.
- Uptime used to come from the last 200 samples, which at a one-minute interval is barely three
  hours. The hourly roll-up fixes that: an hour keeps its check and failure counts and its median
  and 95th percentile latency, and only the open hour keeps raw latencies (thinned evenly past 240).
  Hours follow the local clock so days end at the user's midnight, half-hour zones included.
- Warn is degraded, not down: it shows on the page but opens no incident.
- A target's sign-in type and Basic username are fixed once it is made, since changing either
  needs a new secret. Delete and add the target again to switch.
- Built test-first by three hands against one contract (`shared/healthTypes.ts`, `IPC.health`):
  core, main and renderer. `health.e2e.ts` runs the whole flow against a protocol endpoint in the
  test process: add, the key shown once and not on disk, healthy, a failing service with its
  error, a confirmed incident with one inbox entry, rotation turned down, and recovery.
