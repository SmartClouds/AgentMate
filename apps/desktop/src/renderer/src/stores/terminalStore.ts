import type { RunKind } from '@agentmat/core';
import type { SshSavedServer } from '@shared/apiTypes';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export const TERMINAL_MIN_HEIGHT = 160;
export const TERMINAL_DEFAULT_HEIGHT = 288;
/** How much of the page area stays above the drawer when it is made taller. */
export const TERMINAL_PAGE_ROOM = 240;

/** The tallest the drawer can be in a page area this tall. */
export function terminalMaxHeight(pageAreaHeight: number): number {
  return Math.max(TERMINAL_MIN_HEIGHT, pageAreaHeight - TERMINAL_PAGE_ROOM);
}

/** The project run command a tab was opened to run, which puts it in the status bar. */
export interface TerminalRunInfo {
  commandId: string;
  /** The command's name, or the command itself when it has none. */
  label: string;
  command: string;
  kind: RunKind;
  startedAt: number;
}

export interface TerminalSessionMeta {
  id: string;
  title: string;
  cwd?: string;
  shell?: string;
  initialInput?: string;
  projectId?: string;
  /**
   * Defaults to 'local'. An 'ssh' session connects to a saved server instead of spawning a shell.
   * An 'sftp' tab shows a server's file manager (E25) and has no shell at all.
   */
  kind?: 'local' | 'ssh' | 'container' | 'sftp';
  sshServerId?: string;
  /** For an 'sftp' tab: the saved server whose files it shows. */
  sftpServerId?: string;
  /** The agent conversation this tab resumed, so opening it again goes back to this tab. */
  conversationId?: string;
  /**
   * For a 'container' session: a console in a container on a server with the core (Deploy).
   * These panes live inside the Containers screen and are never put in the store.
   */
  container?: { serverId: string; containerId: string };
  /**
   * Brought back from a previous run of the app. Its pane only reconnects to the shell that
   * is still running in the background and closes itself if that shell is gone, so a
   * restored tab never starts a new shell or replays its install command. SSH sessions are
   * never persisted in the first place (see `partialize` below), so this is always false for them.
   */
  restored?: boolean;
  /** Set when the tab runs a project's run command. Kept across restarts like the tab itself. */
  run?: TerminalRunInfo;
}

export interface SshSessionExtras {
  title?: string;
  initialInput?: string;
  conversationId?: string;
}

interface TerminalState {
  isOpen: boolean;
  drawerHeight: number;
  /**
   * The drawer fills the page area. Kept here rather than in the drawer so the shell can hide
   * the page under it. Not persisted: a fresh start always opens the drawer at its height.
   */
  isMaximized: boolean;
  sessions: TerminalSessionMeta[];
  activeSessionId: string | null;
  setMaximized: (maximized: boolean) => void;
  openDrawer: () => void;
  closeDrawer: () => void;
  toggleDrawer: () => void;
  setDrawerHeight: (height: number) => void;
  openSession: (meta: Omit<TerminalSessionMeta, 'id'> & { id?: string }) => string;
  openDefaultSession: () => string;
  /**
   * Opens a new tab connected to a saved SSH server. `extras` names the tab, gives it a command
   * to type once the shell opens, and records the conversation that command resumes.
   */
  openSshSession: (server: SshSavedServer, extras?: SshSessionExtras) => string;
  /** The open SSH tab resuming this conversation on this server, if there is one. */
  findSshConversationTab: (serverId: string, conversationId: string) => string | null;
  /** Closes the tab and ends its shell. A file manager tab has none: its SFTP session stays. */
  closeSession: (id: string) => void;
  /** Drops the tab of a shell that has already ended. */
  forgetSession: (id: string) => void;
  setActiveSession: (id: string) => void;
  /** Moves the tab at `from` so it sits at `to`, the way a drop in the tab strip lands it. */
  moveSession: (from: number, to: number) => void;
}

type PersistedTerminalState = Pick<
  TerminalState,
  'isOpen' | 'drawerHeight' | 'sessions' | 'activeSessionId'
>;

/** The shell a plain "new tab" starts, per platform. The tab is always called a terminal:
 * naming it after the shell ("New zsh") confused people into thinking zsh itself was the app. */
export function defaultNewSession(): { title: string; shell?: string } {
  const platform = window.agentmat.platform;
  if (platform === 'win32') return { title: 'Terminal', shell: 'powershell.exe' };
  if (platform === 'darwin') return { title: 'Terminal', shell: 'zsh' };
  return { title: 'Terminal', shell: 'bash' };
}

function withoutSession(
  state: TerminalState,
  id: string,
): Pick<TerminalState, 'sessions' | 'activeSessionId'> {
  const remaining = state.sessions.filter((s) => s.id !== id);
  return {
    sessions: remaining,
    activeSessionId:
      state.activeSessionId === id ? (remaining.at(-1)?.id ?? null) : state.activeSessionId,
  };
}

