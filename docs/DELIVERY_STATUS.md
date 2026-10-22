# Delivery Status

Updated: 2026-10-03
Run branch: master (direct, per the user's instruction)
Plan: docs/ROADMAP.md

## Commands

| Gate | Command |
|---|---|
| Install | `pnpm install --frozen-lockfile` |
| Format and lint | `pnpm biome:ci` |
| Deprecated code | `pnpm check:deprecated-code` |
| Deprecated dependencies | `pnpm check:deprecated-deps` |
| Build packages | `pnpm build:packages` |
| Type check | `pnpm -r typecheck` |
| Unit and integration tests | `pnpm test:unit` (core, protocol, desktop) |
| Desktop build | `pnpm --filter @agentmat/desktop build` |
| Server core format | `pnpm server-core:format:check` |
| Server core tests | `pnpm server-core:test` (Linux-only socket tests run in the .NET SDK container or CI) |
| Contracts | `pnpm server-core:contracts`, then no diff under `apps/desktop/src/shared/deploy/protocol/generated` |
| System tests | `pnpm server-core:publish linux-x64`, then `AGENTMATE_SYSTEM_TESTS=1 pnpm --filter @agentmat/desktop exec vitest run src/main/deploy/deploy.int.test.ts` (Docker with Linux containers; CI job "Server core on test servers", on every CI run) |
| e2e | `pnpm test:e2e`, on every CI run (Linux, self-hosted); Windows and macOS only in CD when the tagged commit carries `[e2e]` |
| Full server matrix | `.github/workflows/nightly.yml` (nightly and `gh workflow run nightly.yml`): every Deploy system test once per test server (`AGENTMATE_TEST_SERVER_IMAGES`), plus the server core's nginx and Pebble system tests |

## Epics

| Epic | Title | Status | Commit | Notes |
|---|---|---|---|---|
| E00 | Delivery docs | Complete | 4e412e3 | Written by hand |
| E01 | Server core scaffold | Complete | 3353dba | Contracts via Tapper and TypedSignalR (TS 7 has no compiler API for openapi-typescript); API is WebSocket-first |
| E02 | SSH foundation | Complete | dc698a8 | Host-key trust dialog shared by terminals and Deploy; sudo password validated alone before payloads |
| E03 | Walking skeleton: install and see the server | Complete | 88403fa, 42aabeb | Tunnel or bridge settled by trying after the install (OpenSSH hides the reason); exec exit-status race fixed; DevHost e2e on every OS |
| E04 | Identity and device enrollment | Complete | 73663f6, see git log | Authenticator codes work once (RFC 6238 5.2); two-factor changes end the other sessions only; access tokens sealed with Data Protection rather than JWTs; enrollment-code screens come with E15 T1; SignalR kept out of the main bundle |
| E05 | Realtime, jobs and server overview | Complete | see git log | Live link with token rotation and reboot recovery; Overview with health score, charts, updates and reboot; AC3 and AC4 covered by fake-core tests and the DevHost reboot, not a real server |
| E06 | Docker engine and containers | Complete | c5c0b68, 5bfa76e, see git log | Core (install with podman removal, engine client, stats math, redacted logs, console, resources) and the Containers screen; the Rocky 9 system test passed locally in E17 and runs nightly |
| E07 | Compose stacks | Complete | ea106b3, see git log | Files over REST, revisions on disk with their own project folder, compose config linted in the core with the app's finding ids; DevHost runs a simulated compose |
| E08 | Private registries | Complete | see git log | Sign-ins sealed on this computer and sent per deploy into a tmpfs DOCKER_CONFIG wiped in a `finally` (the core refuses a non-tmpfs folder); GitHub scopes read from `X-OAuth-Scopes`, anything beyond read:packages behind a warning; write-only stored credentials (Data Protection, Admin with step-up); Containers pulls sign in through X-Registry-Auth |
| E09 | Logs center, problems feed and Deploy AI | Complete | see git log | StreamExec with the read-only allowlist and device-signed approvals; the SSH AI loop takes a pluggable executor (characterization suite before and after); problems feed and log viewer in a Logs section; Deploy AI drawer on every server screen |
| E10 | nginx websites | Complete | 77b262a, 07db580, aca88a8, see git log | Renderer, snippet allowlist, apply with rollback, stream proxies, SELinux labels; the `nginx -t` harness on Debian 13 and Rocky 9 runs nightly. The Rocky apply failure of the first nightly run was a product bug (a refused reload ended before nginx stopped retrying the port, so the next apply read its leftovers as its own cause), fixed with a test |
| E11 | Let's Encrypt certificates | Complete | 7110a67, 07db580, aca88a8 | ACME client (RFC 8555 and ARI) against Pebble, renewal service, SSL tab; AC3 tested in E17 (a failed renewal now has its own inbox title); DNS-01 through E14; HTTP-01 on an installed core fixed in E17 (its webroot folders came out 0700 under the core's umask) |
| E12 | App Store | Complete | see git log | Catalog of 19 apps pinned by digest (MinIO left out: no public official image); App Store section, one-screen install sheet, post-install card with masked secrets (step-up reveal), explicit updates as server-side revisions, digest refresh script. AC3 by `appStoreHttps.int.test.ts` (WordPress on a domain over HTTPS with a Pebble certificate, nightly), which found and fixed the install sheet's invalid upstream service name |
| E13 | Firewall | Complete | 2a87c89, 271820e, see git log | Core (ufw and firewalld, lockout guard, safe apply), the Firewall screen (T6) and "make private" (T5): an AgentMate app is redeployed with the service on 127.0.0.1 as a revision the server copies; anything else is shown the compose or run change. AC1 to AC3 by the firewall system tests, in CI since run 37084799281 |
| E14 | Cloudflare | Complete | df848e5, see git log | Desktop T1 to T4, T8, T9; core and desktop T5 to T7: Origin CA (key made on the server), origin lock through firewall change sets with a daily unattended refresh and nginx real IP, DNS-01 with a zone-scoped token (migration CloudflareOriginAndDns) |
| E15 | Security center and maintenance | Complete | c87918a, see git log | Checklist with a score and previewed fixes; SSH password login off only over a proven key login (two guards, timer rollback, kept over a new key login); a failed core update reconnects; backups encrypted on the core (PBKDF2 600,000, AES-256-GCM chunks) and restored over SSH as root |
| E16 | Direct TLS mode | Complete | see git log | Opt-in HTTPS listener bound and closed at runtime (Kestrel endpoint reload), P-256 certificate made on first start and pinned over SSH; desktop self-signs a client certificate with its device key, checked against the enrolled keys on every handshake and request; firewall rule through E13 change sets; direct TLS first, SSH after, a pin mismatch stops the link |
| E17 | Polish and full OS matrix | Complete | see git log | Nightly full matrix, system tests parameterized by image, visual and keyboard pass of every Deploy screen, README; the full-stack e2e (`deployFullStack.e2e.ts`, AC1) passed on Ubuntu 24.04 and Rocky 9, locally and in nightly run 37116895444 |
| E18 | Ask AI for Remote Desktop | Complete | | Input through the IronRDP session, screenshots from its canvas; verified against xrdp and XFCE; Codex image answer unverified locally |
| E19 | WordPress Connector plugin and sync engine | Complete | | Built by four parallel agents against one contract and shared vectors; plugin on PHP 7.4 to 8.4 and multisite, smoke on real WordPress; the sync engine against the real plugin in Docker (`wordpress.int.test.ts`); security review findings fixed; uninstall checked on single site and multisite |
| E20 | WordPress sites in Deploy | Complete | | Rail group, connect dialog, overview, items, deploys with rollback, access and audit log |
| E21 | WordPress projects | Complete | | New project flow, WordPress section, pull and deploy reviews with conflicts and the left-out list; `deployWordPress.e2e.ts` passes on the final code (6 of 6, 3.9 minutes; nightly job `wordpress-e2e`). The new-project item step loaded slowly in the e2e window (likely its throttling; unconfirmed in a focused window) |
| E22 | Project monitoring | Complete | | Core protocol, main (store, probe, scheduler, alerts, auto-diagnosis, IPC) and renderer (Monitoring page, project tab, dialogs, Build with AI) built test-first; `health.e2e.ts` passes (1 of 1, 43 s). AC4 (an agent builds a passing endpoint from the setup prompt alone) not yet tried with a real agent |
| E23 | FTP and SFTP sites | In progress | | Built test-first by parallel agents against one contract (`shared/deployFilesTypes.ts`, `IPC.deployFiles`, `RemoteFiles`). All tasks done and reviewed; Docker integration 105 of 105, `deployFiles.e2e.ts` 7 of 7 (before the review fixes). Still owed: a full `test:unit` and `test:coverage` run, and the e2e spec again after the review fixes |
| E24 | Error tracking | Complete | | Sentry issues on the Monitoring page (Uptime and Errors tabs), built test-first by parallel agents against one contract (`shared/errorTrackingTypes.ts`, `IPC.errorTracking`); `errorTracking.e2e.ts` passes (1 of 1) against a fake Sentry. A real sentry.io organization, real GlitchTip and Linux without a keyring not yet tried |
| E25 | SSH SFTP file manager | Complete | | Built test-first by parallel agents in one worktree against one contract (`shared/sftpTypes.ts`, `IPC.sftp`, `components/sftp/contracts.ts`). Dual-pane manager for saved SSH servers: transfers with conflicts, permissions, remote edit, and entry points from Remote, the terminal drawer and the palette. A follow-up makes it usable from anywhere: a status bar transfers item, a dock tab in the terminal drawer and a pop-out window, all views of one session, so switching never stops a transfer. Docker integration 20 of 20 against OpenSSH, `sshFiles.e2e.ts` 1 of 1, light and dark checked by screenshot. A 1 GB transfer, a 10k-file folder, a dropped network mid-transfer and macOS or Linux local paths not yet tried by hand |
| E26 | Relay | Complete | | Built test-first by parallel agents against one contract (`shared/relayTypes.ts`, `IPC.relay`). Context-sized task files and Markdown handoffs (chosen over Graphiti), a pure relay reducer in core, a main-side driver that starts each leg's Claude Code with relay hooks (plan gate, context guard, Stop gate) and an `agentmate_relay` MCP bridge, a workspace Tasks track, a glass board, Split into tasks, Revise with AI and Blueprint task files. `relay.e2e.ts` 6 of 6 with a fake Claude that parses its arguments like the real CLI. Verified on real Claude Code 2.1.305: a plan-first relay of two tasks, plans approved into auto mode, a forced 30K budget rolling a task over five sessions by its handoff, one commit per task. That run found four bugs fixed since (prompt swallowed by `--allowedTools`, "Open questions: None." held a plan, transcript path lost before the file exists, budgets below a fresh session's ~50K churned legs). Codex and Copilot MCP paths, cmd.exe and macOS or Linux not tried by hand |
| E27 | Deploy file manager | Complete | | A Files section on each Deploy server: the server disk over SFTP, a container or a volume through the core (exec and the archive API, volumes through a pinned busybox helper with no network, kept out of the Containers list). Reuses the E25 view and engine behind a Docker `SftpFileClient`; Browse files in the container drawer and the Volumes tab. Admins only, every download and change audited. Built test-first by parallel agents (core, desktop main, renderer). Core: Files 193 and Docker 89 unit tests pass, system tests 20 of 20 on real Docker (alpine, debian slim, distroless, stopped, a volume; 50 MB both ways with a hash check). Desktop: `dockerFiles.int.test.ts` 31 of 31 against the DevHost, `deployServerFiles.e2e.ts` 2 of 2, E25 `sshFiles.e2e.ts` 2 of 2 (one Monaco typing flake passed on rerun). Full desktop suite with coverage: all pass apart from `connectorBundle.test.ts` (plugin zip 1.61.0, expects 1.62.0; not E27). Not done: a light and dark check by hand, and a 1 GB transfer on a real server |
| E28 | Server backups | Complete | | Whole-server backups on demand or on a Hangfire schedule, encrypted to a key ring sealed with a secret the core never stores, sent to several destinations (server folder, FTP, SFTP, Google Drive, OneDrive, Telegram in parts) with a keep count per plan. Restore onto the same server or a new one with a new address, which moves every setting that named the old one. Built test-first |
| E29 | Error reporting | In progress | | A server's core sends its own warnings and errors to a Sentry project as OpenTelemetry logs (OTLP over HTTP, no Sentry SDK), set up by an Owner in Security > Error reporting with a status card and a test event. Live swap with no restart, secrets scrubbed before anything leaves, DSN sealed and never returned, crashes reported. Built test-first: core 108 tests for it (the whole core suite passed, 1870), desktop unit tests for every new file, `deployErrorReporting.e2e.ts` passing against the DevHost. Still owed: the full desktop unit and coverage run (stopped once for low memory), and a real Sentry (Sentry marks its OTLP log intake beta) |
| E30 | Telegram notifications | In progress | | A Notifications section per Deploy server: an Owner gives the core a bot token, the chat ID of a person or group, and the server name that starts every message, and picks which alerts to send (all on by default). The core itself sends to Telegram (app closed or not): on open, on getting worse, and a resolved note. Two new alerts: BackupFailed (from the backup runner, per plan) and ContainerCrashLoop (a watcher on Docker events, 3 exits in 10 minutes). Token sealed and never returned, every change audited without it. Built test-first: core suite 2339 (0 failed, 17 skipped), desktop unit 14163 passed (1 unrelated flaky SFTP test that passes alone), both tsc projects clean, `deployTelegram.e2e.ts` passing against the DevHost and a fake Bot API. Still owed: a real bot and chat from a real server |

