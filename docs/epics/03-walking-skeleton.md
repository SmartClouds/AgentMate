# E03 Walking skeleton: install and see the server

Milestone: M1 Foundations. Depends on: E01, E02.

## Goal

From the new Deploy section a user picks a saved server, installs the core over SSH, and sees a
live health card. Every layer exists end to end: UI, IPC, installer, release artifact, systemd
service, Unix socket, tunnel and REST.

## Tasks

- [x] T1 Deploy nav item (new `Rocket` icon via `makeIcon`) after Pipelines, lazy route `/deploy`,
  added to `e2e/navigation.e2e.ts`.
- [x] T2 Server rail: servers from the Remote section with a status per server (not installed,
  connecting, online, offline) and an "Install core" call to action.
- [x] T3 Pure install plan (`main/deploy/bootstrap/installPlan.ts`): ordered steps with commands per
  OS family and architecture, fully unit tested.
- [x] T4 Preflight over SSH: os-release (supported matrix), architecture, systemd, free disk,
  sudo mode (root, passwordless, password), `AllowStreamLocalForwarding`/`AllowTcpForwarding` via
  `sshd -T`, existing install detection.
- [x] T5 Installer: create group `agentmate`, add the SSH user to it, place the verified binary under
  `/opt/agentmate-core/releases/<version>`, `current` symlink, directories with modes, systemd unit
  with the hardening options, `restorecon` on SELinux systems, start, wait for health. After the
  group change the pooled SSH connection is reset because membership only applies to new logins.
- [x] T6 Binary source: packaged builds download the release asset for their own version and check
  it against the embedded `server-core-manifest.json` hash before anything runs; dev builds upload a
  local `dotnet publish` through SFTP.
- [x] T7 `agentmate-core bridge`: stdio to the Unix socket, used when stream-local forwarding is
  disabled.
- [x] T8 Transport: one socket-shim Duplex (adds the no-op socket methods `ws` and `http` expect)
  behind a custom `http.Agent#createConnection`; a small REST client over `node:http` typed with
  the generated DTOs, and the SignalR connection with the TypedSignalR hub proxy, both using it.
- [x] T9 Upgrade keeps the previous release; if the new one fails its health check the symlink goes
  back and the service restarts on the old release. Uninstall (keep or delete data).
- [x] T10 Install wizard UI: preflight results, step timeline with live progress, errors with a
  plain explanation and a retry.
- [x] T11 Health card: core version, OS, architecture, uptime of the core.
- [x] T12 CD: `build-server-core` job (linux-x64 and linux-arm64 self-contained single-file,
  ReadyToRun, tar.gz and `.sha256`, `server-core-manifest.json`), desktop builds embed the manifest,
  the release job attaches the assets.
- [x] T13 DevHost (`apps/server-core/src/AgentMate.ServerCore.DevHost`) with fake platform state and
  a dev-only loopback transport that packaged builds refuse, so e2e runs on Windows and macOS.
- [x] T14 Fixtures: systemd plus sshd test-server images in `apps/server-core/test-servers/`
  (ubuntu-24.04, debian-13, rocky-9), a root login and a non-root user whose sudo asks for a
  password.

## Fixtures

- systemd plus sshd test servers (T14): used by installer integration tests now and by system and
  e2e tests in later epics. The full OS matrix runs nightly.

## Acceptance criteria

1. On a fresh ubuntu-24.04 and rocky-9 test server, the app goes from "not installed" to a live
   health card, both as root and as a non-root sudo user whose sudo prompts for a password.
2. A binary whose hash does not match the manifest is rejected before it is executed.
3. With stream-local forwarding disabled on the server, the bridge fallback connects.
4. An upgrade to a broken release rolls back to the previous one automatically.
5. The Deploy page and install wizard pass their component tests in every state (loading shimmer,
   empty, error, success), and the navigation e2e reaches Deploy.

## Implementation notes

