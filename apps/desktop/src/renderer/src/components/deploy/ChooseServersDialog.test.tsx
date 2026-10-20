import type { DeployServer } from '@shared/deployTypes';
import { screen, within } from '@testing-library/react';
import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { ChooseServersDialog } from './ChooseServersDialog';

/**
 * The picker behind "Choose servers to show": every saved server with a tick for the ones Deploy
 * lists. Nothing changes until Save, and a server picked now joins the end of the rail.
 */

function server(id: string, nickname: string, extra: Partial<DeployServer> = {}): DeployServer {
  return {
    id,
    nickname,
    host: `${id}.example`,
    port: 22,
    username: 'deployer',
    core: null,
    enrolled: false,
    ...extra,
  };
}

const SERVERS = [
  server('srv-1', 'Production'),
  server('srv-2', 'Staging'),
  server('srv-3', 'Backups'),
];

function LocationProbe(): React.JSX.Element {
  return <span data-testid="path">{useLocation().pathname}</span>;
}

function renderDialog(props: Partial<Parameters<typeof ChooseServersDialog>[0]> = {}) {
  const onOpenChange = vi.fn();
  const onSave = vi.fn();
  // The page owns whether the dialog is open, and a button there opens it again.
  function Page(): React.JSX.Element {
    const [open, setOpen] = useState(true);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Open the picker
        </button>
        <ChooseServersDialog
          open={open}
          onOpenChange={(next) => {
            onOpenChange(next);
            setOpen(next);
          }}
          servers={SERVERS}
          chosenIds={['srv-2']}
          onSave={onSave}
          {...props}
        />
        <LocationProbe />
      </>
    );
  }
  return { ...renderWithProviders(<Page />), onOpenChange, onSave };
}

function box(name: RegExp): HTMLElement {
  return within(screen.getByRole('dialog', { name: 'Choose servers to show' })).getByRole(
    'checkbox',
    { name },
  );
}

describe('ChooseServersDialog', () => {
  it('lists every saved server and ticks the ones Deploy shows', () => {
    renderDialog();

    expect(box(/Production/).getAttribute('aria-checked')).toBe('false');
    expect(box(/Staging/).getAttribute('aria-checked')).toBe('true');
    expect(box(/Backups/).getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText('deployer@srv-1.example:22')).toBeTruthy();
  });

  it('says the servers saved in Remote stay out of Deploy until picked', () => {
    renderDialog();

    expect(screen.getByText(/stay out of Deploy until you pick them/)).toBeTruthy();
  });

  it('saves the picked servers, the new ones after the ones already shown', async () => {
    const { user, onSave, onOpenChange } = renderDialog({ chosenIds: ['srv-3'] });

    await user.click(box(/Production/));
    await user.click(box(/Staging/));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith(['srv-3', 'srv-1', 'srv-2']);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('stops showing a server that was unticked', async () => {
    const { user, onSave } = renderDialog({ chosenIds: ['srv-1', 'srv-2', 'srv-3'] });

    await user.click(box(/Staging/));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(onSave).toHaveBeenCalledWith(['srv-1', 'srv-3']);
  });

  it('can end up showing no server at all', async () => {
    const { user, onSave } = renderDialog();

    await user.click(box(/Staging/));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(onSave).toHaveBeenCalledWith([]);
  });

  it('keeps Save off until the picks differ from what is shown', async () => {
    const { user } = renderDialog();
    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    await user.click(box(/Backups/));
    expect(save.disabled).toBe(false);

    await user.click(box(/Backups/));
    expect(save.disabled).toBe(true);
  });

  it('saves nothing on Cancel', async () => {
    const { user, onSave, onOpenChange } = renderDialog();

    await user.click(box(/Production/));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onSave).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('starts from what is shown each time it opens, not from an abandoned pick', async () => {
    const { user } = renderDialog();

    await user.click(box(/Production/));
    expect(box(/Production/).getAttribute('aria-checked')).toBe('true');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'Open the picker' }));

    expect(box(/Production/).getAttribute('aria-checked')).toBe('false');
    expect(box(/Staging/).getAttribute('aria-checked')).toBe('true');
  });

  it('marks the development server', () => {
    renderDialog({ servers: [...SERVERS, server('devhost', 'DevHost', { dev: true })] });

    expect(screen.getByText('Development')).toBeTruthy();
  });

  it('sends someone with no saved servers to Remote', async () => {
    const { user, onOpenChange } = renderDialog({ servers: [], chosenIds: [] });

    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.getByText(/no saved servers yet/i)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /Open Remote/ }));

    expect(screen.getByTestId('path').textContent).toBe('/remote');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