Status values: Not started, In progress, Blocked, Complete.

## Unverified criteria

Reviewed in E17 (2026-10-03). What follows is what no test has shown yet, or has shown only on
this machine.

**The first nightly run** (37097759993, dispatched on 6d498a9)

- Green: every Deploy system test on Ubuntu 24.04, Debian 13 and Rocky 9 (installs as root and
  with sudo, stacks, private registries, exec and journal, the Security center, and the Rocky 9
  podman case, E06 AC4), ufw and direct TLS, and firewalld. Debian 13 and Rocky 9 had never run
  these in CI before.
- The server core's own system tests (nginx `-t` harness and Pebble, which no workflow ran
  before): 18 of 19 passed, Pebble issue and renew included (E11 AC1). The one failure,
  `RockyNginxApplyTests.A_release_the_core_applies_serves_with_basic_auth_and_logs_per_site`, was
  a product bug: nginx retries a port in use five times, 500 ms apart, and the core called the
  reload refused at the first line, so the next apply read the rest as its own cause. Fixed on
  2026-10-03 with a unit test that failed with the nightly's message first, and the port-in-use
  system test now applies again straight after (see the E10 notes). All 18 pass locally; the
  next nightly run is the CI check.

**Not covered by any test**

- E05 AC3 and AC4: recovery after a real reboot and a stream across a real token expiry are tested
  with the fake core and the DevHost's pretend reboot, not a rebooting machine.
