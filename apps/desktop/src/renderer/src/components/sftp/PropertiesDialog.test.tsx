import type { SftpRemoteEntry } from '@shared/sftpTypes';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import type { PropertiesDialogProps } from './contracts';
import { PropertiesDialog } from './PropertiesDialog';

/**
 * Details and permissions of the selected remote entries: a Read / Write / Execute grid and an
 * octal field that follow each other, "Also apply inside" for a real folder, and boxes that show
 * as mixed when several entries disagree. Apply hands one chmod per resulting mode to the page.
 */

function entry(over: Partial<SftpRemoteEntry> = {}): SftpRemoteEntry {
  return {
    name: 'index.html',
    path: '/var/www/index.html',
    kind: 'file',
    isDirectory: false,
    isSymlink: false,
    size: 2048,
    mtimeMs: Date.UTC(2026, 9, 18, 12, 0, 0),
    mode: 0o644,
    owner: 'www-data',
    group: 'staff',
    ...over,
  };
}

const folder = entry({
  name: 'site',
  path: '/var/www/site',
  kind: 'dir',
  isDirectory: true,
  size: 0,
  mode: 0o755,
});

function renderDialog(entries: SftpRemoteEntry[], over: Partial<PropertiesDialogProps> = {}) {
  const props: PropertiesDialogProps = {
    open: true,
    entries,
    onOpenChange: vi.fn(),
    onApply: vi.fn(async () => undefined),
    ...over,
  };
  return { ...renderWithProviders(<PropertiesDialog {...props} />), props };
}

const box = (name: string) => screen.getByRole('checkbox', { name });
const octal = () => screen.getByRole('textbox', { name: 'Octal' });

