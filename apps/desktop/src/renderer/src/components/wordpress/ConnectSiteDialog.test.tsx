import { fireEvent, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NOW_SECONDS, wpKey, wpSite } from '@/components/deploy/wordpress/testing/fixtures';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { ConnectSiteDialog } from './ConnectSiteDialog';

/**
 * Connecting a site: the key is read locally to show what it connects before anything is sent,
 * plain HTTP needs an explicit yes, every failure reads as a person would say it, and the key is
 * gone from the dialog once it has been used or the dialog closes.
 */

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn() }),
);
vi.mock('sonner', () => ({ toast }));

beforeEach(() => {
  toast.success.mockClear();
  toast.error.mockClear();
});

function keyBox(): HTMLTextAreaElement {
  return screen.getByLabelText('Connection key') as HTMLTextAreaElement;
}

/** Pasting is one input event; typing a 400-character key one key at a time is slow for nothing. */
function paste(value: string): void {
  fireEvent.change(keyBox(), { target: { value } });
}

function connectButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: 'Connect' }) as HTMLButtonElement;
}

function renderDialog(bridge: Record<string, unknown> = {}, onConnected = vi.fn()) {
  const onOpenChange = vi.fn();
  const view = renderWithProviders(
    <ConnectSiteDialog open onOpenChange={onOpenChange} onConnected={onConnected} />,
    { bridge },
  );
  return { ...view, onOpenChange, onConnected };
}

/** A dialog that really closes and opens again, the way a page holds it. */
function Toggle(): React.JSX.Element {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open again
      </button>
      <ConnectSiteDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

describe('ConnectSiteDialog key preview', () => {
  it('shows the site, scope and time left before connecting', async () => {
    renderDialog();
    paste(wpKey({ scope: 'read' }));

    expect(screen.getByText('https://bakery.example')).toBeTruthy();
    expect(
      screen.getByText('Read-only key. You can pull files from this site but not deploy to it.'),
    ).toBeTruthy();
    expect(screen.getByText(/Works for (9|10) more minutes/)).toBeTruthy();
    expect(connectButton().disabled).toBe(false);
  });

  it('reads a key that was wrapped and indented on the way', async () => {
    renderDialog();
    const key = wpKey();
    paste(`  ${key.slice(0, 40)}\n    ${key.slice(40)}\n`);

    expect(screen.getByText('https://bakery.example')).toBeTruthy();
    expect(connectButton().disabled).toBe(false);
  });

  it('says what is wrong with a key that does not read, and keeps Connect off', () => {
    renderDialog();
    paste('hello there');
    expect(screen.getByText(/doesn't look like a connection key/)).toBeTruthy();
    expect(connectButton().disabled).toBe(true);

    paste(wpKey({ expiresAt: NOW_SECONDS - 5 }));
    expect(screen.getByText(/This key has expired/)).toBeTruthy();
    expect(connectButton().disabled).toBe(true);
  });

  it('turns spelling and autocomplete off on the key box', () => {
    renderDialog();
    expect(keyBox().getAttribute('spellcheck')).toBe('false');
    expect(keyBox().getAttribute('autocomplete')).toBe('off');
  });
});

describe('ConnectSiteDialog plain HTTP', () => {
  const plainKey = () =>
    wpKey({
      siteUrl: 'http://staging.bakery.example',
      restUrl: 'http://staging.bakery.example/wp-json/runova/v1',
      ajaxUrl: 'http://staging.bakery.example/wp-admin/admin-ajax.php',
    });

  it('asks for an explicit yes, with a warning, before connecting over plain HTTP', async () => {
    const { user, bridge } = renderDialog({
      'deployWordPress.connect': async () => wpSite({ transport: 'plain-http' }),
    });
    paste(plainKey());

    expect(
      screen.getByText(/anyone on the network between you and the site can read/),
    ).toBeTruthy();
    expect(connectButton().disabled).toBe(true);
    await user.click(screen.getByRole('switch', { name: 'Allow plain HTTP for this site' }));
    await user.click(connectButton());

    await waitFor(() =>
      expect(bridge.$fn('deployWordPress.connect')).toHaveBeenCalledWith({
        connectionKey: plainKey(),
        allowPlainHttp: true,
      }),
    );
  });

  it('asks nothing for plain HTTP to this computer', () => {
    renderDialog();
    paste(
      wpKey({
        siteUrl: 'http://localhost:8080',
        restUrl: 'http://localhost:8080/wp-json/runova/v1',
        ajaxUrl: 'http://localhost:8080/wp-admin/admin-ajax.php',
      }),
    );

    expect(screen.queryByRole('switch', { name: 'Allow plain HTTP for this site' })).toBeNull();
    expect(screen.getByText(/fine for local development/)).toBeTruthy();
    expect(connectButton().disabled).toBe(false);
  });
});

describe('ConnectSiteDialog connecting', () => {
  it('sends the key without whitespace, the name and the HTTP sign-in, then clears the key', async () => {
    const site = wpSite();
    const { user, bridge, onConnected } = renderDialog({
      'deployWordPress.connect': async () => site,
    });
    const key = wpKey();
    paste(`${key}\n`);
    await user.type(screen.getByLabelText('Name in Runova (optional)'), 'Shop');
    await user.click(screen.getByRole('switch', { name: 'The site asks for an HTTP sign-in' }));
    expect(connectButton().disabled).toBe(true);
    await user.type(screen.getByLabelText('User name'), 'staging');
    await user.type(screen.getByLabelText('Password'), 'hunter2');
    await user.click(connectButton());

    await waitFor(() => expect(onConnected).toHaveBeenCalledWith(site));
    expect(bridge.$fn('deployWordPress.connect')).toHaveBeenCalledWith({
      connectionKey: key,
      label: 'Shop',
      httpAuth: { username: 'staging', password: 'hunter2' },
    });
    expect(keyBox().value).toBe('');
    expect((screen.queryByLabelText('Password') as HTMLInputElement | null)?.value ?? '').toBe('');
    expect(toast.success).toHaveBeenCalledWith('Connected Bakery.');
    for (const call of [...toast.success.mock.calls, ...toast.error.mock.calls]) {
      expect(JSON.stringify(call)).not.toContain(key);
    }
  });

  it('clears the key when the dialog is closed and opened again', async () => {
    const { user } = renderWithProviders(<Toggle />);
    paste(wpKey());
    expect(keyBox().value).not.toBe('');

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'Open again' }));

    expect(keyBox().value).toBe('');
  });

  it('clears the key when the dialog is closed with Escape', async () => {
    const { user } = renderWithProviders(<Toggle />);
    paste(wpKey());

    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Open again' }));

    expect(keyBox().value).toBe('');
  });

  it('opens the HTTP sign-in fields when the site asks for one', async () => {
    const { user } = renderDialog({
      'deployWordPress.connect': async () => {
        throw new Error(
          "Error invoking remote method 'deployWordPress:connect': Error: [wp:httpAuthRequired] 401",
        );
      },
    });
    paste(wpKey());
    await user.click(connectButton());

    expect(await screen.findByText(/Turn on "HTTP sign-in" below/)).toBeTruthy();
    expect(screen.getByLabelText('User name')).toBeTruthy();
    expect(keyBox().value).not.toBe('');
  });

  it('downloads the plugin from the dialog', async () => {
    const { user, bridge } = renderDialog({
      'deployWordPress.saveConnectorZip': async () => ({ saved: true, path: 'C:\\x.zip' }),
    });
    await user.click(screen.getByRole('button', { name: /Download the plugin/ }));

    expect(bridge.$fn('deployWordPress.saveConnectorZip')).toHaveBeenCalled();
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Saved the plugin to C:\\x.zip.'),
    );
  });
});

