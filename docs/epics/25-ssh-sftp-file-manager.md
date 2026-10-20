# E25 SSH SFTP file manager

Milestone: standalone (Remote). Depends on: E23 (SFTP additions to `SshConnection`, coded
`[files:*]` errors).

## Goal

Open a saved SSH server as a two-pane file manager, the way FileZilla and WinSCP do: this
computer on the left, the server on the right, a transfer queue at the bottom. Files and whole
folders go both ways with progress, speed and time left, and can be cancelled and retried. A file
that is already at the target is never overwritten without an answer (Overwrite, Skip or Keep
both, with apply to all). Permissions show as a column and change in a dialog, and a remote text
file can be edited in Monaco and saved back atomically. The page opens from the server's row in
Remote, from the terminal drawer of an SSH tab, and from the command palette.

## Tasks

- [x] T0 Contracts and scaffolding: `shared/sftpTypes.ts` (with the `SftpBridge` interface),
  `shared/sftpNames.ts`, four new `[files:*]` codes, the `IPC.sftp` block, `SftpFileClient` and
  `SftpPool`, an in-memory fake client and pool with one contract suite, the fake SFTP session
  pulled out of `connection.test.ts`, and the props contracts of the dialogs and the queue.
- [x] T1 Open a session and list both sides: `sftpListDetailed` (mode, links, broken links,
  longname), owner and group from the longname, local places and listings, the local write
  sandbox, error mapping, remote path input (`~`, relative, `..`), the service with its
  self-healing browse lease, IPC with input checks, preload, and the page with both panes.
- [x] T2 Upload and download one file with progress: optional upload hash, a streamed
  `downloadFile` through a `.part` file, the rate meter, safe local names, the transfer engine
  (3 at a time, coalesced snapshots, cancel, retry, one automatic retry on a fresh connection),
  the queue events, and the Transfers card.
- [x] T3 Folders, multi-select and drag and drop: local and remote walks that never descend into
  a linked folder, folders made before their files, selection with Ctrl and Shift, and drops
  between panes, onto folder rows and from the OS.
- [x] T4 Conflicts: the engine parks a file and pauses its batch while others run, Overwrite,
  Skip and Keep both with apply to all, the conflict kept in the snapshot across a reload, and
  the "This file already exists" dialog.
- [x] T5 New folder, rename and delete on both sides: recursive delete as an engine job that
  unlinks links instead of following them, local deletes to the Trash with a permanent fallback,
  inline name fields, the delete confirm with type to confirm for shallow folders, context menus.
- [x] T6 Permissions: octal and grid helpers, recursive chmod (all, files, folders) that skips
  links, the stat and chmod channels, and the Properties dialog.
- [x] T7 Edit a remote text file: read with the 2 MB, NUL and UTF-8 checks and the BOM kept,
  write through a temp file that keeps the mode and refuses a file changed on the server unless
  forced, and the editor dialog.
- [x] T8 Entry points: Files on each saved server row (after the vault unlock), the drawer button
  for SSH tabs of a saved server, and "Open SFTP files" in the command palette.
- [x] T9 Integration, e2e, docs and coverage: the contract suite and round trips against real
  OpenSSH in Docker, `sshFiles.e2e.ts`, the Help article, this file and the status rows, and the
  coverage floors.

## Acceptance criteria

- AC1 The Files button in the SSH tab, the drawer button and the palette all open a dual-pane
  manager. A locked vault asks for the passkey, and an unknown or changed host key asks the user
  to trust it.
- AC2 Files and folders transfer both ways with progress, rate and time left. Transfers can be
  cancelled and retried, run at most 3 at a time, and keep running when the user leaves the page.
- AC3 An existing target asks Overwrite / Skip / Keep both, with apply to all. Nothing is
  overwritten without an answer.
- AC4 New folder, rename, recursive delete (after confirmation) and refresh work on both sides.
  Local deletes go to the Trash.
- AC5 There is a permissions column, and a Properties dialog with octal and grid editing and an
  optional recursive apply.
- AC6 Text files up to 2 MB can be edited in Monaco. Saves are atomic and keep the file's mode.
  A file that changed on the server is never silently overwritten.
- AC7 No secret reaches the renderer. Every channel validates its input and answers only the main
  window. Recursive operations never follow links. Names from the server cannot write outside the
  chosen local folder.

## Implementation notes

- Two connections per session. Browsing shares the pooled connection the terminal and Deploy
  use; transfers open a separate one on first use and close it 30 s after the queue drains, so a
  2 GB upload never holds up a listing.
