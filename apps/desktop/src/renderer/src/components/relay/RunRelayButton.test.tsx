import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAgentStatusStore } from '@/stores/agentStatusStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { RunRelayButton, ScheduleRelayDialog } from './RunRelayButton';
import { board, card, run } from './testing/fixtures';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));

const started = { ok: true, run: run({ status: 'waiting' }) };

beforeEach(() => {
  useWorkspaceStore.setState({ workspaces: {}, railProjectIds: [], activeProjectId: null });
  useAgentStatusStore.setState({ statuses: {} });
});

describe('RunRelayButton', () => {
  it('runs every task now', async () => {
    const { user, bridge } = renderWithProviders(<RunRelayButton board={board()} />, {
      bridge: { 'relay.start': started },
    });
    await user.click(screen.getByRole('button', { name: 'Run relay' }));
    expect(bridge.$fn('relay.start')).toHaveBeenCalledWith({
      projectId: 'p1',
      trigger: { kind: 'now' },
    });
  });

  it('cannot run a board where nothing is left to do', () => {
    renderWithProviders(
      <RunRelayButton board={board({ tasks: [card('T001', { status: 'done' })] })} />,
    );
    expect(screen.getByRole('button', { name: 'Run relay' })).toBeDisabled();
  });

  it('opens the schedule from its menu', async () => {
    const { user } = renderWithProviders(<RunRelayButton board={board()} />);
    await user.click(screen.getByRole('button', { name: 'More ways to run' }));
    await user.click(await screen.findByRole('menuitem', { name: /Schedule/ }));
    expect(await screen.findByRole('dialog', { name: 'Schedule the relay' })).toBeInTheDocument();
  });
});

describe('ScheduleRelayDialog', () => {
  it('schedules the relay for a time', async () => {
    const onOpenChange = vi.fn();
    const { user, bridge } = renderWithProviders(
      <ScheduleRelayDialog board={board()} open onOpenChange={onOpenChange} />,
      { bridge: { 'relay.start': started } },
    );
    const input = screen.getByLabelText('Starts at');
    await user.clear(input);
    await user.type(input, '2030-01-02T09:30');
    await user.click(screen.getByRole('button', { name: 'Schedule relay' }));
    expect(bridge.$fn('relay.start')).toHaveBeenCalledWith({
      projectId: 'p1',
      trigger: { kind: 'at', at: new Date('2030-01-02T09:30').getTime() },
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('offers only the agent sessions that are busy to follow', async () => {
    useWorkspaceStore.getState().openProject('p1');
    const busy = useWorkspaceStore
      .getState()
      .addTerminal('p1', { title: 'Claude Code', cliId: 'claude-code', cwd: 'E:/p1' });
    const quiet = useWorkspaceStore
      .getState()
      .addTerminal('p1', { title: 'Codex', cliId: 'codex-cli', cwd: 'E:/p1' });
    useAgentStatusStore.setState({ statuses: { [busy]: 'working', [quiet]: 'idle' } });
    const { user } = renderWithProviders(
      <ScheduleRelayDialog board={board()} open onOpenChange={vi.fn()} />,
    );
    await user.click(screen.getByRole('radio', { name: 'After a session' }));
    await user.click(screen.getByRole('combobox', { name: 'Session to wait for' }));
    expect(await screen.findByRole('option', { name: 'Claude Code' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Codex' })).toBeNull();
  });

  it('says so when no session is busy', async () => {
    const { user } = renderWithProviders(
      <ScheduleRelayDialog board={board()} open onOpenChange={vi.fn()} />,
    );
    await user.click(screen.getByRole('radio', { name: 'After a session' }));
    expect(screen.getByText(/No agent is working right now/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Schedule relay' })).toBeDisabled();
  });
});
