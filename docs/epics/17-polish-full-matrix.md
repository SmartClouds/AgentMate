# E17 Polish and full OS matrix

Milestone: M4 Security and operations. Depends on: all earlier epics.

## Goal

Prove the whole flow on every supported OS, finish the accessibility and visual pass, and document
the feature.

## Tasks

- [x] T1 Full-stack e2e on ubuntu-24.04 and rocky-9 (the other distros nightly): install, sign in
  with 2FA, install Docker, deploy a fixture project stack with an environment, pull a private image
  from a local registry, add a site with a test domain, issue a Pebble certificate, apply a firewall
  change and watch it revert, break a container and fix it through the Deploy AI with a fake CLI,
  see the problem clear.
- [x] T2 Accessibility and keyboard pass on every Deploy screen, both themes.
- [x] T3 README: a Deploy section in the features, the project structure, scripts and testing
  updates.
- [x] T4 Delivery status complete with any unverified criteria listed.

## Acceptance criteria

1. The full-stack e2e passes on ubuntu-24.04 and rocky-9.
2. Every Deploy screen is reachable and operable by keyboard alone.
3. README documents the feature and its security model.

## Implementation notes

### The full OS matrix (T1)

- `testing/testServers.ts` has `testServerImages(supported, defaults)`: each system test keeps its
  defaults on every `[e2e]` push, and `RUNOVA_TEST_SERVER_IMAGES` (comma separated) runs it on
  the asked-for images it supports instead. Unknown names fail the run, so a typo cannot skip
  everything. `skipWhenNoServers` leaves a skipped test behind when none apply (vitest fails an
  empty suite).
- Parameterized over Ubuntu 24.04, Debian 13 and Rocky 9: the install (`deploy.int.test.ts`,
  Debian added), `stacks`, `registries`, `deployExec` and `security`. The firewall tests run per
  backend (ufw, firewalld), direct TLS on ufw, the podman case on Rocky.
- `.github/workflows/nightly.yml` (schedule and `workflow_dispatch`, never a push) runs every Deploy
  system test once per test server (5 jobs, `fail-fast: false`), and a job for the server core's own
  xUnit system tests (the nginx `-t` harness and Pebble), which no workflow ran before.
- Run locally on 2026-10-03 (Docker Desktop): Debian 13 install as root and as deployer, exec,
  security, stacks and registries; Rocky 9 exec, security, stacks, registries and the podman case.
  All passed.

### The end-to-end story (T1, AC1)

`e2e/deployFullStack.e2e.ts` walks the whole story in one run. Playwright drives the built app
(the `out-e2e` build) against a systemd test server, booted the way the system tests boot theirs,
with the core from `pnpm server-core:publish linux-x64`. It is gated on `RUNOVA_SYSTEM_TESTS=1`
and Docker for Linux containers, so ordinary e2e runs skip it, and `RUNOVA_TEST_SERVER_IMAGES`
picks the server. One serial describe per server, eight tests, no retries (a retry would boot
and install everything again):

1. The server is added in Remote (the Add server form, as the `deployer` user whose sudo asks for
   the saved password), and the core is installed from the Deploy wizard with its owner.
2. Two-factor goes on with a code generated from the key the dialog shows; after signing out, the
   sign-in asks for the next code.
3. Docker is installed from Containers (the job retried up to three times, since its packages come
   over the network).
4. A project with a compose file and a Production environment (saved through the same bridge the
   Environments tab uses) deploys through the New App wizard; the env key shows, never its value,
   and the page the container serves carries the value.
5. A registry:2 with htpasswd runs on the server (`testing/privateRegistry.ts`, now shared with
   `registries.int.test.ts`); a sign-in is added under Apps, Registries, and a second revision
   pulls a worker from the private image. The token never shows on screen.
6. Websites: nginx is set up, a site for `shop.runova.test` proxies to the app, and a
   certificate is issued by Pebble over HTTP-01 against the server's own nginx. The list shows
   "SSL, 90 days" and Live, and a curl on the server gets the app's page over HTTPS with a chain
   that verifies against Pebble's root. On Rocky the HTTP preset is applied and kept first, since
   firewalld is on there.
