import {
  type AgentTabMode,
  type AutoContinueOptions,
  activateTab,
  addTab,
  allGroups,
  allTabIds,
  chatReaderFor,
  createGroup,
  findGroup,
  findGroupOfTab,
  firstGroup,
  isSameOrInside,
  type MergeMethod,
  moveTab,
  normalizeLayout,
  type PaneNode,
  parseScopeId,
  remapPath,
  removeGroup,
  removeTab,
  replaceTabId,
  type SplitDirection,
  setRatio,
  splitGroup,
} from '@runova/core';
import type { GitDiffSide } from '@shared/apiTypes';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { browserRuntime } from '@/lib/browser/browserRuntime';
import { VIEWPORT_PRESETS, type ViewportPresetId } from '@/lib/browser/viewportPresets';
import { terminalRuntime } from '@/lib/terminal/terminalRuntime';
import { useBrowserStore } from './browserStore';
import { type RevealTarget, useEditorRevealStore } from './editorRevealStore';
import { useRecentFilesStore } from './recentFilesStore';

export type { GitDiffSide };

export interface WorkspaceTerminalTab {
  kind: 'terminal';
  /** Doubles as the pty session id, which is how a tab finds its shell after a restart. */
  id: string;
  title: string;
  /** A name the user gave the tab. Wins over `title` and the program's own title. */
  userTitle?: string;
  /**
   * The last task name the agent set as the window title. Kept on the tab so the name survives
   * an app restart, or the program resetting its title, instead of dropping back to the CLI name.
   */
  agentTitle?: string;
  /**
   * The agent's own id for the conversation running in this tab (Claude Code reports it through
   * hooks). Kept on the tab so the conversation can be picked back up after its shell is gone,
   * for example when Windows restarted or Runova was killed.
   */
  conversationId?: string;
  cliId?: string;
  shell?: string;
  cwd: string;
  createdAt: number;
  /** Typed into the shell when it first starts, and again on a restart (the agent's command). */
  launchInput?: string;
  /** The model and effort the tab was launched with, when chosen at launch ("Opus 5.5 · High"). */
  runLabel?: string;
  /** Types "continue" for the agent after a usage limit resets or a network error. */
  autoContinue?: AutoContinueOptions;
  /** The view the user picked for this tab; unset follows the default view from Settings. */
  viewMode?: AgentTabMode;
  restored?: boolean;
  /**
   * Set on a tab that shows a Relay leg (E26). Main started its session, so the tab only ever
   * attaches to it, and the relay finds the tab again by this id after a reload.
   */
  relayLegId?: string;
}

export interface WorkspaceDiffTab {
  kind: 'diff';
  id: string;
  path: string;
  /** For a staged rename, where the file came from. */
  origPath?: string;
  side: GitDiffSide;
  /** Set for a file as a past commit changed it, rather than a working tree change. */
  commit?: string;
  /** A preview tab is replaced by the next file opened, until the user pins it. */
  preview: boolean;
}

/** A project file opened for reading or editing, from the explorer. */
export interface WorkspaceFileTab {
  kind: 'file';
  id: string;
  /** Absolute path on disk. */
  path: string;
  preview: boolean;
}

/** A web page, usually the project's dev server, where elements can be picked for an agent. */
export interface WorkspaceBrowserTab {
  kind: 'browser';
  id: string;
  /** The page on screen, or empty for the start page. */
  url: string;
  title: string;
  faviconUrl?: string;
  viewport: ViewportPresetId;
}

export type WorkspaceTab =
  | WorkspaceTerminalTab
  | WorkspaceDiffTab
  | WorkspaceFileTab
  | WorkspaceBrowserTab;

/** The tabs of the right-hand panel. */
export type SidePanelSection = 'sourceControl' | 'explorer' | 'history' | 'tests' | 'tasks';

export const SIDE_PANEL_SECTIONS: SidePanelSection[] = [
  'sourceControl',
  'explorer',
  'history',
  'tests',
  'tasks',
];

/** The folding sections inside the Source control tab, top to bottom. */
export type SourceControlSection =
  | 'changes'
  | 'stashes'
  | 'branches'
  | 'worktrees'
  | 'commits'
  | 'pullRequest'
  | 'pipelines';

export const SOURCE_CONTROL_SECTIONS: SourceControlSection[] = [
  'changes',
  'stashes',
  'branches',
  'worktrees',
  'commits',
  'pullRequest',
  'pipelines',
];

/** Only the changes are open until the user opens something else. */
const DEFAULT_OPEN_SOURCE_SECTIONS: Record<SourceControlSection, boolean> = {
  changes: true,
  stashes: false,
  branches: false,
  worktrees: false,
  commits: false,
  pullRequest: false,
  pipelines: false,
};

