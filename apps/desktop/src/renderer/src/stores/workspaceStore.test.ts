import { allGroups, allTabIds, findGroup, findGroupOfTab } from '@runova/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type FakeBridge, installRunovaBridge } from '../../../test/renderer/runovaBridge';
import { useBrowserStore } from './browserStore';
import { useEditorRevealStore } from './editorRevealStore';
import { useRecentFilesStore } from './recentFilesStore';
import {
  GIT_PANEL_DEFAULT_WIDTH,
  type ProjectWorkspace,
  terminalTabLabel,
  useWorkspaceStore,
} from './workspaceStore';

const dispose = vi.hoisted(() => vi.fn());

// The runtime owns real xterm instances; only the two calls closing a tab makes matter here.
vi.mock('@/lib/terminal/terminalRuntime', () => ({
  terminalRuntime: { dispose, mount: vi.fn(), unmount: vi.fn(), focus: vi.fn() },
}));

const disposeBrowser = vi.hoisted(() => vi.fn());
vi.mock('@/lib/browser/browserRuntime', () => ({
  browserRuntime: { dispose: disposeBrowser },
}));

let bridge: FakeBridge;

function store() {
  return useWorkspaceStore.getState();
}

function workspace(projectId = 'p1'): ProjectWorkspace {
  const current = store().workspaces[projectId];
  if (!current) throw new Error(`no workspace for ${projectId}`);
  return current;
}

/** Opens a project with one terminal tab and hands back both ids. */
function withTerminal(projectId = 'p1'): { tabId: string; groupId: string } {
  store().openProject(projectId);
  const tabId = store().addTerminal(projectId, { title: 'PowerShell', cwd: 'E:\\proj' });
  return { tabId, groupId: workspace(projectId).focusedGroupId };
}

beforeEach(() => {
  bridge = installRunovaBridge();
  dispose.mockClear();
  disposeBrowser.mockClear();
  useBrowserStore.setState({ annotations: {}, recentUrls: {} });
  useWorkspaceStore.setState({
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
      openSourceSections: {
        changes: true,
        stashes: false,
        branches: false,
        commits: false,
        pullRequest: false,
        pipelines: false,
        worktrees: false,
      },
      sourceSectionHeights: {},
      mergeMethods: {},
    },
  });
});

describe('the initial state', () => {
  it('has nothing open and a changes panel at its default width', () => {
    expect(store().workspaces).toEqual({});
    expect(store().railProjectIds).toEqual([]);
    expect(store().activeProjectId).toBeNull();
    expect(store().gitPanel).toMatchObject({
      width: GIT_PANEL_DEFAULT_WIDTH,
      collapsed: false,
      activeSection: 'sourceControl',
    });
  });
});

describe('setMergeMethod', () => {
  it('squashes by default and remembers a change per project', () => {
    expect(store().gitPanel.mergeMethods).toEqual({});
    store().setMergeMethod('p1', 'rebase');
    expect(store().gitPanel.mergeMethods).toEqual({ p1: 'rebase' });
    store().setMergeMethod('p2', 'merge');
    expect(store().gitPanel.mergeMethods).toEqual({ p1: 'rebase', p2: 'merge' });
  });
});

describe('openProject', () => {
  it('adds the project to the rail with an empty workspace and makes it active', () => {
    store().openProject('p1');
    expect(store().railProjectIds).toEqual(['p1']);
    expect(store().activeProjectId).toBe('p1');
    expect(allGroups(workspace().root)).toHaveLength(1);
    expect(workspace().tabs).toEqual({});
  });

  it('only brings a project already in the rail forward, keeping its tabs', () => {
    const { tabId } = withTerminal();
    store().openProject('p2');
    store().openProject('p1');
    expect(store().railProjectIds).toEqual(['p1', 'p2']);
    expect(store().activeProjectId).toBe('p1');
    expect(workspace().tabs[tabId]).toBeDefined();
  });
});

describe('closeProject', () => {
  it('ends every shell it had open and drops the workspace', () => {
    const { tabId } = withTerminal();
    store().closeProject('p1');
    expect(bridge.$fn('terminal.kill')).toHaveBeenCalledWith(tabId);
    expect(dispose).toHaveBeenCalledWith(tabId);
    expect(store().workspaces.p1).toBeUndefined();
    expect(store().railProjectIds).toEqual([]);
    expect(store().activeProjectId).toBeNull();
  });

  it('moves to the project that took its place in the rail', () => {
    store().openProject('p1');
    store().openProject('p2');
    store().openProject('p3');
    store().openProject('p2');
    store().closeProject('p2');
    expect(store().activeProjectId).toBe('p3');
  });

  it('falls back to the last project when the closed one was at the end', () => {
    store().openProject('p1');
    store().openProject('p2');
    store().closeProject('p2');
    expect(store().activeProjectId).toBe('p1');
  });

  it('leaves the active project alone when another one closes', () => {
    store().openProject('p1');
    store().openProject('p2');
    store().closeProject('p1');
    expect(store().activeProjectId).toBe('p2');
  });
});

describe('moveRailProject', () => {
  beforeEach(() => {
    for (const id of ['a', 'b', 'c']) store().openProject(id);
  });

  it('moves a project later in the rail', () => {
    // The index counts slots in the rail as it was, with the dragged project still in it.
    store().moveRailProject('a', 2);
    expect(store().railProjectIds).toEqual(['b', 'a', 'c']);
  });

  it('moves a project earlier in the rail', () => {
    store().moveRailProject('c', 0);
    expect(store().railProjectIds).toEqual(['c', 'a', 'b']);
  });

  it('moves a project to the end', () => {
    store().moveRailProject('a', 3);
    expect(store().railProjectIds).toEqual(['b', 'c', 'a']);
  });

  it('does nothing when the project would land where it already is', () => {
    const before = store().railProjectIds;
    store().moveRailProject('b', 1);
    expect(store().railProjectIds).toBe(before);
  });

  it('does nothing for a project that is not in the rail', () => {
    const before = store().railProjectIds;
    store().moveRailProject('zz', 0);
    expect(store().railProjectIds).toBe(before);
  });
});

