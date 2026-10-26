# E23 FTP and SFTP sites

Milestone: standalone (Deploy). Depends on: E02 (SSH foundation), E19 patterns (sync planner,
local walk, ignore rules).

## Goal

Deploy a plain site or web app to any host that offers SFTP, FTPS or FTP. A site is a local
deploy folder, a server login and a folder on the server. Runova watches the local folder,
lists what changed since the last deploy (added, modified, deleted), and sends only that after
the user reviews it. Before anything is sent, the server folder is compared with what the last
deploy left there, so a file someone changed on the server is never overwritten without a
choice. A site can be attached to one or more projects, and each of them shows it in its own
Deploy tab. An optional Deploy on save switch sends changes on its own after a quiet period.

## Tasks

- [x] T0 Delivery docs: this file, the ROADMAP row and the status row.
- [x] T1 Shared ignore rules (`core/deploy/ignoreRules.ts`, the WordPress rules now a wrapper) and
  the file-site path policy: the hard deny list without `php.ini` and `.user.ini`, a default
  ignore list, `.runovaignore` and the site's own patterns.
- [x] T2 Drift judge: a server file compared with what the last deploy saw there, by size and
  modified time from the same source, size only when the time cannot be compared, and the
  whole-hour clock shift detected.
- [x] T3 Sync planner: upload, delete on the server, adopt or conflict for each path, judged
  from this computer, the last deploy and the server.
- [x] T4 First deploy over a folder that already has files: skip same-size files or overwrite.
- [x] T5 Shared types and coded errors (`shared/deployFilesTypes.ts`,
  `shared/deployFilesErrors.ts`).
- [x] T6 Site store (`deploy-files.json`): checked records, sealed secrets in the Servers vault,
  folder rules for the local and remote folder.
- [x] T7 Bases with an append-only journal (a run that stops keeps what it finished), and run
  history.
- [x] T8 A deleted project is unlinked from its sites; the sites stay.
- [x] T9 `RemoteFiles` interface, an in-memory server for tests, and one contract suite every
  transport passes.
- [x] T10 SFTP additions to `SshConnection`: mkdir, unlink, rmdir, stat, chmod and a streamed
  upload with a hash check, site file modes and fallbacks for servers without the OpenSSH
  extensions.
- [x] T11 SFTP transport, for a server saved in Remote or a login of the site's own.
- [x] T12 FTP and FTPS transport (basic-ftp): one task at a time, MLSD or MDTM times, certificate
  checks with an explicit pin for a self-signed certificate.
- [x] T13 Test connection: log in, find the folder, write, replace and remove a probe file, and
  learn how changes on the server can be detected.
- [x] T14 Local walk of a deploy folder with a hash cache, links refused and every left-out path
  reported.
- [x] T15 Folder watcher (debounced, polling on Linux and after a Windows overflow).
- [x] T16 Changes service: the live list of pending changes for each site.
- [x] T17 Deploy on save: a quiet period, one run at a time, never a conflict or a mass delete
  on its own.
- [x] T18 Plan: list only the folders the plan needs on the server, then judge each file.
- [x] T19 Run: folders, uploads, deletes and clean-up, with progress, cancel and resume.
- [x] T20 Service facade with a busy lock per site.
- [x] T21 IPC channels with input checks; no secret ever crosses them.
- [x] T22 Wiring in main and preload.
- [x] T23 Renderer hooks, messages and the run store.
- [x] T24 The FTP and SFTP sites group in the Deploy rail.
- [x] T25 Add and edit site dialog with Test connection, a remote folder browser and the
  project picker.
- [x] T26 Site view: Changes (review, conflicts, first deploy, progress), History and Settings.
- [x] T27 The project's Deploy tab with its badge.
- [x] T28 FTP test server image (ProFTPD with FTPS and mod_sftp, vsftpd with LIST only).
- [x] T29 Integration tests against real servers in Docker.
- [x] T30 e2e: add a site, deploy, change, conflict, Deploy on save and the project tab.
- [x] T31 Help article, implementation notes and status.

