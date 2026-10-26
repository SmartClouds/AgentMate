// @vitest-environment node
import type { PaneNode } from '@runova/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectWorkspace, WorkspaceTab } from '@/stores/workspaceStore';
import {
  findAgentTerminal,
  forgetAgentTabs,
  listAgentTerminals,
  rememberAgentTab,
} from './agentTarget';

/**
 * Which agent tab files from the explorer go to. The workspace and the ended-session list are
 * plain objects here, so each case spells out the layout it is about.
 */

const state: { workspaces: Record<string, ProjectWorkspace>; ended: Record<string, boolean> } = {
  workspaces: {},
  ended: {},
};

vi.mock('@/stores/workspaceStore', () => ({
  useWorkspaceStore: { getState: () => ({ workspaces: state.workspaces }) },
}));
vi.mock('@/lib/terminal/terminalRuntime', () => ({
  useTerminalSessionStore: { getState: () => ({ ended: state.ended }) },
}));

function agent(id: string, createdAt = 0): WorkspaceTab {
  return { kind: 'terminal', id, title: id, cliId: 'claude-code', cwd: 'E:\\proj', createdAt };
}

function shell(id: string): WorkspaceTab {
  return { kind: 'terminal', id, title: id, cwd: 'E:\\proj', createdAt: 0 };
}

function file(id: string): WorkspaceTab {
  return { kind: 'file', id, path: `E:\\proj\\${id}`, preview: false };
}

function group(id: string, tabIds: string[], activeTabId: string | null): PaneNode {
  return { type: 'group', id, tabIds, activeTabId };
}

function setWorkspace(root: PaneNode, tabs: WorkspaceTab[], focusedGroupId: string): void {
  state.workspaces.p1 = {
    root,
    tabs: Object.fromEntries(tabs.map((tab) => [tab.id, tab])),
    focusedGroupId,
    zoomedGroupId: null,
  };
}

beforeEach(() => {
  state.workspaces = {};
  state.ended = {};
  forgetAgentTabs();
});

describe('findAgentTerminal', () => {
  it('is null for a workspace that is not open', () => {
    expect(findAgentTerminal('p1')).toBeNull();
  });

  it('picks the focused pane’s agent tab', () => {
    setWorkspace(group('g1', ['a', 'b'], 'b'), [agent('a', 5), agent('b', 1)], 'g1');
    expect(findAgentTerminal('p1')?.id).toBe('b');
  });

  it('prefers the agent the user last focused when a file tab is in front', () => {
    setWorkspace(
      group('g1', ['a', 'b', 'f'], 'f'),
      [agent('a', 1), agent('b', 9), file('f')],
      'g1',
    );
    rememberAgentTab('p1', 'a');
    expect(findAgentTerminal('p1')?.id).toBe('a');
  });

  it('falls back to an agent on screen in another pane', () => {
    const root: PaneNode = {
      type: 'split',
      id: 's1',
      direction: 'row',
      ratio: 0.5,
      a: group('g1', ['f'], 'f'),
      b: group('g2', ['old', 'visible'], 'visible'),
    };
    setWorkspace(root, [file('f'), agent('old', 1), agent('visible', 0)], 'g1');
    expect(findAgentTerminal('p1')?.id).toBe('visible');
  });

  it('falls back to the newest agent tab', () => {
    setWorkspace(
      group('g1', ['f', 'a', 'b'], 'f'),
      [file('f'), agent('a', 1), agent('b', 7)],
      'g1',
    );
    expect(findAgentTerminal('p1')?.id).toBe('b');
  });

  it('skips plain shells and agents whose shell has ended', () => {
    setWorkspace(group('g1', ['sh', 'dead'], 'dead'), [shell('sh'), agent('dead')], 'g1');
    state.ended.dead = true;
    expect(findAgentTerminal('p1')).toBeNull();
  });
});

describe('listAgentTerminals', () => {
  it('lists the running agents, the one files would go to first', () => {
    setWorkspace(
      group('g1', ['a', 'b', 's', 'c'], 'b'),
      [agent('a', 1), agent('b', 2), shell('s'), agent('c', 3)],
      'g1',
    );
    state.ended.c = true;
    expect(listAgentTerminals('p1').map((tab) => tab.id)).toEqual(['b', 'a']);
  });

  it('is empty for a workspace that is not open', () => {
    expect(listAgentTerminals('p1')).toEqual([]);
  });
});