describe('PropertiesDialog', () => {
  it('shows the details of one entry, owner and group included', () => {
    renderDialog([entry()]);
    const dialog = screen.getByRole('dialog', { name: 'index.html' });
    expect(within(dialog).getByText('/var/www/index.html')).toBeInTheDocument();
    expect(within(dialog).getByText('File')).toBeInTheDocument();
    expect(within(dialog).getByText('2.0 KB')).toBeInTheDocument();
    expect(within(dialog).getByText('www-data')).toBeInTheDocument();
    expect(within(dialog).getByText('staff')).toBeInTheDocument();
    expect(octal()).toHaveValue('644');
    expect(within(dialog).getByText('-rw-r--r--')).toBeInTheDocument();
  });

  it('opens on the octal field, so no tooltip pops up and one Escape closes it', async () => {
    const { user, props } = renderDialog([entry()]);
    await waitFor(() => expect(octal()).toHaveFocus());
    expect(screen.queryByRole('tooltip')).toBeNull();
    await user.keyboard('{Escape}');
    expect(props.onOpenChange).toHaveBeenCalledWith(false);
  });

  it('copies the path', async () => {
    const { user } = renderDialog([entry()]);
    await user.click(screen.getByRole('button', { name: 'Copy path' }));
    expect(await navigator.clipboard.readText()).toBe('/var/www/index.html');
  });

  it('moves the octal field when a box is clicked', async () => {
    const { user } = renderDialog([entry()]);
    expect(box('Owner read')).toBeChecked();
    expect(box('Group write')).not.toBeChecked();

    await user.click(box('Group write'));
    expect(octal()).toHaveValue('664');
    await user.click(box('Owner read'));
    expect(octal()).toHaveValue('264');
  });

  it('moves the boxes when an octal mode is typed', async () => {
    const { user } = renderDialog([entry()]);
    await user.clear(octal());
    await user.type(octal(), '751');
    expect(box('Owner execute')).toBeChecked();
    expect(box('Group read')).toBeChecked();
    expect(box('Group write')).not.toBeChecked();
    expect(box('Others execute')).toBeChecked();
    expect(box('Others read')).not.toBeChecked();
    expect(screen.getByText('-rwxr-x--x')).toBeInTheDocument();
  });

  it('shows the special bits once they are set, and keeps them in the octal mode', async () => {
    const { user } = renderDialog([entry()]);
    expect(screen.queryByRole('checkbox', { name: 'Set user ID (setuid)' })).toBeNull();
    await user.clear(octal());
    await user.type(octal(), '4755');
    expect(box('Set user ID (setuid)')).toBeChecked();
    await user.click(box('Sticky'));
    expect(octal()).toHaveValue('5755');
  });

  it('opens the special bits on request', async () => {
    const { user } = renderDialog([entry()]);
    await user.click(screen.getByRole('button', { name: /Special bits/ }));
    await user.click(box('Set group ID (setgid)'));
    expect(octal()).toHaveValue('2644');
  });

  it('turns Apply off while the octal field is not a mode', async () => {
    const { user } = renderDialog([entry()]);
    await user.clear(octal());
    await user.type(octal(), '9');
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
    expect(screen.getByText(/3 or 4 digits from 0 to 7/)).toBeInTheDocument();

    await user.clear(octal());
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
    await user.type(octal(), '0640');
    expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled();
  });

  it('has nothing to apply until something changes, and Enter does nothing then', async () => {
    const { user, props } = renderDialog([folder]);
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
    await user.click(octal());
    await user.keyboard('{Enter}');
    expect(props.onApply).not.toHaveBeenCalled();

    // The same mode again, but now reaching inside the folder, is a change worth applying.
    await user.click(screen.getByRole('checkbox', { name: 'Also apply inside' }));
    expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled();
    await user.click(octal());
    await user.keyboard('{Enter}');
    expect(props.onApply).toHaveBeenCalledWith({
      paths: ['/var/www/site'],
      mode: 0o755,
      recursive: 'all',
    });
  });

  it('applies the mode to the entry, then closes', async () => {
    const { user, props } = renderDialog([entry()]);
    await user.click(box('Group write'));
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(props.onApply).toHaveBeenCalledWith({
      paths: ['/var/www/index.html'],
      mode: 0o664,
      recursive: 'none',
    });
    await waitFor(() => expect(props.onOpenChange).toHaveBeenCalledWith(false));
  });

  it('offers "Also apply inside" only for a real folder', () => {
    const { unmount } = renderDialog([entry()]);
    expect(screen.queryByRole('checkbox', { name: 'Also apply inside' })).toBeNull();
    unmount();

    const link = renderDialog([{ ...folder, isSymlink: true }]);
    expect(screen.queryByRole('checkbox', { name: 'Also apply inside' })).toBeNull();
    link.unmount();

    renderDialog([folder]);
    expect(screen.getByRole('checkbox', { name: 'Also apply inside' })).toBeInTheDocument();
  });

  it('sends the chosen reach inside a folder', async () => {
    const { user, props } = renderDialog([folder]);
    expect(screen.queryByRole('radio', { name: 'Files only' })).toBeNull();

    await user.click(screen.getByRole('checkbox', { name: 'Also apply inside' }));
    expect(screen.getByRole('radio', { name: 'Folders and files' })).toBeChecked();
    await user.click(screen.getByRole('radio', { name: 'Files only' }));
    await user.click(screen.getByRole('button', { name: 'Apply' }));

    expect(props.onApply).toHaveBeenCalledWith({
      paths: ['/var/www/site'],
      mode: 0o755,
      recursive: 'files',
    });
  });

  it('shows bits several entries disagree on as mixed, and leaves them as they are', async () => {
    const a = entry({ name: 'a.txt', path: '/srv/a.txt', mode: 0o644, owner: 'ann' });
    const b = entry({ name: 'b.txt', path: '/srv/b.txt', mode: 0o664, owner: 'bob' });
    const c = entry({ name: 'c.txt', path: '/srv/c.txt', mode: 0o644, owner: 'ann' });
    const { user, props } = renderDialog([a, b, c]);

    expect(screen.getByRole('dialog', { name: '3 items' })).toBeInTheDocument();
    expect(box('Group write')).toHaveAttribute('aria-checked', 'mixed');
    expect(box('Owner read')).toBeChecked();
    expect(octal()).toHaveValue('');
    expect(octal()).toHaveAttribute('placeholder', 'Mixed');
    expect(screen.getByText('Mixed owners')).toBeInTheDocument();

    // Others gets execute everywhere; group write stays what each file had.
    await user.click(box('Others execute'));
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(props.onApply).toHaveBeenCalledTimes(2);
    expect(props.onApply).toHaveBeenCalledWith({
      paths: ['/srv/a.txt', '/srv/c.txt'],
      mode: 0o645,
      recursive: 'none',
    });
    expect(props.onApply).toHaveBeenCalledWith({
      paths: ['/srv/b.txt'],
      mode: 0o665,
      recursive: 'none',
    });
  });

  it('settles a mixed bit with one click, and the octal field follows', async () => {
    const { user } = renderDialog([
      entry({ path: '/a', mode: 0o644 }),
      entry({ path: '/b', mode: 0o664 }),
    ]);
    await user.click(box('Group write'));
    expect(box('Group write')).toBeChecked();
    expect(octal()).toHaveValue('664');
  });

  it('stays open and says why when the change is refused', async () => {
    const onApply = vi
      .fn()
      .mockRejectedValue(new Error('[files:permissionDenied] Operation not permitted'));
    const { user, props } = renderDialog([entry()], { onApply });
    await user.click(box('Group write'));
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(await screen.findByText('Operation not permitted')).toBeInTheDocument();
    expect(props.onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled();
  });

  it('starts again from the entries each time it opens', async () => {
    const { user, rerender, props } = renderDialog([entry()]);
    await user.click(box('Group write'));
    expect(octal()).toHaveValue('664');
    const { TooltipProvider } = await import('@/components/ui/tooltip');
    rerender(
      <TooltipProvider>
        <PropertiesDialog {...props} open={false} />
      </TooltipProvider>,
    );
    rerender(
      <TooltipProvider>
        <PropertiesDialog {...props} open />
      </TooltipProvider>,
    );
    expect(octal()).toHaveValue('644');
  });
});

describe('PropertiesDialog, where permissions cannot change (E27)', () => {
  const REASON = 'The container is stopped. Start it to rename, delete or change permissions.';

  it('shows the details and the permissions, and says why they cannot change', async () => {
    const { user, props } = renderDialog([folder], { readOnlyReason: REASON });
    const dialog = screen.getByRole('dialog', { name: 'site' });
    expect(within(dialog).getByText('/var/www/site')).toBeInTheDocument();
    expect(within(dialog).getByText(REASON)).toBeInTheDocument();
    expect(box('Owner read')).toBeChecked();
    expect(box('Owner read')).toBeDisabled();
    expect(box('Others write')).toBeDisabled();
    expect(octal()).toHaveValue('755');
    expect(octal()).toBeDisabled();
    expect(within(dialog).queryByRole('button', { name: 'Apply' })).toBeNull();
    expect(within(dialog).queryByText('Also apply inside')).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Done' }));
    expect(props.onOpenChange).toHaveBeenCalledWith(false);
    expect(props.onApply).not.toHaveBeenCalled();
  });

  it('describes itself as details only', () => {
    renderDialog([entry()], { readOnlyReason: REASON });
    expect(screen.getByText('Details and permissions, read only.')).toBeInTheDocument();
  });
});
