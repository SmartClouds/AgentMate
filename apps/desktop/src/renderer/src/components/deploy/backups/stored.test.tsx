import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { BOX, DISK, PLAN, SERVER, STEPPED_UP, STORED } from './testing/fixtures';

/**
 * What a destination holds (E28): each backup with its date, size, parts and the plan that made
 * it, and the three things to do with one: download it here, restore it, or delete it after a
 * confirmation.
 */

const { toast } = vi.hoisted(() => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('sonner', () => ({ toast }));
const confirm = vi.fn(async () => true);
vi.mock('@/stores/confirmStore', () => ({
  confirmDialog: (...args: unknown[]) => confirm(...(args as [])),
}));

const { StoredTab } = await import('./StoredTab');
const { useStepUp } = await import('../security/useStepUp');

function Harness({ onRestore }: { onRestore: (choice: unknown) => void }): React.JSX.Element {
  const stepUp = useStepUp(SERVER);
  return (
    <>
      <StoredTab server={SERVER} stepUp={stepUp} onRestore={onRestore} />
      {stepUp.dialog}
    </>
  );
}

function renderTab(bridge: Record<string, unknown> = {}, onRestore = vi.fn()) {
  return {
    onRestore,
    ...renderWithProviders(<Harness onRestore={onRestore} />, {
      bridge: {
        ...STEPPED_UP,
        'deployServerBackups.listDestinations': [DISK, BOX],
        'deployServerBackups.listPlans': [PLAN],
        'deployServerBackups.listStored': async () => [STORED],
        ...bridge,
      },
    }),
  };
}

describe('StoredTab', () => {
  it('lists what the first destination holds', async () => {
    const { bridge } = renderTab();
    const table = await screen.findByRole('table', { name: 'Backups on Local disk' });
    const row = within(table).getAllByRole('row')[1] as HTMLElement;
    expect(within(row).getByText('2 GB')).toBeTruthy();
    expect(within(row).getByText('2 parts')).toBeTruthy();
    expect(within(row).getByText('Nightly')).toBeTruthy();
    expect(within(row).getByText('web-1')).toBeTruthy();
    expect(bridge.$fn('deployServerBackups.listStored')).toHaveBeenCalledWith({
      serverId: 'srv-1',
      id: DISK.id,
    });
  });

  it('deletes a backup only after asking', async () => {
    const remove = vi.fn(async () => true);
    const { user } = renderTab({ 'deployServerBackups.deleteStored': remove });
    const table = await screen.findByRole('table');
    await user.click(within(table).getByRole('button', { name: /Delete the backup from/ }));
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive' }));
    await waitFor(() =>
      expect(remove).toHaveBeenCalledWith({
        serverId: 'srv-1',
        destinationId: DISK.id,
        backupId: STORED.backupId,
      }),
    );
  });

  it('hands a backup to the restore wizard and downloads one here', async () => {
    const download = vi.fn(async () => ({ saved: true, path: 'C:/b.ambackup', sizeBytes: 1 }));
    const { user, onRestore } = renderTab({ 'deployServerBackups.downloadStored': download });
    const table = await screen.findByRole('table');
    await user.click(within(table).getByRole('button', { name: /Restore the backup from/ }));
    expect(onRestore).toHaveBeenCalledWith({
      serverId: 'srv-1',
      destinationId: DISK.id,
      backupId: STORED.backupId,
    });
    await user.click(within(table).getByRole('button', { name: /Download the backup from/ }));
    await waitFor(() =>
      expect(download).toHaveBeenCalledWith({
        serverId: 'srv-1',
        destinationId: DISK.id,
        backupId: STORED.backupId,
      }),
    );
  });

  it('switches to another destination', async () => {
    const { user, bridge } = renderTab();
    await screen.findByRole('table');
    await user.click(screen.getByRole('combobox', { name: 'Destination' }));
    await user.click(await screen.findByRole('option', { name: 'Storage box' }));
    await waitFor(() =>
      expect(bridge.$fn('deployServerBackups.listStored')).toHaveBeenLastCalledWith({
        serverId: 'srv-1',
        id: BOX.id,
      }),
    );
  });
});