/** Only tabs with a shell that can still be running after a restart are saved. */
function isKeptAcrossRestart(session: TerminalSessionMeta): boolean {
  return session.kind !== 'ssh' && session.kind !== 'sftp';
}

export const useTerminalStore = create<TerminalState>()(
  persist(
    (set, get) => ({
      isOpen: false,
      drawerHeight: TERMINAL_DEFAULT_HEIGHT,
      isMaximized: false,
      sessions: [],
      activeSessionId: null,
      setMaximized: (maximized) => set({ isMaximized: maximized }),
      openDrawer: () => set({ isOpen: true }),
      closeDrawer: () => set({ isOpen: false }),
      toggleDrawer: () => set((state) => ({ isOpen: !state.isOpen })),
      setDrawerHeight: (height) =>
        set({ drawerHeight: Math.max(TERMINAL_MIN_HEIGHT, Math.round(height)) }),
      openSession: (meta) => {
        const id = meta.id ?? crypto.randomUUID();
        const session: TerminalSessionMeta = {
          id,
          title: meta.title,
          cwd: meta.cwd,
          shell: meta.shell,
          initialInput: meta.initialInput,
          projectId: meta.projectId,
          kind: meta.kind,
          sshServerId: meta.sshServerId,
          sftpServerId: meta.sftpServerId,
          conversationId: meta.conversationId,
          run: meta.run,
        };
        set((state) => ({
          sessions: [...state.sessions, session],
          activeSessionId: id,
          isOpen: true,
        }));
        return id;
      },
      openDefaultSession: () => {
        const next = defaultNewSession();
        const count = get().sessions.filter((s) => s.shell === next.shell).length;
        return get().openSession({
          title: count === 0 ? next.title : `${next.title} ${count + 1}`,
          shell: next.shell,
        });
      },
      openSshSession: (server, extras = {}) =>
        get().openSession({
          title: extras.title ?? server.nickname,
          kind: 'ssh',
          sshServerId: server.id,
          initialInput: extras.initialInput,
          conversationId: extras.conversationId,
        }),
      findSshConversationTab: (serverId, conversationId) =>
        get().sessions.find(
          (s) =>
            s.kind === 'ssh' && s.sshServerId === serverId && s.conversationId === conversationId,
        )?.id ?? null,
      closeSession: (id) => {
        // Ending the shell lives here rather than in the pane's unmount, because a pane
        // also unmounts when the app reloads or React re-runs its effects, and neither of
        // those should cost the user a running shell.
        const session = get().sessions.find((s) => s.id === id);
        // A file manager tab is only a view: the SFTP session it shows lives on in main and in
        // the other views of it (the page, the pop-out), so closing the tab ends nothing.
        if (session?.kind !== 'sftp') {
          void (session?.kind === 'ssh' ? window.agentmat.ssh : window.agentmat.terminal).kill(id);
        }
        set((state) => withoutSession(state, id));
      },
      forgetSession: (id) => set((state) => withoutSession(state, id)),
      setActiveSession: (id) => set({ activeSessionId: id }),
      moveSession: (from, to) =>
        set((state) => {
          const last = state.sessions.length - 1;
          if (from === to || from < 0 || from > last || to < 0 || to > last) return state;
          const sessions = [...state.sessions];
          const [moved] = sessions.splice(from, 1);
          sessions.splice(to, 0, moved);
          return { sessions };
        }),
    }),
    {
      name: 'agentmate-terminal-sessions',
      partialize: (state): PersistedTerminalState => ({
        isOpen: state.isOpen,
        drawerHeight: state.drawerHeight,
        activeSessionId: state.activeSessionId,
        // The pre-filled command already ran once; a reconnect must never type it again.
        // SSH sessions are dropped entirely: they don't survive a restart (no background host
        // to reattach to), so persisting one would only leave a tab that reopens and fails.
        // File manager tabs go too: the SFTP session behind one ends with the app.
        sessions: state.sessions
          .filter(isKeptAcrossRestart)
          .map(({ initialInput: _initialInput, ...rest }) => rest),
      }),
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as Partial<PersistedTerminalState>;
        const sessions = Array.isArray(saved.sessions)
          ? saved.sessions
              .filter(isKeptAcrossRestart)
              .map((session) => ({ ...session, restored: true }))
          : [];
        return {
          ...current,
          isOpen: sessions.length > 0 && saved.isOpen === true,
          drawerHeight:
            typeof saved.drawerHeight === 'number' ? saved.drawerHeight : current.drawerHeight,
          sessions,
          activeSessionId: sessions.some((s) => s.id === saved.activeSessionId)
            ? (saved.activeSessionId ?? null)
            : (sessions.at(-1)?.id ?? null),
        };
      },
    },
  ),
);