describe('addTerminal', () => {
  it('puts the tab in the focused pane and keeps what it was launched with', () => {
    store().openProject('p1');
    const tabId = store().addTerminal('p1', {
      title: 'Claude Code',
      cwd: 'E:\\proj',
      cliId: 'claude-code',
      launchInput: 'claude\r',
    });
    expect(workspace().tabs[tabId]).toMatchObject({
      kind: 'terminal',
      title: 'Claude Code',
      cliId: 'claude-code',
      launchInput: 'claude\r',
    });
    expect(findGroupOfTab(workspace().root, tabId)?.id).toBe(workspace().focusedGroupId);
  });

  it('puts the tab in the pane it was asked for, and focuses that pane', () => {
    const { groupId } = withTerminal();
    const other = store().splitGroup('p1', groupId, 'row');
    store().focusGroup('p1', groupId);
    const tabId = store().addTerminal('p1', { title: 'bash', cwd: '/' }, other);
    expect(findGroupOfTab(workspace().root, tabId)?.id).toBe(other);
    expect(workspace().focusedGroupId).toBe(other);
  });

  it('falls back to the focused pane when the pane it was given is gone', () => {
    const { groupId } = withTerminal();
    const tabId = store().addTerminal('p1', { title: 'bash', cwd: '/' }, 'g-missing');
    expect(findGroupOfTab(workspace().root, tabId)?.id).toBe(groupId);
  });

  it('does nothing for a project that is not open', () => {
    store().addTerminal('nope', { title: 'bash', cwd: '/' });
    expect(store().workspaces.nope).toBeUndefined();
  });
});

describe('closeTab', () => {
  it('ends the shell and takes the tab out of the tree', () => {
    const { tabId } = withTerminal();
    store().closeTab('p1', tabId);
    expect(bridge.$fn('terminal.kill')).toHaveBeenCalledWith(tabId);
    expect(dispose).toHaveBeenCalledWith(tabId);
    expect(workspace().tabs[tabId]).toBeUndefined();
    expect(allTabIds(workspace().root)).toEqual([]);
  });

  it('ends no shell for a diff tab', () => {
    store().openProject('p1');
    store().openDiff('p1', { path: 'a.ts', side: 'unstaged' });
    const [tabId] = Object.keys(workspace().tabs);
    store().closeTab('p1', tabId);
    expect(workspace().tabs[tabId]).toBeUndefined();
    expect(dispose).not.toHaveBeenCalled();
  });
});

describe('restartTab', () => {
  it('starts a fresh shell in the same place, keeping the launch settings', () => {
    store().openProject('p1');
    const tabId = store().addTerminal('p1', {
      title: 'Claude Code',
      cwd: 'E:\\proj',
      launchInput: 'claude\r',
      restored: true,
    });
    store().restartTab('p1', tabId);
    const ids = allTabIds(workspace().root);
    expect(ids).toHaveLength(1);
    expect(ids[0]).not.toBe(tabId);
    const fresh = workspace().tabs[ids[0]];
    expect(fresh).toMatchObject({ title: 'Claude Code', launchInput: 'claude\r' });
    // A restart is the one time the launch command is typed again, so it is no longer restored.
    expect(fresh.kind === 'terminal' && fresh.restored).toBe(false);
    expect(bridge.$fn('terminal.kill')).toHaveBeenCalledWith(tabId);
  });

  it('forgets the conversation on a plain restart, since that starts a new one', () => {
    store().openProject('p1');
    const tabId = store().addTerminal('p1', {
      title: 'Claude Code',
      cliId: 'claude-code',
      cwd: 'E:\\proj',
      launchInput: 'claude\r',
    });
    store().setConversationId('p1', tabId, 'abc-123');
    store().setAgentTitle('p1', tabId, 'Fix the login bug');
    store().restartTab('p1', tabId);
    const fresh = Object.values(workspace().tabs)[0];
    expect(fresh).toMatchObject({ launchInput: 'claude\r' });
    expect(fresh?.kind === 'terminal' && fresh.conversationId).toBeUndefined();
    expect(fresh?.kind === 'terminal' && fresh.agentTitle).toBeUndefined();
  });

  it('resumes the same conversation, keeping its name and id', () => {
    store().openProject('p1');
    const tabId = store().addTerminal('p1', {
      title: 'Claude Code',
      cliId: 'claude-code',
      cwd: 'E:\\proj',
      launchInput: 'claude\r',
      restored: true,
    });
    store().setConversationId('p1', tabId, 'abc-123');
    store().setAgentTitle('p1', tabId, 'Fix the login bug');
    store().restartTab('p1', tabId, 'claude --resume abc-123\r');
    const fresh = Object.values(workspace().tabs)[0];
    expect(fresh).toMatchObject({
      launchInput: 'claude --resume abc-123\r',
      conversationId: 'abc-123',
      agentTitle: 'Fix the login bug',
      restored: false,
    });
  });

  it('does nothing for a tab that is not a terminal', () => {
    store().openProject('p1');
    store().openFile('p1', 'E:\\proj\\a.ts');
    const [tabId] = Object.keys(workspace().tabs);
    store().restartTab('p1', tabId);
    expect(workspace().tabs[tabId]).toBeDefined();
  });
});