export function isSourceControlSection(value: unknown): value is SourceControlSection {
  return SOURCE_CONTROL_SECTIONS.includes(value as SourceControlSection);
}

const MERGE_METHODS: readonly MergeMethod[] = ['squash', 'merge', 'rebase'];

export interface ProjectWorkspace {
  root: PaneNode;
  tabs: Record<string, WorkspaceTab>;
  focusedGroupId: string;
  /** A group blown up to fill the whole center area, or null. */
  zoomedGroupId: string | null;
}

export const GIT_PANEL_MIN_WIDTH = 240;
export const GIT_PANEL_MAX_WIDTH = 560;
export const GIT_PANEL_DEFAULT_WIDTH = 320;

export type GitPanelSection = 'conflicts' | 'staged' | 'unstaged' | 'untracked';

interface GitPanelPrefs {
  width: number;
  collapsed: boolean;
  collapsedSections: Partial<Record<GitPanelSection, boolean>>;
  diffSideBySide: boolean;
  diffIgnoreWhitespace: boolean;
  /** Show the added/removed line totals above the changed files. */
  showLineStats: boolean;
  /** Whether those totals are broken down per group. */
  lineStatsExpanded: boolean;
  /** Which panel tab is showing. */
  activeSection: SidePanelSection;
  /** Which sections of the Source control tab are unfolded. */
  openSourceSections: Record<SourceControlSection, boolean>;
  /**
   * Heights in pixels the user dragged Source control sections to. A section without one sizes
   * to what it shows, and the changes always take whatever is left.
   */
  sourceSectionHeights: Partial<Record<SourceControlSection, number>>;
  /** The merge method last used per project; squash when a project has none yet. */
  mergeMethods: Record<string, MergeMethod>;
}

export type NewTerminalTab = Omit<WorkspaceTerminalTab, 'kind' | 'id' | 'createdAt'>;

interface WorkspaceState {
  /**
   * Keyed by project id for a project's own checkout, and by scope id (`<project>~<worktree>`,
   * see `worktreeScopeId`) for each of its git worktrees.
   */
  workspaces: Record<string, ProjectWorkspace>;
  /** Projects open in the rail, in the order they were opened or the user dragged them into. */
  railProjectIds: string[];
  /** The workspace on screen: a project id or a worktree's scope id. */
  activeProjectId: string | null;
  /** Projects whose worktrees are folded away in the rail. Unset means shown. */
  railExpanded: Record<string, boolean>;
  gitPanel: GitPanelPrefs;

