# E15 Security center and maintenance

Milestone: M4 Security and operations. Depends on: E13.

## Goal

One place to see how safe a server is and fix it, plus the maintenance a long-lived install needs:
users, devices, audit, core updates and backups.

## Tasks

- [x] T1 Users and roles (Owner only), devices and sessions with revoke, enrollment codes.
- [x] T2 Audit viewer with filters, export and chain status.
- [x] T3 Security checklist with a score and previewed one-click fixes: firewall on, SSH password
  login off (only when key login for this app is proven), root login policy, automatic security
  updates, pending reboot, exposed ports, certificate health, core up to date.
- [x] T4 Core update from the app over SSH (verified binary, previous release kept, automatic
  rollback on a failed health check).
- [x] T5 Passphrase-encrypted backup and restore of the core database and settings.

## Acceptance criteria

1. No checklist fix can lock the app out of the server (tested per fix against the test servers).
2. A failed core update rolls back and the app reconnects.
3. A backup cannot be restored without its passphrase, and a restored core keeps working.

## Implementation notes

- **Where it lives.** Server core: `Hubs/CoreHub.Users.cs` and `Contracts/UserContracts.cs`, with
  the audit filters in `CoreHub.cs`. Desktop main process: `main/deploy/security.ts` (users,
  devices, sessions, codes, audit, export), `main/deploy/auditExport.ts`,
  `main/deploy/auth/enrollmentCode.ts`, `main/deploy/bootstrap/coreGroup.ts`, the
  `redeemEnrollmentCode` method of `service.ts`, and the `deploySecurity` IPC group in
  `main/ipc/deploySecurity.ts`. Renderer: `components/deploy/security/`, mounted as the Security
  section of a server (`?view=security`, `ServerSections.tsx`), and `RedeemCodeDialog`.
- **T1, users.** Hub methods for Owners: `ListUsers`, `CreateUser`, `SetUserRole`,
  `SetUserDisabled`, `ResetUserPassword` and `DeleteUser`; every change needs a step-up. Each
  change runs in one BEGIN IMMEDIATE transaction that checks again that the caller is still an
  Owner and that the core keeps one, so two Owners demoting each other at the same moment cannot
  leave it with none. An Owner cannot disable, remove or reset their own account. Disabling is
  Identity's lockout until the end of time plus a new security stamp, so no migration was needed;
  sign-in tells a disabled account from a locked one. Role changes, disables, resets and removals
  close the user's open hub connections, since a connection keeps the roles it was opened with.
  The transaction is handed to EF from outside, so a refusal rolls it back explicitly: disposing
  EF's wrapper would keep the write lock until the connection closed, and the audit append that
  follows waited out the 30 second busy timeout (the first test run found it).
- **T1, devices, sessions and codes.** The existing device and session methods, plus
  `RevokeOtherSessions` (account self-service, added to the Viewer pin on purpose). Ending all
  other sessions and removing a user take typed confirmation, which the shared confirm dialog
  now offers (`typeToConfirm`). An Owner mints a code from a user's row; it is shown once with
  its expiry. Redeeming one needs no sudo: the app makes a device key, sends the public half with
  the code and the password to `POST /api/v1/auth/enroll` over the tunnel, seals the private
  half like an SSH enrollment and signs in. On a server whose core another computer installed,
  the app first reads the preflight as the login user and settles the transport with a health
  check. The core's socket is open to root and the agentmate group only, so a login outside the
  group is told the `usermod` an admin has to run; one added since it logged in gets a fresh
  login. The join offer shows on the install panel when a core already runs there.
- **T2, audit.** `AuditQuery` gained actor (user name or id), result, time range and action
  groups (a prefix ending in a dot); events now carry the actor's and device's current names.
  The viewer pages with `nextBeforeId`, exports every match (newest 50,000 at most) as JSON or
  CSV to a file the user picks, with CSV cells that a spreadsheet would read as formulas
  escaped, and shows the chain check in words, broken or intact.
- **Evidence.** Server core: `HubUserTests` (21 cases: roles, last Owner, disable, reset,
  removal with its devices, sessions and codes, other sessions, audit filters). Desktop: tests for
  the security service, export, redemption, group check and IPC validation, and every new screen
  through its loading, empty, error and success states; `deploy.e2e.ts` signs in to the DevHost
  and finds its user, this computer, this session and an intact audit chain in the Security area.
