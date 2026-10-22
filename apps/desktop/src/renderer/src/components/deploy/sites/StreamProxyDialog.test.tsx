import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { StreamProxyDialog, toStreamSettings } from './StreamProxyDialog';
import { SERVER, sitesBridge } from './testing/fixtures';

/** Adding a TCP or UDP proxy: what is checked here, what the core refuses, and a failed save. */

function renderDialog(bridge: Record<string, unknown> = {}) {
  const onSaved = vi.fn();
  const onClose = vi.fn();
  const view = renderWithProviders(
    <StreamProxyDialog
      serverId={SERVER.id}
      proxy={null}
      open
      onClose={onClose}
      onSaved={onSaved}
    />,
    { bridge: { ...sitesBridge(), ...bridge } },
  );
  return {
    ...view,
    onSaved,
    onClose,
    dialog: screen.getByRole('dialog', { name: 'Add a TCP or UDP proxy' }),
  };
}

describe('StreamProxyDialog', () => {
  it('checks the id, the ports, the target and the allow list before asking the core', async () => {
    const { user, dialog, bridge } = renderDialog();
    await user.type(within(dialog).getByLabelText('Id'), 'Bad Id');
    await user.type(within(dialog).getByLabelText('Public port'), '0');
    await user.type(within(dialog).getByLabelText('Passes to'), 'nowhere');
    await user.type(within(dialog).getByLabelText('Allow only these addresses'), 'nope');
    await user.click(within(dialog).getByRole('button', { name: /Save the proxy/ }));
    expect(
      within(dialog).getByText('Use lowercase letters, digits and hyphens.'),
    ).toBeInTheDocument();
    expect(within(dialog).getByText(/Ports go from 1/)).toBeInTheDocument();
    expect(within(dialog).getByText(/such as 127.0.0.1:5432/)).toBeInTheDocument();
    expect(within(dialog).getByText(/^nope: /)).toBeInTheDocument();
    expect(() => bridge.$fn('deploySites.saveStream')).toThrow(/has not been touched/);
  });

  it('saves a UDP proxy and shows what the core refused next to its field', async () => {
    let calls = 0;
    const { user, dialog, bridge, onSaved } = renderDialog({
      'deploySites.saveStream': async () => {
        calls += 1;
        if (calls === 1) {
          return {
            problems: [
              {
                field: 'streams[dns].listenPort',
                message: 'Another stream proxy already listens on UDP port 53.',
              },
              { field: 'nginx', message: 'nginx has no stream module.' },
            ],
          };
        }
        return { problems: [], proxy: {} };
      },
    });
    await user.type(within(dialog).getByLabelText('Id'), 'dns');
    await user.click(within(dialog).getByRole('combobox', { name: 'Protocol' }));
    await user.click(await screen.findByRole('option', { name: 'UDP' }));
    await user.type(within(dialog).getByLabelText('Public port'), '53');
    await user.type(within(dialog).getByLabelText('Passes to'), '127.0.0.1:5353');
    await user.click(within(dialog).getByRole('button', { name: /Save the proxy/ }));
    expect(await within(dialog).findByText(/already listens on UDP port 53/)).toBeInTheDocument();
    expect(within(dialog).getByText('nginx has no stream module.')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: /Save the proxy/ }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(bridge.$fn('deploySites.saveStream')).toHaveBeenCalledWith(SERVER.id, {
      id: 'dns',
      protocol: 'udp',
      listenPort: 53,
      upstream: {
        kind: 'endpoint',
        address: '127.0.0.1:5353',
        verifyCertificate: false,
        sendUpstreamHost: false,
      },
    });
  });

  it('says when saving failed, and closes on cancel', async () => {
    const { user, dialog, onClose } = renderDialog({
      'deploySites.saveStream': () => Promise.reject(new Error('Admins only.')),
    });
    await user.type(within(dialog).getByLabelText('Id'), 'pg');
    await user.type(within(dialog).getByLabelText('Public port'), '5432');
    await user.type(within(dialog).getByLabelText('Passes to'), '[[::1]:5432');
    await user.click(within(dialog).getByRole('button', { name: /Save the proxy/ }));
    expect(await within(dialog).findByText('Admins only.')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('reads a saved proxy that points at a bare port', () => {
    const { settings, errors } = toStreamSettings({
      id: 'pg',
      protocol: 'tcp',
      listenPort: '5432',
      target: '127.0.0.1:5433',
      allowFrom: '10.0.0.0/8',
    });
    expect(errors).toEqual({});
    expect(settings.allowFrom).toEqual(['10.0.0.0/8']);
  });
});
