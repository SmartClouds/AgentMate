# Deploy: delivery roadmap

This roadmap covers the **Deploy** section of AgentMate and the **AgentMate Server Core** that it
talks to. Deploy is an aaPanel-style server panel with one big difference: nothing is served on the
web. A small service (the core) is installed on each server, and every screen lives in the desktop
app.

The work is split into epics under [`docs/epics/`](epics/). Each epic is a vertical slice: server
core, desktop main process, UI and tests together, so `master` stays releasable after every one.
Progress is tracked in [`DELIVERY_STATUS.md`](DELIVERY_STATUS.md) and risks in
[`RISKS.md`](RISKS.md).

## Working rules

- **Test-driven.** Every task starts with a failing test that fails for the right reason, then the
  code that makes it pass, then cleanup. No test is skipped, weakened or deleted to get green.
- **Straight on `master`.** No feature branch. One commit per epic, pushed once every gate passes.
  The body of each epic's final commit carries `[e2e]` so CI runs the end-to-end matrix.
- **TypeScript 7** for everything in the desktop app and `packages/core` (the repo already uses
  `typescript@7.0.2` with the native `tsc`).
- **.NET 10** for the core, latest stable packages, versions pinned centrally.
- **No packages from Chinese authors or repackagers.** Prefer the upstream vendor's own package, or
  write the small piece in-house (this is why `.dockerignore` matching is ours).
- **Model names** only in `packages/core/src/models/catalog.ts`.
- **Copy and docs** never use the em dash character.
- **UI rules:** shimmer per card while loading (a full-page overlay only on cold start),
  `SimpleTooltip` instead of the native `title` attribute, `confirmDialog` for anything
  destructive, status never shown by color alone, reduced motion respected.

## Architecture

```
Desktop (Electron, TS 7)                                   Server (Linux + systemd)
renderer  Deploy section (React)                           agentmate-core  (.NET 10, root, unix socket)
   |  window.agentmat.deploy* (IPC, zod-validated)            SignalR /hubs/core (typed API + streams)
main      deploy/connection  ssh2 pool --streamlocal--> sshd ---> /run/agentmate-core/core.sock
          typed hub client (TypedSignalR) + small REST client, both over the SSH channel
          deploy/bootstrap   install/upgrade/repair via SSH exec + SFTP
          deploy/cloudflare  official SDK                      EF Core + SQLite, Identity, Data Protection
          deploy/assistant   shared AI loop -> StreamExec      Docker API + compose CLI, nginx, ACME,
          deploy/watcher     alerts -> inbox + OS toast        ufw|firewalld, apt|dnf, journald, SELinux
```

## Decisions