- **T3, the checklist.** `GetSecurityChecklist` (Admin) in `Hubs/CoreHub.Security.cs`, its rules in
  `Hardening/ChecklistRules.cs` (pure, each tested on its own): firewall on, SSH password login off
  (`PasswordAuthentication` and `KbdInteractiveAuthentication`, since PAM asks for the same
  password), root signs in with a key only, automatic security updates, no reboot waiting, no
  unexpected public ports (SSH and 80/443 are expected; Docker publishing past the firewall fails),
  certificates healthy (expired, failing, or within 14 days), core up to date (the app sends the
  release it installs, so one place compares) and two-factor for every Owner. Each item has a
  weight; the score counts the items the core could judge, a warning earning half. A fact the core
  cannot read leaves its item unknown instead of failing the list. The screen is the Checklist tab
  of the Security area (`components/deploy/security/checklist/`), the default for Admins and
  Owners. The score ring has one arc per item, as long as the item weighs, filled, half filled,
  outlined or dotted by status, and every item also says its status in words.
- **T3, fixes that cannot lock the app out.** Firewall: the fix opens the Firewall section with the
  SSH preset's rules staged where the firewall lacks them, then turning it on, and E13's own review,
  lockout guard and safe apply take over (`?fix=enable-firewall`, read once by `FirewallPanel`).
  Exposed ports link to the Firewall exposure view ("make private" still waits on E13 T5). Reboot
  links to Overview. Automatic updates and certificate renewal say what they will do in a
  confirmation and reuse `SetAutomaticSecurityUpdates` and `RenewCertificate`. Core version opens
  the install panel in update mode. Two-factor opens the existing dialog for the signed-in Owner.
  SSH (Owner, step-up): the core writes its own `/etc/ssh/sshd_config.d/00-agentmate.conf` (sshd
  takes the first value, and every supported distribution includes that folder at the top). Two
  guards must agree: the app refuses when the saved server logs in with a password, and the core
  reads sshd's journal (`journalctl -o json -t sshd -t sshd-session -t sshd-auth`, the syslog files
  as a fallback) for the "Accepted ..." line of the very connection the call came over (found
  through the socket peer, as the firewall does) and refuses anything but `publickey`, before
  anything is written. The preview and the apply go over a brand-new SSH connection opened with the
  key alone. Order: save the old drop-in, arm a transient systemd timer (`agentmate-core
  ssh-revert`), write, `sshd -t`, `sshd -T` to see the settings really take, then `systemctl reload
  ssh|sshd`; any failure puts the old file back at once. Keeping the change needs another new
  connection that signed in with a key after the change. Root login is only ever restricted to
  keys, never turned off. Change sets are files in `ssh-hardening/` under the state folder (no
  migration), with the firewall's create-once decision file; a background monitor reverts one
  whose timer did not fire.
- **T4, core update.** Already possible from the health card through the E03 installer (verified
  release, previous release kept, rollback on a failed start or health check). New: the checklist
  shows the running and the available version and opens the update, and a failed update now resets
  the server's lasting connection so the app reconnects to whichever release runs
  (`DeployService.runInstall`).
- **Core update without SSH (added 2026-10-25).** The Server core card shows "Core X is available"
  when this build has a newer core, and its menu has "Update the core" next to "Update or reinstall
  over SSH". The update goes through the core (hub `UpdateCore`, Owner with a step-up): the core
  downloads the GitHub release asset named by the app, refuses anything that is not the manifest's
  size and SHA-256, unpacks it under `/opt/agentmate-core/releases` and schedules the switch from a
  transient unit (`agentmate-coreupdate-*`) three seconds later. That unit swaps the symlink,
  restarts, and goes back to the previous release when the new one is not active five seconds
  after its start. A failed download is an outcome, and the app then uploads the tarball over
  `PUT /api/v1/core/update` on the same connection. Older cores (no hub method or route) and cores
  not run from `/opt/agentmate-core/current` answer in a way the app turns into `needs-ssh`, and the
  page hands over to the SSH installer. Code: `Updates/CoreUpdater.cs`,
  `Updates/CoreInstallation.cs`, `apps/desktop/src/main/deploy/coreUpdate.ts`,
  `components/deploy/CoreUpdatePanel.tsx`. Not yet tried against a real server.
