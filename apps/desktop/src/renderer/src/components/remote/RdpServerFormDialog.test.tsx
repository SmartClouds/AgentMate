import type { RdpSavedServer, RdpServerOptions, SaveRdpServerInput } from '@shared/apiTypes';
import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { RdpServerFormDialog } from './RdpServerFormDialog';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const options: RdpServerOptions = {
  resolution: 'fitWindow',
  fullscreenOnConnect: false,
  maximizeOnConnect: true,
  clipboard: true,
  fileTransfer: true,
  nla: true,
};

const saved: RdpSavedServer = {
  id: 'server-1',
  nickname: 'Build box',
  host: '10.0.0.5',
  port: 3389,
  username: 'Administrator',
  hasSecret: false,
  options,
  createdAt: 0,
  lastConnectedAt: null,
};

/** `null` opens the dialog for a new server, with nothing saved yet. */
async function openDisplaySection(initial: RdpSavedServer | null = saved) {
  const view = renderWithProviders(
    <RdpServerFormDialog
      open
      onOpenChange={() => undefined}
      initial={initial ?? undefined}
      onSaved={() => undefined}
    />,
    { bridge: { 'rdp.saveServer': async () => saved } },
  );
  await view.user.click(await screen.findByRole('button', { name: /Display and sharing/ }));
  return view;
}

function savedOptions(bridge: { $fn: (path: string) => unknown }): RdpServerOptions {
  const save = vi.mocked(bridge.$fn('rdp.saveServer') as (input: SaveRdpServerInput) => unknown);
  return (save.mock.calls[0][0] as SaveRdpServerInput).options;
}

describe('RdpServerFormDialog open mode', () => {
  it('shows the saved mode as the selected one', async () => {
    await openDisplaySection();
    expect(screen.getByRole('radio', { name: 'Maximized' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Window' })).not.toBeChecked();
    expect(screen.getByRole('radio', { name: 'Full screen' })).not.toBeChecked();
  });

  it('preselects Window for a new server', async () => {
    await openDisplaySection(null);
    expect(screen.getByRole('radio', { name: 'Window' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Maximized' })).not.toBeChecked();
    expect(screen.getByRole('radio', { name: 'Full screen' })).not.toBeChecked();
  });

  it('lets a new server be switched to Maximized and saves it', async () => {
    const { user, bridge } = await openDisplaySection(null);

    await user.type(screen.getByLabelText('Nickname'), 'Build box');
    await user.type(screen.getByLabelText('Computer'), '10.0.0.5');
    await user.type(screen.getByLabelText('Username'), 'Administrator');
    await user.click(screen.getByRole('radio', { name: 'Maximized' }));
    await user.click(screen.getByRole('button', { name: /^(Save|Add)/ }));

    await waitFor(() => expect(bridge.$fn('rdp.saveServer')).toHaveBeenCalled());
    expect(savedOptions(bridge)).toMatchObject({
      fullscreenOnConnect: false,
      maximizeOnConnect: true,
    });
  });

  it('treats a server saved before the option existed as a plain window, like the session does', async () => {
    const legacy = { ...options } as Partial<RdpServerOptions>;
    delete legacy.maximizeOnConnect;
    await openDisplaySection({ ...saved, options: legacy as RdpServerOptions });

    expect(screen.getByRole('radio', { name: 'Window' })).toBeChecked();
  });

  it.each([
    ['Window', { fullscreenOnConnect: false, maximizeOnConnect: false }],
    ['Full screen', { fullscreenOnConnect: true, maximizeOnConnect: false }],
  ])('saves %s', async (label, expected) => {
    const { user, bridge } = await openDisplaySection();

    await user.click(screen.getByRole('radio', { name: label }));
    expect(screen.getByRole('radio', { name: label })).toBeChecked();
    await user.click(screen.getByRole('button', { name: /^Save/ }));

    await waitFor(() => expect(bridge.$fn('rdp.saveServer')).toHaveBeenCalled());
    expect(savedOptions(bridge)).toMatchObject(expected);
  });

  it('goes back to Maximized after trying another mode', async () => {
    const { user, bridge } = await openDisplaySection();

    await user.click(screen.getByRole('radio', { name: 'Full screen' }));
    await user.click(screen.getByRole('radio', { name: 'Maximized' }));
    await user.click(screen.getByRole('button', { name: /^Save/ }));

    await waitFor(() => expect(bridge.$fn('rdp.saveServer')).toHaveBeenCalled());
    expect(savedOptions(bridge)).toMatchObject({
      fullscreenOnConnect: false,
      maximizeOnConnect: true,
    });
  });
});