| Topic | Decision | Why |
|---|---|---|
| Core location | `apps/server-core` (.NET solution, no package.json, so pnpm ignores it) | Monorepo; the name avoids clashing with `packages/core` |
| Transport | The core listens on a Unix socket `/run/agentmate-core/core.sock` (0660, group `agentmate`; the installer adds the SSH user to the group). The app reaches it through an in-process SSH tunnel: `ssh2` `openssh_forwardOutStreamLocal`, or, when sshd disables forwarding, an exec channel running `agentmate-core bridge` (stdio to the socket). Either channel goes through one socket-shim Duplex behind a custom `http.Agent#createConnection` shared by `node:http` REST, `ws` and the SignalR client. No local listening port. Direct TLS with mTLS arrives in E16 | Zero open ports; OS permissions stop other local users and nginx before any HTTP parsing; no DNS rebinding surface |
| API style | WebSocket first: one SignalR hub (`/hubs/core`, JSON protocol) carries every request/response call and every stream (metrics, stats, logs, jobs, exec, container console, alerts) through typed `ICoreHub` and `ICoreHubReceiver` interfaces. REST minimal APIs remain only for anonymous health, sign-in (challenge, login, renew) and large uploads. JSON uses camelCase, omits nulls and writes enums as camelCase strings, so the wire matches the generated types | One protocol, typed end to end; streaming and reconnect built in |
| Identity | ASP.NET Core Identity on EF Core SQLite (users, password hashes, TOTP 2FA, recovery codes, lockout); custom auth endpoints only (no public `/register`); deny-by-default authorization fallback policy; 15-minute access tokens; roles Owner, Admin, Operator, Viewer | The password lives in the core's SQLite; no open sign-up surface |
| Device enrollment | The desktop generates a P-256 device key (private half sealed with `safeStorage`). The installer pipes the public key and the owner password over SSH **stdin** to `agentmate-core admin create-owner` and `enroll-device` (never argv). Login is a signed server challenge plus password (and TOTP); renewal is a fresh signed challenge, so no refresh secret exists anywhere. Break-glass over SSH: `admin revoke-all`, `admin reset-password` | Nothing bearer-like to intercept or replay; a copied token dies in 15 minutes; the same key later backs mTLS and command approvals |
| Privileges | The core runs as root under systemd with the hardening options that do not break its job; exposure is contained by the socket, auth, roles and a full audit trail | It administers Docker, nginx, packages and the firewall and offers root exec to the AI, so a helper split adds complexity without a real boundary |
| Platforms | Debian family (Ubuntu 22.04/24.04/26.04, Debian 12/13: apt, ufw, AppArmor) and RHEL family (RHEL, Rocky, Alma 9/10, CentOS Stream 9/10: dnf, firewalld, SELinux), x64 and arm64, behind `IPackageManager`, `IFirewallBackend` and `ISecurityModule` | Both families from day one; pluggable keeps later distros cheap |
| Docker | `Docker.DotNet.Enhanced` 4.3.x (the Testcontainers fork, Engine API 29) over `/var/run/docker.sock`; the `docker compose` CLI for stacks (argument lists only, never shell strings). Docker Engine from `download.docker.com` with the GPG fingerprint pinned | Maintained client; compose has no Engine API |
| Compose apply | The app uploads compose, the rendered `.env` and an optional build-context tarball; the core keeps revisions and writes an override file that replaces proxied services' ports with `127.0.0.1` bindings using compose's `!override` tag (a plain override appends, which would keep the public binding) | Published ports bypass the host firewall; user files stay untouched |
| Container exposure | Controlled at publish time instead of in `DOCKER-USER` (which conflicts with firewalld's docker zone and does not exist under Docker's nftables backend). AgentMate stacks bind to loopback by default; anything public goes through nginx (HTTP sites, or `stream` TCP/UDP proxies with optional IP allowlists), where the host firewall applies. An exposure inventory flags containers still publishing on `0.0.0.0` or `::` and offers a one-click "make private" redeploy | Works the same on every firewall backend, no third-party scripts |
| TLS certificates | In-house ACME v2 client (RFC 8555 plus ARI, RFC 9773) on BCL crypto, tested against Let's Encrypt's Pebble; HTTP-01 through an nginx webroot, optional DNS-01 through a zone-scoped Cloudflare token; Cloudflare Origin CA and uploaded certificates as alternatives | .NET ACME libraries are stale or were only just revived; Let's Encrypt is moving to 45-day certificates and recommends ARI for renewal timing |
| Cloudflare | Desktop main process with the official `cloudflare` SDK 7.x; the token sits in the existing `SecretEnvelope`, its permissions are checked and shown, and the app guides the user to a minimally scoped token. A server only receives a separate zone-scoped `DNS:Edit` token when the user opts into DNS-01. Proxied sites can be locked to Cloudflare: the firewall allows 80/443 only from Cloudflare's published ranges (refreshed daily), nginx restores the real client IP, and Authenticated Origin Pulls are optional | Zones are account-level; the broad token stays off servers; origin bypass is blocked |
| Private registries | Default: a packages-only GitHub token (a classic PAT with just `read:packages`; the app opens GitHub's new-token page pre-filled and verifies `X-OAuth-Scopes`), kept in the app's secret envelope. The `gh` sign-in token is allowed only after an explicit warning, because it carries repo and workflow scopes. Either way the token travels per deploy into a tmpfs `DOCKER_CONFIG` that is wiped in a `finally`; an optional stored credential (Data Protection encrypted) covers unattended pulls | A compromised server must not become a compromised GitHub account |
| Firewall | ufw (Debian family, `IPV6=yes`) or firewalld (RHEL family) backend; an SSH lockout guard using `sshd -T` plus the live `SSH_CONNECTION` port; "apply, confirm over a new SSH connection, or roll back", where the rollback is a transient systemd timer so it fires even if the core dies | Safety first |
| Deploy AI | Reuse the SSH AI loop (`apps/desktop/src/main/agents/sshTaskRunner.ts`): the same RUN/FINISHED/NEEDS_INPUT protocol, approval flow, and CLI or Settings-provider choice. The loop gets a pluggable command executor, and a new executor runs through the core's `StreamExec` hub stream. Deploy modes: "approve every command" (default) and "auto-run diagnostics", where only a strict read-only allowlist (a single simple command without shell metacharacters, such as `docker ps`, `docker logs`, `docker inspect`, `systemctl status`, `journalctl`, `df`, `free`, `ss -tlnp`) runs unattended. There is no fully autonomous mode, because pattern blocklists can be bypassed with base64 or eval. The core itself refuses any non-allowlisted AI command unless it carries a device-signed approval over the exact command text and a nonce. Output is redacted (stack env values, token shapes) before it reaches the model, and logs enter prompts as delimited untrusted data | Proven UX; exit codes come back directly; prompt injection from logs cannot run anything destructive unattended |
| Protocol types | Tapper and TypedSignalR.Client.TypeScript (pinned local dotnet tool) generate the TypeScript DTO types and a typed hub client straight from the C# contracts into `apps/desktop/src/shared/deploy/protocol/generated/` (Bundler resolution, because the generator emits extensionless imports). CI regenerates and fails on any diff. OpenAPI generators were rejected: `openapi-typescript` and `@hey-api/openapi-ts` need the TypeScript 5 compiler API, which TypeScript 7 does not ship, and Kiota's TypeScript models make every field optional | One source of truth across C# and TypeScript, strict types, TS 7 only |
| WordPress sites (E19) | A plugin, AgentMate Connector, installed from wp-admin; paired with a one-time key (15 minutes, read or write) that carries the site's Ed25519 public key; every request signed by a per-site desktop key (sealed with the Servers vault) over a canonical string with the bundle's hash, a timestamp and a nonce; every reply signed by the site key. One wire format for every call: `POST multipart/form-data` with `am_auth` and a gzip `bundle`, over `/wp-json/`, `?rest_route=` or admin-ajax. Plain HTTP only by a per-site opt-in | Many WordPress sites have no SSH or FTP; Ed25519 works on any WordPress through its bundled `sodium_compat`; the wire format survives header-stripping hosts and firewalls that flag PHP in request bodies |
| WordPress deploys (E19) | Staged in a data folder the web server never serves, PHP syntax checked with `token_get_all(TOKEN_PARSE)`, every touched file snapshotted, applied with temp files and renames, health checked against a baseline, rolled back on failure. A guard mu-plugin rolls back at a deadline or on a fatal error in a changed file and answers rescue routes before other plugins load; `rescue.php` is the last resort | A deploy must never leave a site down with no way back in, since there is no SSH to fix it |
| WordPress exclusions (E19, E21) | The project folder keeps the site's layout and only linked items are walked; a hard deny list (agent folders, AgentMate's own files, agent instruction files, `.mcp.json`, secrets, PHP config, version control) is enforced by the desktop and again by the plugin; a default ignore list leaves local clutter out unless the site already has it; the user's `.distignore` and `.agentmateignore` apply both ways | Agent settings, skills and AgentMate's files must never reach a site |
| Release | CD builds self-contained single-file `linux-x64` and `linux-arm64` binaries (ReadyToRun, not AOT, since EF Core and Identity need reflection) as tar.gz plus SHA-256. A manifest with the hashes is embedded into the desktop build, so the app only installs a core it can verify. Core updates are pushed from the desktop over SSH, never fetched by the core itself | Supply-chain safety without key management |

