import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { BOX, DISK, ownerAccess, PLAN, RUN, SERVER, STEPPED_UP } from './testing/fixtures';

/**
 * The Backups section (E28): Owners only, with the reason for everyone else; a banner while no
 * secret key is set; the run history with each destination's outcome; and Back up now, which
 * follows the run and asks for a step-up when the core wants one.
 */

const { toast } = vi.hoisted(() => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));
vi.mock('sonner', () => ({ toast }));

const { BackupsPanel } = await import('./BackupsPanel');

function renderPanel(bridge: Record<string, unknown> = {}) {
  return renderWithProviders(<BackupsPanel server={SERVER} />, {
    bridge: {
      ...ownerAccess(),
      ...STEPPED_UP,
      'deployServerBackups.getSecret': { isSet: true, keyId: 'k1', updatedAtUnixMs: 1 },
      'deployServerBackups.listDestinations': [DISK, BOX],
      'deployServerBackups.listPlans': [{ ...PLAN, lastRun: RUN }],
      'deployServerBackups.listRuns': [RUN],
      ...bridge,
    },
  });
}

describe('BackupsPanel', () => {
  it('tells someone who is not an Owner why there is nothing here', async () => {
    renderPanel(ownerAccess(['admin']));
    expect(await screen.findByText(/Only an Owner of Production can/)).toBeTruthy();
    expect(screen.queryByRole('tab', { name: 'Plans' })).toBeNull();
  });

  it('shows every tab to an Owner', async () => {
    renderPanel();
    for (const name of ['Overview', 'Backups', 'Plans', 'Destinations', 'Secret key', 'Restore']) {
      expect(await screen.findByRole('tab', { name })).toBeTruthy();
    }
  });

  it('says no backup can be made until a secret key is set, and leads there', async () => {
    const { user } = renderPanel({ 'deployServerBackups.getSecret': { isSet: false } });
    expect(await screen.findByText(/No secret key yet/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Back up now' }).hasAttribute('disabled')).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Set the secret key' }));
    expect(await screen.findByRole('tab', { name: 'Secret key', selected: true })).toBeTruthy();
  });

  it("lists runs with each destination's outcome, and when plans ran and run next", async () => {
    renderPanel();
    const history = await screen.findByRole('table', { name: 'Backup runs' });
    const row = within(history).getAllByRole('row')[1] as HTMLElement;
    expect(within(row).getByText('Nightly')).toBeTruthy();
    expect(within(row).getByText('Partly failed')).toBeTruthy();
    expect(within(row).getByText(/Local disk: Uploaded/)).toBeTruthy();
    expect(within(row).getByText(/Storage box: Failed/)).toBeTruthy();
    expect(within(row).getByText('2 GB')).toBeTruthy();
    const plans = screen.getByRole('list', { name: 'Plans' });
    expect(within(plans).getByText('Nightly')).toBeTruthy();
    expect(within(plans).getByText(/Daily at 03:30/)).toBeTruthy();
    expect(within(plans).getByText(/Next run/)).toBeTruthy();
  });

  it('follows a run while it goes, then stops asking', async () => {
    const running = {
      ...RUN,
      state: 'running' as const,
      finishedAtUnixMs: undefined,
      targets: RUN.targets.map((target) => ({ ...target, state: 'pending' as const, attempts: 0 })),
    };
    const done = { ...RUN, state: 'succeeded' as const };
    const listRuns = vi.fn(async () => (listRuns.mock.calls.length > 1 ? [done] : [running]));
    renderPanel({ 'deployServerBackups.listRuns': listRuns });
    const history = await screen.findByRole('table', { name: 'Backup runs' });
    expect(within(history).getByText('Running')).toBeTruthy();
    expect(await within(history).findByText('Done', {}, { timeout: 5_000 })).toBeTruthy();
    const calls = listRuns.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(listRuns.mock.calls.length).toBe(calls);
  });

  it('tells a destination waiting to try again from one not tried yet', async () => {
    const running = {
      ...RUN,
      state: 'running' as const,
      finishedAtUnixMs: undefined,
      targets: [
        { ...RUN.targets[0], state: 'pending' as const, attempts: 0, pruned: 0 },
        { ...RUN.targets[1], state: 'pending' as const, attempts: 1 },
      ],
    };
    renderPanel({ 'deployServerBackups.listRuns': [running] });
    const history = await screen.findByRole('table', { name: 'Backup runs' });
    expect(within(history).getByText(/Local disk: Waiting/)).toBeTruthy();
    expect(within(history).getByText(/Storage box: Retrying/)).toBeTruthy();
  });
});

