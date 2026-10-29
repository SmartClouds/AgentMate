import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { ProxyRouteDialog } from './ProxyRouteDialog';

/** The dialog that puts one published port on a domain through nginx. */

const SAVED = { problems: [], site: { settings: {} } };
const APPLIED = { applied: true, problems: [], warnings: [] };

function renderDialog(bridge: Record<string, unknown> = {}, onOpenWebsites?: () => void) {
  const onClose = vi.fn();
  const view = renderWithProviders(
    <ProxyRouteDialog
      serverId="srv-1"
      route={{ stack: 'shop', service: 'api', target: 3000, port: 8091 }}
      open
      onClose={onClose}
      onOpenWebsites={onOpenWebsites}
    />,
    { bridge },
  );
  return {
    ...view,
    onClose,
    dialog: screen.getByRole('dialog', { name: 'Put api:3000 on a domain' }),
  };
}

describe('ProxyRouteDialog', () => {
  it('shows where the domain will lead as it is typed', async () => {
    const { user, dialog } = renderDialog();
    expect(within(dialog).getByLabelText('Domain')).toHaveFocus();
    expect(within(dialog).getByLabelText('Route')).toHaveTextContent('your domain');
    await user.type(within(dialog).getByLabelText('Domain'), 'api.example.com');
    expect(within(dialog).getByLabelText('Route')).toHaveTextContent(
      'api.example.com127.0.0.1:8091api:3000',
    );
  });

  it('says what is wrong with the domain and sends nothing', async () => {
    const { user, bridge, dialog } = renderDialog();
    await user.click(within(dialog).getByRole('button', { name: 'Add the domain' }));
    expect(within(dialog).getByText('Enter a domain.')).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText('Domain'), 'https://api.example.com');
    await user.keyboard('{Enter}');
    expect(
      within(dialog).getByText('Enter just the domain, without http://, a path or a port.'),
    ).toBeInTheDocument();
    expect(() => bridge.$fn('deploySites.save')).toThrow();
  });

  it('skips the certificate and WebSocket when they are switched off', async () => {
    const { user, bridge, dialog } = renderDialog({
      'deploySites.save': SAVED,
      'deploySites.applyChanges': APPLIED,
    });
    await user.type(within(dialog).getByLabelText('Domain'), 'api.example.com');
    await user.click(within(dialog).getByRole('switch', { name: 'Get an HTTPS certificate' }));
    await user.click(within(dialog).getByRole('switch', { name: 'WebSocket' }));
    await user.click(within(dialog).getByRole('button', { name: 'Add the domain' }));
    const steps = await within(dialog).findByRole('list', { name: 'Steps' });
    expect(
      await within(steps).findByRole('listitem', { name: 'Ask for a certificate' }),
    ).toHaveTextContent('(skipped)');
    expect(bridge.$fn('deploySites.save').mock.calls[0][1]).toMatchObject({
      domains: ['api.example.com'],
      websocket: false,
      upstream: { kind: 'servicePort', service: 'shop-api', port: 8091 },
    });
    expect(() => bridge.$fn('deployCerts.issue')).toThrow();
    expect(within(dialog).getByText(/http:\/\/api\.example\.com/)).toBeInTheDocument();
  });

  it('marks the step that failed and lets the domain be tried again', async () => {
    const { user, dialog } = renderDialog({
      'deploySites.save': {
        problems: [{ field: 'domains[0]', message: 'api.example.com is used by the site blog.' }],
      },
    });
    await user.type(within(dialog).getByLabelText('Domain'), 'api.example.com');
    await user.click(within(dialog).getByRole('button', { name: 'Add the domain' }));
    const site = await within(dialog).findByRole('listitem', { name: 'Add the site in Websites' });
    expect(site).toHaveTextContent('(failed)');
    expect(site).toHaveTextContent('api.example.com is used by the site blog.');
    await user.click(within(dialog).getByRole('button', { name: 'Try again' }));
    expect(within(dialog).getByLabelText('Domain')).toHaveValue('api.example.com');
  });

  it('closes from Done and offers Websites only when it can open it', async () => {
    const { user, dialog, onClose } = renderDialog({
      'deploySites.save': SAVED,
      'deploySites.applyChanges': APPLIED,
      'deployCerts.issue': { id: 'job-cert' },
    });
    await user.type(within(dialog).getByLabelText('Domain'), 'api.example.com');
    await user.keyboard('{Enter}');
    await within(dialog).findByText(/api\.example\.com is set up/);
    expect(within(dialog).queryByRole('button', { name: 'Open in Websites' })).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('keeps the steps when the page is left mid-way, and shows them on return', async () => {
    let finishApply!: (value: unknown) => void;
    const bridge = {
      'deploySites.save': SAVED,
      'deploySites.applyChanges': () =>
        new Promise((resolve) => {
          finishApply = resolve;
        }),
    };
    const first = renderDialog(bridge);
    await first.user.type(within(first.dialog).getByLabelText('Domain'), 'api.example.com');
    await first.user.click(
      within(first.dialog).getByRole('switch', { name: 'Get an HTTPS certificate' }),
    );
    await first.user.click(within(first.dialog).getByRole('button', { name: 'Add the domain' }));
    const apply = await within(first.dialog).findByRole('listitem', { name: 'Apply nginx' });
    expect(apply).toHaveTextContent('(working)');
    first.unmount();

    finishApply(APPLIED);
    const again = renderDialog(bridge);
    expect(
      await within(again.dialog).findByText(/api\.example\.com is set up/),
    ).toBeInTheDocument();
    expect(within(again.dialog).queryByLabelText('Domain')).toBeNull();
    await again.user.click(within(again.dialog).getByRole('button', { name: 'Done' }));
    expect(again.onClose).toHaveBeenCalled();
    again.unmount();

    // Done with it, the next time starts at the form.
    const third = renderDialog(bridge);
    expect(within(third.dialog).getByLabelText('Domain')).toHaveValue('');
  });
});
