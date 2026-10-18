# E24 Error tracking

Milestone: standalone (Ship). Depends on: E22.

## Goal

Show what breaks for the people using each project, next to whether it is up. AgentMate connects
to an error tracker (Sentry first: sentry.io in the US and EU regions, self-hosted Sentry, and
GlitchTip as best effort), links its projects to AgentMate projects, and lists their issues on an
Errors tab of the Monitoring page and of each project's Monitoring tab. An issue opens on its
latest event (stack trace, breadcrumbs, request and tags), can be copied for an agent or handed to
the project's agent with Fix with AI, the same way a failed pipeline run is, and can be resolved
or ignored at the tracker.

## Tasks

- [x] T1 Core module (`packages/core/src/errorTracking`): Sentry parsers to provider-neutral types
  (lenient, every string redacted, no header, cookie, email or IP kept), the `Link` header cursor,
  host clean-up (regions, `<org>.sentry.io`, self-hosted, plain HTTP only to loopback), the fix
  prompt and copy text capped at 12,000 characters, and project link suggestions.
- [x] T2 Store: connections with their token sealed in the Vault (a registered sealed store),
  links from AgentMate projects to tracker projects, pruned with the project.
- [x] T3 Sentry client: injected `net.fetch`, a timeout, no redirects, a body cap, the org's data
  region used for every call, readable errors for a rejected token, a missing scope, rate
  limiting and the network, with the token masked; older GlitchTip paths on a 404.
- [x] T4 Service and IPC with input validation: token check before saving (scopes, organizations,
  org tokens that cannot read issues), issues across connections with partial failures, a short
  cache, the latest event, resolve and ignore, the fix prompt. No token ever crosses IPC.
- [x] T5 Monitoring tabs: Uptime and Errors on the page and on the project tab, in `?view=`.
- [x] T6 Errors tab: first run, connections dialog, project linking with suggestions, filters,
  the issue list with its sparkline, the issue panel, resolve and ignore with undo, Copy for AI and
  Fix with AI, and the Help article.
- [x] T7 e2e against a fake Sentry in the test process: connect, link, list, open, copy, Fix with
  AI, resolve, and the token not on disk in the clear.

## Acceptance criteria

- AC1 With a token that has the read scopes, a linked project's unresolved issues show with their
  level, counts and last seen, and an issue shows its stack trace with the app's own frames first.
- AC2 The token never reaches the renderer, never goes over plain HTTP to another machine, and is
  never sent after a redirect.
- AC3 Copy for AI and Fix with AI hold the error, the top frame of the app's code and the request
  path, and no email, IP address, cookie, header or query value.
- AC4 Resolve and Ignore change the issue at the tracker, can be undone, and are offered disabled,
  with the reason, when the token lacks `event:write`.

## Implementation notes

- The UI says Errors; code identifiers say `errorTracking`, since `errors` already means other
  things in the code.
- No background polling and no notifications in this version: Sentry asks API users not to poll,
  so the list refreshes every minute only while the tab is open. The Monitoring badges stay about
  uptime.
- Built test-first by three parallel hands against one contract (`shared/errorTrackingTypes.ts`,
  `IPC.errorTracking`, `core/errorTracking/types.ts`): core, main and renderer, then e2e.
  `errorTracking.e2e.ts` passes (1 of 1, about 1.5 minutes) against `e2e/fakeSentryServer.ts`.
- The org list names a data region (`links.regionUrl`) and calls go there, but only on the host
  the user gave, or on a `*.sentry.io` region when the host is sentry.io. The address comes from
  the server's answer, so taking any other host would let that answer move the token.
- Sentry's issue list carries no environment or release, so the rows show the level, short id
  and culprit, and the issue panel shows environment and release from the latest event.
- Not yet tried: a real sentry.io organization (only the fake server and the API docs), a real
  GlitchTip, and Linux without a keyring (the token sealed in passphrase mode).