7. A firewall change nobody keeps reverts by itself: ufw (off, as on a fresh VPS) is turned on with
   the SSH preset, firewalld gets port 8081. The step-up for it takes the password. After the
   countdown the DOM says the old rules are back, the history says rolled back, and the server's
   own `ufw status` or `firewall-cmd` agrees.
8. Stopping the web container sends the worker into a crash loop; the problems feed shows it,
   "Diagnose with AI" opens the Deploy AI, and the e2e fake model (the fake Ollama, which can now
   be given its script mid-run) proposes `docker start <web> && docker restart <worker>`. The user
   approves it, it runs, both containers run again and the crash loop leaves the feed.

What the run sets up outside the app, before the app sees the server (`e2e/fullStackServer.ts`,
`e2e/pebble.ts`):

- Pebble and pebble-challtestsrv, ported from the server core's `PebbleFixture` with the same
  images and configuration and HTTP-01 on port 80 (as `PebbleOnPort80Fixture`). They run on
  Docker's default bridge next to the test server, not on a network of their own: on GitHub's
  runners a test server joined to a second network lost its published SSH port, since its default
  route moved to the new network. The test server trusts Pebble's test CA in its system store,
  reaches the API as `pebble` (a hosts entry; Pebble's certificate names it), and
  `/etc/runova-core/core.json` sets `Core:Acme:ProductionDirectory` to it. challtestsrv is the
  test DNS: it maps the domain to the server's address.
- busybox and registry:2 are loaded from this computer into the server's Docker, since the
  server's way to Docker Hub can be slow.
- Every container is created under a random name and removed by name afterwards; the run prints
  them.

The servers are `ubuntu-24.04-ufw` and `rocky-9-firewalld`: the Ubuntu 24.04 and Rocky 9 test
servers with their firewall installed (ufw off, firewalld on), since step 7 needs one. Every step
runs against the real server; none fell back to the DevHost.

Found and fixed on the way:

- HTTP-01 had never worked on a real install. The core runs with `UMask=0077`, and
  `LocalNginxMachine` created missing parent folders under that umask, so `/var/www`,
  `/var/www/runova` and the rest of the ACME webroot came out 0700. nginx's workers (user
  `nginx`) could not reach the challenge file, and `try_files` answered Pebble with 404. Every
  folder it creates now gets its mode outright (0755 for parents, whatever the umask), with a test
  that sets umask 0077 (`LocalNginxMachineUmaskTests`, Linux only, run alone since the umask is
  process-wide). The nginx harness tests missed it because they write through `docker exec`. A
  server whose nginx was set up by an older build keeps its 0700 folders until they are changed by
  hand (no release has shipped, so no real server has them).
- The local `-ufw` and `-firewalld` images had been built from a base older than its Docker
  volumes, so Docker inside them could not mount overlays. `startTestServer` now passes those
  volumes itself, and removes the container with `-v` so anonymous volumes go with it.
- `testServers.ts` split in two: everything that starts and looks at test servers moved to
  `testServerMachines.ts`, which has no vitest import, so Playwright can load it. The old module
  re-exports it, so the system tests import it as before.

Run locally on 2026-10-03 (Docker Desktop, Windows): all eight steps passed on
`ubuntu-24.04-ufw` (21.5 minutes, most of it the Docker install) and on `rocky-9-firewalld`
(20.6 minutes). The nightly workflow runs it in its `full-stack` job, once per server.
The first nightly dispatch (37111769885, on a7e9ec1) failed at step 1 on both servers: the app
could not reach the test server's SSH port once the server had joined Pebble's network, which
Docker Desktop does not show. Pebble moved to the default bridge (see above); the rest of that
run, every Deploy system test on all five servers and the server core's nginx and Pebble tests,
passed. The next dispatch (37116895444, on 5d10c61) passed the full-stack run on both servers:
Ubuntu in 6.5 minutes, Rocky in 12.1 (most of it the Docker install). Every other job of that run
passed too, the first nightly with all eight jobs green.

### Each step on its own

The per-step specs and system tests from before stay. The specs run against the DevHost on every
OS the e2e matrix has, which the full-stack run cannot, and the system tests on every `[e2e]` push:

