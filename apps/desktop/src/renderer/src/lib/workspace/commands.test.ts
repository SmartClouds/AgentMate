import type { Project } from '@runova/core';
import { findGroup } from '@runova/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { onBrowserShortcut } from '@/lib/browser/browserSync';
import { queryKeys } from '@/lib/queryKeys';
import { queryClient } from '@/queryClient';
import { useCliStore } from '@/stores/cliStore';
import { useWorkspaceSearchStore } from '@/stores/workspaceSearchStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { installRunovaBridge } from '../../../../test/renderer/runovaBridge';
import {
  DIFF_CHANGE_EVENT,
  isWorkspacePath,
  RUN_PROJECT_EVENT,
  useLauncherStore,
  usePromptDialogStore,
  workspaceCommands,
} from './commands';

vi.mock('@/lib/terminal/terminalRuntime', () => ({
  terminalRuntime: { dispose: vi.fn(), mount: vi.fn(), unmount: vi.fn(), focus: vi.fn() },
}));

const project = {
  id: 'p1',
  name: 'App',
  folderPath: 'E:\\proj',
  agentType: 'fullstack',
  cliId: 'claude-code',
} as unknown as Project;

function store() {
  return useWorkspaceStore.getState();
}

function workspace() {
  const current = store().workspaces.p1;
  if (!current) throw new Error('no workspace for p1');
  return current;
}

/** A project open in the workspace with one shell tab in the focused pane. */
function openWorkspace(): { tabId: string; groupId: string } {
  store().openProject('p1');
  const tabId = store().addTerminal('p1', { title: 'PowerShell', cwd: 'E:\\proj' });
  return { tabId, groupId: workspace().focusedGroupId };
}

beforeEach(() => {
  installRunovaBridge({ platform: 'win32' });
  queryClient.clear();
  queryClient.setQueryData(queryKeys.projects, [project]);
  useWorkspaceStore.setState({ workspaces: {}, railProjectIds: [], activeProjectId: null });
  useLauncherStore.setState({ openForGroupId: null });
  usePromptDialogStore.setState({ projectId: null, groupId: null });
});

describe('isWorkspacePath', () => {
  it('recognizes the workspace page and everything under it', () => {
    expect(isWorkspacePath('/workspace')).toBe(true);
    expect(isWorkspacePath('/workspace/p1')).toBe(true);
  });

  it('does not match another page that merely starts the same way', () => {
    expect(isWorkspacePath('/workspaces')).toBe(false);
    expect(isWorkspacePath('/projects')).toBe(false);
    expect(isWorkspacePath('/')).toBe(false);
  });
});

describe('useLauncherStore', () => {
  it('opens the launcher menu of one pane at a time', () => {
    useLauncherStore.getState().setOpenFor('g1');
    expect(useLauncherStore.getState().openForGroupId).toBe('g1');
    useLauncherStore.getState().setOpenFor(null);
    expect(useLauncherStore.getState().openForGroupId).toBeNull();
  });
});

describe('usePromptDialogStore', () => {
  it('remembers the project and the pane a launch from it should land in', () => {
    usePromptDialogStore.getState().open('p1', 'g2');
    expect(usePromptDialogStore.getState()).toMatchObject({ projectId: 'p1', groupId: 'g2' });
    usePromptDialogStore.getState().close();
    expect(usePromptDialogStore.getState()).toMatchObject({ projectId: null, groupId: null });
  });
});

describe('openLauncher', () => {
  it('opens the menu of the focused pane', () => {
    const { groupId } = openWorkspace();
    workspaceCommands.openLauncher();
    expect(useLauncherStore.getState().openForGroupId).toBe(groupId);
  });

  it('does nothing with no project open', () => {
    workspaceCommands.openLauncher();
    expect(useLauncherStore.getState().openForGroupId).toBeNull();
  });
});