describe('activateTab and focusGroup', () => {
  it('brings a tab forward and focuses the pane holding it', () => {
    const { tabId, groupId } = withTerminal();
    const other = store().splitGroup('p1', groupId, 'row');
    expect(workspace().focusedGroupId).toBe(other);
    store().activateTab('p1', tabId);
    expect(workspace().focusedGroupId).toBe(groupId);
    expect(findGroup(workspace().root, groupId)?.activeTabId).toBe(tabId);
  });

  it('changes nothing when the pane is already focused', () => {
    const { groupId } = withTerminal();
    const before = workspace();
    store().focusGroup('p1', groupId);
    expect(workspace()).toStrictEqual(before);
  });
});

describe('splitGroup and closeGroup', () => {
  it('adds an empty pane and focuses it', () => {
    const { groupId } = withTerminal();
    const newGroup = store().splitGroup('p1', groupId, 'row');
    expect(allGroups(workspace().root).map((group) => group.id)).toEqual([groupId, newGroup]);
    expect(findGroup(workspace().root, newGroup)?.tabIds).toEqual([]);
    expect(workspace().focusedGroupId).toBe(newGroup);
  });

  it('can add the pane on the other side', () => {
    const { groupId } = withTerminal();
    const newGroup = store().splitGroup('p1', groupId, 'column', 'before');
    expect(allGroups(workspace().root).map((group) => group.id)).toEqual([newGroup, groupId]);
  });

  it('drops any zoom, since a second pane has to be visible to be split into', () => {
    const { groupId } = withTerminal();
    store().toggleZoom('p1', groupId);
    store().splitGroup('p1', groupId, 'row');
    expect(workspace().zoomedGroupId).toBeNull();
  });

  it('closes a pane and ends every shell in it', () => {
    const { groupId } = withTerminal();
    const other = store().splitGroup('p1', groupId, 'row');
    const tabId = store().addTerminal('p1', { title: 'bash', cwd: '/' }, other);
    store().closeGroup('p1', other);
    expect(bridge.$fn('terminal.kill')).toHaveBeenCalledWith(tabId);
    expect(workspace().tabs[tabId]).toBeUndefined();
    expect(allGroups(workspace().root).map((group) => group.id)).toEqual([groupId]);
  });

  it('keeps the last pane, emptied, so there is still somewhere to launch from', () => {
    const { tabId, groupId } = withTerminal();
    store().closeGroup('p1', groupId);
    expect(allGroups(workspace().root)).toHaveLength(1);
    expect(workspace().tabs[tabId]).toBeUndefined();
    expect(workspace().focusedGroupId).toBe(allGroups(workspace().root)[0].id);
  });

  it('moves focus onto a pane that still exists', () => {
    const { groupId } = withTerminal();
    const other = store().splitGroup('p1', groupId, 'row');
    store().closeGroup('p1', other);
    expect(workspace().focusedGroupId).toBe(groupId);
  });

  it('drops a zoom on a pane that was closed', () => {
    const { groupId } = withTerminal();
    const other = store().splitGroup('p1', groupId, 'row');
    store().toggleZoom('p1', other);
    store().closeGroup('p1', other);
    expect(workspace().zoomedGroupId).toBeNull();
  });

  it('does nothing for a pane that is not there', () => {
    withTerminal();
    const before = workspace();
    store().closeGroup('p1', 'g-missing');
    expect(workspace()).toBe(before);
  });
});

describe('moveTab and setSplitRatio', () => {
  it('moves a tab into another pane and focuses that pane', () => {
    const { tabId, groupId } = withTerminal();
    const other = store().splitGroup('p1', groupId, 'row');
    store().moveTab('p1', tabId, other);
    expect(findGroupOfTab(workspace().root, tabId)?.id).toBe(other);
    expect(workspace().focusedGroupId).toBe(other);
  });

  it('moves a tab to a given position within a pane', () => {
    const { groupId } = withTerminal();
    const second = store().addTerminal('p1', { title: 'two', cwd: '/' }, groupId);
    store().moveTab('p1', second, groupId, 0);
    expect(findGroup(workspace().root, groupId)?.tabIds[0]).toBe(second);
  });

  it('resizes a split', () => {
    const { groupId } = withTerminal();
    store().splitGroup('p1', groupId, 'row');
    const root = workspace().root;
    if (root.type !== 'split') throw new Error('the root should be a split');
    store().setSplitRatio('p1', root.id, 0.3);
    const updated = workspace().root;
    expect(updated.type === 'split' && updated.ratio).toBe(0.3);
  });
});

describe('renameTab', () => {
  it('gives a terminal tab a name of the user is own', () => {
    const { tabId } = withTerminal();
    store().renameTab('p1', tabId, 'Backend');
    const tab = workspace().tabs[tabId];
    expect(tab.kind === 'terminal' && terminalTabLabel(tab)).toBe('Backend');
  });

  it('goes back to the launched name when the box is emptied', () => {
    const { tabId } = withTerminal();
    store().renameTab('p1', tabId, 'Backend');
    store().renameTab('p1', tabId, '   ');
    const tab = workspace().tabs[tabId];
    expect(tab.kind === 'terminal' && terminalTabLabel(tab)).toBe('PowerShell');
  });

  it('leaves a diff tab alone', () => {
    store().openProject('p1');
    store().openDiff('p1', { path: 'a.ts', side: 'unstaged' });
    const [tabId] = Object.keys(workspace().tabs);
    const before = workspace();
    store().renameTab('p1', tabId, 'nope');
    expect(workspace()).toStrictEqual(before);
  });
});

