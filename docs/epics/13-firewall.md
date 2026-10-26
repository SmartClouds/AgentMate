# E13 Firewall

Milestone: M4 Security and operations. Depends on: E10.

## Goal

Manage the host firewall safely: rules, presets and exposure at a glance, with changes that undo
themselves if they cut the app off.

## Tasks

- [x] T1 `IFirewallBackend` for ufw (with `IPV6=yes`) and firewalld: status, enable, disable,
  default policies, rules with validation (ports, ranges, protocols, source CIDRs, comments).
- [x] T2 Presets (SSH, HTTP, HTTPS, common databases) and the current SSH port from `sshd -T` plus
  the live `SSH_CONNECTION`.
- [x] T3 Lockout guard: a change set that would block the SSH port or the app's source is refused
  unless explicitly overridden with a typed confirmation.
- [x] T4 Safe apply: snapshot, apply, arm a transient systemd timer that restores the snapshot in 60
  seconds, confirm only over a new SSH connection.
- [x] T5 Exposure inventory: listening sockets and container port bindings, public versus local,
  with a "make private" redeploy for Runova stacks.
- [x] T6 UI: status hero, rules table with add and edit, presets, exposure view, countdown banner.
- [x] T7 Fixture: privileged ufw and firewalld test servers that check the live IPv4 and IPv6
  rulesets, plus a lockout test over a second SSH connection.

## Acceptance criteria

1. An unconfirmed change reverts even when the core process is killed right after applying it.
2. A rule set that would block SSH is refused without the override.
3. Rules land correctly in both families' live rulesets for IPv4 and IPv6.

## Implementation notes

- Core (2a87c89): ufw and firewalld behind `IFirewallBackend`, presets with the SSH ports from
  `sshd -T` and the caller's own SSH connection, the lockout guard (refused unless the typed
  phrase and a step-up come with it), safe apply with a transient systemd timer that restores the
  snapshot after 60 seconds, and the exposure inventory from `ss` and `docker ps`. A change is
  confirmed only over a brand-new SSH connection.
- Firewall screen (271820e, T6): status hero, rules with add and edit, presets, staged changes
  previewed as the exact commands, the typed SSH override, the countdown banner to keep or revert,
  history and the exposure view.
- "Make private" (T5): the exposure view's button works out whose container it is from the
  container's compose labels, the server's apps and that app's own list of containers (a compose
  project with the same name as an app is not enough). For a Runova app it asks first, then
  the core copies the live revision with that service added to the loopback override (new hub
  method `ReviseStack`, audited as `stack.revise` with purpose `make-private`; the .env and files
  stay on the server) and deploys it. The row follows the deploy and, once it is live, points to
  Websites for public access and reads the exposure again. A container Runova did not start
  gets a dialog with the compose or `docker run` change to make, ready to copy. Operators and up.
- The DevHost's pretend exposure now lists the ports its pretend Docker Engine publishes, so the
  e2e spec can see a container go from 0.0.0.0 to 127.0.0.1.

Acceptance criteria:

All three: `apps/desktop/src/main/deploy/firewall.int.test.ts` (RUNOVA_SYSTEM_TESTS=1) on
   privileged ufw (Ubuntu 24.04) and firewalld (Rocky 9) test servers: live IPv4 and IPv6
   rulesets after a change, a change that blocks SSH refused without the override, a confirmation
   over a new connection, and a change nobody confirms rolled back with the core killed. All three
   passed locally on 2026-10-02 (Windows host, Docker Desktop).

Tests for make private: `lib/deploy/firewall/makePrivate.test.ts`, the component tests in
`firewall/MakePrivate.test.tsx` (Runova app, turned down, someone else's compose project with
an app's name, docker run, refusals), `main/deploy/stacks/service.revise.test.ts`, the core's
`StackReviseTests`, the system test `stacks.int.test.ts` (a public service moved to 127.0.0.1 on
a real Docker, its .env intact) and `e2e/deployAppStore.e2e.ts` against the DevHost.
