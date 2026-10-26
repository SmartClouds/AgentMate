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
- [x] T10 Status bar: `SftpTransfersSegment` with the count, percent, direction and the "Needs
  your answer" state, its panel (rows with progress and cancel, Answer, Open file manager, Show in
  panel), the `transferSummary` helpers, and "file transfers" as a keep-awake reason.
- [x] T11 Dock: the `'sftp'` kind of terminal drawer tab (`sftpServerId`), `lib/sftp/dock.ts`
  (one tab per server, the drawer raised to a usable height), `SftpDockPane` with the "Shown on
  the page" placeholder, and the compact variant of the view.
- [x] T12 Pop-out window: `main/sftp/window.ts`, the `popOut`, `backToMain` and window control
  channels with their sender checks, the `#/sftp-window` route with its own title bar and hosts,
  and the view switch buttons.
- [x] T13 Multi-owner sessions: `owners` as a set of webContents ids, `addOwner`, `removeOwner`,
  `adoptSessions` and `dropOwner`, events to every live owner, and `SftpConflictHost` once per
  window instead of a dialog in the queue.

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
  chosen local folder. Since the follow-up, a registered SFTP pop-out window is answered too.
- AC8 Transfers stay visible and controllable from any page, from the dock and from a separate
  window, and switching between the page, the dock and the window never interrupts them.

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
  its last window goes away or crashes, when its server is removed, or at quit.
- `sftpListDetailed` is new (mode, link flag, broken links, longname). `sftpList` keeps its shape,
  since Deploy depends on it.
- The upload hash is optional now and the result carries the hash. The engine compares the local
  file's size and time before and after a transfer and fails it with `localChanged` when they
  differ. Deploy still sends its hash and is unaffected.
- `downloadFile` mirrors `uploadFile`: 16 reads in flight, positional writes to
  `<target>.runova-<8 hex>.part`, fsync, the server's time set on the file, then a rename. A
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

## Use it from anywhere (follow-up)

A big transfer can take a long time, so the file manager had to be usable without sitting on its
page. Leaving the page never disconnected (sessions and the engine live in main), so the gap was
seeing and steering transfers from elsewhere. Three ways were built: a status bar item, a dock in
the terminal drawer and a pop-out window.

- F1 One session, many views. A session holds `owners: Set<number>` (webContents ids) instead of
  one owner. `own()` passes for any member, queue and finished events go to every live member, and
  `open(owner, server)` returns the session when the caller is already a member. `dropOwner(id)`
  takes one window out and disposes a session only when its set is empty. The page, the dock and
  the pop-out are views of the same session, and Disconnect from any of them ends it for all.
- F2 Pop-out like the RDP session windows. `sftp:popOut(sessionId)`, main window only, opens or
  focuses one `BrowserWindow` per session in `main/sftp/window.ts`. The window is added as an owner
  right after it is created and before its page loads, so the page's own `open` gets the same
  session back. On `close` its sessions are handed to the main window with `adoptSessions`, then
  on `closed` it is dropped as an owner. `backToMain` does the same hand-over, focuses the main
  window on `/ssh-files/<id>` and closes the pop-out. Window controls (minimize, maximize, close)
  and the maximized state go through channels that act on the asking pop-out only. The pop-outs
  close with the main window and at quit.
- F3 The view is pulled out. `components/sftp/SshFilesView.tsx` takes `serverId`, `variant`
  (`'page' | 'dock' | 'window'`) and a `viewActions` slot drawn in the server pane's title row
  before Disconnect. `SshFilesPage` is a thin wrapper with the header.
- F4 One conflict host per window. `SftpConflictHost` is mounted once in the app shell and once in
  the pop-out route, and `QueueArea` no longer renders the dialog. It asks about the server the
  user picked with `requestAnswer` (the status bar's Answer button), else the first one waiting,
  so a page plus a dock on the same server never stack two modals. The dialog names the server
  ("On <name>"). With the main window and a pop-out on one session, both can show the question;
  the first answer counts, and a late one gets "That conflict is no longer waiting for an answer."
- F5 Status bar item. `SftpTransfersSegment` sits between the run and terminal items, built on
  `PopSegment` like the Docker item, and is hidden while nothing runs and nothing waits. The bar
  shows the direction, "N transfers" and the percent of bytes, or "Needs your answer" in the
  warning tone with a pulsing dot. Queue snapshots land every 100 ms with fresh objects, so both
  selectors return a JSON string of what is drawn and an unchanged bar does not render again. The
  panel lists each active batch per server (label, bar, progress, rate, cancel), an Answer button
  for a waiting conflict, and the "Open file manager" and "Show in panel" links. `BUSY_LABEL`
  gained `sftp: 'file transfers'`.
- F6 Dock as a terminal drawer tab of kind `'sftp'` with `sftpServerId`. One tab per server
  (docking again focuses it), titled with the nickname. `openSftpDock` raises the drawer to 45% of
  the window, at least 380 px and never above the drawer's maximum, and a taller drawer keeps its
  height. The tab has no shell: closing it just closes the view and the session stays, it is not
  persisted, and the Terminals count leaves it out. The compact variant has a one-row pane toolbar,
  tighter rows, no Permissions or Owner columns, and the Transfers card folded to one line. While
  the route is `/ssh-files/<same server>` the tab shows "Shown on the page" with a "Show the page"
  button instead of a second copy of the view.
- F7 View switch buttons (`SftpViewSwitch`) in the server pane's title row. The page has "Show in
  panel" and "Open in a new window", and both then go back to where the user was (Remote when the
  page was the first entry). The dock has "Open as page" and "Open in a new window", and both close
  the tab. The window has "Back to main window"; once the session there is gone the title bar
  offers it instead, since the pane's title row goes with the session.
- F8 Pop-out route `#/sftp-window?server=<id>&theme=<mode>`, outside the app shell next to
  `rdp-session`. It mounts its own toaster, confirm host, host key dialog host and conflict host
  (the vault unlock comes with the view), and draws a title bar with the server's name, its login
  and the window controls. The theme comes from the hash and is applied once. The IPC guard lets
  a registered SFTP window through as well as the main window; `popOut` itself answers only the
  main window, so a pop-out cannot pop out again, and its own channels answer only pop-outs.
- F9 Entry points stay as they were: the Files button, the drawer button of SSH tabs and the
  palette open the page, and the page offers the switch.

## Known limits and follow-ups

- About 512 KB is in flight per round trip. On high-latency links `DOWNLOAD_READS_IN_FLIGHT` may
  need to go up.
- `.runova-*.part` files are visible on the server while an upload runs. Quitting in the middle
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
- The main window and its pop-outs join one session per server, but only once it is open. Two of
  them connecting to the same server at the very same moment can still end up with two sessions.
  When the pop-out then closes, a busy session is handed to the main window anyway (nothing
  running is lost) and an idle one ends.
- The "transfer finished" toast is decided per window: watching a transfer in the pop-out, the
  toast can still appear in the main window, which shows no view of that server.
- A main window reloaded while a pop-out is open only hears about sessions handed back to it once
  its store has connected to some server again.
- A pop-out keeps the theme it opened with. Changing the theme in the main window does not reach
  it until it is opened again.
- The pop-out has no status bar of its own, and it cannot pop out again.
- The dock leaves out the Permissions and Owner columns; Properties in the context menu still
  shows them.
