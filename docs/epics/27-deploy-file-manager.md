# E27 Deploy file manager

Milestone: standalone (Deploy). Depends on: E06 (Docker in the core), E25 (the SFTP file manager,
its engine and its UI).

## Goal

A Files section on every Deploy server, the same two-pane manager as E25 (this computer on the
left, the server on the right, transfers at the bottom) with a source picker: the server's own
disk over SFTP, a container's file system, or a Docker volume. Files and folders go both ways with
progress, conflicts and cancel, from any page. A database dump can come out of a volume, an
uploads folder can go into one, and a config file in a container can be edited in place.

The container drawer and the Volumes tab open it straight on that container or volume.

## Design

- The E25 renderer, store, service and transfer engine are reused as they are. A Docker target
  has a file manager id of its own (`shared/fileTargets.ts`), and the main process routes those
  ids to a `DockerFileClient` that implements `SftpFileClient` against the server core.
- The core does the work through the Docker Engine API, never through host paths:
  - Listing in a running container with a shell is one exec of a fixed `sh` lister (`stat -c`,
    names ended by NUL). Without a shell, or in a stopped container, it is a scan of the archive
    API's tar, cut short past a byte cap (the listing says so).
  - Downloads are the archive API's tar of one file, unwrapped on the core and streamed as plain
    bytes over REST. Uploads are wrapped into a one-entry tar on the fly, owned like the folder
    they land in, written under a `.part` name and moved into place when there is a shell.
  - Rename, delete and chmod are execs with the paths as arguments, never through a shell string.
  - A volume is mounted at `/data` in a helper container (busybox, pinned by digest, no network),
    which gives it a shell and confines every path to the volume. Paths are shown from `/`. The
    helper is reused per volume, removed after 5 minutes idle, and swept at core start. It is
    `busybox@sha256:bdf57e52...` (1.37), and it is left out of the Containers list.
  - Links inside a volume are resolved by the core one name at a time: an absolute link starts at
    the volume's root and `..` stops there, so no link reaches the helper's own files. Containers
    keep the kernel's rules.
- Admins only, like the console. Every download and change is in the audit trail.

## Tasks

- [x] T0 Contracts and scaffolding: `Contracts/FileContracts.cs` and the hub methods (stubs),
  regenerated TS contracts, `SftpSessionInfo.kind`, `capabilities` and `limitation`,
  `shared/fileTargets.ts`, this file and the status row.
- [x] T1 Core: lister output parser and path rules.
- [x] T2 Core: one-entry tar writer and unwrap.
- [x] T3 Core: engine exec (no TTY), archive stat, get and put, helper containers.
- [x] T4 Core: the files service (capabilities, both listings, uploads through `.part`, helper
  reuse, idle removal, sweep, audit) and the in-memory engine's file trees for the DevHost.
- [x] T5 Core: hub methods and the REST transfers, Admin only.
- [x] T6 Core: system tests against real Docker (alpine, debian slim, distroless, a volume).
- [x] T7 Desktop: `DockerFileClient` passing the E25 client contract, error mapping, abort,
  stall and progress.
- [x] T8 Desktop: the routing pool, Docker targets in `findServer`, kind and capabilities in
  `open`, sessions closed with the server.
- [x] T9 Desktop: the contract suite against a real DevHost core.
- [x] T10 Renderer: actions gated by capabilities, the partial listing banner.
- [x] T11 Renderer: the Files section with its source picker and states.
- [x] T12 Renderer: Browse files in the container drawer and the Volumes tab.
- [x] T13 `deployServerFiles.e2e.ts` against the DevHost.
- [x] T14 Help article, coverage floors, this file and the status row.

## Acceptance criteria

- AC1 Every Deploy server has a Files section. Its source picker offers the server's disk (when
  the server is reached over SSH), each container and each volume, and the choice is kept in the
  URL.
- AC2 In a running container with a shell and in any volume: list, upload, download (files and
  folders, with progress, conflicts, cancel and retry), new folder, rename, delete, chmod and edit.
- AC3 In a stopped or shell-less container: list, upload, download and new folder work; rename,
  delete, chmod and edit are off with the reason shown.
- AC4 Uploaded files are owned like the folder they land in. With a shell, an upload appears all
  at once (written under a temporary name, then moved).
- AC5 Only Admins can open a session; others see why. Every download and change lands in the
  core's audit trail.
- AC6 No path can reach outside the container or the volume, and no file name reaches a shell.
- AC7 The container drawer and the Volumes tab open the Files section on that target. Transfers
  stay visible from the status bar, the dock and the pop-out, as in E25.

## Known limits

- A volume whose driver Docker cannot mount in the helper cannot be browsed.
- Listing a very large folder in a stopped or shell-less container is partial.
- Without a shell, uploads are written in place, not atomically, and links are only partly
  described (a broken link is not spotted, and only links to a sibling folder count as folders).
- With user namespace remapping, uploaded files keep the uid the tar entry carries.