describe('setAgentTitle', () => {
  it('keeps the name the agent gave its task', () => {
    const { tabId } = withTerminal();
    store().setAgentTitle('p1', tabId, 'Fix the login bug');
    const tab = workspace().tabs[tabId];
    expect(tab.kind === 'terminal' && terminalTabLabel(tab)).toBe('Fix the login bug');
  });

  it('lets the name the user typed win', () => {
    const { tabId } = withTerminal();
    store().renameTab('p1', tabId, 'Backend');
    store().setAgentTitle('p1', tabId, 'Fix the login bug');
    const tab = workspace().tabs[tabId];
    expect(tab.kind === 'terminal' && terminalTabLabel(tab)).toBe('Backend');
  });

  it('ignores an empty title so the tab keeps the name it had', () => {
    const { tabId } = withTerminal();
    store().setAgentTitle('p1', tabId, 'Fix the login bug');
    store().setAgentTitle('p1', tabId, '  ');
    const tab = workspace().tabs[tabId];
    expect(tab.kind === 'terminal' && terminalTabLabel(tab)).toBe('Fix the login bug');
  });

  it('drops the old task name when the tab restarts', () => {
    const { tabId } = withTerminal();
    store().setAgentTitle('p1', tabId, 'Fix the login bug');
    store().restartTab('p1', tabId);
    const tab = Object.values(workspace().tabs)[0];
    expect(tab?.kind === 'terminal' && terminalTabLabel(tab)).toBe('PowerShell');
  });
});

describe('setAutoContinue', () => {
  it('turns each option on and off without touching the other', () => {
    const { tabId } = withTerminal();
    store().setAutoContinue('p1', tabId, { afterLimitReset: true });
    store().setAutoContinue('p1', tabId, { afterNetworkError: true });
    expect(workspace().tabs[tabId]).toMatchObject({
      autoContinue: { afterLimitReset: true, afterNetworkError: true },
    });

    store().setAutoContinue('p1', tabId, { afterLimitReset: false });
    expect(workspace().tabs[tabId]).toMatchObject({
      autoContinue: { afterLimitReset: false, afterNetworkError: true },
    });
  });

  it('keeps the options when the tab is restarted', () => {
    const { tabId } = withTerminal();
    store().setAutoContinue('p1', tabId, { afterNetworkError: true });
    store().restartTab('p1', tabId);
    const [freshId] = allTabIds(workspace().root);
    expect(freshId).not.toBe(tabId);
    expect(workspace().tabs[freshId]).toMatchObject({
      autoContinue: { afterNetworkError: true },
    });
  });

  it('leaves a file tab alone', () => {
    store().openProject('p1');
    store().openFile('p1', 'E:\\proj\\a.ts');
    const [tabId] = Object.keys(workspace().tabs);
    const before = workspace();
    store().setAutoContinue('p1', tabId, { afterLimitReset: true });
    expect(workspace()).toStrictEqual(before);
  });
});

describe('toggleZoom', () => {
  it('blows a pane up and puts it back, focusing it either way', () => {
    const { groupId } = withTerminal();
    const other = store().splitGroup('p1', groupId, 'row');
    store().toggleZoom('p1', groupId);
    expect(workspace().zoomedGroupId).toBe(groupId);
    expect(workspace().focusedGroupId).toBe(groupId);
    store().toggleZoom('p1', groupId);
    expect(workspace().zoomedGroupId).toBeNull();
    store().toggleZoom('p1', other);
    expect(workspace().zoomedGroupId).toBe(other);
  });

  it('will not zoom the only pane there is', () => {
    const { groupId } = withTerminal();
    store().toggleZoom('p1', groupId);
    expect(workspace().zoomedGroupId).toBeNull();
  });
});

describe('openDiff', () => {
  beforeEach(() => {
    store().openProject('p1');
  });

  it('opens a preview tab that the next file replaces', () => {
    store().openDiff('p1', { path: 'a.ts', side: 'unstaged' });
    const first = Object.keys(workspace().tabs)[0];
    store().openDiff('p1', { path: 'b.ts', side: 'unstaged' });
    expect(Object.keys(workspace().tabs)).toEqual([first]);
    expect(workspace().tabs[first]).toMatchObject({ path: 'b.ts', preview: true });
  });

  it('keeps a pinned tab open and opens the next one beside it', () => {
    store().openDiff('p1', { path: 'a.ts', side: 'unstaged' }, { pin: true });
    store().openDiff('p1', { path: 'b.ts', side: 'unstaged' });
    expect(Object.keys(workspace().tabs)).toHaveLength(2);
  });

  it('brings an already open diff forward instead of opening a second one', () => {
    store().openDiff('p1', { path: 'a.ts', side: 'unstaged' }, { pin: true });
    const [tabId] = Object.keys(workspace().tabs);
    store().openDiff('p1', { path: 'b.ts', side: 'unstaged' }, { pin: true });
    store().openDiff('p1', { path: 'a.ts', side: 'unstaged' });
    expect(Object.keys(workspace().tabs)).toHaveLength(2);
    expect(findGroup(workspace().root, workspace().focusedGroupId)?.activeTabId).toBe(tabId);
  });

  it('pins a tab that was already open when asked to', () => {
    store().openDiff('p1', { path: 'a.ts', side: 'unstaged' });
    const [tabId] = Object.keys(workspace().tabs);
    store().openDiff('p1', { path: 'a.ts', side: 'unstaged' }, { pin: true });
    expect(workspace().tabs[tabId]).toMatchObject({ preview: false });
  });

  it('tells the same file on different sides, and in a commit, apart', () => {
    store().openDiff('p1', { path: 'a.ts', side: 'unstaged' }, { pin: true });
    store().openDiff('p1', { path: 'a.ts', side: 'staged' }, { pin: true });
    store().openDiff('p1', { path: 'a.ts', side: 'staged', commit: 'abc' }, { pin: true });
    expect(Object.keys(workspace().tabs)).toHaveLength(3);
  });

  it('keeps where a staged rename came from', () => {
    store().openDiff('p1', { path: 'b.ts', origPath: 'a.ts', side: 'staged' });
    expect(Object.values(workspace().tabs)[0]).toMatchObject({ origPath: 'a.ts' });
  });

  it('un-zooms, so the file being opened is actually visible', () => {
    const groupId = workspace().focusedGroupId;
    store().addTerminal('p1', { title: 'sh', cwd: '/' });
    store().splitGroup('p1', groupId, 'row');
    store().toggleZoom('p1', groupId);
    store().openDiff('p1', { path: 'a.ts', side: 'unstaged' });
    expect(workspace().zoomedGroupId).toBeNull();
  });
});

