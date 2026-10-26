# E28 Server backups

Milestone: standalone (Deploy). Depends on: E15 (backups and restore of the core), E06 and E07
(Docker and stacks), E13 (firewall), E14 (Cloudflare), E27 (the volume helper container).

## Goal

A Backups section on every Deploy server. A backup holds the whole server: the panel's database
and keys, its settings, the stacks, every Docker volume, the images in use (so a restore never
waits on a registry), standalone containers and the firewall rules. Backups are made on demand (and downloaded to this
computer) or on a schedule, encrypted with a secret key only the user knows, and sent to several
destinations at once: a folder on the server, FTP or FTPS, SFTP, Google Drive, OneDrive and a
Telegram account. Each plan keeps the last N backups on each destination and deletes older ones.

A restore is one action. It goes back onto the same server, or onto a new server with a new
address, in which case everything that named the old address is moved to the new one: firewall
rules, sites, Cloudflare DNS records, the direct TLS certificate, stack files and this computer's
own records of the server.

## Design

- **The core owns backups.** Schedules have to fire with the app closed, so making, encrypting,
  uploading, pruning and listing all run in the core. The app owns the screens, OAuth sign-in,
  the Telegram login screens, downloads to this computer and the restore wizard.
- **Jobs run on Hangfire** (`Hangfire.Core`, `Hangfire.AspNetCore`, `Hangfire.Storage.SQLite`), in
  `<data>/hangfire.db`, kept apart from `core.db` so a restore never swaps it. No dashboard is
  mapped. A plan is a recurring job `backup-plan:<id>`; at start the core reconciles them with the
  plans in `core.db`. Each destination's upload is a continuation with its own retries, so one
  failing destination does not hold up the others. Our own run rows keep the history the screens
  show, and every run is in the audit trail.
- **The secret key is never stored on the server** (format 2 in `Backups/BackupCrypto.cs`). The core
  keeps a key ring (`Backups/BackupKeyRing.cs`): an ECDH P-256 key pair whose private half is
  sealed with the secret (PBKDF2-HMAC-SHA256, 600,000 iterations, then AES-256-GCM, bound to the
  public key). Each backup gets a random content key wrapped to the public key (ECDH with a fresh
  ephemeral key, HKDF-SHA256, AES-256-GCM), then the E15 chunked AES-256-GCM. The sealed private
  key travels in every backup's header, so the secret alone restores a backup onto a bare server.
  Changing the secret reseals the same key pair; backups made before keep the secret they were
  made under. Format 1 (passphrase) backups still open.
- **Volumes are copied live.** Nothing is stopped while a backup runs. A database that is busy at
  that moment may restore inconsistent, and the screens say so.
- **Destinations** implement one contract (test, upload, list, open, delete). A backup lands as
  `runova-<server>-<yyyyMMdd-HHmmss>-<id>.ambackup` (or numbered `.partNNN` parts) with a
  plaintext manifest beside it that holds no secret. Telegram takes parts of 2000 MiB, or 4000 MiB
  on a Premium account. Retention only ever deletes backups whose manifest names the plan, and only
  after an upload succeeded.
- **Google Drive and OneDrive** use the user's own OAuth client (no Runova registration), signed in
  from the app over a loopback redirect with PKCE. The core keeps the refresh token sealed with
  Data Protection. **Telegram** uses the user's own account over MTProto (WTelegramClient), with
  their own `api_id` and `api_hash`; the session is sealed with Data Protection.

## Tasks

- [x] T0 Contracts, hub stubs, generated TS, the data model and its migration, this file and the
  status rows.
- [x] T1 Format 2: key ring, sealed private key, per-backup content key; format 1 still opens.
- [x] T2 Parts and manifest: splitting and joining, SHA-256 of each part.
- [x] T3 Retention planner and the preview the plan screen shows.
- [x] T4 Hangfire: SQLite storage, the plan scheduler, reconcile at start.
- [x] T5 The full backup: core data, volumes through the helper, images, standalone containers,
  firewall rules and addresses.
- [x] T6 Destinations: a folder on the server, FTP and FTPS, SFTP.
- [x] T7 Destinations: Google Drive and OneDrive.
- [x] T8 Destination: Telegram, its login and part sizes.
- [x] T9 The backup run: compose, upload to each destination, retention, history, audit.
- [x] T10 Restore from a destination or a file onto the same server, with rollback.
- [x] T11 Moving to a new address: planner and applier.
- [x] T12 Desktop main: service, IPC, preload, OAuth loopback, the restore wizard, this computer's
  records of the server.