- **Where it lives.** Main process: `main/deploy/bootstrap/` (OS matrix, preflight, install plan,
  release source, installer), `main/deploy/connection/` (socket shim, transports, REST client,
  SignalR connection), `main/deploy/service.ts` and `main/deploy/state.ts` (the app's record of
  each server's core, in `userData/data/deploy.json`), `main/ipc/deploy.ts` (main window only,
  arguments checked) and `main/deploy/index.ts` (Electron wiring). Renderer: `pages/DeployPage.tsx`,
  `components/deploy/`, `stores/deploySetupStore.ts` (an install keeps its progress when the page
  is left) and `lib/deploy/setup.ts`. Shared data types: `shared/deployTypes.ts`.
- **T4, tunnels.** The preflight probes a stream-local tunnel instead of reading `sshd -T`, which
  needs root and misses per-user `Match` blocks and `authorized_keys` restrictions. OpenSSH turns
  down a forbidden stream-local tunnel with the same "open failed" (reason 2) as a tunnel to a
  socket that is not there, so the probe is only certain when a server says "prohibited". The
  install settles it: once the socket exists, a refused tunnel means sshd forbids it and the
  health check goes through the bridge, which becomes the recorded transport. `health()` does the
  same later if sshd changes, and updates the record. Found by the system test with
  `AllowStreamLocalForwarding no`.
- **T5, order.** Preflight (read-only) and root access come first; a sudo password is checked on
  its own before anything is uploaded. The checksum step exits with its own code (97) so a failed
  copy never reads as tampering. Health is checked after cleanup, which keeps the previous release;
  a failed start or health check switches back to it (a reinstall of the same release has nothing
  to go back to). Leftovers the cleanup cannot remove are reported but do not fail an install that
  is running. The staging folder is removed as the login user whatever happens.
- **T6, sources.** Packaged builds read `server-core-manifest.json` from their resources and
  download the matching asset from the release for their own version (at most five reconnects).
  Development builds use `pnpm server-core:publish <rid>` output, found by walking up from the app
  path, so `electron-vite dev` and a build folder both work. `AGENTMATE_SERVER_CORE_ARTIFACTS`
  overrides the folder.
- **T6, the server downloads it instead.** The release is public, so a packaged build's source
  also names the asset's address (`remote`), and the preflight tries it from the server (a HEAD
  request through GitHub's redirect, with curl and then wget, as the login user). A server that
  answers downloads the tarball itself into the same staging folder an upload would use, and
  checks its SHA-256 there; the app downloads and uploads nothing (about 63 MB per install, which
  is slow from a home connection). The root `verify` step is unchanged and checks the file again
  after the copy into the root-only folder, so a server-side download is trusted no more than an
  upload. If the probe says no, or the download fails or does not match on the day, the install
  falls back to the app's download and upload, and the `fetch` step says why. Development builds
  have no address and always upload. `serverDownload.ts` holds the commands; the real-shell test
  there runs them with a stand-in curl and wget, and the same commands were run once against the
  v1.60.0 release on GitHub with its published checksum.
- **T9.** Removing the core with its data also deletes the `agentmate` group.
- **T13.** The DevHost serves the real core (health for now) on loopback; fake platform, Docker and
  nginx state arrive with the epics that need them. The app lists it only when not packaged and
  `AGENTMATE_DEPLOY_DEV_CORE` names its port; it cannot be installed on or removed.
- **SSH exec fix.** A command that finishes at once can have its exit status parsed in the same
  burst as the exec reply, before the listener exists; the status was then lost (an install step
  would have read as failed). The exit status is now also taken from `close`.
- **Evidence.** `deploy.int.test.ts` (with `AGENTMATE_SYSTEM_TESTS=1`) installs on fresh Ubuntu
  24.04 and Rocky 9 servers as root and as a password-sudo user, refuses a tampered download,
  rolls back a release that will not start, and connects through the bridge. `deploy.e2e.ts`
  shows the DevHost online on every OS. The whole flow was also driven by hand in a built app in
  both themes against an Ubuntu test server.