describe('openFile', () => {
  beforeEach(() => {
    store().openProject('p1');
  });

  it('opens a preview tab, and reuses it for the next file', () => {
    store().openFile('p1', 'E:\\proj\\a.ts');
    const [tabId] = Object.keys(workspace().tabs);
    store().openFile('p1', 'E:\\proj\\b.ts');
    expect(Object.keys(workspace().tabs)).toEqual([tabId]);
    expect(workspace().tabs[tabId]).toMatchObject({ kind: 'file', path: 'E:\\proj\\b.ts' });
  });

  it('shares the preview slot with a diff tab', () => {
    store().openDiff('p1', { path: 'a.ts', side: 'unstaged' });
    store().openFile('p1', 'E:\\proj\\a.ts');
    expect(Object.keys(workspace().tabs)).toHaveLength(1);
  });

  it('brings an already open file forward', () => {
    store().openFile('p1', 'E:\\proj\\a.ts', { pin: true });
    const [tabId] = Object.keys(workspace().tabs);
    store().openFile('p1', 'E:\\proj\\b.ts', { pin: true });
    store().openFile('p1', 'E:\\proj\\a.ts');
    expect(findGroup(workspace().root, workspace().focusedGroupId)?.activeTabId).toBe(tabId);
  });

  it('counts as a recent file for the search dialog', () => {
    store().openFile('p1', 'E:\\proj\\a.ts');
    store().openFile('p1', 'E:\\proj\\b.ts');
    expect(useRecentFilesStore.getState().byProject.p1).toEqual([
      'E:\\proj\\b.ts',
      'E:\\proj\\a.ts',
    ]);
  });

  it('asks the editor to show a line when given one', () => {
    store().openFile('p1', 'E:\\proj\\a.ts', { reveal: { line: 12, column: 5, length: 3 } });
    expect(useEditorRevealStore.getState().pending['E:\\proj\\a.ts']).toMatchObject({
      line: 12,
      column: 5,
      length: 3,
    });
  });

  it('makes a file recent again when its tab is picked', () => {
    store().openFile('p1', 'E:\\proj\\a.ts', { pin: true });
    const [tabId] = Object.keys(workspace().tabs);
    store().openFile('p1', 'E:\\proj\\b.ts', { pin: true });
    store().activateTab('p1', tabId);
    expect(useRecentFilesStore.getState().byProject.p1?.[0]).toBe('E:\\proj\\a.ts');
  });
});

describe('recent files follow the explorer', () => {
  beforeEach(() => {
    store().openProject('p1');
  });

  it('follows a rename', () => {
    store().openFile('p1', 'E:\\proj\\a.ts', { pin: true });
    store().retargetFileTabs('p1', 'E:\\proj\\a.ts', 'E:\\proj\\b.ts');
    expect(useRecentFilesStore.getState().byProject.p1).toEqual(['E:\\proj\\b.ts']);
  });

  it('forgets a deleted file', () => {
    store().openFile('p1', 'E:\\proj\\src\\a.ts', { pin: true });
    store().closeFileTabsUnder('p1', ['E:\\proj\\src']);
    expect(useRecentFilesStore.getState().byProject.p1 ?? []).toEqual([]);
  });
});

describe('retargetFileTabs', () => {
  beforeEach(() => {
    store().openProject('p1');
  });

  it('points a renamed file is tab at its new path, keeping the tab', () => {
    // The tab keeps its unsaved edits, which reopening it would lose.
    store().openFile('p1', 'E:\\proj\\a.ts', { pin: true });
    const [tabId] = Object.keys(workspace().tabs);
    store().retargetFileTabs('p1', 'E:\\proj\\a.ts', 'E:\\proj\\b.ts');
    expect(workspace().tabs[tabId]).toMatchObject({ path: 'E:\\proj\\b.ts' });
  });

  it('follows a file whose folder was moved', () => {
    store().openFile('p1', 'E:\\proj\\src\\a.ts', { pin: true });
    const [tabId] = Object.keys(workspace().tabs);
    store().retargetFileTabs('p1', 'E:\\proj\\src', 'E:\\proj\\lib');
    expect(workspace().tabs[tabId]).toMatchObject({ path: 'E:\\proj\\lib\\a.ts' });
  });

  it('leaves the state alone when nothing matched', () => {
    store().openFile('p1', 'E:\\proj\\a.ts', { pin: true });
    const before = workspace();
    store().retargetFileTabs('p1', 'E:\\proj\\other.ts', 'E:\\proj\\x.ts');
    expect(workspace()).toStrictEqual(before);
  });
});

describe('closeFileTabsUnder', () => {
  beforeEach(() => {
    store().openProject('p1');
  });

  it('closes the tab of a deleted file', () => {
    store().openFile('p1', 'E:\\proj\\a.ts', { pin: true });
    store().closeFileTabsUnder('p1', ['E:\\proj\\a.ts']);
    expect(workspace().tabs).toEqual({});
    expect(allTabIds(workspace().root)).toEqual([]);
  });

  it('closes everything inside a deleted folder', () => {
    store().openFile('p1', 'E:\\proj\\src\\a.ts', { pin: true });
    store().openFile('p1', 'E:\\proj\\src\\b.ts', { pin: true });
    store().openFile('p1', 'E:\\proj\\keep.ts', { pin: true });
    store().closeFileTabsUnder('p1', ['E:\\proj\\src']);
    expect(Object.values(workspace().tabs)).toHaveLength(1);
    expect(Object.values(workspace().tabs)[0]).toMatchObject({ path: 'E:\\proj\\keep.ts' });
  });

  it('leaves terminal and diff tabs alone', () => {
    const tabId = store().addTerminal('p1', { title: 'sh', cwd: 'E:\\proj' });
    store().closeFileTabsUnder('p1', ['E:\\proj']);
    expect(workspace().tabs[tabId]).toBeDefined();
  });

  it('leaves the state alone when nothing matched', () => {
    store().openFile('p1', 'E:\\proj\\a.ts', { pin: true });
    const before = workspace();
    store().closeFileTabsUnder('p1', ['E:\\other']);
    expect(workspace()).toStrictEqual(before);
  });
});

