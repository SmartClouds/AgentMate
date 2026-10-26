import { filesErrorCode } from '@shared/deployFilesErrors';
import { parseDockerFileTargetId } from '@shared/fileTargets';
import { isValidEntryName } from '@shared/sftpNames';
import type {
  SftpBatchFinished,
  SftpBridge,
  SftpChmodInput,
  SftpConflictDecision,
  SftpJobKind,
  SftpListing,
  SftpLocalEntry,
  SftpLocalPlace,
  SftpQueueSnapshot,
  SftpRemoteEntry,
  SftpSessionClosed,
  SftpSessionInfo,
  SftpTarget,
  SftpTextFile,
} from '@shared/sftpTypes';
import { sshErrorCode } from '@shared/sshErrors';
import { toast } from 'sonner';
import { create } from 'zustand';
import { sftpBridge } from '@/lib/sftp/bridge';
import { refusalFor } from '@/lib/sftp/capabilities';
import { DEFAULT_SORT, type SortKey, type SortState, visibleEntries } from '@/lib/sftp/entries';
import { editRefusal, sftpProblem } from '@/lib/sftp/messages';
import {
  baseName,
  joinPath,
  parentPath,
  resolveLocalInput,
  resolveRemoteInput,
  samePath,
} from '@/lib/sftp/paths';
import { EMPTY_SELECTION, reconcileSelection, type Selection } from '@/lib/sftp/selection';
import { isBatchActive } from '@/lib/sftp/transferSummary';
import { withHostKeyTrust } from '@/lib/ssh/hostKeyTrust';

/**
 * The SFTP file manager (E25), one entry per saved server. It is global and outlives the page
 * (D3): leaving and coming back finds the same folders, selection and queue, and main keeps the
 * session open. Main does all the work; this asks, keeps the answers, and turns queue events
 * into refreshed panes and toasts.
 */

export type PaneSide = 'local' | 'remote';

/**
 * Where a server's session stands. `locked`: the Servers vault holds its secret. `missing`: the
 * saved server is gone (never there, or removed while open).
 */
export type SftpStatus = 'idle' | 'connecting' | 'ready' | 'locked' | 'error' | 'missing';

export interface PaneState<E extends SftpLocalEntry | SftpRemoteEntry> {
  /** The folder shown, as main resolved it; null before the first listing. */
  path: string | null;
  parent: string | null;
  entries: E[];
  loading: boolean;
  /** Why the last listing failed. With nothing listed yet it fills the pane. */
  error: string | null;
  /** The folder that failed to list, for Retry. */
  errorPath: string | null;
  /** Main listed only part of the folder (E27, a stopped or shell-less container). */
  partial: boolean;
  selection: Selection;
  sort: SortState;
  filter: string;
  showHidden: boolean;
}

export interface ServerSummary {
  nickname: string;
  host: string;
  port: number;
  username: string;
}

export interface ServerFiles {
  serverId: string;
  /** Known before the session opens, from the saved servers, for the header and the gate. */
  server: ServerSummary | null;
  session: SftpSessionInfo | null;
  status: SftpStatus;
  error: string | null;
  local: PaneState<SftpLocalEntry>;
  remote: PaneState<SftpRemoteEntry>;
  queue: SftpQueueSnapshot | null;
  /** The remote file open in the editor. */
  editingPath: string | null;
  /** What `openEditor` read for it, so the editor starts from it without reading again. */
  editingFile: SftpTextFile | null;
  /** The remote entries the Properties dialog is about. */
  propertiesPaths: string[] | null;
  /** How many mounted pages show this server, so a finished transfer elsewhere gets a toast. */
  visible: number;
}

export type RemoveResult = { ok: true } | { ok: false; message: string };

/**
 * How a typed path went: there, failed with the reason, or overtaken by another navigation of
 * the same pane (a click, another typed path) before its listing came back.
 */
export type GoToResult =
  | { status: 'ok' }
  | { status: 'failed'; problem: string }
  | { status: 'superseded' };