- The browse lease heals itself: it is acquired again when the connection is closed, and a
  "connection closed" failure is retried once. After 10 minutes with nothing going on and no
  transfers the lease is released, but the session stays.
- Sessions outlive the page and a reload. The renderer store is global and keyed by server, `open`
  for the same window and server returns the session it already has, and `queue` hands back the
  snapshot, so a pending conflict comes back after a reload. A session closes on Disconnect, when
  its window goes away or crashes, when its server is removed, or at quit.
- `sftpListDetailed` is new (mode, link flag, broken links, longname). `sftpList` keeps its shape,
  since Deploy depends on it.
- The upload hash is optional now and the result carries the hash. The engine compares the local
  file's size and time before and after a transfer and fails it with `localChanged` when they
  differ. Deploy still sends its hash and is unaffected.
- `downloadFile` mirrors `uploadFile`: 16 reads in flight, positional writes to
  `<target>.agentmate-<8 hex>.part`, fsync, the server's time set on the file, then a rename. A
  stall or an abort removes the `.part` file and leaves the target as it was.
- Errors reuse the `[files:*]` codes, with `exists`, `changedOnServer`, `tooLarge` and `notText`
  added. `[ssh:*]` tags pass through and a locked vault comes back as `[ssh:vault-locked]`, so the
  host key prompt and the unlock flow work as they do for terminals.
- Main logic is written against `SftpFileClient`, a slice of `SshConnection`, with an in-memory
  fake for unit tests. One contract suite runs against the fake and against real OpenSSH in
  Docker. There is no in-process SFTP server.
- A conflict is checked just before each file goes. The file is parked and its batch pauses while
  other batches keep running; one conflict is shown at a time, and apply to all sets the batch's
  policy. Escape or closing the dialog skips that one file.
- The queue sends one coalesced snapshot per session about every 100 ms: batch summaries, the
  running items, and at most 50 failures per batch.
- Delete and recursive chmod are engine jobs, with the same progress, cancel and failure list as
  transfers.
- Links are leaves in every recursive walk: delete unlinks the link itself, chmod skips links, and
  transfers follow links to files but skip links to folders and report them as skipped.
- Local writes are sandboxed. Each window keeps the last 32 folders its local pane listed, and a
  local write (new folder, rename, delete, a download's target) must land inside one of them,
  compared by real path. Upload sources can come from anywhere, since the OS can drop any file.
- Remote edit happens in a full-size dialog with Monaco loaded lazily, up to 2 MB. A NUL byte in
  the first 8 KB or invalid UTF-8 means not text, and a BOM is kept. A save checks that the size
  and time still match what was opened (`changedOnServer` unless forced), then writes through
  `uploadFile` with the file's mode and hash. SFTP version 3 times have whole-second resolution,
  so a change in the same second that keeps the size is missed; the Help article says so.
- Double-click or Enter on a file transfers it to the other pane, as FileZilla does (WinSCP opens
  it instead; this could become a setting). Edit is in the context menu, and nothing is opened
  with the OS.
- Entry points only navigate. The page's store wraps `open` in the host key trust flow and handles
  a locked vault itself; the server row's Files button also goes through the vault unlock first.
- With several entries selected, the Properties dialog leaves a mixed bit as each entry has it, so
  Apply sends one chmod per mode that comes out rather than one for all.
- Built test-first by parallel agents in one worktree against one contract
  (`shared/sftpTypes.ts`, `IPC.sftp`, `components/sftp/contracts.ts`).

## Known limits and follow-ups

- About 512 KB is in flight per round trip. On high-latency links `DOWNLOAD_READS_IN_FLIGHT` may
  need to go up.
- `.agentmate-*.part` files are visible on the server while an upload runs. Quitting in the middle
  of a transfer can leave one behind, on the server or in the local folder, because the quit does
  not wait for the cleanup. A quit warning (the service already counts `runningTransfers()`) or a
  sweep of stale `.part` files next to a target is a follow-up.
- `localChanged` is only noticed after the upload has replaced the server's copy, so the server
  then holds the torn file; the error says so and a retry sends it again. Checking before the
  final rename needs a pre-commit hook in `uploadFile`.
- Deleting a big tree over SFTP is slow. An `rm -rf` fast path through exec is a follow-up, since
  SFTP-only accounts have no shell.
- The changed-on-server check misses a change made within the same second that keeps the size.
- Dragging files out of the app onto the OS desktop is out of scope.