describe('coming back from a saved layout', () => {
  interface SavedTab {
    kind: string;
    id: string;
    [key: string]: unknown;
  }

  function seed(state: Record<string, unknown>): void {
    localStorage.setItem('runova-workspaces', JSON.stringify({ state, version: 1 }));
  }

  function savedWorkspace(tabs: SavedTab[], patch: Record<string, unknown> = {}) {
    return {
      root: {
        type: 'group',
        id: 'g1',
        tabIds: tabs.map((tab) => tab.id),
        activeTabId: tabs[0]?.id,
      },
      tabs: Object.fromEntries(tabs.map((tab) => [tab.id, tab])),
      focusedGroupId: 'g1',
      zoomedGroupId: null,
      ...patch,
    };
  }

  async function rehydrate(): Promise<void> {
    await useWorkspaceStore.persist.rehydrate();
  }

  it('brings back the rail, the tabs and the panel width', async () => {
    seed({
      railProjectIds: ['p1'],
      activeProjectId: 'p1',
      gitPanel: { width: 420, collapsed: true, activeSection: 'explorer' },
      workspaces: {
        p1: savedWorkspace([{ kind: 'terminal', id: 't1', title: 'PowerShell', cwd: 'E:\\proj' }]),
      },
    });
    await rehydrate();
    expect(store().railProjectIds).toEqual(['p1']);
    expect(store().activeProjectId).toBe('p1');
    expect(store().gitPanel).toMatchObject({
      width: 420,
      collapsed: true,
      activeSection: 'explorer',
    });
    expect(allTabIds(workspace().root)).toEqual(['t1']);
  });

  it('marks every restored terminal, so it reconnects instead of starting a shell', async () => {
    // A restored tab must never replay its launch command, which would run the agent twice.
    seed({
      railProjectIds: ['p1'],
      workspaces: {
        p1: savedWorkspace([
          {
            kind: 'terminal',
            id: 't1',
            title: 'Claude Code',
            cwd: 'E:\\proj',
            launchInput: 'claude\r',
          },
        ]),
      },
    });
    await rehydrate();
    const tab = workspace().tabs.t1;
    expect(tab.kind === 'terminal' && tab.restored).toBe(true);
  });

  it('forgets a tab that no pane holds any more', async () => {
    seed({
      railProjectIds: ['p1'],
      workspaces: {
        p1: {
          root: { type: 'group', id: 'g1', tabIds: ['t1'], activeTabId: 't1' },
          tabs: {
            t1: { kind: 'terminal', id: 't1', title: 'a', cwd: '/' },
            orphan: { kind: 'terminal', id: 'orphan', title: 'b', cwd: '/' },
          },
          focusedGroupId: 'g1',
          zoomedGroupId: null,
        },
      },
    });
    await rehydrate();
    expect(Object.keys(workspace().tabs)).toEqual(['t1']);
  });

  it('drops a project in the rail that has no workspace left', async () => {
    seed({
      railProjectIds: ['p1', 'gone'],
      activeProjectId: 'gone',
      workspaces: { p1: savedWorkspace([{ kind: 'terminal', id: 't1', title: 'a', cwd: '/' }]) },
    });
    await rehydrate();
    expect(store().railProjectIds).toEqual(['p1']);
    expect(store().activeProjectId).toBe('p1');
  });

  it('has no active project when the rail comes back empty', async () => {
    seed({ railProjectIds: [], activeProjectId: 'p1', workspaces: {} });
    await rehydrate();
    expect(store().activeProjectId).toBeNull();
  });

  it('falls back to Source control for a panel tab it does not know', async () => {
    seed({ railProjectIds: [], gitPanel: { activeSection: 'something-else' }, workspaces: {} });
    await rehydrate();
    expect(store().gitPanel.activeSection).toBe('sourceControl');
  });

  it('turns an old Pull request tab into Source control with that section open', async () => {
    seed({ railProjectIds: [], gitPanel: { activeSection: 'pullRequest' }, workspaces: {} });
    await rehydrate();
    expect(store().gitPanel.activeSection).toBe('sourceControl');
    expect(store().gitPanel.openSourceSections).toMatchObject({
      changes: true,
      pullRequest: true,
      commits: false,
    });
  });

  it('keeps the folded sections and drops what it does not know', async () => {
    seed({
      railProjectIds: [],
      gitPanel: { openSourceSections: { changes: false, commits: true, pipelines: 'yes', x: 1 } },
      workspaces: {},
    });
    await rehydrate();
    expect(store().gitPanel.openSourceSections).toEqual({
      changes: false,
      stashes: false,
      branches: false,
      commits: true,
      pullRequest: false,
      pipelines: false,
      worktrees: false,
    });
  });

  it('keeps the dragged section heights and drops what it cannot use', async () => {
    seed({
      railProjectIds: [],
      gitPanel: {
        sourceSectionHeights: { branches: 180, commits: -4, pipelines: 'tall', x: 90 },
      },
      workspaces: {},
    });
    await rehydrate();
    expect(store().gitPanel.sourceSectionHeights).toEqual({ branches: 180 });
  });

  it('keeps each project’s merge method and drops one it does not know', async () => {
    seed({
      railProjectIds: [],
      gitPanel: { mergeMethods: { p1: 'rebase', p2: 'octopus', p3: 7 } },
      workspaces: {},
    });
    await rehydrate();
    expect(store().gitPanel.mergeMethods).toEqual({ p1: 'rebase' });
  });

  it('survives a saved layout with nothing usable in it', async () => {
    seed({
      railProjectIds: ['p1'],
      workspaces: { p1: { root: null, tabs: null, focusedGroupId: 7 } },
    });
    await rehydrate();
    expect(allGroups(workspace().root)).toHaveLength(1);
    expect(workspace().focusedGroupId).toBe(allGroups(workspace().root)[0].id);
  });

  it('starts empty when there is nothing saved at all', async () => {
    localStorage.removeItem('runova-workspaces');
    await rehydrate();
    expect(store().workspaces).toEqual({});
    expect(store().railProjectIds).toEqual([]);
  });

  it('keeps preview tabs out of what gets saved', () => {
    store().openProject('p1');
    store().openDiff('p1', { path: 'a.ts', side: 'unstaged' });
    store().openFile('p1', 'E:\\proj\\b.ts', { pin: true });
    const saved = JSON.parse(localStorage.getItem('runova-workspaces') ?? '{}');
    const tabs = saved.state.workspaces.p1.tabs as Record<string, { kind: string }>;
    // A preview tab is throwaway by definition, so it never comes back after a restart.
    expect(Object.values(tabs).map((tab) => tab.kind)).toEqual(['file']);
  });
});

