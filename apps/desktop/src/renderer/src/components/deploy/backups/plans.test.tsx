import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { BOX, DISK, PLAN, SERVER, STEPPED_UP } from './testing/fixtures';

/**
 * Plans and the secret key (E28). The plan editor builds the cron line from its presets and reads
 * the core's live preview back as a sentence, with the next runs and the live copy notice. The
 * secret key wants 12 characters typed twice, the current one to change it, and says plainly
 * that a lost key means no restore.
 */

const { toast } = vi.hoisted(() => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('sonner', () => ({ toast }));
const confirm = vi.fn(async () => true);
vi.mock('@/stores/confirmStore', () => ({
  confirmDialog: (...args: unknown[]) => confirm(...(args as [])),
}));

const { PlansTab } = await import('./PlansTab');
const { SecretTab } = await import('./SecretTab');
const { useStepUp } = await import('../security/useStepUp');

const PREVIEW = {
  nextRunsUnixMs: [Date.UTC(2026, 9, 23, 1, 30), Date.UTC(2026, 9, 24, 1, 30)],
  kept: 7,
  bytesPerDestination: 14 * 1024 ** 3,
  firstDeletionAtUnixMs: Date.UTC(2026, 9, 30, 1, 30),
  coversMs: 7 * 86_400_000,
};

function renderPlans(bridge: Record<string, unknown> = {}) {
  return renderWithProviders(<PlansTab server={SERVER} onOpenTab={vi.fn()} />, {
    bridge: {
      'deployServerBackups.listPlans': [PLAN],
      'deployServerBackups.listDestinations': [DISK, BOX],
      'deployServerBackups.previewPlan': async () => PREVIEW,
      'deployServerBackups.savePlan': async () => PLAN,
      ...bridge,
    },
  });
}

describe('PlansTab', () => {
  it('lists plans with their schedule, what they keep and where they go', async () => {
    renderPlans();
    const row = await screen.findByRole('listitem', { name: 'Nightly' });
    expect(within(row).getByText(/Daily at 03:30/)).toBeTruthy();
    expect(within(row).getByText(/Keeps the last 7/)).toBeTruthy();
    expect(within(row).getByText(/Local disk, Storage box/)).toBeTruthy();
  });

  it('builds a weekly plan and shows the live preview before saving it', async () => {
    const { user, bridge } = renderPlans({ 'deployServerBackups.listPlans': [] });
    await user.click(await screen.findByRole('button', { name: 'New plan' }));
    const dialog = await screen.findByRole('dialog', { name: 'New backup plan' });

    await user.type(within(dialog).getByLabelText('Name'), 'Weekly');
    await user.click(within(dialog).getByRole('combobox', { name: 'Schedule' }));
    await user.click(await screen.findByRole('option', { name: 'Weekly on a day' }));
    await user.click(within(dialog).getByRole('combobox', { name: 'Day' }));
    await user.click(await screen.findByRole('option', { name: 'Monday' }));
    const time = within(dialog).getByLabelText('At');
    await user.clear(time);
    await user.type(time, '04:15');
    await user.click(within(dialog).getByRole('checkbox', { name: 'Local disk' }));
    const keep = within(dialog).getByLabelText('Keep the last');
    await user.clear(keep);
    await user.type(keep, '7');

    expect(
      await within(dialog).findByText(
        /Keeps 7 backups on each destination, about 14 GB each, the oldest goes on/,
      ),
    ).toBeTruthy();
    expect(within(dialog).getByRole('list', { name: 'Next runs' }).children).toHaveLength(2);
    expect(within(dialog).getByText(/copied while the apps keep running/)).toBeTruthy();
    await waitFor(() =>
      expect(bridge.$fn('deployServerBackups.previewPlan')).toHaveBeenLastCalledWith({
        serverId: 'srv-1',
        preview: expect.objectContaining({ cron: '15 4 * * 1', keepLast: 7 }),
      }),
    );

    await user.click(within(dialog).getByRole('button', { name: 'Save the plan' }));
    await waitFor(() =>
      expect(bridge.$fn('deployServerBackups.savePlan')).toHaveBeenCalledWith({
        serverId: 'srv-1',
        plan: expect.objectContaining({
          name: 'Weekly',
          enabled: true,
          cron: '15 4 * * 1',
          keepLast: 7,
          destinationIds: [DISK.id],
          timeZone: expect.any(String),
        }),
      }),
    );
  });

  it('shows what the core finds wrong with a cron line', async () => {
    const { user } = renderPlans({
      'deployServerBackups.listPlans': [],
      'deployServerBackups.previewPlan': async () => ({
        ...PREVIEW,
        problem: 'That cron line never runs.',
      }),
    });
    await user.click(await screen.findByRole('button', { name: 'New plan' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('combobox', { name: 'Schedule' }));
    await user.click(await screen.findByRole('option', { name: 'Custom cron line' }));
    await user.type(within(dialog).getByLabelText('Cron line'), '0 0 31 2 *');
    expect(await within(dialog).findByText('That cron line never runs.')).toBeTruthy();
  });

  it('opens a saved plan with its preset filled in', async () => {
    const { user } = renderPlans();
    const row = await screen.findByRole('listitem', { name: 'Nightly' });
    await user.click(within(row).getByRole('button', { name: 'Edit Nightly' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit Nightly' });
    expect((within(dialog).getByLabelText('At') as HTMLInputElement).value).toBe('03:30');
    expect(
      within(dialog).getByRole('checkbox', { name: 'Storage box' }).getAttribute('data-state'),
    ).toBe('checked');
  });
});

function SecretHarness(): React.JSX.Element {
  const stepUp = useStepUp(SERVER);
  return (
    <>
      <SecretTab server={SERVER} stepUp={stepUp} />
      {stepUp.dialog}
    </>
  );
}

describe('SecretTab', () => {
  it('warns that a lost secret means no restore, and sets one typed twice', async () => {
    const { user, bridge } = renderWithProviders(<SecretHarness />, {
      bridge: {
        ...STEPPED_UP,
        'deployServerBackups.getSecret': { isSet: false },
        'deployServerBackups.setSecret': async () => ({ isSet: true, keyId: 'k1' }),
      },
    });
    expect(await screen.findByText(/no backup made with it can be restored/)).toBeTruthy();
    expect(screen.getByText(/never stored on the server/)).toBeTruthy();
    const save = screen.getByRole('button', { name: 'Set the secret key' });
    await user.type(screen.getByLabelText('New secret key'), 'too short');
    expect(screen.getByText('Use at least 12 characters.')).toBeTruthy();
    await user.clear(screen.getByLabelText('New secret key'));
    await user.type(screen.getByLabelText('New secret key'), 'orange tractor lamp');
    await user.type(screen.getByLabelText('New secret key again'), 'orange tractor lamp');
    await user.click(save);
    await waitFor(() =>
      expect(bridge.$fn('deployServerBackups.setSecret')).toHaveBeenCalledWith({
        serverId: 'srv-1',
        newSecret: 'orange tractor lamp',
      }),
    );
  });

  it('needs the current secret to change one', async () => {
    const { user, bridge } = renderWithProviders(<SecretHarness />, {
      bridge: {
        ...STEPPED_UP,
        'deployServerBackups.getSecret': { isSet: true, keyId: 'k1', updatedAtUnixMs: 1 },
        'deployServerBackups.setSecret': async () => ({ isSet: true, keyId: 'k1' }),
      },
    });
    await user.type(await screen.findByLabelText('Current secret key'), 'the old secret key');
    await user.type(screen.getByLabelText('New secret key'), 'orange tractor lamp');
    await user.type(screen.getByLabelText('New secret key again'), 'orange tractor lamp');
    await user.click(screen.getByRole('button', { name: 'Change the secret key' }));
    await waitFor(() =>
      expect(bridge.$fn('deployServerBackups.setSecret')).toHaveBeenCalledWith({
        serverId: 'srv-1',
        currentSecret: 'the old secret key',
        newSecret: 'orange tractor lamp',
      }),
    );
  });
});