describe('Back up now', () => {
  it('backs up to the destinations picked, follows the run and says how it went', async () => {
    const done = {
      ...RUN,
      id: '55555555-5555-4555-8555-555555555555',
      trigger: 'manual' as const,
      planName: undefined,
      planId: undefined,
      state: 'succeeded' as const,
      targets: [{ ...RUN.targets[0], state: 'succeeded' as const }],
    };
    const { user, bridge } = renderPanel({
      'deployServerBackups.runNow': async () => ({
        started: true,
        run: { ...done, state: 'running' },
      }),
      'deployServerBackups.watchRun': async () => ({ run: done }),
    });

    await user.click(await screen.findByRole('button', { name: 'Back up now' }));
    const dialog = await screen.findByRole('dialog', { name: /Back up Production now/ });
    await user.click(within(dialog).getByRole('checkbox', { name: 'Local disk' }));
    await user.click(within(dialog).getByRole('button', { name: 'Start the backup' }));

    expect(bridge.$fn('deployServerBackups.runNow')).toHaveBeenCalledWith({
      serverId: 'srv-1',
      destinationIds: [DISK.id],
      download: false,
    });
    await waitFor(() =>
      expect(bridge.$fn('deployServerBackups.watchRun')).toHaveBeenCalledWith({
        serverId: 'srv-1',
        runId: done.id,
      }),
    );
    expect(await within(dialog).findByText(/The backup is done/)).toBeTruthy();
  });

  it('keeps following the backup when the page is left, and shows it on return', async () => {
    const running = {
      ...RUN,
      id: '66666666-6666-4666-8666-666666666666',
      state: 'running' as const,
    };
    let finish!: (value: unknown) => void;
    const bridge = {
      'deployServerBackups.runNow': async () => ({ started: true, run: running }),
      'deployServerBackups.watchRun': () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    };
    const first = renderPanel(bridge);
    await first.user.click(await screen.findByRole('button', { name: 'Back up now' }));
    const dialog = await screen.findByRole('dialog', { name: /Back up Production now/ });
    await first.user.click(within(dialog).getByRole('checkbox', { name: 'Local disk' }));
    await first.user.click(within(dialog).getByRole('button', { name: 'Start the backup' }));
    expect(await within(dialog).findByText(/Backing up/)).toBeTruthy();
    first.unmount();

    finish({ run: { ...running, state: 'succeeded' } });
    renderPanel(bridge);
    const again = await screen.findByRole('dialog', { name: /Back up Production now/ });
    expect(await within(again).findByText(/The backup is done/)).toBeTruthy();
  });

  it('asks for nothing to be made when no destination and no download is picked', async () => {
    const { user } = renderPanel();
    await user.click(await screen.findByRole('button', { name: 'Back up now' }));
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByRole('button', { name: 'Start the backup' }).hasAttribute('disabled'),
    ).toBe(true);
    await user.click(within(dialog).getByRole('checkbox', { name: 'Download to this computer' }));
    expect(
      within(dialog).getByRole('button', { name: 'Start the backup' }).hasAttribute('disabled'),
    ).toBe(false);
  });

  it('asks for the password when the core wants a step-up, then starts the backup', async () => {
    let refuse = true;
    const runNow = vi.fn(async () => {
      if (refuse) {
        refuse = false;
        throw new Error(
          'Error invoking remote method: Error: [core:stepUpRequired] Confirm your password.',
        );
      }
      return { started: false };
    });
    const { user, bridge } = renderPanel({
      'deployServerBackups.runNow': runNow,
      'deploy.stepUp': async () => ({ stepUpUntilUnixMs: Date.now() + 600_000 }),
      'deploy.stepUpSaved': async () => null,
    });

    await user.click(await screen.findByRole('button', { name: 'Back up now' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('checkbox', { name: 'Download to this computer' }));
    await user.click(within(dialog).getByRole('button', { name: 'Start the backup' }));

    const confirm = await screen.findByRole('dialog', { name: 'Confirm it is you' });
    await user.type(within(confirm).getByLabelText('Password'), 'correct horse battery staple');
    await user.click(within(confirm).getByRole('button', { name: 'Confirm' }));

    await waitFor(() => expect(runNow).toHaveBeenCalledTimes(2));
    expect(bridge.$fn('deploy.stepUp')).toHaveBeenCalledWith({
      serverId: 'srv-1',
      password: 'correct horse battery staple',
    });
  });
});