interface SftpState {
  servers: Record<string, ServerFiles>;
  /** The local Places menu; null until read. */
  places: SftpLocalPlace[] | null;
  /**
   * The server whose conflict the user asked to answer (the status bar's Answer), so the
   * window's one conflict dialog asks about it first when several servers wait. It lets go once
   * that server has no conflict left.
   */
  conflictFocus: string | null;

  connect: (serverId: string) => Promise<void>;
  disconnect: (serverId: string) => Promise<void>;
  /** Lists the places (once) and opens Home in the local pane when nothing is open yet. */
  initLocal: (serverId: string) => Promise<void>;
  setPageVisible: (serverId: string, visible: boolean) => void;

  navigate: (serverId: string, side: PaneSide, path: string) => Promise<void>;
  /** A typed path. A failure answers the problem, and the pane stays where it was. */
  goTo: (serverId: string, side: PaneSide, input: string) => Promise<GoToResult>;
  up: (serverId: string, side: PaneSide) => Promise<void>;
  home: (serverId: string, side: PaneSide) => Promise<void>;
  refresh: (serverId: string, side: PaneSide) => Promise<void>;
  /** Tries the folder that failed to list again. */
  retryListing: (serverId: string, side: PaneSide) => Promise<void>;

  setSelection: (serverId: string, side: PaneSide, selection: Selection) => void;
  sortBy: (serverId: string, side: PaneSide, key: SortKey) => void;
  setFilter: (serverId: string, side: PaneSide, filter: string) => void;
  toggleHidden: (serverId: string, side: PaneSide) => void;

  /** The selected entries of `side` to the folder the other pane shows. */
  transferSelected: (serverId: string, side: PaneSide) => Promise<string | null>;
  /** `paths` of `fromSide` (or OS files, as `local`) into `targetDir` of the other side. */
  transferPaths: (
    serverId: string,
    fromSide: PaneSide,
    paths: string[],
    targetDir: string,
  ) => Promise<string | null>;

  /** Answers true once made; false (after a toast) so an inline field can stay open. */
  mkdir: (serverId: string, side: PaneSide, name: string) => Promise<boolean>;
  rename: (serverId: string, side: PaneSide, path: string, newName: string) => Promise<boolean>;
  /** Queues a delete on the server and answers its batch, or null after a toast. */
  removeRemote: (serverId: string, paths: string[]) => Promise<string | null>;
  removeLocal: (
    serverId: string,
    paths: string[],
    options: { permanent: boolean },
  ) => Promise<RemoveResult>;
  /** Rejects with the problem in words, for the Properties dialog to show. */
  chmod: (serverId: string, input: SftpChmodInput) => Promise<void>;

  /**
   * The queue controls reject with main's error, untouched, so the conflict dialog and the
   * queue say what went wrong in their own words and unlock themselves. No toast here.
   */
  resolveConflict: (
    serverId: string,
    conflictId: string,
    decision: SftpConflictDecision,
  ) => Promise<void>;
  cancel: (serverId: string, target: SftpTarget) => Promise<void>;
  retry: (serverId: string, target: SftpTarget) => Promise<void>;
  clearFinished: (serverId: string) => Promise<void>;

  /**
   * Reads the file first and opens the editor with it. A file too large or not text gets a
   * toast and no editor, so nothing flashes open and shut.
   */
  openEditor: (serverId: string, path: string) => Promise<void>;
  closeEditor: (serverId: string) => void;
  openProperties: (serverId: string, paths: string[]) => void;
  closeProperties: (serverId: string) => void;

  /** Points the conflict dialog at this server. Does nothing when it has no conflict waiting. */
  requestAnswer: (serverId: string) => void;
}

function emptyPane<E extends SftpLocalEntry | SftpRemoteEntry>(): PaneState<E> {
  return {
    path: null,
    parent: null,
    entries: [],
    loading: false,
    error: null,
    errorPath: null,
    partial: false,
    selection: EMPTY_SELECTION,
    sort: DEFAULT_SORT,
    filter: '',
    showHidden: false,
  };
}

