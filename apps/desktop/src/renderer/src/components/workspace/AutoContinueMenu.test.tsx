import type { AutoContinuePending } from '@runova/core';
import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAgentStatusStore } from '@/stores/agentStatusStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { currentBridge } from '../../../../test/renderer/runovaBridge';
import { AutoContinueMenu, autoContinuePendingLine } from './AutoContinueMenu';

// The runtime owns real xterm instances, which the workspace store only calls when a tab closes.
vi.mock('@/lib/terminal/terminalRuntime', () => ({
  terminalRuntime: { dispose: vi.fn(), mount: vi.fn(), unmount: vi.fn(), focus: vi.fn() },
}));

let tabId: string;

/** Reads the tab from the store on every render, the way the pane header does. */
function Harness(): React.JSX.Element | null {
  const tab = useWorkspaceStore((s) => s.workspaces.p1?.tabs[tabId]);
  return tab?.kind === 'terminal' ? <AutoContinueMenu projectId="p1" tab={tab} /> : null;
}

function savedOptions() {
  const tab = useWorkspaceStore.getState().workspaces.p1?.tabs[tabId];
  return tab?.kind === 'terminal' ? tab.autoContinue : undefined;
}

beforeEach(() => {
  useWorkspaceStore.getState().openProject('p1');
  tabId = useWorkspaceStore.getState().addTerminal('p1', {
    title: 'Claude Code',
    cwd: 'E:\\proj',
    cliId: 'claude-code',
  });
});

describe('AutoContinueMenu', () => {
  it('turns each option on and off for the tab', async () => {
    const { user } = renderWithProviders(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Auto-continue' }));
    const limit = screen.getByRole('menuitemcheckbox', { name: /usage limit resets/ });
    expect(limit).toHaveAttribute('aria-checked', 'false');

    await user.click(limit);
    expect(savedOptions()).toEqual({ afterLimitReset: true });
    // The menu stays open, so both can be set in one go.
    await user.click(screen.getByRole('menuitemcheckbox', { name: /network error/ }));
    expect(savedOptions()).toEqual({ afterLimitReset: true, afterNetworkError: true });
    expect(screen.getByRole('menuitemcheckbox', { name: /usage limit resets/ })).toHaveAttribute(
      'aria-checked',
      'true',
    );

    await user.click(screen.getByRole('menuitemcheckbox', { name: /usage limit resets/ }));
    expect(savedOptions()).toEqual({ afterLimitReset: false, afterNetworkError: true });
  });

  it('shows the scheduled continue and can cancel it', async () => {
    const pending: AutoContinuePending = {
      kind: 'network',
      fireAt: Date.now() + 3 * 60_000,
      attempt: 2,
    };
    useAgentStatusStore.setState({ autoContinue: { [tabId]: pending } });
    const { user } = renderWithProviders(<Harness />);

    await user.click(screen.getByRole('button', { name: 'Auto-continue' }));
    expect(screen.getByText(autoContinuePendingLine(pending))).toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: 'Cancel this time' }));
    expect(currentBridge().$fn('agents.cancelAutoContinue')).toHaveBeenCalledWith(tabId);
  });

  it('has no cancel item when nothing is scheduled', async () => {
    const { user } = renderWithProviders(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Auto-continue' }));
    expect(screen.queryByRole('menuitem', { name: 'Cancel this time' })).not.toBeInTheDocument();
  });
});

describe('autoContinuePendingLine', () => {
  it('says why and when, with the try number for network retries', () => {
    const fireAt = new Date(2030, 0, 1, 15, 5).getTime();
    expect(autoContinuePendingLine({ kind: 'limit', fireAt, attempt: 1 })).toMatch(
      /^Usage limit hit\. Sending "continue" at .*3:05/,
    );
    expect(autoContinuePendingLine({ kind: 'network', fireAt, attempt: 3 })).toMatch(
      /^Network error\. Sending "continue" at .*\(try 3\)$/,
    );
  });
});