describe('launchAgent', () => {
  function agentTabs() {
    return Object.values(workspace().tabs).filter((tab) => tab.kind === 'terminal' && tab.cliId);
  }

  beforeEach(() => {
    useCliStore.setState({ cliOrder: [] });
    queryClient.setQueryData(queryKeys.cliStatus, [
      { id: 'claude-code', installed: true },
      { id: 'gemini-cli', installed: false },
      { id: 'codex-cli', installed: true },
    ]);
  });

  it('starts the installed agent at that position in the focused pane', async () => {
    const { groupId } = openWorkspace();
    await workspaceCommands.launchAgent(2);
    // Gemini is not installed, so the second agent in the menu is Codex.
    expect(agentTabs()).toMatchObject([{ cliId: 'codex-cli' }]);
    expect(findGroup(workspace().root, groupId)?.tabIds).toHaveLength(2);
  });

  it('follows the order chosen in Settings', async () => {
    useCliStore.setState({ cliOrder: ['codex-cli', 'claude-code'] });
    openWorkspace();
    await workspaceCommands.launchAgent(1);
    expect(agentTabs()).toMatchObject([{ cliId: 'codex-cli' }]);
  });

  it('closes an open launcher menu', async () => {
    const { groupId } = openWorkspace();
    useLauncherStore.getState().setOpenFor(groupId);
    await workspaceCommands.launchAgent(1);
    expect(useLauncherStore.getState().openForGroupId).toBeNull();
  });

  it('does nothing past the last installed agent', async () => {
    openWorkspace();
    await workspaceCommands.launchAgent(3);
    expect(agentTabs()).toHaveLength(0);
  });

  it('does nothing with no project open', async () => {
    await workspaceCommands.launchAgent(1);
    expect(store().workspaces).toEqual({});
  });
});

describe('buildPrompt', () => {
  it('opens Build Prompt for the project on screen, aimed at the focused pane', () => {
    const { groupId } = openWorkspace();
    useLauncherStore.getState().setOpenFor(groupId);
    workspaceCommands.buildPrompt();
    expect(usePromptDialogStore.getState()).toMatchObject({ projectId: 'p1', groupId });
    expect(useLauncherStore.getState().openForGroupId).toBeNull();
  });

  it('does nothing with no project open', () => {
    workspaceCommands.buildPrompt();
    expect(usePromptDialogStore.getState().projectId).toBeNull();
  });
});

describe('newShell', () => {
  it('opens a shell tab in the focused pane of the active project', () => {
    const { groupId } = openWorkspace();
    workspaceCommands.newShell();
    const group = findGroup(workspace().root, groupId);
    expect(group?.tabIds).toHaveLength(2);
  });

  it('does nothing when the active project is not in the query cache', () => {
    openWorkspace();
    queryClient.setQueryData(queryKeys.projects, []);
    workspaceCommands.newShell();
    expect(Object.keys(workspace().tabs)).toHaveLength(1);
  });

  it('opens the shell in the worktree when a worktree’s workspace is on screen', () => {
    queryClient.setQueryData(queryKeys.worktrees('p1'), [
      {
        id: 'wt-1',
        projectId: 'p1',
        path: 'E:\\proj.worktrees\\feat',
        branch: 'feat',
        baseBranch: 'main',
        createdAt: '2026-09-25T00:00:00.000Z',
        createdByApp: true,
        missing: false,
        locked: false,
        status: null,
      },
    ]);
    store().openProject('p1~wt-1');
    workspaceCommands.newShell();
    const tabs = Object.values(store().workspaces['p1~wt-1']?.tabs ?? {});
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toMatchObject({ kind: 'terminal', cwd: 'E:\\proj.worktrees\\feat' });
  });
});

describe('newWorktree', () => {
  it('opens New worktree for the project on screen, from its checkout or a worktree', async () => {
    const { useWorktreeDialogStore } = await import('@/stores/worktreeDialogStore');
    store().openProject('p1~wt-1');
    workspaceCommands.newWorktree();
    expect(useWorktreeDialogStore.getState().create).toEqual({ projectId: 'p1' });
  });

  it('does nothing with no workspace open', async () => {
    const { useWorktreeDialogStore } = await import('@/stores/worktreeDialogStore');
    useWorktreeDialogStore.setState({ create: null });
    workspaceCommands.newWorktree();
    expect(useWorktreeDialogStore.getState().create).toBeNull();
  });
});