Versions to pin (re-check when each package is first added): .NET SDK 10.0.4xx, ASP.NET Core, EF
Core and Identity 10.0.12, xunit.v3 4.x on Microsoft.Testing.Platform, Docker.DotNet.Enhanced
4.3.x, Testcontainers 4.x, Verify.XunitV3, TypedSignalR.Client.TypeScript 1.17 (generator and
attributes), Tapper 1.14 (attributes), `@microsoft/signalr` 10.0.x, `cloudflare` 7.x, `yaml`
(eemeli), `tar` (npm's own).

## Server core at a glance

- **Install layout:** binary `/opt/agentmate-core/releases/<version>/agentmate-core` plus a
  `current` symlink (the previous release is kept for rollback); config
  `/etc/agentmate-core/core.json` (0600); data `/var/lib/agentmate-core/` (0700: `core.db`, `keys/`,
  `stacks/`, `sites/`, `acme/`, `jobs/`, `backups/`); logs to journald; unit
  `agentmate-core.service` with `Restart=on-failure`, `UMask=0077`, `LimitCORE=0`,
  `ProtectKernelModules`, `ProtectKernelLogs`, `ProtectClock`, `LockPersonality` and
  `RuntimeDirectory=agentmate-core` for the socket.
- **Privileged work** that spawns programs (package operations, Docker and nginx installs, reboot,
  `StreamExec` commands) runs in its own transient unit through `systemd-run --collect`, so it gets
  a normal umask and filesystem view, survives a core restart when it must, and is killed as a
  whole cgroup on cancel or timeout.
- **Persistence:** SQLite in WAL mode behind a single writer queue (`BEGIN IMMEDIATE` with a busy
  timeout) so audit appends can never fork the hash chain; timestamps stored as unix milliseconds;
  live metrics kept in memory ring buffers with periodic downsampled writes.
- **Security baseline** (enforced from E01 on, extended by each epic):
  - Unix socket only, with the stdio bridge as the fallback. No TCP listener exists until the
    opt-in direct TLS mode.
  - Host header allowlist. Any request carrying an `Origin` header is refused, because browsers
    are never clients. No CORS.
  - Kestrel header and body limits, streaming uploads with explicit caps, request timeouts.
  - The peer uid from `SO_PEERCRED` is recorded in the audit trail.
  - Deny-by-default authorization with a named policy on every endpoint and hub method, checked by
    a reflection test.
  - Every input re-validated on the server: IDNA domains, compose project and env-key patterns,
    `$` escaping in `.env`, CR/LF and `;{}`/quote rejection in anything rendered into config.
  - Audit of every mutation, exec line and auth event, append-only and hash-chained.
  - A central redactor seeded with each stack's env values runs before anything is stored or
    streamed.
  - Data Protection for stored secrets. `.env` files, private keys and the database are 0600.
  - `IProcessRunner` with argument lists only. `StreamExec` is the single shell entry point.
  - Tarball extraction rejects absolute paths, `..`, escaping links and device files, and enforces
    entry-count and size caps.
  - Bounded stream channels with backpressure.
  - Supply chain: locked NuGet restore, package source mapping, NuGet audit, pinned GPG
    fingerprints.
- **nginx:** the nginx.org stable repo (GPG pinned) on every distro; one include we own,
  `/etc/nginx/agentmate/current`, is a symlink to a numbered release directory. Apply renders a new
  release, swaps the symlink, runs `nginx -t`, reloads, or swaps back and reports the parsed
  error. Sites render HTTP-only until their certificate exists. Custom snippets pass a directive
  allowlist parser (no `include`, `load_module`, `*_log` paths, `alias` or `root` outside the site
  directory, `lua`, `perl`) and are Owner-only.
- **RHEL specifics:**
  - Before installing Docker, remove the conflicting podman, buildah and runc packages (with
    confirmation).
  - Run `restorecon` on the core binary.
  - Enable `httpd_can_network_connect` so nginx can reach its upstreams.
  - Use `semanage fcontext` plus `restorecon` for the ACME webroot and the cert directories.
  - Label non-standard listen ports as `http_port_t`.
  - The compose linter warns about bind mounts without `:z`/`:Z` while SELinux is enforcing.

## Desktop at a glance

- **SSH foundation:**
  - `main/ssh/connectConfig.ts` is shared host verification, extracted from `sessionManager.ts`.
  - `SshConnection` adds exec with exit codes and stdin, SFTP, `forwardOut`, stream-local
    forwarding and keepalive.
  - A pool keeps one connection per server.
  - sudo passwords are piped through stdin, never argv.
  - An explicit host-key-changed prompt replaces the broken "re-save to trust" flow.
- **Connection:**
  - Each server runs a state machine: not installed, connecting, authenticating, online,
    degraded, offline, needs sign-in, needs re-enroll.
  - It reconnects with backoff, renews through a signed challenge, and resumes streams after a
    reconnect.
  - The device key is stored as a `SecretEnvelope` through `main/ssh/vault.ts`.
- **IPC groups** (two-level names, contract-tested): `deploy`, `deploySystem`, `deployDocker`,
  `deployStacks`, `deployRegistry`, `deployStore`, `deploySites`, `deployCerts`, `deployFirewall`,
  `deployLogs`, `deployAssistant`, `deploySecurity`, `cloudflare`.
  - Handlers take injected services (the Vault pattern).
  - They accept calls only from the main window frame.
  - They validate input with zod schemas from `packages/core/src/deploy`.
- **Renderer:**
  - A "Deploy" nav item after Pipelines, with a server rail.
  - Each server gets a sub-nav: Overview, Apps, Containers, App Store, Websites, Firewall, Logs,
    Security.
  - Cloudflare opens as a dialog over Deploy (`/deploy?dialog=cloudflare`) because it is account-level.
  - An Assistant drawer is available on every Deploy screen.
- **Signature interactions:**
  - A server pulse header.
  - A deploy timeline with rollback.
  - A route map (domain, nginx, service port, containers).
  - A problems feed with "Diagnose with AI" and "Fix in project".
  - A security checklist with previewed one-click fixes.
  - A safe-apply countdown banner.
  - A one-screen App Store install sheet.
  - Command palette actions.

## Testing layers

| Layer | Where | What |
|---|---|---|
| .NET unit | `apps/server-core/tests/AgentMate.ServerCore.Tests` | Validators, renderers (Verify snapshots), ACME JWS/CSR, stats math, parsers over fixtures, schedulers with `FakeTimeProvider`, audit chain |
| .NET integration | same project | `WebApplicationFactory` with in-memory SQLite and fakes (`FakeDockerEngine`, `FakeProcessRunner`, `FakePlatform`); every endpoint's auth, role, validation and error paths; hub methods through a real `HubConnection` |
| .NET system | `apps/server-core/tests/AgentMate.ServerCore.SystemTests` | Linux and Docker only (Testcontainers): real Docker, `nginx -t`, Pebble, ufw and firewalld, full installs on the test servers |
| TS unit | colocated `*.test.ts(x)` | `packages/core/src/deploy`, main-process services with fake SSH and a fake core, IPC handlers through `ipcHarness`, renderer components in every state |
| TS integration | `*.int.test.ts` | SSH exec, SFTP and tunnels, and the installer against the test servers (skip without Docker) |
| e2e | `apps/desktop/e2e/*.e2e.ts` | Playwright driving the built app; grows with every epic |

Security-sensitive modules (auth, device enrollment and challenges, approvals, audit, redaction,
upload extraction, tunnel, installer verification, firewall guard) get coverage floors of 90%.

## CI

- `test.yml` gains a `server-core` job on every push: locked restore, `dotnet format
  --verify-no-changes`, build with warnings as errors, unit and integration tests, NuGet
  vulnerability audit, and a contracts drift check (regenerate the TypeScript, fail on any diff).
- A `server-core-system` job (system tests plus the desktop installer integration tests on
  ubuntu-24.04 and rocky-9) runs when the commit message carries `[e2e]`.
- A scheduled workflow runs the full OS matrix. SELinux-enforcing behavior runs in a Rocky VM when
  the runner supports KVM; otherwise it is recorded as unverified.
- `cd.yml` gains `build-server-core` (linux-x64 and linux-arm64, tar.gz, `.sha256`,
  `server-core-manifest.json`, provenance attestation). The desktop builds embed the manifest.
  Releases still only happen on `v*.*.*` tags.

## Milestones and epics

| Epic | Title | Milestone | Depends on |
|---|---|---|---|
| [E00](epics/00-delivery-docs.md) | Delivery docs | M1 Foundations | none |
| [E01](epics/01-server-core-scaffold.md) | Server core scaffold | M1 Foundations | E00 |
| [E02](epics/02-ssh-foundation.md) | SSH foundation | M1 Foundations | E00 |
| [E03](epics/03-walking-skeleton.md) | Walking skeleton: install and see the server | M1 Foundations | E01, E02 |
| [E04](epics/04-identity-and-enrollment.md) | Identity and device enrollment | M1 Foundations | E03 |
| [E05](epics/05-realtime-and-overview.md) | Realtime, jobs and server overview | M1 Foundations | E04 |
| [E06](epics/06-docker-and-containers.md) | Docker engine and containers | M2 Docker, apps and AI | E05 |
| [E07](epics/07-compose-stacks.md) | Compose stacks | M2 Docker, apps and AI | E06 |
| [E08](epics/08-private-registries.md) | Private registries | M2 Docker, apps and AI | E07 |
| [E09](epics/09-logs-problems-deploy-ai.md) | Logs center, problems feed and Deploy AI | M2 Docker, apps and AI | E07 |
| [E10](epics/10-nginx-websites.md) | nginx websites | M3 Web, SSL and app store | E07 |
| [E11](epics/11-lets-encrypt.md) | Let's Encrypt certificates | M3 Web, SSL and app store | E10 |
| [E12](epics/12-app-store.md) | App Store | M3 Web, SSL and app store | E11 |
| [E13](epics/13-firewall.md) | Firewall | M4 Security and operations | E10 |
| [E14](epics/14-cloudflare.md) | Cloudflare | M4 Security and operations | E11, E13 |
| [E15](epics/15-security-center.md) | Security center and maintenance | M4 Security and operations | E13 |
| [E16](epics/16-direct-tls.md) | Direct TLS mode | M4 Security and operations | E15 |
| [E17](epics/17-polish-full-matrix.md) | Polish and full OS matrix | M4 Security and operations | all |
| [E18](epics/18-rdp-ask-ai.md) | Ask AI for Remote Desktop | Standalone (Remote) | none |
| [E19](epics/19-wordpress-connector.md) | WordPress Connector plugin and sync engine | Standalone (Deploy) | E07 patterns |
| [E20](epics/20-wordpress-sites-in-deploy.md) | WordPress sites in Deploy | Standalone (Deploy) | E19 |
| [E21](epics/21-wordpress-projects.md) | WordPress projects | Standalone (Projects) | E19, E20 |
| [E22](epics/22-health-checks.md) | Project monitoring | Standalone (Ship) | none |
| [E23](epics/23-ftp-sftp-sites.md) | FTP and SFTP sites | Standalone (Deploy) | E02, E19 patterns |
| [E24](epics/24-error-tracking.md) | Error tracking | Standalone (Ship) | E22 |
