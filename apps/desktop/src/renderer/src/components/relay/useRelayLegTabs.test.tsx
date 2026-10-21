import { waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { renderHookWithProviders } from '../../../../test/renderer/renderWithProviders';
import { useRelayLegTabs } from './useRelayLegTabs';

const LEG = {
  projectId: 'p2',
  tabId: 'leg-tab-1',
  legId: 'r1-T003-1-1',
  cliId: 'claude-code',
  title: 'T003 · Claude Code CLI',
  runLabel: 'Leg 1 · Opus 5.5 · High',
  cwd: 'E:/work/p2',
};

beforeEach(() => {
  useWorkspaceStore.setState({ workspaces: {}, railProjectIds: [], activeProjectId: null });
});

describe('useRelayLegTabs', () => {
  it('shows a leg main started as an attach-only tab without leaving the project on screen', () => {
    useWorkspaceStore.getState().openProject('p1');
    const { bridge } = renderHookWithProviders(() => useRelayLegTabs());
    bridge.$emit('relay.onLegTab', LEG);

    const state = useWorkspaceStore.getState();
    expect(state.activeProjectId).toBe('p1');
    expect(state.railProjectIds).toEqual(['p1', 'p2']);
    expect(state.workspaces.p2.tabs['leg-tab-1']).toMatchObject({
      kind: 'terminal',
      id: 'leg-tab-1',
      cliId: 'claude-code',
      cwd: 'E:/work/p2',
      title: 'T003 · Claude Code CLI',
      runLabel: 'Leg 1 · Opus 5.5 · High',
      relayLegId: 'r1-T003-1-1',
      restored: true,
    });
    expect(state.workspaces.p2.tabs['leg-tab-1']).not.toHaveProperty('launchInput');
  });

  it('adds a leg tab once even when told twice', () => {
    const { bridge } = renderHookWithProviders(() => useRelayLegTabs());
    bridge.$emit('relay.onLegTab', LEG);
    bridge.$emit('relay.onLegTab', LEG);
    expect(Object.keys(useWorkspaceStore.getState().workspaces.p2.tabs)).toEqual(['leg-tab-1']);
  });

  it('closes a finished leg tab when main says so', () => {
    const { bridge } = renderHookWithProviders(() => useRelayLegTabs());
    bridge.$emit('relay.onLegTab', LEG);
    bridge.$emit('relay.onCloseTab', { projectId: 'p2', tabId: 'leg-tab-1' });
    expect(useWorkspaceStore.getState().workspaces.p2.tabs['leg-tab-1']).toBeUndefined();
  });

  it('reports the leg tabs it already has once mounted', async () => {
    useWorkspaceStore.getState().addRelayLegTab('p2', {
      id: 'leg-tab-1',
      title: 'T003',
      cwd: 'E:/work/p2',
      relayLegId: 'r1-T003-1-1',
    });
    useWorkspaceStore.getState().openProject('p1');
    useWorkspaceStore.getState().addTerminal('p1', { title: 'shell', cwd: 'E:/work/p1' });
    const { bridge } = renderHookWithProviders(() => useRelayLegTabs());
    await waitFor(() =>
      expect(bridge.$fn('relay.reconcile')).toHaveBeenCalledWith([
        { legId: 'r1-T003-1-1', tabId: 'leg-tab-1' },
      ]),
    );
  });

  it('stops listening when unmounted', () => {
    const { bridge, unmount } = renderHookWithProviders(() => useRelayLegTabs());
    expect(bridge.$listenerCount('relay.onLegTab')).toBe(1);
    unmount();
    expect(bridge.$listenerCount('relay.onLegTab')).toBe(0);
    expect(bridge.$listenerCount('relay.onCloseTab')).toBe(0);
  });
});