/** A server after Disconnect, from this view or another: the gate offers Connect again. */
function disconnected(): Partial<ServerFiles> {
  return {
    session: null,
    status: 'idle',
    error: null,
    queue: null,
    editingPath: null,
    editingFile: null,
    propertiesPaths: null,
    remote: emptyPane(),
  };
}

function emptyServer(serverId: string): ServerFiles {
  return {
    serverId,
    server: null,
    session: null,
    status: 'idle',
    error: null,
    local: emptyPane(),
    remote: emptyPane(),
    queue: null,
    editingPath: null,
    editingFile: null,
    propertiesPaths: null,
    visible: 0,
  };
}

/** One empty state per server id, so a selector reading a server not seen yet stays stable. */
const EMPTY_SERVERS = new Map<string, ServerFiles>();

/** A server's state, or an empty one when nothing was kept for it yet. Reading never stores. */
export function serverFiles(state: Pick<SftpState, 'servers'>, serverId: string): ServerFiles {
  const kept = state.servers[serverId];
  if (kept) return kept;
  let empty = EMPTY_SERVERS.get(serverId);
  if (!empty) {
    empty = emptyServer(serverId);
    EMPTY_SERVERS.set(serverId, empty);
  }
  return empty;
}

/** Whether any batch of the queue is still going (a conflict waiting counts). */
export function hasRunningTransfers(queue: SftpQueueSnapshot | null): boolean {
  return (queue?.batches ?? []).some((batch) => isBatchActive(batch.state));
}

/**
 * The server whose conflict the window's one dialog asks about: the one the user picked to answer
 * while it still has a conflict, else the first by id that has one. Null when none waits.
 */
export function conflictServerId(
  state: Pick<SftpState, 'servers' | 'conflictFocus'>,
): string | null {
  const focus = state.conflictFocus;
  if (focus && state.servers[focus]?.queue?.conflict) return focus;
  const waiting = Object.keys(state.servers)
    .filter((id) => state.servers[id]?.queue?.conflict)
    .sort();
  return waiting[0] ?? null;
}

/** How long a read for the editor may take before a loading toast says it is coming. */
const EDITOR_LOADING_DELAY_MS = 300;

const KIND_TITLE: Record<SftpJobKind, string> = {
  upload: 'Upload',
  download: 'Download',
  delete: 'Delete',
  chmod: 'Permission change',
};

/**
 * Each pane's latest navigation (a new folder). An older one that comes back late is dropped,
 * and while one is loading, refreshes of whatever the pane showed before are not applied.
 */
const navTokens = new Map<string, number>();
const navInFlight = new Set<string>();
/** Each pane's latest refresh (the same folder again), so refreshes land in order. */
const refreshTokens = new Map<string, number>();

/** The bridge the queue events are subscribed on, so a replaced bridge gets subscribed again. */
let subscribedTo: SftpBridge | null = null;
let unsubscribers: Array<() => void> = [];