  /** Opens a project's workspace, or a worktree's (by scope id, which puts its project in the rail). */
  openProject: (projectId: string) => void;
  /** Removes a project from the rail and ends every shell it, and each of its worktrees, had open. */
  closeProject: (projectId: string) => void;
  /** Closes one worktree's workspace and ends its shells, going back to the project if it was open. */
  closeWorkspace: (scopeId: string) => void;
  setRailExpanded: (projectId: string, expanded: boolean) => void;
  /** Moves a project to another spot in the rail. `index` is a slot in the rail's current order. */
  moveRailProject: (projectId: string, index: number) => void;
  addTerminal: (projectId: string, tab: NewTerminalTab, groupId?: string) => string;
  /**
   * Shows a session main already started (a Relay leg) as a tab of its project, under the
   * session's own id. The project joins the rail if it was not there, but the workspace on screen
   * stays the one the user is looking at.
   */
  addRelayLegTab: (projectId: string, tab: NewTerminalTab & { id: string }) => void;
  /** Opens a browser tab, on its start page without a url, and returns its id. */
  openBrowser: (projectId: string, options?: { url?: string; groupId?: string }) => string;
  /** Keeps what a browser tab's page shows, for its label and for the next start. */
  setBrowserPage: (
    projectId: string,
    tabId: string,
    page: { url: string; title: string; faviconUrl: string | null },
  ) => void;
  setBrowserViewport: (projectId: string, tabId: string, viewport: ViewportPresetId) => void;
  /** Closes a tab. Terminal tabs end their shell. */
  closeTab: (projectId: string, tabId: string) => void;
  /**
   * Starts a fresh shell in place of an ended one, same position and launch settings.
   * `resumeInput` replaces the launch command with one that picks the tab's conversation back
   * up, which also keeps the task name, since it is still the same conversation.
   */
  restartTab: (projectId: string, tabId: string, resumeInput?: string) => void;
  activateTab: (projectId: string, tabId: string) => void;
  focusGroup: (projectId: string, groupId: string) => void;
  /** Splits a group and returns the new, empty group's id. */
  splitGroup: (
    projectId: string,
    groupId: string,
    direction: SplitDirection,
    side?: 'before' | 'after',
  ) => string;
  /** Closes a pane and every tab in it. */
  closeGroup: (projectId: string, groupId: string) => void;
  moveTab: (projectId: string, tabId: string, groupId: string, index?: number) => void;
  setSplitRatio: (projectId: string, splitId: string, ratio: number) => void;
  renameTab: (projectId: string, tabId: string, title: string) => void;
  /** Remembers the task name an agent set as its window title, so the tab keeps it later. */
  setAgentTitle: (projectId: string, tabId: string, title: string) => void;
  /** Remembers which agent conversation a tab is running, so it can be resumed later. */
  setConversationId: (projectId: string, tabId: string, conversationId: string) => void;
  setAutoContinue: (projectId: string, tabId: string, options: AutoContinueOptions) => void;
  /** Shows an agent tab as its CLI or as a chat, for this tab only. */
  setViewMode: (projectId: string, tabId: string, mode: AgentTabMode) => void;
  toggleZoom: (projectId: string, groupId: string) => void;
  /**
   * Shows a file's diff. An already open tab for it comes forward; otherwise it replaces the
   * focused pane's preview tab, or opens a new preview tab. `pin` keeps it open for good.
   */
  openDiff: (
    projectId: string,
    file: { path: string; side: GitDiffSide; origPath?: string; commit?: string },
    options?: { pin?: boolean },
  ) => void;
  /**
   * Opens a project file in an editor tab, with the same preview behavior as diffs, and at a
   * line when `reveal` says where.
   */
  openFile: (
    projectId: string,
    path: string,
    options?: { pin?: boolean; reveal?: RevealTarget },
  ) => void;
  /** Points file tabs at a renamed or moved path, keeping each tab (and its unsaved edits). */
  retargetFileTabs: (projectId: string, from: string, to: string) => void;
  /** Closes the file tabs showing a deleted path or anything inside a deleted folder. */
  closeFileTabsUnder: (projectId: string, paths: string[]) => void;
  setGitPanel: (patch: Partial<GitPanelPrefs>) => void;
  /** Folds or unfolds one section of the Source control tab. */
  setSourceSectionOpen: (section: SourceControlSection, open: boolean) => void;
  /** Sets or, with `undefined`, forgets the dragged heights of Source control sections. */
  setSourceSectionHeights: (
    patch: Partial<Record<SourceControlSection, number | undefined>>,
  ) => void;
  /**
   * Brings a panel tab into view. A Source control section also switches to that tab and
   * unfolds the section.
   */
  revealPanelSection: (section: SidePanelSection | SourceControlSection) => void;
  setMergeMethod: (projectId: string, method: MergeMethod) => void;
}

/**
 * The saved panel tab and folded sections. Older builds had a tab each for changes, commits,
 * branches, pipelines and the pull request; one of those comes back as Source control with
 * that section unfolded.
 */
function restorePanelSections(
  saved: Partial<GitPanelPrefs> | undefined,
): Pick<GitPanelPrefs, 'activeSection' | 'openSourceSections' | 'sourceSectionHeights'> {
  const savedHeights: Record<string, unknown> = { ...(saved?.sourceSectionHeights ?? {}) };
  const sourceSectionHeights = Object.fromEntries(
    SOURCE_CONTROL_SECTIONS.flatMap((section) => {
      const height = savedHeights[section];
      return typeof height === 'number' && Number.isFinite(height) && height > 0
        ? [[section, height]]
        : [];
    }),
  ) as Partial<Record<SourceControlSection, number>>;
  const savedOpen: Record<string, unknown> = { ...(saved?.openSourceSections ?? {}) };
  const openSourceSections = Object.fromEntries(
    SOURCE_CONTROL_SECTIONS.map((section) => [
      section,
      typeof savedOpen[section] === 'boolean'
        ? savedOpen[section]
        : DEFAULT_OPEN_SOURCE_SECTIONS[section],
    ]),
  ) as Record<SourceControlSection, boolean>;
  const active: unknown = saved?.activeSection;
  if (isSourceControlSection(active)) {
    return {
      activeSection: 'sourceControl',
      openSourceSections: { ...openSourceSections, [active]: true },
      sourceSectionHeights,
    };
  }
  return {
    activeSection: SIDE_PANEL_SECTIONS.includes(active as SidePanelSection)
      ? (active as SidePanelSection)
      : 'sourceControl',
    openSourceSections,
    sourceSectionHeights,
  };
}

function newId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function emptyWorkspace(): ProjectWorkspace {
  const group = createGroup(newId('g'));
  return { root: group, tabs: {}, focusedGroupId: group.id, zoomedGroupId: null };
}

