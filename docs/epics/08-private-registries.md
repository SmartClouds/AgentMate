# E08 Private registries

Milestone: M2 Docker, apps and AI. Depends on: E07.

## Goal

Private images (GitHub Container Registry first, then Docker Hub and custom registries) pull during
a deploy without the user typing anything on the server, and without leaving a token behind.

## Tasks

- [x] T1 GitHub packages token flow: open GitHub's new-token page pre-filled with `read:packages`,
  paste, verify scopes through `X-OAuth-Scopes`, store as a `SecretEnvelope`.
- [x] T2 Optional use of the `gh` sign-in token (`gh auth token`) behind an explicit warning about
  its repo and workflow scopes, with a scope check and a `gh auth refresh -s read:packages` helper.
- [x] T3 Per-deploy registry auth: the token travels with the deploy request, lands in a tmpfs
  `DOCKER_CONFIG` for that job only, and is wiped in a `finally`; job logs and audit are redacted.
- [x] T4 Stored credentials on the core (Data Protection encrypted, write-only through the API) for
  unattended pulls, with a clear "stored on this server" label.
- [x] T5 Docker Hub and custom registry credentials (username and token).
- [x] T6 UI: registry settings, per-app registry choice, scope problems shown with the fix.

## Acceptance criteria

1. After a deploy, successful or failed, no registry token remains on the server's disk (system
   test searches the filesystem and the job directory).
2. A token without `read:packages` is refused with a guided fix.
3. Stored credentials are unreadable without the Data Protection keys (test reads the raw row).

## Implementation notes

Server core:

- `Registries/`: `RegistryNames` (hosts as the docker CLI matches them, Docker Hub's names all
  become docker.io), `RegistryCredentials` (stored credentials, Data Protection purpose
  `Runova.Registries.Credential.v1`, one row per registry, migration `Registries`) and
  `RegistryAuthFolders` (the per-job DOCKER_CONFIG). Hub: `DeployStackWithRegistries` and
  `RollbackStackWithRegistries` (Operator), `ListRegistryCredentials` (Operator),
  `SaveRegistryCredential` and `DeleteRegistryCredential` (Admin and a step-up). The old
  `DeployStack` and `RollbackStack` stay, so the app uses them when it has no sign-in to send
  and a core from before E08 still deploys public images.
- The sign-ins a deploy brings stay in the job's memory. Once the validate step knows which
  registries the images come from, stored credentials fill in for the rest (all of them when a
  service builds, since base images can come from anywhere), and the lot goes into
  `<runtime>/registry-auth/<job>/config.json` (folder 0700, file 0600, written with the mode, no
  credential helpers). Pull, build and up get `DOCKER_CONFIG` through `--setenv`, which carries
  only the path. A `finally` at the end of the job zeroes and deletes the folder, whether the job
  succeeded, failed or was cancelled, and a start-up sweep removes anything a core that died
  mid-job left. On a server the core refuses to write there unless `/proc/self/mountinfo` says
  it is a tmpfs (the RuntimeDirectory is); `Core:RegistryAuthOnDisk=allow` lets the DevHost and
  the tests use a plain folder.
- The job's redactor is seeded with each secret and with the base64 `user:secret` form docker
  writes. The audit entry for a deploy carries only the registry hosts. `RegistryAuth` and
  `SaveRegistryCredentialRequest` print without their secret, and SignalR's debug logging (which
  prints invocation arguments) is held at Information.
- Containers screen: `ImagePullRequest` takes an optional `Auth`; the engine gets it as
  X-Registry-Auth, so nothing touches the disk. Without one the stored credential for the
  image's registry is used.
- DevHost: a pretend private registry, `registry.runova.test` (user `devhost`, token
  `devhost-registry-token-4417`). The simulated compose and the pretend engine refuse its images
  without a matching sign-in, read from the DOCKER_CONFIG the way the docker CLI reads it.

Desktop:

- `main/deploy/registry/`: sign-ins in `registries.json`, sealed with the Servers vault (they move
  with a passkey change), one per registry. GitHub tokens are checked with one `GET /user` as the
  token: `X-OAuth-Scopes` says what it can do. A token without read:packages (or
  write:packages) is refused with the fix, fine-grained tokens are refused before any call (GHCR
  does not take them), and anything broader than read:packages is saved only with the warning
  accepted. The gh sign-in comes from `runGh(['auth', 'token'])` and always needs the warning;
  when it lacks the scope the dialog offers `gh auth refresh -h github.com -s read:packages` to
  copy (gh asks the browser for the new scope, so it runs in a terminal) and a check again.
- `DeployStacks.deploy` and `rollback` read the revision's compose file from the server, work out
  the registries its pulled images come from and send the matching sign-ins. A locked passkey
  stops the deploy with the reason instead of letting the pull fail on the server.
- UI: Apps > Registries (`&view=apps&registries=1`) with the sign-ins on this computer and the
  ones stored on the server (labelled as such, write-only, Admin with step-up), the New App review
  and the app page show which sign-in goes with the deploy for each registry, and the app page has
  the per-app switch to stop sending this computer's sign-ins.

Acceptance criteria:

1. Core tests (`Registries/RegistryDeployTests`) prove the sign-in is in the job's config.json
   while the pull runs and that afterwards, for a deploy that succeeded and one that failed, no
   file under the data and runtime folders (database and WAL, job logs, stacks, keys) holds the
   token or its base64 form; nor do the job log, the audit trail, the command lines or the hub's
   answers. The system test `apps/desktop/src/main/deploy/registries.int.test.ts` (gated by
   RUNOVA_SYSTEM_TESTS=1, a job in the `[e2e]` CI run) pulls from a registry:2 with htpasswd on
   Ubuntu 24.04 and greps the whole filesystem and the core's journal after both deploys.
2. A token without read:packages is refused with the fix (`github.test.ts`, `service.test.ts`,
   the RTL tests of the token and gh dialogs).
3. `RegistryCredentialTests` reads the raw row: the secret is not in it, a key ring other than the
   core's cannot unprotect it, and the core's own can.

Left: the App Store (E12) installs do not deploy through stacks yet, so they pick these up when
that integration lands. The registry sign-ins have had no visual pass in both themes.