export const useSftpStore = create<SftpState>()((set, get) => {
  function patch(serverId: string, change: Partial<ServerFiles>): void {
    set((state) => {
      // The conflict asked about is answered once the server's queue holds none (or is gone).
      const answered =
        state.conflictFocus === serverId && 'queue' in change && !change.queue?.conflict;
      return {
        servers: { ...state.servers, [serverId]: { ...serverFiles(state, serverId), ...change } },
        ...(answered ? { conflictFocus: null } : {}),
      };
    });
  }

  function patchPane(serverId: string, side: PaneSide, change: Partial<PaneState<never>>): void {
    set((state) => {
      const current = serverFiles(state, serverId);
      return {
        servers: {
          ...state.servers,
          [serverId]: { ...current, [side]: { ...current[side], ...change } },
        },
      };
    });
  }

  const files = (serverId: string): ServerFiles => serverFiles(get(), serverId);

  function serverIdOfSession(sessionId: string): string | null {
    for (const entry of Object.values(get().servers)) {
      if (entry.session?.sessionId === sessionId) return entry.serverId;
    }
    return null;
  }

  function nickname(serverId: string): string {
    const entry = files(serverId);
    return entry.session?.nickname ?? entry.server?.nickname ?? 'the server';
  }

  /**
   * Lists `path` in a pane.
   *
   * A `navigate` goes to a folder: it supersedes any earlier load of the pane, starts with an
   * empty selection, and `inline` leaves the pane's error alone (the typed path shows it).
   * A `refresh` lists the folder the pane shows again, keeping the selection by name (or picking
   * `select`, a new folder or a rename). It never supersedes a navigation: one asked for while a
   * navigation loads is skipped, and one that comes back after the pane moved on is dropped.
   */
  async function load(
    serverId: string,
    side: PaneSide,
    path: string,
    options: { kind?: 'navigate' | 'refresh'; select?: string; inline?: boolean } = {},
  ): Promise<GoToResult> {
    const key = `${serverId}:${side}`;
    const refresh = options.kind === 'refresh';
    let token: number;
    if (refresh) {
      if (navInFlight.has(key)) return { status: 'superseded' };
      token = (refreshTokens.get(key) ?? 0) + 1;
      refreshTokens.set(key, token);
    } else {
      token = (navTokens.get(key) ?? 0) + 1;
      navTokens.set(key, token);
      navInFlight.add(key);
    }
    const navAtStart = navTokens.get(key);
    /** Whether this load's answer still counts once it is back. */
    const current = (): boolean => {
      if (!refresh) return navTokens.get(key) === token;
      const shown = files(serverId)[side].path;
      return (
        refreshTokens.get(key) === token &&
        navTokens.get(key) === navAtStart &&
        !navInFlight.has(key) &&
        shown !== null &&
        samePath(shown, path)
      );
    };

    patchPane(serverId, side, { loading: true });
    let listing: SftpListing<SftpLocalEntry> | SftpListing<SftpRemoteEntry>;
    try {
      if (side === 'remote') {
        const session = files(serverId).session;
        if (!session) throw new Error('Not connected to the server.');
        listing = await sftpBridge().list(session.sessionId, path);
      } else {
        listing = await sftpBridge().localList(path);
      }
    } catch (error) {
      if (!current()) return { status: 'superseded' };
      if (!refresh) navInFlight.delete(key);
      const problem = sftpProblem(error);
      if (options.inline) patchPane(serverId, side, { loading: false });
      else patchPane(serverId, side, { loading: false, error: problem, errorPath: path });
      return { status: 'failed', problem };
    }
    if (!current()) return { status: 'superseded' };
    if (!refresh) navInFlight.delete(key);

    const pane = files(serverId)[side];
    const sameFolder = pane.path !== null && samePath(pane.path, listing.path);
    const view = { ...pane, filter: sameFolder ? pane.filter : '' };
    const names = visibleEntries(listing.entries as never[], view).map(
      (entry: { name: string }) => entry.name,
    );
    let selection: Selection = EMPTY_SELECTION;
    if (options.select && names.includes(options.select)) {
      selection = { selected: [options.select], focus: options.select, anchor: options.select };
    } else if (refresh && sameFolder) {
      selection = reconcileSelection(pane.selection, names);
    }
    patchPane(serverId, side, {
      path: listing.path,
      parent: listing.parent,
      entries: listing.entries as never[],
      loading: false,
      error: null,
      errorPath: null,
      partial: listing.partial === true,
      selection,
      filter: view.filter,
    });
    return { status: 'ok' };
  }

  /** Lists `path` again as a refresh when the pane shows it, else goes there. */
  function reload(
    serverId: string,
    side: PaneSide,
    path: string,
    select?: string,
  ): Promise<GoToResult> {
    const shown = files(serverId)[side].path;
    const kind = shown !== null && samePath(shown, path) ? 'refresh' : 'navigate';
    return load(serverId, side, path, { kind, select });
  }

  function onQueue(snapshot: SftpQueueSnapshot): void {
    const serverId = serverIdOfSession(snapshot.sessionId);
    if (serverId) patch(serverId, { queue: snapshot });
  }

  function onBatchFinished(event: SftpBatchFinished): void {
    const serverId = serverIdOfSession(event.sessionId);
    if (!serverId) return;
    const entry = files(serverId);
    const pane = entry[event.side];
    if (pane.path && (event.target === null || samePath(pane.path, event.target))) {
      void load(serverId, event.side, pane.path, { kind: 'refresh' });
    }
    const label = entry.queue?.batches.find((batch) => batch.batchId === event.batchId)?.label;
    if (event.failed > 0) {
      toast.error(`${KIND_TITLE[event.kind]} finished with ${event.failed} failed`, {
        description: label,
      });
    } else if (entry.visible === 0 && (event.kind === 'upload' || event.kind === 'download')) {
      const title =
        event.kind === 'upload'
          ? `Upload to ${nickname(serverId)} finished`
          : `Download from ${nickname(serverId)} finished`;
      toast.success(title, { description: label });
    }
  }

  function onSessionClosed(event: SftpSessionClosed): void {
    if (event.reason === 'quit') return;
    const serverId = serverIdOfSession(event.sessionId) ?? event.serverId;
    const entry = get().servers[serverId];
    if (!entry || entry.session?.sessionId !== event.sessionId) return;
    const name = nickname(serverId);
    if (event.reason === 'disconnected') {
      // Another view of the session asked for it: the same as this view's own Disconnect.
      patch(serverId, disconnected());
    } else if (event.reason === 'removed') {
      patch(serverId, {
        session: null,
        queue: null,
        status: 'missing',
        error: null,
        editingPath: null,
        editingFile: null,
        propertiesPaths: null,
      });
      toast.info(`${name} was removed, so its file session closed.`);
    } else {
      patch(serverId, {
        session: null,
        queue: null,
        status: 'error',
        error: `The connection to ${name} closed.`,
        editingPath: null,
        editingFile: null,
        propertiesPaths: null,
      });
      toast.info(`The file session on ${name} closed.`);
    }
  }

  /** A session handed over by a pop-out that closed. A server showing its own keeps that one. */
  function onSessionAdopted(info: SftpSessionInfo): void {
    if (files(info.serverId).session) return;
    void attach(info.serverId, info);
  }

  /** Shows `session` as connected: its remote folder and the queue as main has it. */
  async function attach(serverId: string, session: SftpSessionInfo): Promise<void> {
    patch(serverId, {
      session,
      status: 'ready',
      error: null,
      server: {
        nickname: session.nickname,
        host: session.host,
        port: session.port,
        username: session.username,
      },
    });
    // A reconnect goes back to the folder it showed; a first visit starts at home.
    void load(serverId, 'remote', files(serverId).remote.path ?? session.home);
    // The queue as main has it, so a conflict left open before a reload comes back (D3).
    try {
      const queue = await sftpBridge().queue(session.sessionId);
      if (files(serverId).session?.sessionId === session.sessionId) patch(serverId, { queue });
    } catch {
      // The next snapshot brings it.
    }
  }

  function ensureSubscribed(): void {
    const bridge = sftpBridge();
    if (subscribedTo === bridge) return;
    for (const unsubscribe of unsubscribers) unsubscribe();
    subscribedTo = bridge;
    unsubscribers = [
      bridge.onQueue(onQueue),
      bridge.onBatchFinished(onBatchFinished),
      bridge.onSessionClosed(onSessionClosed),
      bridge.onSessionAdopted(onSessionAdopted),
    ];
  }

  /** The session id, or null after telling the user there is none. */
  function sessionOf(serverId: string): string | null {
    const session = files(serverId).session;
    if (!session) toast.error(`Not connected to ${nickname(serverId)}.`);
    return session?.sessionId ?? null;
  }

  /** Says why when the session does not allow `action` on the server, and answers true then. */
  function refuse(serverId: string, action: 'rename' | 'remove'): boolean {
    const refused = refusalFor(files(serverId).session, action);
    if (refused) toast.error(refused);
    return refused !== null;
  }

  /** The session id, or a rejection saying there is none, for callers that tell it themselves. */
  function requireSession(serverId: string): string {
    const session = files(serverId).session;
    if (!session) throw new Error(`Not connected to ${nickname(serverId)}.`);
    return session.sessionId;
  }

  async function guarded(what: string, run: () => Promise<unknown>): Promise<void> {
    try {
      await run();
    } catch (error) {
      toast.error(`${what}: ${sftpProblem(error)}`);
    }
  }

  function nameProblem(name: string): string | null {
    if (!isValidEntryName(name)) {
      return `"${name}" can't be used as a name. Names can't be empty, "." or "..", or hold a slash.`;
    }
    return null;
  }

  return {
    servers: {},
    places: null,
    conflictFocus: null,

    async connect(serverId) {
      const entry = files(serverId);
      if (entry.status === 'connecting') return;
      if (entry.status === 'ready' && entry.session) return;
      patch(serverId, { status: 'connecting', error: null });
      ensureSubscribed();

      // A container or volume on a Deploy server (E27) is no saved server: main knows it from
      // the id alone, and there is no host key to trust on the way.
      const docker = parseDockerFileTargetId(serverId);
      if (docker) {
        patch(serverId, { server: { nickname: docker.id, host: '', port: 0, username: '' } });
      }

      // The saved server tells the gate what to call it, and an unknown one never gets opened.
      let saved: Awaited<ReturnType<typeof window.runova.ssh.listServers>> | null = null;
      if (!docker) {
        try {
          saved = await window.runova.ssh.listServers();
        } catch {
          saved = null;
        }
      }
      if (Array.isArray(saved)) {
        const server = saved.find((one) => one.id === serverId);
        if (!server) {
          patch(serverId, { status: 'missing', server: null });
          return;
        }
        patch(serverId, {
          server: {
            nickname: server.nickname,
            host: server.host,
            port: server.port,
            username: server.username,
          },
        });
      }

      let session: SftpSessionInfo;
      try {
        session = docker
          ? await sftpBridge().open(serverId)
          : await withHostKeyTrust(serverId, () => sftpBridge().open(serverId));
      } catch (error) {
        if (sshErrorCode(error) === 'vault-locked' || filesErrorCode(error) === 'vaultLocked') {
          patch(serverId, { status: 'locked', error: null });
        } else if (filesErrorCode(error) === 'siteUnknown') {
          patch(serverId, { status: 'missing', error: null });
        } else {
          patch(serverId, { status: 'error', error: sftpProblem(error) });
        }
        return;
      }

      await attach(serverId, session);
    },

    async disconnect(serverId) {
      const session = files(serverId).session;
      patch(serverId, disconnected());
      if (!session) return;
      await guarded('Could not disconnect', () => sftpBridge().close(session.sessionId));
    },

    async initLocal(serverId) {
      let places = get().places;
      if (!places) {
        try {
          const read = await sftpBridge().localPlaces();
          places = Array.isArray(read) ? read : [];
          set({ places });
        } catch (error) {
          // Nothing is listed yet, so Retry comes back here (see retryListing).
          patchPane(serverId, 'local', { error: sftpProblem(error) });
          return;
        }
      }
      const pane = files(serverId).local;
      if (pane.path !== null || pane.loading) return;
      const start = places.find((place) => place.kind === 'home') ?? places[0];
      if (start) await load(serverId, 'local', start.path);
    },

    setPageVisible(serverId, visible) {
      const current = files(serverId).visible;
      patch(serverId, { visible: Math.max(0, current + (visible ? 1 : -1)) });
    },

    async navigate(serverId, side, path) {
      await load(serverId, side, path);
    },

    async goTo(serverId, side, input) {
      const pane = files(serverId)[side];
      const cwd = pane.path ?? (side === 'remote' ? (files(serverId).session?.home ?? '/') : '/');
      const path =
        side === 'remote' ? resolveRemoteInput(input, cwd) : resolveLocalInput(input, cwd);
      if (path === null) return { status: 'ok' };
      return load(serverId, side, path, { inline: true });
    },

    async up(serverId, side) {
      const pane = files(serverId)[side];
      if (!pane.path) return;
      const parent = pane.parent ?? parentPath(pane.path);
      if (parent) await load(serverId, side, parent);
    },

    async home(serverId, side) {
      if (side === 'remote') {
        const session = files(serverId).session;
        if (session) await load(serverId, 'remote', session.home);
        return;
      }
      const home = get().places?.find((place) => place.kind === 'home');
      if (home) await load(serverId, 'local', home.path);
    },

    async refresh(serverId, side) {
      const pane = files(serverId)[side];
      const path = pane.path ?? pane.errorPath;
      if (path) await reload(serverId, side, path);
    },

    async retryListing(serverId, side) {
      const pane = files(serverId)[side];
      const path = pane.errorPath ?? pane.path;
      if (path) await reload(serverId, side, path);
      // The places never came, so nothing was listed: read them again.
      else if (side === 'local') await get().initLocal(serverId);
    },

    setSelection(serverId, side, selection) {
      patchPane(serverId, side, { selection });
    },

    sortBy(serverId, side, key) {
      const current = files(serverId)[side].sort;
      const dir = current.key === key && current.dir === 'asc' ? 'desc' : 'asc';
      patchPane(serverId, side, { sort: { key, dir } });
    },

    setFilter(serverId, side, filter) {
      patchPane(serverId, side, { filter });
    },

    toggleHidden(serverId, side) {
      patchPane(serverId, side, { showHidden: !files(serverId)[side].showHidden });
    },

    async transferSelected(serverId, side) {
      const entry = files(serverId);
      const pane = entry[side];
      const selected = new Set(pane.selection.selected);
      const paths = (pane.entries as Array<{ name: string; path: string }>)
        .filter((one) => selected.has(one.name))
        .map((one) => one.path);
      const other = entry[side === 'local' ? 'remote' : 'local'];
      if (paths.length === 0) return null;
      if (!other.path) {
        toast.error(
          side === 'local'
            ? 'Open a folder on the server first.'
            : 'Open a folder on this computer first.',
        );
        return null;
      }
      return get().transferPaths(serverId, side, paths, other.path);
    },

    async transferPaths(serverId, fromSide, paths, targetDir) {
      if (paths.length === 0) return null;
      const sessionId = sessionOf(serverId);
      if (!sessionId) return null;
      try {
        const ref =
          fromSide === 'local'
            ? await sftpBridge().upload(sessionId, { localPaths: paths, remoteDir: targetDir })
            : await sftpBridge().download(sessionId, { remotePaths: paths, localDir: targetDir });
        return ref.batchId;
      } catch (error) {
        toast.error(
          `Could not start the ${fromSide === 'local' ? 'upload' : 'download'}: ${sftpProblem(error)}`,
        );
        return null;
      }
    },

    async mkdir(serverId, side, name) {
      const trimmed = name.trim();
      const problem = nameProblem(trimmed);
      if (problem) {
        toast.error(problem);
        return false;
      }
      const dir = files(serverId)[side].path;
      if (!dir) return false;
      try {
        if (side === 'remote') {
          const sessionId = sessionOf(serverId);
          if (!sessionId) return false;
          await sftpBridge().mkdir(sessionId, dir, trimmed);
        } else {
          await sftpBridge().localMkdir(dir, trimmed);
        }
      } catch (error) {
        toast.error(
          filesErrorCode(error) === 'exists'
            ? `"${trimmed}" is already there. Pick another name.`
            : `Could not create the folder: ${sftpProblem(error)}`,
        );
        return false;
      }
      await reload(serverId, side, dir, trimmed);
      return true;
    },

    async rename(serverId, side, path, newName) {
      const trimmed = newName.trim();
      const problem = nameProblem(trimmed);
      if (problem) {
        toast.error(problem);
        return false;
      }
      if (side === 'remote' && refuse(serverId, 'rename')) return false;
      try {
        if (side === 'remote') {
          const sessionId = sessionOf(serverId);
          if (!sessionId) return false;
          await sftpBridge().rename(sessionId, path, trimmed);
        } else {
          await sftpBridge().localRename(path, trimmed);
        }
      } catch (error) {
        toast.error(
          filesErrorCode(error) === 'exists'
            ? `"${trimmed}" is already there. Pick another name.`
            : `Could not rename: ${sftpProblem(error)}`,
        );
        return false;
      }
      const dir = files(serverId)[side].path ?? parentPath(path) ?? joinPath(path, '..');
      await reload(serverId, side, dir, trimmed);
      return true;
    },

    async removeRemote(serverId, paths) {
      if (refuse(serverId, 'remove')) return null;
      const sessionId = sessionOf(serverId);
      if (!sessionId || paths.length === 0) return null;
      try {
        const ref = await sftpBridge().remove(sessionId, paths);
        return ref.batchId;
      } catch (error) {
        toast.error(`Could not delete: ${sftpProblem(error)}`);
        return null;
      }
    },

    async removeLocal(serverId, paths, options) {
      try {
        await sftpBridge().localDelete(paths, options);
      } catch (error) {
        // Whatever went to the Trash before the failure is gone from the folder already.
        void get().refresh(serverId, 'local');
        return { ok: false, message: sftpProblem(error) };
      }
      await get().refresh(serverId, 'local');
      return { ok: true };
    },

    async chmod(serverId, input) {
      const session = files(serverId).session;
      if (!session) throw new Error(`Not connected to ${nickname(serverId)}.`);
      const refused = refusalFor(session, 'chmod');
      if (refused) throw new Error(refused);
      try {
        await sftpBridge().chmod(session.sessionId, input);
      } catch (error) {
        throw new Error(sftpProblem(error));
      }
    },

    async resolveConflict(serverId, conflictId, decision) {
      const sessionId = requireSession(serverId);
      await sftpBridge().resolveConflict(sessionId, conflictId, decision);
    },

    async cancel(serverId, target) {
      const sessionId = requireSession(serverId);
      await sftpBridge().cancel(sessionId, target);
    },

    async retry(serverId, target) {
      const sessionId = requireSession(serverId);
      await sftpBridge().retry(sessionId, target);
    },

    async clearFinished(serverId) {
      const sessionId = requireSession(serverId);
      await sftpBridge().clearFinished(sessionId);
    },

    async openEditor(serverId, path) {
      const name = baseName(path);
      const refused = refusalFor(files(serverId).session, 'edit');
      if (refused) {
        toast.error(`Can't edit ${name} here`, { description: refused });
        return;
      }
      const sessionId = sessionOf(serverId);
      if (!sessionId) return;
      // A quick read says nothing; a slow one says it is on its way.
      let waiting: string | number | undefined;
      const slow = setTimeout(() => {
        waiting = toast.loading(`Opening ${name}…`);
      }, EDITOR_LOADING_DELAY_MS);
      let file: SftpTextFile;
      try {
        file = await sftpBridge().readText(sessionId, path);
      } catch (error) {
        const code = filesErrorCode(error);
        const refusal = code ? editRefusal(name, code) : null;
        if (refusal) toast.error(refusal.title, { description: refusal.description });
        else toast.error(`Could not open ${name}`, { description: sftpProblem(error) });
        return;
      } finally {
        clearTimeout(slow);
        if (waiting !== undefined) toast.dismiss(waiting);
      }
      // The session ended while the file was on its way.
      if (files(serverId).session?.sessionId !== sessionId) return;
      patch(serverId, { editingPath: path, editingFile: file });
    },
    closeEditor(serverId) {
      patch(serverId, { editingPath: null, editingFile: null });
    },
    openProperties(serverId, paths) {
      patch(serverId, { propertiesPaths: paths });
    },
    closeProperties(serverId) {
      patch(serverId, { propertiesPaths: null });
    },

    requestAnswer(serverId) {
      if (files(serverId).queue?.conflict) set({ conflictFocus: serverId });
    },
  };
});

/** Back to nothing, subscriptions included. For tests. */
export function resetSftpStore(): void {
  for (const unsubscribe of unsubscribers) unsubscribe();
  unsubscribers = [];
  subscribedTo = null;
  navTokens.clear();
  navInFlight.clear();
  refreshTokens.clear();
  useSftpStore.setState({ servers: {}, places: null, conflictFocus: null });
}