describe('setGitPanel', () => {
  it('patches only what it was given', () => {
    store().setGitPanel({ collapsed: true });
    expect(store().gitPanel).toMatchObject({ collapsed: true, width: GIT_PANEL_DEFAULT_WIDTH });
    store().setGitPanel({ activeSection: 'tests' });
    expect(store().gitPanel).toMatchObject({ collapsed: true, activeSection: 'tests' });
  });

  it('reveals a Source control section by switching tab and unfolding it', () => {
    store().setGitPanel({ collapsed: true, activeSection: 'tests' });
    store().revealPanelSection('branches');
    expect(store().gitPanel).toMatchObject({ collapsed: false, activeSection: 'sourceControl' });
    expect(store().gitPanel.openSourceSections.branches).toBe(true);
    store().revealPanelSection('explorer');
    expect(store().gitPanel.activeSection).toBe('explorer');
  });

  it('reveals the Worktrees section, which starts folded', () => {
    expect(store().gitPanel.openSourceSections.worktrees).toBe(false);
    store().revealPanelSection('worktrees');
    expect(store().gitPanel).toMatchObject({ activeSection: 'sourceControl' });
    expect(store().gitPanel.openSourceSections.worktrees).toBe(true);
  });

  it('folds one Source control section without touching the rest', () => {
    store().setSourceSectionOpen('changes', false);
    store().setSourceSectionOpen('pipelines', true);
    expect(store().gitPanel.openSourceSections).toMatchObject({
      changes: false,
      pipelines: true,
      branches: false,
    });
  });

  it('remembers which sections were folded away', () => {
    store().setGitPanel({ collapsedSections: { staged: true } });
    expect(store().gitPanel.collapsedSections).toEqual({ staged: true });
  });
});

describe('worktree workspaces', () => {
  const SCOPE = 'p1~wt-1';

  it('opens a worktree as a workspace of its own, with only its project in the rail', () => {
    store().openProject(SCOPE);
    expect(store().activeProjectId).toBe(SCOPE);
    expect(store().railProjectIds).toEqual(['p1']);
    expect(store().workspaces[SCOPE]).toBeDefined();
    expect(store().workspaces.p1).toBeUndefined();
  });

  it('keeps the tabs of the worktree and the main checkout apart', () => {
    const main = withTerminal('p1');
    const tree = withTerminal(SCOPE);
    expect(Object.keys(workspace('p1').tabs)).toEqual([main.tabId]);
    expect(Object.keys(workspace(SCOPE).tabs)).toEqual([tree.tabId]);
  });

  it('closeWorkspace ends only that worktree’s shells and goes back to the main checkout', () => {
    const main = withTerminal('p1');
    const tree = withTerminal(SCOPE);
    store().closeWorkspace(SCOPE);
    expect(bridge.$fn('terminal.kill')).toHaveBeenCalledWith(tree.tabId);
    expect(bridge.$fn('terminal.kill')).not.toHaveBeenCalledWith(main.tabId);
    expect(store().workspaces[SCOPE]).toBeUndefined();
    expect(store().activeProjectId).toBe('p1');
    expect(store().railProjectIds).toEqual(['p1']);
  });

  it('closeWorkspace leaves the active workspace alone when another one closes', () => {
    withTerminal(SCOPE);
    store().openProject('p2');
    store().closeWorkspace(SCOPE);
    expect(store().activeProjectId).toBe('p2');
  });

  it('closing a project closes its worktree workspaces too', () => {
    const tree = withTerminal(SCOPE);
    store().openProject('p2');
    store().openProject('p1~wt-2');
    store().closeProject('p1');
    expect(bridge.$fn('terminal.kill')).toHaveBeenCalledWith(tree.tabId);
    expect(Object.keys(store().workspaces)).toEqual(['p2']);
    expect(store().railProjectIds).toEqual(['p2']);
    expect(store().activeProjectId).toBe('p2');
  });

  it('remembers which projects show their worktrees in the rail', () => {
    expect(store().railExpanded.p1).toBeUndefined();
    store().setRailExpanded('p1', false);
    expect(store().railExpanded.p1).toBe(false);
    store().setRailExpanded('p1', true);
    expect(store().railExpanded.p1).toBe(true);
  });

  it('brings worktree workspaces back, and drops ones whose project left the rail', async () => {
    localStorage.setItem(
      'runova-workspaces',
      JSON.stringify({
        version: 1,
        state: {
          railProjectIds: ['p1'],
          activeProjectId: SCOPE,
          railExpanded: { p1: false, junk: 'yes' },
          workspaces: {
            p1: { root: { type: 'group', id: 'g1', tabIds: [] }, tabs: {} },
            [SCOPE]: { root: { type: 'group', id: 'g2', tabIds: [] }, tabs: {} },
            'p9~wt-9': { root: { type: 'group', id: 'g3', tabIds: [] }, tabs: {} },
          },
        },
      }),
    );
    await useWorkspaceStore.persist.rehydrate();
    expect(Object.keys(store().workspaces).sort()).toEqual(['p1', SCOPE]);
    expect(store().activeProjectId).toBe(SCOPE);
    expect(store().railExpanded).toEqual({ p1: false });
  });
});

