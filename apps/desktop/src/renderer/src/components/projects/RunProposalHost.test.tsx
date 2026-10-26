import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useTerminalStore } from '@/stores/terminalStore';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { RunProposalHost } from './RunProposalHost';

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), info: vi.fn() }));
vi.mock('sonner', () => ({ toast, Toaster: () => null }));

/** What the project list holds once the command was saved, as the Run hook needs it. */
function apolloProject(runCommands: unknown[]) {
  return { id: 'p1', name: 'Apollo', folderPath: '/work/apollo', runCommands };
}

const PROPOSED =
  'Push-Location E:\\BitIron\\BitIronPlatform\\app; flutter run --flavor dev -d emulator-5554; Pop-Location';

const apollo = {
  id: 'r1',
  projectId: 'p1',
  projectName: 'Apollo',
  label: 'android dev',
  command: PROPOSED,
  proposedAt: '2026-10-16T10:00:00.000Z',
};
const second = { ...apollo, id: 'r2', label: '', command: 'npm run serve' };

type Changed = { pending: unknown[] };

/** Renders the host with the suggestions it starts with, and lets a test announce a new list. */
function renderHost(
  pending: unknown[],
  decideResult: unknown = { ok: true, projectId: 'p1' },
  extraBridge: Record<string, unknown> = {},
) {
  const listeners: ((changed: Changed) => void)[] = [];
  const view = renderWithProviders(<RunProposalHost />, {
    bridge: {
      ...extraBridge,
      'runProposals.list': async () => pending,
      'runProposals.onChanged': (callback: (changed: Changed) => void) => {
        listeners.push(callback);
        return () => undefined;
      },
      'runProposals.decide': async () => decideResult,
    },
  });
  const announce = (next: unknown[]) =>
    act(() => {
      for (const listener of listeners) listener({ pending: next });
    });
  return { ...view, announce };
}

describe('RunProposalHost', () => {
  it('shows nothing while no suggestion is waiting', async () => {
    const { bridge } = renderHost([]);

    await waitFor(() => expect(bridge.$fn('runProposals.list')).toHaveBeenCalled());
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows the suggestion with its project, and the command exactly as it was proposed', async () => {
    renderHost([apollo]);

    const dialog = await screen.findByRole('dialog', { name: 'Add "android dev" to Apollo?' });
    expect(within(dialog).getByText(PROPOSED)).toBeTruthy();
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Discard' })).toHaveFocus(),
    );
  });

  it('adds the command when the user chooses Add command, and starts nothing', async () => {
    const { user, bridge } = renderHost([apollo]);
    const dialog = await screen.findByRole('dialog');

    await user.click(within(dialog).getByRole('button', { name: 'Add command' }));

    expect(bridge.$fn('runProposals.decide')).toHaveBeenCalledWith('r1', 'add');
    expect(useTerminalStore.getState().sessions).toHaveLength(0);
  });

  it('adds the command and starts it when the user chooses Add and run', async () => {
    const runCommand = { id: 'c1', label: 'android dev', command: 'flutter run' };
    const { user, bridge } = renderHost(
      [apollo],
      { ok: true, projectId: 'p1', runCommand },
      { 'projects.list': [apolloProject([runCommand])] },
    );
    const dialog = await screen.findByRole('dialog');

    await user.click(within(dialog).getByRole('button', { name: 'Add and run' }));

    expect(bridge.$fn('runProposals.decide')).toHaveBeenCalledWith('r1', 'add');
    await waitFor(() =>
      expect(useTerminalStore.getState().sessions.map((s) => s.initialInput)).toEqual([
        'flutter run\r',
      ]),
    );
    expect(useTerminalStore.getState().sessions[0]).toMatchObject({
      cwd: '/work/apollo',
      projectId: 'p1',
    });
  });

  it('asks for the values first when the command added with Add and run has placeholders', async () => {
    const runCommand = { id: 'c1', label: 'serve', command: 'pnpm dev -- --port {{port=3000}}' };
    const { user } = renderHost(
      [{ ...apollo, label: 'serve', command: runCommand.command }],
      { ok: true, projectId: 'p1', runCommand },
      { 'projects.list': [apolloProject([runCommand])] },
    );
    const dialog = await screen.findByRole('dialog');

    await user.click(within(dialog).getByRole('button', { name: 'Add and run' }));

    expect(await screen.findByRole('dialog', { name: 'Run serve' })).toBeTruthy();
    expect(useTerminalStore.getState().sessions).toHaveLength(0);
  });

  it('does not start anything when the command could not be added', async () => {
    const { user } = renderHost([apollo], {
      ok: false,
      error: 'This project already has that run command.',
    });
    const dialog = await screen.findByRole('dialog');

    await user.click(within(dialog).getByRole('button', { name: 'Add and run' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(useTerminalStore.getState().sessions).toHaveLength(0);
  });

  it('discards the suggestion on Discard', async () => {
    const { user, bridge } = renderHost([apollo]);
    const dialog = await screen.findByRole('dialog');

    await user.click(within(dialog).getByRole('button', { name: 'Discard' }));

    expect(bridge.$fn('runProposals.decide')).toHaveBeenCalledWith('r1', 'discard');
  });

  it('treats Escape as Discard, so a dismissed suggestion is never left waiting', async () => {
    const { user, bridge } = renderHost([apollo]);
    await screen.findByRole('dialog');

    await user.keyboard('{Escape}');

    expect(bridge.$fn('runProposals.decide')).toHaveBeenCalledWith('r1', 'discard');
  });

  it('shows one suggestion at a time, says how many are waiting, and moves on after a decision', async () => {
    const { user, announce } = renderHost([apollo, second]);
    expect(await screen.findByText('1 of 2 suggestions')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Add command' }));

    expect(
      await screen.findByRole('dialog', { name: 'Add a run command to Apollo?' }),
    ).toBeTruthy();
    announce([]);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('says why when Runova will not add it, and takes the suggestion off the screen', async () => {
    const { user } = renderHost([apollo], {
      ok: false,
      error: 'This project already has that run command.',
    });
    const dialog = await screen.findByRole('dialog');

    await user.click(within(dialog).getByRole('button', { name: 'Add command' }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('This project already has that run command.'),
    );
  });
});