## Acceptance criteria

- AC1 Only changed files travel, and the review lists them before anything is sent.
- AC2 A file is deleted on the server only if a previous deploy uploaded it and it is unchanged
  there, or you chose to delete it in the review; a file that is only on the server is never
  touched.
- AC3 A change made on the server is never overwritten without an explicit choice.
- AC4 A password or key passphrase never reaches the renderer, and moves with a passkey change.
- AC5 A failed or cancelled run resumes without sending the finished files again.
- AC6 Deploy on save never resolves a conflict or deletes many files on its own.

## Implementation notes

- Three views meet in the planner: the local folder (hashed), the base (what the last deploy
  sent, plus what the server reported for each file right after it arrived) and the server as
  listed now. A server file is judged against what the server itself said before, never against
  this computer's clock: size and time compare only when the time came from the same source
  (`sftp`, `mlsd` or `mdtm`), and by size alone otherwise, marked unverified. A shift by the same
  whole number of hours on every changed file is a clock or DST change, not edits.
- Only the folders a plan needs are listed: the parent of every changed path, deleted ones
  included, so a deletion is judged rather than guessed. On a LIST-only FTP server the time is
  asked per file with MDTM, up to 500; above that the plan says it judged by size.
- FTP has no transactions, so the base moves forward file by file through an append-only journal,
  folded at the end of a run and at startup. The live changes list reads the base with the
  journal applied in memory (`peekBase`), so a walk during a deploy never folds the journal under
  it.
- An upload goes to `<name>.runova-<8 hex>.part` and takes the real name only when its hash
  matches, so a failure, a cancel or a file edited mid-upload leaves the old file. On SFTP a cancel
  counts only until the rename is sent; after that the upload finishes and is recorded, or the next
  plan would take Runova's own file for someone else's (found by the Docker integration test).
- A server that cannot rename onto an existing file gets the old file moved aside first
  (`<name>.runova-<8 hex>.old`), the new one renamed in, and the backup deleted. A refused
  second rename puts the backup back, so the live file is never gone; a later run deletes or
  restores any backup it finds.
- A review can be up to 10 minutes old, so the run stats every path once more right before it
  writes or deletes it, and a file that changed on the server since stays pending as a conflict.
  A plan made while the site was being edited or forgotten is never kept.
- A file deleted here is deleted on the server only when it is in the base and its folder was
  listed showing it unchanged, or when the review's conflict card says Delete. A deployed file the
  walk now leaves out (a new ignore line, too large, a link) shows under Left out and is never
  planned as a delete. Folders are removed only when Runova created them, with RMD, which
  refuses a non-empty folder.
- Deploy on save plans and deploys after a quiet period, one run per site. It stops for a person on
  a conflict, a first deploy over existing files or a mass delete (more than 20, at least 5 that
  are more than a quarter of the base, or an empty folder), and pauses on a login, key,
  certificate or locked vault failure. It never trusts a saved server's first host key on its own.
- Trust is never taken from the form. A fingerprint the dialog sends after Test connection is read
  from the server again before it is saved, and an own SFTP login with no trusted key is only
  probed, never sent the password. An FTPS pin is checked on the control connection before the
  password, and on every data connection; Node skips `checkServerIdentity` for a self-signed
  chain, so the pin cannot rely on it.
- A site's password sits sealed with the saved servers (`registerSealedSecretStore`), so it is
  re-sealed with them on a passkey change; the renderer only ever sees `hasSecret`.
- The local hash cache keys on size and modified time, as the WordPress walk does, so an edit
  that keeps the size and lands within the same modified-time tick is missed until the next edit.
- Built test-first by parallel agents in one tree against one contract (`shared/deployFilesTypes.ts`,
  `IPC.deployFiles`, `RemoteFiles`). The transport passes one contract suite against an in-memory
  server, OpenSSH, ProFTPD (FTP, FTPS pinned, mod_sftp) and vsftpd (LIST only), and
  `deploy.int.test.ts` runs plan and run against all four (24 of 24).