describe('a project open only through its worktrees', () => {
  it('stays in the rail after a restart', async () => {
    localStorage.setItem(
      'runova-workspaces',
      JSON.stringify({
        version: 1,
        state: {
          railProjectIds: ['p1'],
          activeProjectId: 'p1~wt-1',
          workspaces: { 'p1~wt-1': { root: { type: 'group', id: 'g1', tabIds: [] }, tabs: {} } },
        },
      }),
    );
    await useWorkspaceStore.persist.rehydrate();
    expect(store().railProjectIds).toEqual(['p1']);
    expect(store().activeProjectId).toBe('p1~wt-1');
  });
});

describe('browser tabs', () => {
  it('opens a browser tab in the focused pane and brings it forward', () => {
    store().openProject('p1');
    const id = store().openBrowser('p1', { url: 'http://localhost:5173/' });
    const tab = workspace().tabs[id];
    expect(tab).toEqual({
      kind: 'browser',
      id,
      url: 'http://localhost:5173/',
      title: '',
      viewport: 'responsive',
    });
    const group = findGroupOfTab(workspace().root, id);
    expect(group?.id).toBe(workspace().focusedGroupId);
    expect(group?.activeTabId).toBe(id);
  });

  it('opens a blank tab on its start page', () => {
    store().openProject('p1');
    const id = store().openBrowser('p1');
    expect(workspace().tabs[id]).toMatchObject({ kind: 'browser', url: '' });
  });

  it('opens in a given pane', () => {
    store().openProject('p1');
    const first = workspace().focusedGroupId;
    const second = store().splitGroup('p1', first, 'row');
    const id = store().openBrowser('p1', { url: 'https://example.com/', groupId: first });
    expect(findGroupOfTab(workspace().root, id)?.id).toBe(first);
    expect(second).not.toBe(first);
  });

  it('keeps what the page shows, for the tab strip and the next start', () => {
    store().openProject('p1');
    const id = store().openBrowser('p1', { url: 'http://localhost:5173/' });
    store().setBrowserPage('p1', id, {
      url: 'http://localhost:5173/pricing',
      title: 'Pricing',
      faviconUrl: 'http://localhost:5173/favicon.ico',
    });
    expect(workspace().tabs[id]).toMatchObject({
      url: 'http://localhost:5173/pricing',
      title: 'Pricing',
      faviconUrl: 'http://localhost:5173/favicon.ico',
    });
  });

  it('remembers the device size', () => {
    store().openProject('p1');
    const id = store().openBrowser('p1', { url: 'http://localhost:5173/' });
    store().setBrowserViewport('p1', id, 'mobile');
    expect(workspace().tabs[id]).toMatchObject({ viewport: 'mobile' });
  });

  it('leaves other tab kinds alone', () => {
    const { tabId } = withTerminal();
    const before = workspace().tabs[tabId];
    store().setBrowserPage('p1', tabId, { url: 'x', title: 'y', faviconUrl: null });
    store().setBrowserViewport('p1', tabId, 'mobile');
    expect(workspace().tabs[tabId]).toBe(before);
  });

  it('lets go of the page and its comments when closed', () => {
    store().openProject('p1');
    const id = store().openBrowser('p1', { url: 'http://localhost:5173/' });
    useBrowserStore.setState({ annotations: { [id]: [] as never[] } });
    store().closeTab('p1', id);
    expect(disposeBrowser).toHaveBeenCalledWith(id);
    expect(useBrowserStore.getState().annotations[id]).toBeUndefined();
    expect(dispose).not.toHaveBeenCalled();
    expect(workspace().tabs[id]).toBeUndefined();
  });

  it('comes back after a restart, at the page it was on', async () => {
    localStorage.setItem(
      'runova-workspaces',
      JSON.stringify({
        state: {
          railProjectIds: ['p1'],
          activeProjectId: 'p1',
          workspaces: {
            p1: {
              root: { type: 'group', id: 'g1', tabIds: ['b1', 'bad'], activeTabId: 'b1' },
              tabs: {
                b1: {
                  kind: 'browser',
                  id: 'b1',
                  url: 'http://localhost:5173/pricing',
                  title: 'Pricing',
                  viewport: 'tablet',
                },
                bad: { kind: 'browser', id: 'bad', url: 42 },
              },
              focusedGroupId: 'g1',
              zoomedGroupId: null,
            },
          },
        },
        version: 1,
      }),
    );
    await useWorkspaceStore.persist.rehydrate();
    expect(workspace().tabs.b1).toEqual({
      kind: 'browser',
      id: 'b1',
      url: 'http://localhost:5173/pricing',
      title: 'Pricing',
      viewport: 'tablet',
    });
    expect(workspace().tabs.bad).toBeUndefined();
  });
});
