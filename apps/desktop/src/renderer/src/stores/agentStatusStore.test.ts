import type { AutoContinuePending } from '@runova/core';
import type { AgentSessionEntry, AutoContinuePendingMap } from '@shared/apiTypes';
import { renderHook, waitFor } from '@testing-library/react';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type FakeBridge, installRunovaBridge } from '../../../test/renderer/runovaBridge';

// The runtime owns real xterm instances, which the workspace store only calls when a tab closes.
vi.mock('@/lib/terminal/terminalRuntime', () => ({
  terminalRuntime: { dispose: vi.fn(), mount: vi.fn(), unmount: vi.fn(), focus: vi.fn() },
}));

const PENDING: AutoContinuePending = { kind: 'network', fireAt: 1_800_000_000_000, attempt: 1 };

/**
 * `initAgentStatus` starts once per app, so each test loads the stores fresh and starts them
 * against its own bridge, with one Claude Code tab that has the limit option on.
 */
async function start(pending: AutoContinuePendingMap = {}) {
  vi.resetModules();
  const bridge: FakeBridge = installRunovaBridge({
    'agents.list': {},
    'agents.runInfos': {},
    'agents.autoContinuePending': pending,
  });
  const { useWorkspaceStore } = await import('./workspaceStore');
  const status = await import('./agentStatusStore');
  useWorkspaceStore.getState().openProject('p1');
  const tabId = useWorkspaceStore.getState().addTerminal('p1', {
    title: 'Claude Code',
    cwd: 'E:\\proj',
    cliId: 'claude-code',
  });
  useWorkspaceStore.getState().setAutoContinue('p1', tabId, { afterLimitReset: true });
  status.initAgentStatus();
  await waitFor(() => expect(bridge.$fn('agents.autoContinuePending')).toHaveBeenCalled());
  const lastSync = (): AgentSessionEntry[] =>
    bridge.$fn('agents.sync').mock.calls.at(-1)?.[0] as AgentSessionEntry[];
  return { bridge, tabId, useWorkspaceStore, ...status, lastSync };
}

beforeEach(() => {
  vi.resetModules();
});

describe('auto-continue in the agent status store', () => {
  it('sends each tab its auto-continue options, so main knows what to watch', async () => {
    const { tabId, lastSync } = await start();
    expect(lastSync()).toEqual([
      expect.objectContaining({
        sessionId: tabId,
        cliId: 'claude-code',
        autoContinue: { afterLimitReset: true },
      }),
    ]);
  });

  it('syncs again when an option changes', async () => {
    const { tabId, lastSync, useWorkspaceStore } = await start();
    useWorkspaceStore.getState().setAutoContinue('p1', tabId, { afterNetworkError: true });
    await waitFor(() =>
      expect(lastSync()[0]?.autoContinue).toEqual({
        afterLimitReset: true,
        afterNetworkError: true,
      }),
    );
  });

  it('starts from what main has scheduled, then follows its updates', async () => {
    const { bridge, tabId, useAgentStatusStore, useAutoContinuePending } = await start();
    act(() => bridge.$emit('agents.onAutoContinue', { [tabId]: PENDING }));
    expect(useAgentStatusStore.getState().autoContinue[tabId]).toEqual(PENDING);

    const { result } = renderHook(() => useAutoContinuePending(tabId));
    expect(result.current).toEqual(PENDING);

    act(() => bridge.$emit('agents.onAutoContinue', { [tabId]: null }));
    expect(result.current).toBeNull();

    const later: AutoContinuePending = { kind: 'limit', fireAt: 1_900_000_000_000, attempt: 1 };
    act(() => bridge.$emit('agents.onAutoContinue', { [tabId]: later }));
    expect(result.current).toEqual(later);
  });

  it('takes the continues main already had scheduled when it starts', async () => {
    const { useAgentStatusStore } = await start({ 'restored-tab': PENDING });
    await waitFor(() =>
      expect(useAgentStatusStore.getState().autoContinue['restored-tab']).toEqual(PENDING),
    );
  });

  it('has nothing scheduled for a tab main never mentioned', async () => {
    const { useAutoContinuePending } = await start();
    const { result } = renderHook(() => useAutoContinuePending('some-other-tab'));
    expect(result.current).toBeNull();
  });
});

describe('tab tooltip model line', () => {
  it('prefers the live report, then the launch label, then the CLI fallback', async () => {
    const { tabRunLine } = await import('./agentStatusStore');
    expect(tabRunLine({ model: 'claude-opus-5', effort: 'high' }, 'Launch label', 'Fallback')).toBe(
      'Opus 5 · high effort',
    );
    expect(tabRunLine({ effort: 'low' }, 'Launch label', 'Fallback')).toBe('low effort');
    expect(tabRunLine({}, 'Launch label', 'Fallback')).toBe('Launch label');
    expect(tabRunLine(undefined, undefined, 'Fallback')).toBe('Fallback');
    expect(tabRunLine(undefined, undefined, null)).toBeNull();
  });

  it('falls back to the last run and then the launch default per CLI', async () => {
    const status = await import('./agentStatusStore');
    const { useCliStore } = await import('./cliStore');
    // Agents without hooks (OpenCode, FreeBuff, …) never report live, so the
    // tooltip shows what the CLI ran on last, else what it opens with.
    useCliStore.setState({
      lastRunInfoByCli: { opencode: { model: 'muse-spark', effort: 'high' } },
      cliLaunchDefaults: { 'freebuff-cli': { model: 'deepseek-v4-flash' } },
    });
    const { result, rerender } = renderHook(({ cliId }) => status.useCliRunLine(cliId), {
      initialProps: { cliId: 'opencode' as string | undefined },
    });
    expect(result.current).toBe('Muse Spark · high effort');

    rerender({ cliId: 'freebuff-cli' });
    expect(result.current).toBe('Deepseek V4 Flash');

    rerender({ cliId: 'codex-cli' });
    expect(result.current).toBeNull();

    rerender({ cliId: undefined });
    expect(result.current).toBeNull();
  });
});