describe('ConnectSiteDialog failures', () => {
  const cases: Array<[string, RegExp]> = [
    ['keyInvalid', /isn't a connection key Runova can read/],
    ['keyExpired', /This key has expired/],
    ['pairingExpired', /This key has expired/],
    ['pairingInvalid', /didn't accept this key/],
    ['plainHttpRefused', /refuses unless you allow it below/],
    ['tlsUntrusted', /doesn't trust the site's HTTPS certificate/],
    ['httpAuthRequired', /asks for an HTTP sign-in/],
    ['foreignResponse', /firewall.*Cloudflare/],
    ['siteKeyMismatch', /identity doesn't match the key/],
    ['unreachable', /Couldn't reach the site/],
    ['timeout', /took too long to answer/],
  ];

  it.each(cases)('explains [wp:%s] in plain words', async (code, expected) => {
    const { user } = renderDialog({
      'deployWordPress.connect': async () => {
        throw new Error(
          `Error invoking remote method 'deployWordPress:connect': Error: [wp:${code}] raw`,
        );
      },
    });
    paste(wpKey());
    await user.click(connectButton());

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(expected);
    expect(alert.textContent).not.toContain('[wp:');
  });

  it('never shows a message that carries the key', async () => {
    const key = wpKey();
    const { user } = renderDialog({
      'deployWordPress.connect': async () => {
        throw new Error(`Something echoed ${key}`);
      },
    });
    paste(key);
    await user.click(connectButton());

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('The site refused the connection.');
  });
});