- E14: the origin lock runs against the pretend firewalls in the e2e run and through a real
  `nginx -t` in the system tests, but not against Cloudflare's live API; DNS-01 waits a fixed 20
  seconds and was not run against Cloudflare. Origin CA is covered with a test-signed certificate.
- E16: direct TLS over a real network (not a Docker port mapping on loopback) and on a firewalld
  server have no automated run; firewalld rule matching is unit-tested only. `directTls.e2e.ts`
  is skipped on macOS (the DevHost's TLS 1.3 listener does not serve there).
- E10 and E11, desktop: the Websites e2e spec runs against the DevHost's simulated nginx and
  pretend CA on every OS. Real nginx and Pebble through the app are covered by the full-stack run,
  on Linux only.
- E06: the container console has no e2e test (component and adapter tests only).
- E15: the restore screen has no e2e test (the DevHost has no SSH).
- E18: the Codex image answer for Remote Desktop was not verified locally.

**Needs a VM or hardware**

None of these can run in a container on a GitHub runner, so the full-stack run does not cover them
either.

- SELinux enforcing (E03, E10 T7): `restorecon` and the SELinux booleans only run where SELinux is
  on, and the Rocky 9 container runs without it, so they are covered by unit tests only. It needs a
  Rocky VM with SELinux enforcing, which a GitHub runner without KVM cannot host.
- arm64 (E03): the linux-arm64 build cross-compiles, but no arm64 test server runs an install, and
  the full-stack run uses linux-x64 only.
- The signed release path (E03): a packaged build downloading its core from a GitHub release, and
  the CD job that publishes both architectures, attests them and embeds the manifest, first run on
  the next `v*` tag. Until then the download source is covered with a fake downloader, the publish
  script was run by hand for linux-x64 and linux-arm64, and the full-stack run installs an
  unsigned development build from `pnpm server-core:publish`.

**Proven since the last review**

- E17 AC1: `deployFullStack.e2e.ts` ran the whole story in one run, the built app against a real
  test server, on Ubuntu 24.04 (ufw) and Rocky 9 (firewalld), locally on 2026-10-03 and on
  GitHub's runners in nightly run 37116895444: install from
  the wizard, two-factor, Docker, a stack with an environment, a private pull from registry:2, a
  site with a Pebble certificate over HTTP-01 through the core's nginx, a firewall change that
  reverted by itself, and a crash loop fixed by an approved Deploy AI command. It found that
  HTTP-01 had never worked on an installed core (the ACME webroot's folders were 0700 under the
  core's `UMask=0077`, so nginx answered the CA with 404), now fixed and unit-tested.
- E12 AC3 (2026-10-03): `appStoreHttps.int.test.ts` installs WordPress from the App Store on a
  test server, puts it on a domain and issues its certificate from Pebble through nginx; curl
  gets the WordPress setup page over HTTPS, verified against Pebble's root. Passed locally; it runs
  in the nightly Ubuntu 24.04 job. It found that the install sheet named the site's upstream
  service with a space, which the core refuses, so "put it on a domain" always stopped at the
  site; fixed. It also hit the 0700 webroot folders that the full-stack run fixed.

- In CI run 37084799281 (E09), "Server core on test servers" passed: installs on Ubuntu and Rocky
  as root and with sudo, the firewall on ufw and firewalld (E13), private registries (E08), direct
  TLS behind ufw (E16) and exec and journal on Ubuntu (E09).
- E11 AC3 now has a test from alert to inbox entry. It found that the inbox titled a failed
  renewal "Alert on <server>"; the renewal, firewall rollback and Cloudflare lock alerts now have
  their own titles.
- Every Deploy screen had its visual and keyboard pass in both themes (E17 T2), with
  `deployKeyboard.e2e.ts` as the lasting check.
- E04 T11: enrollment codes have their screen since E15 (Security, Devices).
- E01, E03 AC5 and E04 were proven earlier: the Server core job in CI runs 36490352987 and
  36491482619 (E01 AC1); the DevHost, navigation and sign-in specs on Ubuntu, Windows and macOS in
  run 36647129514; all E03 and E04 system tests in run 36677124032, after time limits on every SSH
  wait, a private cgroup namespace for the test servers, and unloading the runner's AppArmor
  profile for unix_chkpwd.

## Known failures outside the Deploy work

The `[e2e]` run for dc698a8 (CI run 36501786157) is red because of end-to-end specs that predate
the Deploy epics and touch none of their code. The matrix had not run since those features
landed, so nothing caught them earlier:

- `apiClient.e2e.ts:40` (all OSes): expects the response header `x-echo`; the table now shows
  `X-Echo`, as the server sent it.
- `settingsPersistence.e2e.ts:77` (all OSes): two buttons are named "Remove Ctrl+P", so the
  locator is ambiguous.
- macOS: the local-terminal specs (autoContinue, launchFlags, terminal, Fix with AI) never see
  "Fake Claude ready".
- Windows: a few more visibility and count assertions in the same run.

Still failing in the E04 runs (36647129514 through 36677124032), none of them Deploy code:

- All OSes: `apiClient.e2e.ts:40` and `settingsPersistence.e2e.ts:77`, as above.
- macOS: the local-terminal specs above, plus `windowState.e2e.ts:99` and `worktrees.e2e.ts:44`
  (`workspaceSearch.e2e.ts:33` failed once too).
- Windows: `browser.e2e.ts:115`, `lastPage.e2e.ts:85`, `windowState.e2e.ts:81` and
  `worktrees.e2e.ts:44`.

The same set was still failing in the E09 run (37084799281), and nothing else: Ubuntu only
`apiClient.e2e.ts:40` and `settingsPersistence.e2e.ts:77`; Windows those two plus
`browser.e2e.ts:115`, `windowState.e2e.ts:81` and `worktrees.e2e.ts:44`; macOS those two plus
the local-terminal specs (autoContinue, launchFlags, terminal, testsPanel Fix with AI),
`windowState.e2e.ts:99` and `worktrees.e2e.ts:44`. No Deploy spec failed on any OS there (the
Docker and macOS TLS ones skip where they cannot run).

The Deploy-related specs pass: `deploy.e2e.ts` (DevHost health, sign-in with two-factor) and
`navigation.e2e.ts` on every OS, and `sshAiTask.e2e.ts` on Ubuntu (the only runner with Docker).
Left for the owner of those features.

## Open blockers

None.
