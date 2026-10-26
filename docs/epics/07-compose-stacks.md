# E07 Compose stacks

Milestone: M2 Docker, apps and AI. Depends on: E06.

## Goal

A user names an app, picks a compose file from a project and an environment from that project's
Environments tab, and deploys it. Each deploy is a timeline with live logs; older revisions can be
restored in one click. Services that will be proxied publish on loopback only.

## Tasks

- [x] T1 `resolveProjectEnvironment(projectId, environmentId)` next to the `mutate()` queue in
  `main/ipc/environments.ts`, returning decrypted entries to main-process callers only.
- [x] T2 Compose discovery in a project through the file index (`compose.y*ml`,
  `docker-compose*.y*ml`), YAML parsing with `yaml`, service and port summary.
- [x] T3 `.env` rendering that compose parses back to exactly the same values (quoting, `$`
  escaping, multiline), key validation.
- [x] T4 In-house `.dockerignore` matcher (Docker's pattern rules, `**`, `!` exceptions) and a
  build-context tarball builder that honors it.
- [x] T5 Risk linter (privileged, host network or PID, docker.sock or `/` mounts, dangerous
  capabilities, public port bindings, `latest` tags, missing restart policy or healthcheck, SELinux
  bind mounts without `:z`) with per-risk acknowledgment recorded in the audit.
- [x] T6 Core stacks module: stack and revision model, upload endpoint (compose, `.env`, optional
  tarball with safe extraction and caps), `docker compose config` validation in memory, override file
  with `ports: !override` loopback bindings for proxied services, deploy job (validate, pull,
  build, `up --wait`, health), start, stop, restart, down, delete with optional volumes, rollback.
- [x] T7 New App wizard (source, configure, expose, review with lint findings, deploy) and app
  detail (services, containers, revisions, env keys, compose viewer, route map stub, actions).
- [x] T8 Deploy timeline UI with per-step live logs, durations and a rollback on older revisions.

## Acceptance criteria

1. Tarballs with absolute paths, `..`, escaping symlinks, device files or too many entries are
   rejected before anything is written outside the stack directory.
2. Rendered `.env` files round-trip through compose's own parser (system test).
3. A proxied service ends up bound to `127.0.0.1` only, even when the user's compose file publishes
   it on all interfaces (system test inspects the running container).
4. Rolling back restores the previous revision's files and running state.
5. The wizard passes component tests for every step and an e2e flow against the DevHost.

## Implementation notes

Server core:

- Stacks and StackRevisions tables (migration `Stacks`). Each revision lives in
  `<data>/stacks/<id>/revisions/<n>/`: the compose file as uploaded, the `.env` (0600), the loopback
  override and `files/`, the compose project directory (the build context unpacked with
  SafeTarExtractor, or an empty folder). Compose runs with `--project-directory files/`, so a
  revision's relative bind mounts are its own files and a rollback brings them back with it.
- Files go up over REST because a compose file and its `.env` can be larger than a hub message:
  `POST /api/v1/stacks/{id}/revisions` (JSON, 4 MB) and `PUT .../revisions/{n}/context`
  (`application/gzip`, 300 MB, `X-Content-Sha256` checked), Operators only. Once the files are in,
  the core runs `docker compose config --format json` (kept in memory, never stored), lints it in
  C# with the app's finding ids (a shared fixture in `packages/core/src/deploy/compose/fixtures`
  is checked by both linters), writes the `!override` file and marks the revision Ready or Invalid.
  Every acknowledgment is one `stack.risk-acknowledge` audit entry.
- The deploy job (validate, pull, build, `up --wait`, health) keeps its steps on the revision with
  the job log lines each one wrote, and seeds the redactor with the stack's env values. Rollback
  copies an earlier revision into a new one and deploys it. Delete with volumes is its own hub
  method, Admin only. A core restart marks a deploy that was running as failed.
- Deviation: the DevHost and the tests run docker compose simulated on the pretend engine
  (`SimulatedCompose`, YamlDotNet in the DevHost only).

Desktop:

- `resolveProjectEnvironment` waits for queued saves and merges the environment's files, the
  later file winning. Discovery uses the file index; the preview lints with the stack's values,
  keeps every publishing service on 127.0.0.1 by default and never sends a value to the renderer.
  The upload reads the project again, refuses what still waits for an acknowledgment, packs the
  compose folder honouring `.dockerignore` when something reads from it, and streams it.
- Apps section per server: list, New App wizard (source, configure, expose, review, deploy), the
  deploy timeline with per-step live logs and durations, and the app detail (services, revisions
  with rollback, lifecycle by role, files, a route map stub, typed confirmation to delete data).

Acceptance criteria:

1. Core tests upload zip-slip, absolute, escaping-link, hard-link, device and bomb archives through
   the REST endpoint and find nothing written outside the stack folder.
2. and 3. and 4. The system test `apps/desktop/src/main/deploy/stacks.int.test.ts` (gated by
   RUNOVA_SYSTEM_TESTS=1) deploys from a project on Ubuntu 24.04 with Docker, checks the env
   value inside the container, the 127.0.0.1-only binding of a port published on all interfaces,
   and a rollback to the first revision's files and environment.
5. Component tests for every wizard step and `e2e/deployApps.e2e.ts` against the DevHost.