describe('closeActiveTab', () => {
  it('closes the active tab of the focused pane', () => {
    const { tabId } = openWorkspace();
    workspaceCommands.closeActiveTab();
    expect(workspace().tabs[tabId]).toBeUndefined();
  });

  it('does nothing in an empty pane', () => {
    const { groupId } = openWorkspace();
    const empty = store().splitGroup('p1', groupId, 'row');
    expect(workspace().focusedGroupId).toBe(empty);
    workspaceCommands.closeActiveTab();
    expect(Object.keys(workspace().tabs)).toHaveLength(1);
  });
});

describe('split', () => {
  it('adds a pane and opens its launcher, so the new pane is usable right away', () => {
    openWorkspace();
    workspaceCommands.split('row');
    const newGroup = workspace().focusedGroupId;
    expect(useLauncherStore.getState().openForGroupId).toBe(newGroup);
  });

  it('does nothing with no project open', () => {
    workspaceCommands.split('column');
    expect(useLauncherStore.getState().openForGroupId).toBeNull();
  });
});

describe('focusPane', () => {
  it('stays put when no pane has a measurable position', () => {
    // jsdom gives every element a zero-sized box, which is also what a hidden pane looks like.
    const { groupId } = openWorkspace();
    store().splitGroup('p1', groupId, 'row');
    const before = workspace().focusedGroupId;
    workspaceCommands.focusPane('left');
    expect(workspace().focusedGroupId).toBe(before);
  });

  it('moves focus to the pane in that direction', () => {
    const { groupId } = openWorkspace();
    const right = store().splitGroup('p1', groupId, 'row');
    store().focusGroup('p1', right);
    for (const [id, x] of [
      [groupId, 0],
      [right, 400],
    ] as const) {
      const element = document.createElement('div');
      element.dataset.paneGroupId = id;
      element.getBoundingClientRect = () =>
        ({ left: x, top: 0, width: 400, height: 300 }) as DOMRect;
      document.body.appendChild(element);
    }
    workspaceCommands.focusPane('left');
    expect(workspace().focusedGroupId).toBe(groupId);
    document.body.replaceChildren();
  });
});

describe('cycleTab', () => {
  it('walks forward and wraps around', () => {
    const { tabId, groupId } = openWorkspace();
    const second = store().addTerminal('p1', { title: 'two', cwd: '/' }, groupId);
    store().activateTab('p1', tabId);
    workspaceCommands.cycleTab(1);
    expect(findGroup(workspace().root, groupId)?.activeTabId).toBe(second);
    workspaceCommands.cycleTab(1);
    expect(findGroup(workspace().root, groupId)?.activeTabId).toBe(tabId);
  });

  it('walks backward and wraps around', () => {
    const { tabId, groupId } = openWorkspace();
    const second = store().addTerminal('p1', { title: 'two', cwd: '/' }, groupId);
    store().activateTab('p1', tabId);
    workspaceCommands.cycleTab(-1);
    expect(findGroup(workspace().root, groupId)?.activeTabId).toBe(second);
  });

  it('does nothing in a pane with fewer than two tabs', () => {
    const { tabId, groupId } = openWorkspace();
    workspaceCommands.cycleTab(1);
    expect(findGroup(workspace().root, groupId)?.activeTabId).toBe(tabId);
  });
});

describe('goToTab', () => {
  it('picks a tab by its position in the focused pane', () => {
    const { tabId, groupId } = openWorkspace();
    const second = store().addTerminal('p1', { title: 'two', cwd: '/' }, groupId);
    workspaceCommands.goToTab(1);
    expect(findGroup(workspace().root, groupId)?.activeTabId).toBe(tabId);
    workspaceCommands.goToTab(2);
    expect(findGroup(workspace().root, groupId)?.activeTabId).toBe(second);
  });

  it('does nothing for a position with no tab in it', () => {
    const { tabId, groupId } = openWorkspace();
    workspaceCommands.goToTab(9);
    expect(findGroup(workspace().root, groupId)?.activeTabId).toBe(tabId);
  });
});