| Step | Against the DevHost (e2e, every OS) | On real servers (system tests) |
|---|---|---|
| Install the core | `deploy.e2e.ts` (the core online) | `deploy.int.test.ts` (Ubuntu, Rocky; Debian nightly) |
| Sign in with 2FA | `deploy.e2e.ts` | `deploy.int.test.ts` (owner, enrollment, hub) |
| Install Docker | Component tests only (the DevHost has Docker) | `docker.int.test.ts` (Rocky 9, podman replaced) |
| Deploy a stack with an environment | `deployApps.e2e.ts` | `stacks.int.test.ts` |
| Pull a private image | `deployRegistries.e2e.ts` | `registries.int.test.ts` (registry:2 with htpasswd) |
| Site with a domain and a certificate | `deploySites.e2e.ts` (pretend CA) | Server core system tests (nginx `-t`, Pebble) |
| Firewall change that reverts | `firewall.e2e.ts` | `firewall.int.test.ts` (ufw, firewalld) |
| AI fixes a broken container | `deployLogsAi.e2e.ts` | `deployExec.int.test.ts` (signed exec, journal) |

`deployLogsAi.e2e.ts` now ends the way the story does: the approved fix is
`docker restart newsletter-sender-1`, the DevHost's pretend exec restarts that container
(`FakeExecRunner`, with a core test), and the crash loop leaves the problems feed. Before, the
step ran a command the DevHost only echoed, and nothing cleared.

### Visual and keyboard pass (T2)

Every section (Overview, Apps, Containers, App Store, Websites, Firewall, Logs, the six Security
tabs) and the Cloudflare page, in light and dark, at 1440 and 960 pixels wide, with the out-e2e
build against the DevHost. A throwaway Playwright script measured text contrast against the
composited background, looked for unnamed controls, `title` attributes, em dashes and content
past the right edge, and tabbed through each screen checking for a focus ring. Found and fixed:

- Light theme contrast: white text on primary buttons was 3.7:1, and the status words in the
  success, warning and destructive colours were 2.8 to 3.9:1 on cards. The light tokens are
  deeper now (primary and ring 23%, success 22%, warning 27%, destructive 41% lightness), and
  the success and warning badges use a lighter tint in light mode. In dark, white on the
  destructive colour was 3.8:1; it now carries dark text like the other dark-theme accents.
  `themeContrast.test.ts` holds every token pair at 4.5:1 or better in both themes.
- Tabs (`components/ui/tabs.tsx`, app-wide) had no focus ring at all, on the tab or its panel.
- Five link-style buttons (sign in, step-up, install, the Deploy AI drawer) used the browser's
  default outline; they now use the ring like everything else.
- Two header buttons on every page (sidebar toggle, Ask AI) had no accessible name.
- Firewall: the facts row cut its values off ("Deny by c", "Filtered t...") and clipped the
  incoming select even at 1440 wide; the facts now wrap.
- The section strip squeezed "App Store" onto two lines and cut Security off at 960 wide; it
  scrolls sideways now.
- The floating Deploy AI button covered the last controls of a long section; the page leaves room
  for it.

No `title` attributes or em dashes were found in the Deploy screens. Shimmer, empty and error
states were already covered by each panel's component tests against the fake core.

`e2e/deployKeyboard.e2e.ts` is the lasting check for AC2: it opens every section from the strip
with Tab and Enter, tabs into it, and expects a control there with a visible focus ring; the
Security tabs are switched with the arrow keys; and no button on any of those screens is
unnamed. Fixes are asserted through the DOM in component tests (`tabs.test.tsx`,
`cards.test.tsx`, `DeployPage.test.tsx`).

### Docs (T3, T4)

README: a Deploy section (what it is, the security model in short, supported servers, trying it
with the DevHost), a Deploy line in the feature list, the Deploy layout in the project structure,
the Deploy system tests in Testing, and the nightly workflow in CI. `DELIVERY_STATUS.md` and
`RISKS.md` updated.

### What is left

- The full-stack run covers Ubuntu and Rocky only. Debian 13 has no firewall image, so it gets the
  per-step system tests nightly instead.
- What needs a VM or hardware: SELinux enforcing, arm64 and the signed release path (see the
  unverified criteria in `DELIVERY_STATUS.md`).