- **T5, backups.** `CreateBackup` (Owner, step-up) makes a `.tar.gz` of a `VACUUM INTO` copy of the
  database, the Data Protection keys and the stacks' files (sites and certificates live in the
  database; job logs and change sets stay out), with a manifest inside. It is encrypted on the
  server (`Backups/BackupCrypto.cs`): PBKDF2-HMAC-SHA256 with 600,000 iterations and a random salt,
  then AES-256-GCM in 1 MB chunks (the STREAM construction: a random nonce prefix, the chunk number
  and a last-chunk flag, with the header as associated data), so a changed byte, a moved, dropped
  or added chunk, a cut file or a header asking for fewer iterations all fail. The app asks where
  to save first, streams the file over REST (`GET /api/v1/backups/{id}`, Owner), checks its SHA-256
  and deletes the server's copy; one nobody downloads goes after an hour. The passphrase is never
  stored, logged or audited.
  A restore runs over SSH as root, so it also works for a core nobody can sign in to (offered on the
  Security area's sign-in view) and on a new server once the core is installed there. `admin
  restore-stage` (passphrase on stdin) decrypts, unpacks through the safe extractor and checks the
  backup beside the running core, refusing a newer schema; it ends every session in the copy
  (devices stay), closes firewall change sets it was waiting on and starts the copy's audit trail
  with `admin.restore`. Only then does the app stop the core, swap the state folder (the old one is
  kept, root only, at `/var/lib/agentmate-core-restore/previous`), start it and check its health,
  going back to the old state if any of that fails. Then it enrolls this computer as the backup's
  Owner the user named and signs in. The restore takes typed confirmation of the server name.
  `restore-stage` first refuses while a firewall or SSH change on the target server waits to be
  kept (a change folder under `firewall/` or `ssh-hardening/` without a decision file, a firewall
  one only while its change set is not settled, since one whose timer never armed changed
  nothing). The swap would take the snapshot its rollback timer needs, so the change could stay in
  place. The refusal names each change and says to keep or revert it first (`Backups/RestoreGuard.cs`,
  tested in `RestoreGuardTests`).
- **IPC.** New group `deployHardening` (checklist, previewSsh, applySsh, confirmSsh, revertSsh,
  onSshProgress, createBackup, pickBackup, restore, onRestoreProgress). A restore names its file by
  the token the open dialog handed out, never by a path.
- **Evidence.** Server core: `Hardening/` tests (sshd -T and journal parsing, the drop-in, the
  revert program, every checklist rule, and the hub: roles, step-up, refusal over a password login
  with nothing written, an sshd that refuses or ignores the drop-in, keeping only over a new key
  login, a change nobody keeps reverting by itself) and `Backups/` tests (format round trip and
  tampering, archive contents, a newer schema refused, hub to file to `admin restore-stage`, the
  restored state opening what the old core sealed). Desktop: unit tests for hardening, backups,
  restore and its plan, the service, the IPC group and the streamed download; RTL for the
  checklist, its SSH dialog and banner, backups and restore, and the firewall fix.
  `security.e2e.ts` scores the DevHost, applies and keeps the SSH fix after a step-up, and saves an
  encrypted backup. `security.int.test.ts` (AGENTMATE_SYSTEM_TESTS=1, Ubuntu 24.04): over a password
  login password login stays on and nothing is written (both guards); over a proven key login it
  goes off, a password is then turned away while the key still gets in, and a change nobody keeps
  is reverted by its timer. A backup made on one server restores onto another, which then signs in
  as the first server's Owner.
- **Left and unverified.** The system test runs on Ubuntu 24.04 only; Rocky 9 (sshd-session, the
  `sshd` unit) and Debian 13 (OpenSSH 10) are covered by fixtures of their output, not by a run.
  sshd `Match` blocks that turn passwords back on for some users are not looked at. The restore
  screen has no e2e run (the DevHost has no SSH); the system test covers the restore itself. After a
  restore, apps are not redeployed and nginx is not applied by themselves; the screen says so. No
  visual pass in both themes yet.