/** Keeps focus and zoom pointing at groups that still exist after the tree changed. */
function settle(workspace: ProjectWorkspace): ProjectWorkspace {
  const groups = allGroups(workspace.root);
  const focusedGroupId = groups.some((g) => g.id === workspace.focusedGroupId)
    ? workspace.focusedGroupId
    : firstGroup(workspace.root).id;
  const zoomedGroupId =
    workspace.zoomedGroupId &&
    groups.length > 1 &&
    groups.some((g) => g.id === workspace.zoomedGroupId)
      ? workspace.zoomedGroupId
      : null;
  return { ...workspace, focusedGroupId, zoomedGroupId };
}

type PreviewableTab = WorkspaceDiffTab | WorkspaceFileTab;

/**
 * Brings up a diff or file tab. An existing tab for the same thing comes forward (and is
 * pinned if asked); otherwise the focused pane's preview tab is reused, or a new one opens.
 */
function openPreviewable(
  ws: ProjectWorkspace,
  matches: (tab: WorkspaceTab) => boolean,
  build: (id: string) => PreviewableTab,
  pin: boolean,
): ProjectWorkspace {
  const same = Object.values(ws.tabs).find(matches) as PreviewableTab | undefined;
  if (same) {
    const group = findGroupOfTab(ws.root, same.id);
    return {
      ...ws,
      root: activateTab(ws.root, same.id),
      focusedGroupId: group?.id ?? ws.focusedGroupId,
      tabs: pin ? { ...ws.tabs, [same.id]: { ...same, preview: false } } : ws.tabs,
    };
  }
  const focused = findGroup(ws.root, ws.focusedGroupId);
  const preview = focused?.tabIds
    .map((id) => ws.tabs[id])
    .find((t): t is PreviewableTab => (t?.kind === 'diff' || t?.kind === 'file') && t.preview);
  const next = build(preview?.id ?? newId('view'));
  return {
    ...ws,
    root: preview ? activateTab(ws.root, next.id) : addTab(ws.root, ws.focusedGroupId, next.id),
    tabs: { ...ws.tabs, [next.id]: next },
    zoomedGroupId: null,
  };
}

function endTab(tab: WorkspaceTab | undefined): void {
  if (tab?.kind === 'browser') {
    browserRuntime.dispose(tab.id);
    useBrowserStore.getState().clearTab(tab.id);
    return;
  }
  if (tab?.kind !== 'terminal') return;
  void window.runova.terminal.kill(tab.id);
  terminalRuntime.dispose(tab.id);
}

function restoredBrowserTab(tab: Partial<WorkspaceBrowserTab>): WorkspaceBrowserTab | null {
  if (typeof tab.id !== 'string' || typeof tab.url !== 'string') return null;
  const viewport = VIEWPORT_PRESETS.some((preset) => preset.id === tab.viewport)
    ? (tab.viewport as ViewportPresetId)
    : 'responsive';
  return {
    kind: 'browser',
    id: tab.id,
    url: tab.url,
    title: typeof tab.title === 'string' ? tab.title : '',
    ...(typeof tab.faviconUrl === 'string' ? { faviconUrl: tab.faviconUrl } : {}),
    viewport,
  };
}