describe('toggleZoom', () => {
  it('zooms the focused pane and puts it back', () => {
    const { groupId } = openWorkspace();
    store().splitGroup('p1', groupId, 'row');
    store().focusGroup('p1', groupId);
    workspaceCommands.toggleZoom();
    expect(workspace().zoomedGroupId).toBe(groupId);
    workspaceCommands.toggleZoom();
    expect(workspace().zoomedGroupId).toBeNull();
  });
});

describe('focusedTabIsDiff', () => {
  it('is true only while a diff is showing in the focused pane', () => {
    openWorkspace();
    expect(workspaceCommands.focusedTabIsDiff()).toBe(false);
    store().openDiff('p1', { path: 'a.ts', side: 'unstaged' });
    expect(workspaceCommands.focusedTabIsDiff()).toBe(true);
  });

  it('is false with no project open', () => {
    expect(workspaceCommands.focusedTabIsDiff()).toBe(false);
  });
});

describe('diffChange', () => {
  it('tells the focused diff which way to jump', () => {
    const heard: string[] = [];
    const listener = (event: Event): void => {
      heard.push((event as CustomEvent<string>).detail);
    };
    window.addEventListener(DIFF_CHANGE_EVENT, listener);
    workspaceCommands.diffChange('next');
    workspaceCommands.diffChange('previous');
    window.removeEventListener(DIFF_CHANGE_EVENT, listener);
    expect(heard).toEqual(['next', 'previous']);
  });
});

describe('toggleGitPanel', () => {
  it('folds the changes panel away and brings it back', () => {
    workspaceCommands.toggleGitPanel();
    expect(store().gitPanel.collapsed).toBe(true);
    workspaceCommands.toggleGitPanel();
    expect(store().gitPanel.collapsed).toBe(false);
  });
});

describe('openSearch', () => {
  it('opens the search on the project on screen, and closes it on a second press', () => {
    openWorkspace();
    workspaceCommands.openSearch();
    expect(useWorkspaceSearchStore.getState()).toMatchObject({ open: true, projectId: 'p1' });
    workspaceCommands.openSearch();
    expect(useWorkspaceSearchStore.getState().open).toBe(false);
  });

  it('does nothing with no project on screen', () => {
    workspaceCommands.openSearch();
    expect(useWorkspaceSearchStore.getState().open).toBe(false);
  });
});

describe('runProject', () => {
  it('tells the header to press its Run button', () => {
    const onRun = vi.fn();
    window.addEventListener(RUN_PROJECT_EVENT, onRun);
    workspaceCommands.runProject();
    window.removeEventListener(RUN_PROJECT_EVENT, onRun);
    expect(onRun).toHaveBeenCalledTimes(1);
  });
});

describe('newBrowser', () => {
  it('opens a browser tab on its start page in the focused pane', () => {
    const { groupId } = openWorkspace();
    workspaceCommands.newBrowser();
    const group = findGroup(workspace().root, groupId);
    const active = group?.activeTabId ? workspace().tabs[group.activeTabId] : undefined;
    expect(active).toMatchObject({ kind: 'browser', url: '' });
  });

  it('does nothing with no project open', () => {
    workspaceCommands.newBrowser();
    expect(store().workspaces).toEqual({});
  });
});

describe('pickElement', () => {
  it('starts commenting in the browser tab of the focused pane', () => {
    openWorkspace();
    const id = store().openBrowser('p1', { url: 'http://localhost:5173/' });
    const seen = vi.fn();
    const off = onBrowserShortcut(id, seen);
    workspaceCommands.pickElement();
    off();
    expect(seen).toHaveBeenCalledWith('pick');
  });

  it('leaves other tabs alone', () => {
    const { tabId } = openWorkspace();
    const seen = vi.fn();
    const off = onBrowserShortcut(tabId, seen);
    workspaceCommands.pickElement();
    off();
    expect(seen).not.toHaveBeenCalled();
  });
});
