import type { SftpConflict } from '@shared/sftpTypes';
import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { ConflictDialog } from './ConflictDialog';
import type { ConflictDialogProps } from './contracts';

/**
 * "This file already exists": the two copies side by side with the newer one marked, Overwrite,
 * Keep both and Skip, and a box that gives the same answer to the rest of the transfer. Any way of
 * dismissing it skips this one file and nothing more.
 */

function conflict(over: Partial<SftpConflict> = {}): SftpConflict {
  return {
    conflictId: 'c1',
    batchId: 'b1',
    itemId: 'i1',
    direction: 'upload',
    name: 'report.pdf',
    relPath: 'docs/report.pdf',
    targetDir: '/var/www/docs',
    source: { size: 2048, mtimeMs: Date.UTC(2026, 9, 18, 12, 0, 0) },
    target: { size: 1024, mtimeMs: Date.UTC(2026, 9, 1, 9, 0, 0), isDirectory: false },
    renameTo: 'report (1).pdf',
    remainingInBatch: 4,
    ...over,
  };
}

function renderDialog(value: SftpConflict | null, over: Partial<ConflictDialogProps> = {}) {
  const props: ConflictDialogProps = {
    conflict: value,
    onResolve: vi.fn(),
    onCancelBatch: vi.fn(),
    ...over,
  };
  const view = renderWithProviders(<ConflictDialog {...props} />);
  const rerender = (next: Partial<ConflictDialogProps>) =>
    view.rerender(
      <TooltipProvider>
        <ConflictDialog {...props} {...next} />
      </TooltipProvider>,
    );
  return { ...view, props, rerender };
}

describe('ConflictDialog', () => {
  it('stays closed without a conflict', () => {
    renderDialog(null);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('names the file and where it is, and marks the newer copy', () => {
    renderDialog(conflict());
    const dialog = screen.getByRole('dialog', { name: 'This file already exists' });
    expect(within(dialog).getByText('report.pdf')).toBeInTheDocument();
    expect(within(dialog).getByText('/var/www/docs')).toBeInTheDocument();

    const yours = within(dialog).getByRole('region', { name: 'Yours' });
    const server = within(dialog).getByRole('region', { name: 'On the server' });
    expect(within(yours).getByText('Newer')).toBeInTheDocument();
    expect(within(yours).getByText('2.0 KB')).toBeInTheDocument();
    expect(within(server).queryByText('Newer')).toBeNull();
    expect(within(server).getByText('1.0 KB')).toBeInTheDocument();
  });

  it('puts the server copy first on a download and marks the local one when it is newer', () => {
    renderDialog(
      conflict({
        direction: 'download',
        targetDir: 'C:\\Users\\me\\Downloads',
        source: { size: 10, mtimeMs: 1_000 },
        target: { size: 20, mtimeMs: 9_000, isDirectory: false },
      }),
    );
    const regions = within(screen.getByRole('dialog')).getAllByRole('region');
    expect(regions.map((r) => r.getAttribute('aria-label'))).toEqual([
      'On the server',
      'On this computer',
    ]);
    expect(within(regions[1]!).getByText('Newer')).toBeInTheDocument();
    expect(within(regions[0]!).queryByText('Newer')).toBeNull();
  });

  it('marks neither copy when both have the same time', () => {
    renderDialog(
      conflict({
        source: { size: 1, mtimeMs: 5_000 },
        target: { size: 2, mtimeMs: 5_000, isDirectory: false },
      }),
    );
    expect(screen.queryByText('Newer')).toBeNull();
  });

  it('shows the name Keep both would give the new file', () => {
    renderDialog(conflict());
    expect(screen.getByText('report (1).pdf')).toBeInTheDocument();
  });

  it.each([
    ['Overwrite', 'overwrite'],
    ['Keep both', 'rename'],
    ['Skip', 'skip'],
  ] as const)('%s answers for this file alone by default', async (label, action) => {
    const { user, props } = renderDialog(conflict());
    await user.click(screen.getByRole('button', { name: label }));
    expect(props.onResolve).toHaveBeenCalledWith({ action, applyToAll: false });
  });

  it.each([
    ['Overwrite', 'overwrite'],
    ['Keep both', 'rename'],
    ['Skip', 'skip'],
  ] as const)(
    '%s answers for the rest of the transfer when the box is ticked',
    async (label, action) => {
      const { user, props } = renderDialog(conflict());
      await user.click(
        screen.getByRole('checkbox', {
          name: 'Do the same for the rest of this transfer (4 more files)',
        }),
      );
      await user.click(screen.getByRole('button', { name: label }));
      expect(props.onResolve).toHaveBeenCalledWith({ action, applyToAll: true });
    },
  );

  it('says "1 more file" for one, and hides the box when nothing else is left', () => {
    const { rerender } = renderDialog(conflict({ remainingInBatch: 1 }));
    expect(
      screen.getByRole('checkbox', {
        name: 'Do the same for the rest of this transfer (1 more file)',
      }),
    ).toBeInTheDocument();

    rerender({ conflict: conflict({ conflictId: 'c2', remainingInBatch: 0 }) });
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('skips this file only on Escape', async () => {
    const { user, props } = renderDialog(conflict());
    await user.click(screen.getByRole('checkbox', { name: /Do the same for the rest/ }));
    await user.keyboard('{Escape}');
    expect(props.onResolve).toHaveBeenCalledTimes(1);
    expect(props.onResolve).toHaveBeenCalledWith({ action: 'skip', applyToAll: false });
  });

  it('skips this file only when closed with the X', async () => {
    const { user, props } = renderDialog(conflict());
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(props.onResolve).toHaveBeenCalledWith({ action: 'skip', applyToAll: false });
  });

  it('does not offer Overwrite when a folder is in the way', () => {
    renderDialog(conflict({ target: { size: 0, mtimeMs: 1_000, isDirectory: true } }));
    expect(screen.getByRole('button', { name: 'Overwrite' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Keep both' })).toBeEnabled();
    expect(screen.getByText('Folder')).toBeInTheDocument();
  });

  it('answers each question once, then waits for the next one', async () => {
    let release: () => void = () => undefined;
    const onResolve = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const { user, rerender } = renderDialog(conflict(), { onResolve });

    await user.click(screen.getByRole('button', { name: 'Skip' }));
    expect(screen.getByRole('button', { name: 'Overwrite' })).toBeDisabled();
    await user.keyboard('{Escape}');
    release();
    await user.click(screen.getByRole('button', { name: 'Keep both' }));
    expect(onResolve).toHaveBeenCalledTimes(1);

    // The next snapshot brings the next question, with the box cleared again.
    rerender({ conflict: conflict({ conflictId: 'c2', name: 'logo.png' }), onResolve });
    expect(screen.getByRole('checkbox', { name: /Do the same/ })).not.toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Overwrite' }));
    expect(onResolve).toHaveBeenCalledTimes(2);
  });

  it('lets the question be answered again when the answer could not be sent', async () => {
    const onResolve = vi.fn().mockRejectedValueOnce(new Error('[files:server] boom'));
    const { user } = renderDialog(conflict(), { onResolve });
    await user.click(screen.getByRole('button', { name: 'Skip' }));
    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Skip' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Skip' }));
    expect(onResolve).toHaveBeenCalledTimes(2);
  });

  it('cancels the whole transfer from its link', async () => {
    const { user, props } = renderDialog(conflict());
    await user.click(screen.getByRole('button', { name: 'Cancel this transfer' }));
    expect(props.onCancelBatch).toHaveBeenCalledWith('b1');
    expect(props.onResolve).not.toHaveBeenCalled();
  });
});