export const useWorkspaceStore = create<WorkspaceState>()(
  persist(
    (set, get) => {
      const update = (projectId: string, fn: (ws: ProjectWorkspace) => ProjectWorkspace): void => {
        set((state) => {
          const current = state.workspaces[projectId];
          if (!current) return state;
          return { workspaces: { ...state.workspaces, [projectId]: settle(fn(current)) } };
        });
      };

      return {
        workspaces: {},
        railProjectIds: [],
        activeProjectId: null,
        railExpanded: {},
        gitPanel: {
          width: GIT_PANEL_DEFAULT_WIDTH,
          collapsed: false,
          collapsedSections: {},
          diffSideBySide: true,
          diffIgnoreWhitespace: false,
          showLineStats: true,
          lineStatsExpanded: false,
          activeSection: 'sourceControl',
          openSourceSections: DEFAULT_OPEN_SOURCE_SECTIONS,
          sourceSectionHeights: {},
          mergeMethods: {},
        },

        openProject: (projectId) =>
          set((state) => {
            // The rail lists projects; a worktree shows up under its project there.
            const railId = parseScopeId(projectId).projectId;
            return {
              activeProjectId: projectId,
              railProjectIds: state.railProjectIds.includes(railId)
                ? state.railProjectIds
                : [...state.railProjectIds, railId],
              workspaces: state.workspaces[projectId]
                ? state.workspaces
                : { ...state.workspaces, [projectId]: emptyWorkspace() },
            };
          }),

        closeProject: (projectId) => {
          const belongs = (key: string): boolean => parseScopeId(key).projectId === projectId;
          for (const [key, workspace] of Object.entries(get().workspaces)) {
            if (belongs(key)) for (const tab of Object.values(workspace.tabs)) endTab(tab);
          }
          set((state) => {
            const workspaces = Object.fromEntries(
              Object.entries(state.workspaces).filter(([key]) => !belongs(key)),
            );
            const railProjectIds = state.railProjectIds.filter((id) => id !== projectId);
            const index = state.railProjectIds.indexOf(projectId);
            return {
              workspaces,
              railProjectIds,
              activeProjectId:
                state.activeProjectId && belongs(state.activeProjectId)
                  ? (railProjectIds[Math.min(index, railProjectIds.length - 1)] ?? null)
                  : state.activeProjectId,
            };
          });
        },

        closeWorkspace: (scopeId) => {
          const { projectId, worktreeId } = parseScopeId(scopeId);
          // A project's own workspace goes with the project, through closeProject.
          if (!worktreeId) return;
          for (const tab of Object.values(get().workspaces[scopeId]?.tabs ?? {})) endTab(tab);
          set((state) => {
            const { [scopeId]: _closed, ...workspaces } = state.workspaces;
            if (state.activeProjectId !== scopeId) return { workspaces };
            return {
              workspaces: workspaces[projectId]
                ? workspaces
                : { ...workspaces, [projectId]: emptyWorkspace() },
              activeProjectId: projectId,
            };
          });
        },

        setRailExpanded: (projectId, expanded) =>
          set((state) => ({ railExpanded: { ...state.railExpanded, [projectId]: expanded } })),

        moveRailProject: (projectId, index) =>
          set((state) => {
            const from = state.railProjectIds.indexOf(projectId);
            if (from === -1) return state;
            const rest = state.railProjectIds.filter((id) => id !== projectId);
            // The index counts slots in the rail as it was, with the dragged project still in it.
            const to = Math.max(0, Math.min(from < index ? index - 1 : index, rest.length));
            if (to === from) return state;
            return { railProjectIds: [...rest.slice(0, to), projectId, ...rest.slice(to)] };
          }),

        addTerminal: (projectId, tab, groupId) => {
          const id = crypto.randomUUID();
          update(projectId, (ws) => {
            const target = groupId && findGroup(ws.root, groupId) ? groupId : ws.focusedGroupId;
            return {
              ...ws,
              root: addTab(ws.root, target, id),
              tabs: { ...ws.tabs, [id]: { ...tab, kind: 'terminal', id, createdAt: Date.now() } },
              focusedGroupId: target,
            };
          });
          return id;
        },

        addRelayLegTab: (projectId, { id, ...tab }) => {
          set((state) => {
            if (state.workspaces[projectId]?.tabs[id]) return state;
            const railId = parseScopeId(projectId).projectId;
            const ws = state.workspaces[projectId] ?? emptyWorkspace();
            const leg: WorkspaceTerminalTab = {
              ...tab,
              kind: 'terminal',
              id,
              createdAt: Date.now(),
              restored: true,
            };
            return {
              railProjectIds: state.railProjectIds.includes(railId)
                ? state.railProjectIds
                : [...state.railProjectIds, railId],
              workspaces: {
                ...state.workspaces,
                [projectId]: settle({
                  ...ws,
                  root: addTab(ws.root, ws.focusedGroupId, id),
                  tabs: { ...ws.tabs, [id]: leg },
                }),
              },
            };
          });
        },

        openBrowser: (projectId, options = {}) => {
          const id = newId('web');
          update(projectId, (ws) => {
            const target =
              options.groupId && findGroup(ws.root, options.groupId)
                ? options.groupId
                : ws.focusedGroupId;
            const tab: WorkspaceBrowserTab = {
              kind: 'browser',
              id,
              url: options.url ?? '',
              title: '',
              viewport: 'responsive',
            };
            return {
              ...ws,
              root: addTab(ws.root, target, id),
              tabs: { ...ws.tabs, [id]: tab },
              focusedGroupId: target,
              zoomedGroupId: null,
            };
          });
          return id;
        },

        setBrowserPage: (projectId, tabId, page) =>
          update(projectId, (ws) => {
            const tab = ws.tabs[tabId];
            if (tab?.kind !== 'browser') return ws;
            const faviconUrl = page.faviconUrl ?? undefined;
            if (tab.url === page.url && tab.title === page.title && tab.faviconUrl === faviconUrl) {
              return ws;
            }
            const { faviconUrl: _old, ...rest } = tab;
            const next: WorkspaceBrowserTab = {
              ...rest,
              url: page.url,
              title: page.title,
              ...(faviconUrl ? { faviconUrl } : {}),
            };
            return { ...ws, tabs: { ...ws.tabs, [tabId]: next } };
          }),

        setBrowserViewport: (projectId, tabId, viewport) =>
          update(projectId, (ws) => {
            const tab = ws.tabs[tabId];
            if (tab?.kind !== 'browser' || tab.viewport === viewport) return ws;
            return { ...ws, tabs: { ...ws.tabs, [tabId]: { ...tab, viewport } } };
          }),

        closeTab: (projectId, tabId) => {
          endTab(get().workspaces[projectId]?.tabs[tabId]);
          update(projectId, (ws) => {
            const { [tabId]: _closed, ...tabs } = ws.tabs;
            return { ...ws, root: removeTab(ws.root, tabId).root, tabs };
          });
        },

        restartTab: (projectId, tabId, resumeInput) => {
          const old = get().workspaces[projectId]?.tabs[tabId];
          if (old?.kind !== 'terminal') return;
          endTab(old);
          const id = crypto.randomUUID();
          update(projectId, (ws) => {
            const { [tabId]: _old, ...tabs } = ws.tabs;
            const fresh: WorkspaceTerminalTab = {
              ...old,
              id,
              createdAt: Date.now(),
              // A restart means a new session, so the old task name should not stick around.
              // A resume carries on the same conversation, so its name and id stay.
              ...(resumeInput
                ? { launchInput: resumeInput }
                : { agentTitle: undefined, conversationId: undefined }),
              restored: false,
              // A fresh shell is no longer the relay leg main started, so the relay forgets it.
              relayLegId: undefined,
            };
            return {
              ...ws,
              root: replaceTabId(ws.root, tabId, id),
              tabs: { ...tabs, [id]: fresh },
            };
          });
        },

        activateTab: (projectId, tabId) => {
          const tab = get().workspaces[projectId]?.tabs[tabId];
          if (tab?.kind === 'file') useRecentFilesStore.getState().touch(projectId, tab.path);
          update(projectId, (ws) => {
            const group = findGroupOfTab(ws.root, tabId);
            return {
              ...ws,
              root: activateTab(ws.root, tabId),
              focusedGroupId: group?.id ?? ws.focusedGroupId,
            };
          });
        },

        focusGroup: (projectId, groupId) =>
          update(projectId, (ws) =>
            ws.focusedGroupId === groupId ? ws : { ...ws, focusedGroupId: groupId },
          ),

        splitGroup: (projectId, groupId, direction, side = 'after') => {
          const group = createGroup(newId('g'));
          update(projectId, (ws) => ({
            ...ws,
            root: splitGroup(ws.root, groupId, direction, group, newId('s'), side),
            focusedGroupId: group.id,
            zoomedGroupId: null,
          }));
          return group.id;
        },

        closeGroup: (projectId, groupId) => {
          const ws = get().workspaces[projectId];
          const group = ws ? findGroup(ws.root, groupId) : null;
          if (!ws || !group) return;
          for (const tabId of group.tabIds) endTab(ws.tabs[tabId]);
          update(projectId, (current) => {
            const tabs = { ...current.tabs };
            for (const tabId of group.tabIds) delete tabs[tabId];
            let root = removeGroup(current.root, groupId);
            // The last pane stays, emptied, so the workspace keeps somewhere to launch from.
            if (root.type === 'group' && root.id === groupId) root = createGroup(groupId);
            return { ...current, root, tabs };
          });
        },

        moveTab: (projectId, tabId, groupId, index) =>
          update(projectId, (ws) => ({
            ...ws,
            root: moveTab(ws.root, tabId, groupId, index),
            focusedGroupId: groupId,
          })),

        setSplitRatio: (projectId, splitId, ratio) =>
          update(projectId, (ws) => ({ ...ws, root: setRatio(ws.root, splitId, ratio) })),

        renameTab: (projectId, tabId, title) =>
          update(projectId, (ws) => {
            const tab = ws.tabs[tabId];
            if (tab?.kind !== 'terminal') return ws;
            const userTitle = title.trim() || undefined;
            return { ...ws, tabs: { ...ws.tabs, [tabId]: { ...tab, userTitle } } };
          }),

        setAgentTitle: (projectId, tabId, title) =>
          update(projectId, (ws) => {
            const tab = ws.tabs[tabId];
            const agentTitle = title.trim();
            if (tab?.kind !== 'terminal' || !agentTitle || tab.agentTitle === agentTitle) return ws;
            return { ...ws, tabs: { ...ws.tabs, [tabId]: { ...tab, agentTitle } } };
          }),

        setConversationId: (projectId, tabId, conversationId) =>
          update(projectId, (ws) => {
            const tab = ws.tabs[tabId];
            if (tab?.kind !== 'terminal' || tab.conversationId === conversationId) return ws;
            return { ...ws, tabs: { ...ws.tabs, [tabId]: { ...tab, conversationId } } };
          }),

        setAutoContinue: (projectId, tabId, options) =>
          update(projectId, (ws) => {
            const tab = ws.tabs[tabId];
            if (tab?.kind !== 'terminal') return ws;
            const autoContinue = { ...tab.autoContinue, ...options };
            return { ...ws, tabs: { ...ws.tabs, [tabId]: { ...tab, autoContinue } } };
          }),

        setViewMode: (projectId, tabId, viewMode) =>
          update(projectId, (ws) => {
            const tab = ws.tabs[tabId];
            if (tab?.kind !== 'terminal' || tab.viewMode === viewMode) return ws;
            return { ...ws, tabs: { ...ws.tabs, [tabId]: { ...tab, viewMode } } };
          }),

        toggleZoom: (projectId, groupId) =>
          update(projectId, (ws) => ({
            ...ws,
            zoomedGroupId: ws.zoomedGroupId === groupId ? null : groupId,
            focusedGroupId: groupId,
          })),

        openDiff: (projectId, file, options = {}) =>
          update(projectId, (ws) =>
            openPreviewable(
              ws,
              (t) =>
                t.kind === 'diff' &&
                t.path === file.path &&
                t.side === file.side &&
                t.commit === file.commit,
              (id) => ({
                kind: 'diff',
                id,
                path: file.path,
                origPath: file.origPath,
                side: file.side,
                commit: file.commit,
                preview: !options.pin,
              }),
              options.pin === true,
            ),
          ),

        openFile: (projectId, path, options = {}) => {
          // Asked for before the tab exists, so a tab that mounts now finds it waiting.
          if (options.reveal) useEditorRevealStore.getState().requestReveal(path, options.reveal);
          useRecentFilesStore.getState().touch(projectId, path);
          update(projectId, (ws) =>
            openPreviewable(
              ws,
              (t) => t.kind === 'file' && t.path === path,
              (id) => ({ kind: 'file', id, path, preview: !options.pin }),
              options.pin === true,
            ),
          );
        },

        retargetFileTabs: (projectId, from, to) => {
          useRecentFilesStore.getState().remap(projectId, from, to);
          update(projectId, (ws) => {
            let changed = false;
            const tabs = { ...ws.tabs };
            for (const tab of Object.values(ws.tabs)) {
              if (tab.kind !== 'file') continue;
              const path = remapPath(tab.path, from, to);
              if (path === null || path === tab.path) continue;
              tabs[tab.id] = { ...tab, path };
              changed = true;
            }
            return changed ? { ...ws, tabs } : ws;
          });
        },

        closeFileTabsUnder: (projectId, paths) => {
          useRecentFilesStore.getState().forget(projectId, paths);
          update(projectId, (ws) => {
            const closing = Object.values(ws.tabs).filter(
              (tab) => tab.kind === 'file' && paths.some((path) => isSameOrInside(tab.path, path)),
            );
            if (closing.length === 0) return ws;
            const tabs = { ...ws.tabs };
            let root = ws.root;
            for (const tab of closing) {
              delete tabs[tab.id];
              root = removeTab(root, tab.id).root;
            }
            return { ...ws, root, tabs };
          });
        },

        setGitPanel: (patch) => set((state) => ({ gitPanel: { ...state.gitPanel, ...patch } })),
        setSourceSectionOpen: (section, open) =>
          set((state) => ({
            gitPanel: {
              ...state.gitPanel,
              openSourceSections: { ...state.gitPanel.openSourceSections, [section]: open },
            },
          })),
        setSourceSectionHeights: (patch) =>
          set((state) => {
            const heights = { ...state.gitPanel.sourceSectionHeights };
            for (const [section, height] of Object.entries(patch) as [
              SourceControlSection,
              number | undefined,
            ][]) {
              if (height === undefined) delete heights[section];
              else heights[section] = height;
            }
            return { gitPanel: { ...state.gitPanel, sourceSectionHeights: heights } };
          }),
        revealPanelSection: (section) =>
          set((state) =>
            isSourceControlSection(section)
              ? {
                  gitPanel: {
                    ...state.gitPanel,
                    collapsed: false,
                    activeSection: 'sourceControl',
                    openSourceSections: { ...state.gitPanel.openSourceSections, [section]: true },
                  },
                }
              : { gitPanel: { ...state.gitPanel, collapsed: false, activeSection: section } },
          ),
        setMergeMethod: (projectId, method) =>
          set((state) => ({
            gitPanel: {
              ...state.gitPanel,
              mergeMethods: { ...state.gitPanel.mergeMethods, [projectId]: method },
            },
          })),
      };
    },
    {
      name: 'runova-workspaces',
      version: 1,
      partialize: (state) => ({
        railProjectIds: state.railProjectIds,
        activeProjectId: state.activeProjectId,
        railExpanded: state.railExpanded,
        gitPanel: state.gitPanel,
        workspaces: Object.fromEntries(
          Object.entries(state.workspaces).map(([projectId, ws]) => {
            // Preview diffs are throwaway by definition. Terminal tabs keep their launch input:
            // a restored tab only reconnects, so it is typed again only on an explicit restart.
            const tabs = Object.fromEntries(
              Object.entries(ws.tabs).filter(
                ([, tab]) => !((tab.kind === 'diff' || tab.kind === 'file') && tab.preview),
              ),
            );
            const kept = new Set(Object.keys(tabs));
            let root = ws.root;
            for (const id of allTabIds(ws.root)) if (!kept.has(id)) root = removeTab(root, id).root;
            return [projectId, { ...ws, root, tabs }];
          }),
        ),
      }),
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as Partial<WorkspaceState>;
        const workspaces: Record<string, ProjectWorkspace> = {};
        for (const [projectId, ws] of Object.entries(saved.workspaces ?? {})) {
          const tabs: Record<string, WorkspaceTab> = {};
          for (const [id, tab] of Object.entries(ws?.tabs ?? {})) {
            if (tab?.kind === 'terminal') tabs[id] = { ...tab, restored: true };
            else if (tab?.kind === 'diff' || tab?.kind === 'file') tabs[id] = tab;
            else if (tab?.kind === 'browser') {
              const browser = restoredBrowserTab(tab);
              if (browser) tabs[id] = browser;
            }
          }
          const root = normalizeLayout(ws?.root, new Set(Object.keys(tabs)), newId('g'));
          const placed = new Set(allTabIds(root));
          for (const id of Object.keys(tabs)) if (!placed.has(id)) delete tabs[id];
          workspaces[projectId] = settle({
            root,
            tabs,
            focusedGroupId: typeof ws?.focusedGroupId === 'string' ? ws.focusedGroupId : '',
            zoomedGroupId: typeof ws?.zoomedGroupId === 'string' ? ws.zoomedGroupId : null,
          });
        }
        // A project stays in the rail while any of its workspaces, its own or a worktree's, is left.
        const withWorkspace = new Set(
          Object.keys(workspaces).map((key) => parseScopeId(key).projectId),
        );
        const railProjectIds = (saved.railProjectIds ?? []).filter((id) => withWorkspace.has(id));
        // A worktree's workspace only makes sense under its project in the rail.
        for (const key of Object.keys(workspaces)) {
          const { projectId, worktreeId } = parseScopeId(key);
          if (worktreeId && !railProjectIds.includes(projectId)) delete workspaces[key];
        }
        const railExpanded = Object.fromEntries(
          Object.entries(saved.railExpanded ?? {}).filter(
            ([id, open]) => railProjectIds.includes(id) && typeof open === 'boolean',
          ),
        );
        return {
          ...current,
          workspaces,
          railProjectIds,
          railExpanded,
          activeProjectId:
            saved.activeProjectId && workspaces[saved.activeProjectId]
              ? saved.activeProjectId
              : (railProjectIds[0] ?? null),
          gitPanel: {
            ...current.gitPanel,
            ...(saved.gitPanel ?? {}),
            ...restorePanelSections(saved.gitPanel),
            mergeMethods: Object.fromEntries(
              Object.entries(saved.gitPanel?.mergeMethods ?? {}).filter(([, method]) =>
                MERGE_METHODS.includes(method as MergeMethod),
              ),
            ) as Record<string, MergeMethod>,
          },
        };
      },
    },
  ),
);

/**
 * The name a terminal tab shows: the one the user gave it, else the last task name its agent
 * set, else the one it was launched with.
 */
export function terminalTabLabel(tab: WorkspaceTerminalTab): string {
  return tab.userTitle ?? tab.agentTitle ?? tab.title;
}

/** Whether the tab runs an agent CLI whose transcript the chat view can read. */
export function canShowChat(tab: WorkspaceTerminalTab): boolean {
  return chatReaderFor(tab.cliId) !== null;
}

/**
 * The view a terminal tab shows: the one picked for it, else the default from Settings. A plain
 * shell, or a CLI the chat view cannot read, always shows the terminal.
 */
export function effectiveViewMode(
  tab: WorkspaceTerminalTab,
  defaultMode: AgentTabMode,
): AgentTabMode {
  if (!canShowChat(tab)) return 'cli';
  return tab.viewMode ?? defaultMode;
}