- [x] T13 Renderer: the Backups section, its tabs, dialogs and wizard.
- [x] T14 End to end and system tests.
- [x] T15 Help article, README, status and risks.

## Acceptance criteria

- AC1 An Owner sets a secret key once. Without it no backup can be made, and the screens say a
  lost secret means no restore.
- AC2 "Back up now" sends a backup to the chosen destinations, or downloads it to this computer.
- AC3 A plan runs on a schedule (every N hours, daily, weekly, or cron, in a chosen time zone) with
  the app closed, to every destination it names.
- AC4 Each plan keeps its last N backups on each destination; the plan screen shows how many will
  be kept and about how much space they take. Nothing a plan did not make is ever deleted.
- AC5 A backup larger than Telegram allows arrives as several parts and restores from them.
- AC6 A restore onto the same server brings back the panel, its settings, the stacks and their
  volumes, and starts what was running.
- AC7 A restore onto a new server with a new address does the same, then moves every setting that
  named the old address and lists any DNS it could not change.
- AC8 Every backup, upload, deletion and restore is in the audit trail; no secret is ever logged.

## Known limits

- Volumes are copied live; a busy database may restore inconsistent.
- Google Drive and OneDrive need the user's own OAuth client.
- DNS outside Cloudflare is listed for the user to change, not changed.
- A server without the tzdata package (Ubuntu's minimal image, for one) knows only UTC, so a plan
  in any other zone is refused with that reason.
- A destination that refuses is tried again after 30 seconds and 5 minutes, so a run with one
  stays Running (that destination "Retrying") for about 6 minutes before it is Partly failed.

## End to end and system tests (T14)

- `apps/desktop/e2e/deployServerBackups.e2e.ts` drives the section against the DevHost: secret key,
  a folder, a Telegram account signed in with its code (a wrong code first), a destination that
  refuses everything, a plan keeping 2 run three times (2 left on each working destination, the
  refusing one retrying without holding the others up), and a backup downloaded here encrypted.
- `apps/desktop/src/main/deploy/serverBackups/serverBackups.int.test.ts` (RUNOVA_SYSTEM_TESTS=1)
  uses the published core on two systemd test servers, each on a Docker network in the
  documentation range so the core sees a public address. The first runs a compose stack and a
  container of its own with data in volumes; a plan keeping 2 runs three times into a folder; the
  newest is fetched back by the core, downloaded, refused with a wrong secret and restored onto the
  second with the right one. Bringing it up there loads the images, writes the volumes back, starts
  the stack and the container with their data, reports the stack file that names the old address,
  and schedules the restored plan again.
- Found on the way: the run history and the plans' last run did not refresh while a run went on;
  a destination waiting to try again looked like one not tried yet; a schedule that stopped making
  sense left the preview loading for good; the DevHost on Windows refused every IANA time zone
  (its globalization was invariant). On the real servers: an image a container ran was left out
  when it was the backup's own helper image (busybox at the same digest), so the stack and the
  container could not start after a restore; and a server with no websites failed the restore's
  Websites step for having no nginx.

## Desktop notes (T12, T13)

- **Main process.** `main/deploy/serverBackups/`: `service.ts` (`ServerBackups`, every hub call through
  `callCore`, Owner step-up on the changes, runs and fetches followed every 1.5 s, downloads ask
  where to save first and stream `GET /api/v1/backups/{id}` to a `.partial` file), `oauth.ts` (Google
  Drive and OneDrive over a `127.0.0.1` loopback with PKCE S256, 5 minute limit; the refresh token
  goes to the core and is kept in memory a few minutes only for the retry after a step-up),
  `restore.ts` (`ServerRestores`: fetch onto the server and stage it there with
  `bootstrap/restore.ts`'s new `fileOnServer`, or bring another server's backup through this
  computer; then `RunServerRestore` and the records move) and `addressMoves.ts` (saved servers,
  health checks, FTP and SFTP sites and WordPress sites that named an old address; a pinned host
  key or certificate is dropped with the move). IPC group `deployServerBackups`
  (`main/ipc/deployServerBackups.ts`, `preload/deployServerBackups.ts`).
- **Renderer.** `components/deploy/backups/`: the Backups section of a server (Owners only), with
  Overview, Backups, Plans, Destinations, Secret key and Restore tabs. `useStepUp` also answers
  `[core:stepUpRequired]`. The backup's firewall rules reach the Firewall section through
  `lib/deploy/firewall/restoredRules.ts` and `?fix=restore-rules`, which stages the missing ones and
  opens the usual review. Help: `shared/help/articles/deploy-server-backups.md`.
