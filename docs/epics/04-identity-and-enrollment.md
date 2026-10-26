# E04 Identity and device enrollment

Milestone: M1 Foundations. Depends on: E03.

## Goal

The core knows who is calling. Users and password hashes live in the core's SQLite through
ASP.NET Core Identity; each desktop proves itself with an enrolled device key; every endpoint and
hub method is covered by a policy; every sensitive action lands in a tamper-evident audit trail.

## Tasks

- [x] T1 EF Core SQLite context with migrations applied at start-up, WAL mode, single writer queue
  (`BEGIN IMMEDIATE`, busy timeout), unix-millisecond timestamps.
- [x] T2 Identity with Guid keys, password rules (12+ characters, common-password list), PBKDF2
  iteration count raised, lockout (5 failures, 15 minutes), TOTP authenticator and recovery codes.
- [x] T3 Roles Owner, Admin, Operator, Viewer and named policies; deny-by-default fallback; the
  reflection test from E01 now also checks hub methods.
- [x] T4 Devices: P-256 public keys, `admin create-owner --username --password-stdin` and
  `admin enroll-device --user --name` reading the public key from stdin.
- [x] T5 Challenge login: `POST /auth/challenge` (single-use nonce, 60 s TTL),
  `POST /auth/login` (signature plus password, then TOTP step when enabled), `POST /auth/renew`
  (signature only, within the device session's idle and absolute limits), 15-minute access tokens,
  logout, device and session list and revoke.
- [x] T6 Step-up: re-enter password or TOTP, valid 10 minutes, required by policy for sensitive
  actions.
- [x] T7 Rate limits per user and global on auth endpoints.
- [x] T8 Audit: append-only, hash-chained events (actor, device, peer uid, action, target, redacted
  parameters, result), query and chain verification endpoints, retention job.
- [x] T9 Break-glass CLI: `admin revoke-all`, `admin reset-password --password-stdin`.
- [x] T10 Desktop: device key generation and sealing (`SecretEnvelope`), enrollment during install
  (owner username and password collected in the wizard, piped over stdin), sign-in and 2FA screens,
  signed renewals in the connection layer, "needs sign-in" and "needs re-enroll" states.
- [x] T11 Extra devices: Owner mints a single-use enrollment code; another device redeems it with its
  public key and the user's password.

## Acceptance criteria

1. Each auth path has integration tests: success, wrong password, wrong TOTP, lockout, replayed
   challenge, expired challenge, revoked device, expired session.
2. A Viewer is denied every mutating endpoint and hub method (table-driven test over the policy
   map).
3. Editing any audit row breaks chain verification (tested).
4. Owner password and device key never appear on a command line (asserted on the exec requests).
5. A revoked device cannot reconnect and the UI moves to "needs re-enroll".

## Implementation notes

- **Where it lives.** Server core: `Data/` (EF Core context, the Initial migration,
  `DatabaseStartup`), `Audit/` (the hash-chained log and its retention job), `Security/` (Identity
  settings, `ProtectedUserStore`, device keys, challenges, access tokens, device sessions, policies,
  enrollment codes, peer credentials, `OneTimeAuthenticator`), `Endpoints/AuthEndpoints.cs`,
  `Hubs/CoreHub.cs` with `Hubs/HubConnections.cs`, and `Cli/AdminCli.cs`. Desktop main process:
  `main/deploy/auth/` (device key, sessions), `main/deploy/bootstrap/enrollment.ts`, the account
  methods of `main/deploy/service.ts`, and `shared/coreErrors.ts`. Renderer: `AccountFields`,
  `CoreAccessCard`, `SignInDialog`, `EnrollDialog` and `TwoFactorDialog` in `components/deploy/`.
- **T1.** Microsoft.Data.Sqlite opens every transaction as `BEGIN IMMEDIATE`, so an EF write
  holds the write lock from its first statement; the audit log appends inside one too
  (`CoreDatabase.BeginWrite`), which keeps the chain from forking when an admin command and the
  service write at the same time (tested across processes). Busy timeout 30 seconds.
- **T2.** PBKDF2 at 210,000 iterations (OWASP's figure for HMAC-SHA512). The common-password list
  is SecLists' xato 1M, cut to the 46,146 entries of 12 to 64 characters, embedded in the binary.
  The authenticator key and the recovery codes are encrypted at rest with Data Protection
  (`ProtectedUserStore`). Authenticator codes work once (RFC 6238, section 5.2):
  `OneTimeAuthenticatorTokenProvider` takes the place of Identity's provider, keeps the last
  accepted step per user, accepts one step either side of now (Identity allows two), and lets the
  concurrency stamp decide when one code arrives twice at once. The plan did not spell this out;
  it is part of what TOTP means, and it surfaced while writing the e2e test.
- **T3 and AC2.** AC2 is read as: account self-service (who am I, sign out, step-up, one's own
  devices, sessions and two-factor) is open to every signed-in role, Viewer included; everything
  that changes the server needs Operator or more. `A_viewer_is_refused_every_method_above_viewer`
  walks the policy map, and `Every_method_a_viewer_may_call_is_account_self_service` pins the
  exceptions. REST has no mutating endpoint yet (health and the four sign-in endpoints, all
  anonymous); the reflection test fails the build for any new endpoint without a policy.
- **T5.** Access tokens are sealed with Data Protection (base64url), not JWTs: only the core reads
  them, so there is no signing key to manage, and every request checks the live session, so a
  revocation takes effect at once. Logout is the hub's `SignOut`. Revoking a session or a device
  closes its open hub connections (`HubConnections`); the caller's own connection closes 250 ms
  later so its reply still gets out.
- **T6.** The step-up window (10 minutes) lives on the session row and is read per call, so it
  counts on a connection that is already open.
- **Two-factor and sessions.** A session ends when the user's security stamp no longer matches the
  one it recorded, and Identity renews the stamp when it makes an authenticator key and when
  two-factor goes on or off. Starting a setup now moves every session to the new stamp (the key is
  not in use yet); turning two-factor on or off keeps only the session that did it and ends the
  others, open connections included, since they never proved the new state. The e2e test found
  this: the app opens a connection per call, so the confirmation was refused the moment the setup
  began, which a hub test on a single open connection could not see.
- **T8.** Query and verification are hub methods (`QueryAudit`, `VerifyAudit`, Admin), in keeping
  with the WebSocket-first API. Each event hashes a JSON array of its fields plus the previous
  hash; ids are assigned inside the write lock; pruning (one year, daily) leaves an anchor so the
  rest still verifies. Limit: someone with root on the server can rewrite the whole file and
  recompute every hash. The chain shows any edit short of that; sending the trail off the server
  (E15) closes the gap.
- **T10.** One P-256 device key per server; the private half is sealed by the Servers vault
  (safeStorage, or the passkey when one is set) and moved when the passkey changes. Tokens stay
  in memory; only the session id is stored. A core's refusal crosses IPC as `[core:<code>]`. The
  install wizard asks for the owner on a new core; on a core this computer is not on, the account
  is optional. When the core installs but the account cannot be set up, the install still
  succeeds and the server card offers to enroll. The DevHost has no SSH, so it enrolls through a
  loopback-only `/dev/enroll` with a fixed development owner, `dev` with the password
  `runova-local-password`. The first password, `runova-dev-password`, was refused by the
  core's own rule against passwords that contain the user name, which only the e2e test caught.
- **T11.** Minting (`CreateEnrollmentCode`, Owner, needs a step-up) and redeeming
  (`POST /api/v1/auth/enroll`) are in the core and tested. The screens for them come with E15 T1
  (users, devices and enrollment codes), where the plan puts user management.
- **System tests in CI.** They had only ever passed on Docker Desktop. On GitHub's runners the
  systemd test servers shared the host's cgroup namespace, which collides with the runner's own
  systemd (Ubuntu servers never finished starting), and the runner's AppArmor profile for
  unix_chkpwd confined the Rocky server's own helper (every password login failed). The servers
  now get a private cgroup namespace and CI unloads that profile. Three SSH waits that had no
  time limit are bounded as well. All 8 pass in CI now.
- **SignalR in the built app.** Bundling the SignalR client broke its runtime `require` of
  `eventsource` and `tough-cookie` in `electron-vite` builds (unit and integration tests run
  unbundled, so none noticed). It is now external, like `postman-runtime`. The e2e test caught it
  on the first hub call.
- **Evidence.** Server core: 140 tests; on Windows 133 pass and 7 are Linux only, and in the .NET
  SDK container 139 pass (the one left needs a Docker daemon). Desktop: unit tests for the device
  key, sessions, enrollment (AC4 checks that the password and the key never reach a command line),
  the service, IPC and every new screen, with a coverage floor for `main/deploy/auth`.
  `deploy.int.test.ts` creates the owner, enrolls and signs in over the SSH tunnel on a real
  server, alongside the E03 installs (all 8 pass on Ubuntu 24.04 and Rocky 9). A visual pass in
  both themes drove the new screens against the DevHost and a real Ubuntu server, including a
  break-glass `revoke-all` that the app reported on its next call and recovered from by enrolling
  again. `deploy.e2e.ts` signs in to the DevHost, turns two-factor on with a code computed from
  the key the dialog shows, and signs in again with a fresh code.
