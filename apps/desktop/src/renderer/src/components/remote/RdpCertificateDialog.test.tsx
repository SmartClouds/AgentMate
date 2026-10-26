import type { RdpCertificateCheckResult, RdpSavedServer } from '@shared/apiTypes';
import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { RdpCertificateDialog } from './RdpCertificateDialog';

/**
 * After a Windows Server is reinstalled it shows a new certificate. This dialog is where a person
 * sees the one saved, gets what the server presents now, and trusts it or forgets the saved one,
 * without having to open a session and meet the library's error first.
 */

const confirm = vi.hoisted(() => ({ answer: true, ask: vi.fn() }));
vi.mock('@/stores/confirmStore', () => ({
  confirmDialog: (options: unknown) => {
    confirm.ask(options);
    return Promise.resolve(confirm.answer);
  },
}));

const LIBRARY_TEXT = /error:|OPENSSL_internal|boringssl|ssl_cert\.cc|third_party/i;

const savedServer: RdpSavedServer = {
  id: 'server-1',
  nickname: 'Build box',
  host: '176.9.22.106',
  port: 3389,
  username: 'Administrator',
  hasSecret: true,
  certFingerprint: 'BB:99:88',
  certDetails: {
    subject: 'CN=WIN-OLD',
    issuer: 'CN=Old authority',
    validTo: 'Jan 1 00:00:00 2026 GMT',
  },
  options: {
    resolution: 'fitWindow',
    fullscreenOnConnect: false,
    maximizeOnConnect: true,
    clipboard: true,
    fileTransfer: true,
    nla: true,
  },
  createdAt: 0,
  lastConnectedAt: null,
};

const unsavedServer: RdpSavedServer = {
  ...savedServer,
  certFingerprint: undefined,
  certDetails: undefined,
};

const NEW_CERTIFICATE = {
  fingerprint: 'AA:11:22',
  subject: 'CN=WIN-NEW',
  issuer: 'CN=WIN-NEW',
  validTo: 'Apr 1 00:00:00 2027 GMT',
};

function renderDialog(
  server: RdpSavedServer | null,
  answer?: RdpCertificateCheckResult,
  extra: Record<string, unknown> = {},
) {
  const onOpenChange = vi.fn();
  const onChanged = vi.fn();
  const view = renderWithProviders(
    <RdpCertificateDialog server={server} onOpenChange={onOpenChange} onChanged={onChanged} />,
    {
      bridge: {
        ...(answer ? { 'rdp.checkCertificate': async () => answer } : {}),
        'rdp.trustCertificate': async () => undefined,
        'rdp.forgetCertificate': async () => undefined,
        ...extra,
      },
    },
  );
  return { ...view, onOpenChange, onChanged };
}

beforeEach(() => {
  confirm.answer = true;
  confirm.ask.mockClear();
});

describe('RdpCertificateDialog', () => {
  it('shows the saved certificate of the server', () => {
    renderDialog(savedServer);

    expect(screen.getByRole('dialog', { name: 'Certificate for Build box' })).toBeInTheDocument();
    expect(screen.getByText('CN=WIN-OLD', { selector: 'dd' })).toBeInTheDocument();
    expect(screen.getByText('BB:99:88')).toBeInTheDocument();
    expect(screen.getByText('Jan 1 00:00:00 2026 GMT')).toBeInTheDocument();
  });

  it('says nothing is saved yet for a server never connected to, and cannot forget what is not there', () => {
    renderDialog(unsavedServer);

    expect(screen.getByText(/Nothing is saved yet/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Forget saved certificate/ })).toBeDisabled();
  });

  it('renders nothing while no server is chosen', () => {
    renderDialog(null);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  describe('getting the certificate from the server', () => {
    it('reports that the server still presents the saved one', async () => {
      const { user, bridge } = renderDialog(savedServer, {
        ok: true,
        check: {
          certificate: { ...NEW_CERTIFICATE, fingerprint: 'BB:99:88' },
          status: 'same',
          saved: { fingerprint: 'BB:99:88' },
        },
      });

      await user.click(screen.getByRole('button', { name: /Get certificate from server/ }));

      expect(
        await screen.findByText('The server still presents the saved certificate.'),
      ).toBeInTheDocument();
      expect(bridge.$fn('rdp.checkCertificate')).toHaveBeenCalledWith('server-1');
      expect(
        screen.queryByRole('button', { name: /Trust this certificate/ }),
      ).not.toBeInTheDocument();
    });

    it('warns about a different certificate, as after a reinstall, and shows it next to the saved one', async () => {
      const { user } = renderDialog(savedServer, {
        ok: true,
        check: {
          certificate: NEW_CERTIFICATE,
          status: 'changed',
          saved: { fingerprint: 'BB:99:88' },
        },
      });

      await user.click(screen.getByRole('button', { name: /Get certificate from server/ }));

      expect(
        await screen.findByText(/This is not the certificate Runova saved/),
      ).toBeInTheDocument();
      expect(screen.getByText(/someone could be intercepting the connection/)).toBeInTheDocument();
      expect(screen.getByText('AA:11:22')).toBeInTheDocument();
      expect(screen.getByText('BB:99:88')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Trust this certificate' })).toBeInTheDocument();
    });

    it('trusts exactly the certificate it showed, then reads the list again', async () => {
      const { user, bridge, onChanged } = renderDialog(savedServer, {
        ok: true,
        check: {
          certificate: NEW_CERTIFICATE,
          status: 'changed',
          saved: { fingerprint: 'BB:99:88' },
        },
      });
      await user.click(screen.getByRole('button', { name: /Get certificate from server/ }));
      onChanged.mockClear();

      await user.click(await screen.findByRole('button', { name: 'Trust this certificate' }));

      await waitFor(() =>
        expect(bridge.$fn('rdp.trustCertificate')).toHaveBeenCalledWith('server-1', 'AA:11:22'),
      );
      await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
      // The comparison is out of date once the certificate is saved.
      expect(
        screen.queryByRole('button', { name: 'Trust this certificate' }),
      ).not.toBeInTheDocument();
    });

    it('offers to save the certificate of a server that has none yet', async () => {
      const { user, bridge } = renderDialog(unsavedServer, {
        ok: true,
        check: { certificate: NEW_CERTIFICATE, status: 'new' },
      });

      await user.click(screen.getByRole('button', { name: /Get certificate from server/ }));
      await user.click(await screen.findByRole('button', { name: 'Save this certificate' }));

      await waitFor(() =>
        expect(bridge.$fn('rdp.trustCertificate')).toHaveBeenCalledWith('server-1', 'AA:11:22'),
      );
    });

    it('says so when the certificate went out of date between getting it and trusting it', async () => {
      const { user } = renderDialog(
        savedServer,
        { ok: true, check: { certificate: NEW_CERTIFICATE, status: 'changed' } },
        {
          'rdp.trustCertificate': async () => {
            throw new Error(
              "Error invoking remote method 'rdp:trustCertificate': Error: out of date",
            );
          },
        },
      );
      await user.click(screen.getByRole('button', { name: /Get certificate from server/ }));

      await user.click(await screen.findByRole('button', { name: 'Trust this certificate' }));

      // Back to the start, with nothing left to trust, rather than a half state.
      await waitFor(() =>
        expect(
          screen.queryByRole('button', { name: 'Trust this certificate' }),
        ).not.toBeInTheDocument(),
      );
    });

    it('explains a server it could not reach in words, with the technical reason folded away', async () => {
      const { user } = renderDialog(savedServer, {
        ok: false,
        failure: {
          code: 'tls-key-usage',
          message:
            "The certificate 176.9.22.106:3389 presented can't be used to set up an encrypted connection.",
          detail: 'KEY_USAGE_BIT_INCORRECT (SSL routines)',
        },
      });

      await user.click(screen.getByRole('button', { name: /Get certificate from server/ }));

      expect(await screen.findByText("The server's certificate can't be used")).toBeInTheDocument();
      expect(screen.getByText('What you can try')).toBeInTheDocument();
      expect(screen.getByText('Technical details').closest('details')).not.toHaveAttribute('open');
      expect(document.body.textContent).not.toMatch(LIBRARY_TEXT);
    });

    it('still explains itself when the call throws', async () => {
      const { user } = renderDialog(savedServer, undefined, {
        'rdp.checkCertificate': async () => {
          throw new Error("Error invoking remote method 'rdp:checkCertificate': Error: boom");
        },
      });

      await user.click(screen.getByRole('button', { name: /Get certificate from server/ }));

      expect(await screen.findByText("Runova couldn't read the certificate.")).toBeInTheDocument();
      expect(document.body.textContent).not.toMatch(/Error invoking remote method/);
    });

    it('disables the buttons while it is connecting', async () => {
      let finish: (result: RdpCertificateCheckResult) => void = () => undefined;
      const { user } = renderDialog(savedServer, undefined, {
        'rdp.checkCertificate': () => new Promise((resolve) => (finish = resolve)),
      });

      await user.click(screen.getByRole('button', { name: /Get certificate from server/ }));

      expect(await screen.findByText(/Connecting to 176\.9\.22\.106/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Get certificate from server/ })).toBeDisabled();
      expect(screen.getByRole('button', { name: /Forget saved certificate/ })).toBeDisabled();

      finish({ ok: true, check: { certificate: NEW_CERTIFICATE, status: 'new' } });
      expect(
        await screen.findByRole('button', { name: 'Save this certificate' }),
      ).toBeInTheDocument();
    });
  });

  describe('forgetting the saved certificate', () => {
    it('asks first, then clears it and reads the list again', async () => {
      const { user, bridge, onChanged } = renderDialog(savedServer);

      await user.click(screen.getByRole('button', { name: /Forget saved certificate/ }));

      expect(confirm.ask).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Forget the saved certificate for "Build box"?',
          variant: 'destructive',
        }),
      );
      await waitFor(() =>
        expect(bridge.$fn('rdp.forgetCertificate')).toHaveBeenCalledWith('server-1'),
      );
      await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
    });

    it('leaves it alone when the person says no', async () => {
      confirm.answer = false;
      const { user, bridge, onChanged } = renderDialog(savedServer);

      await user.click(screen.getByRole('button', { name: /Forget saved certificate/ }));

      await waitFor(() => expect(confirm.ask).toHaveBeenCalled());
      expect(() => bridge.$fn('rdp.forgetCertificate')).toThrow();
      expect(onChanged).not.toHaveBeenCalled();
    });
  });

  it('closes from the Close button', async () => {
    const { user, onOpenChange } = renderDialog(savedServer);

    // The dialog's corner X is named "Close" too; the footer button is the one with no hidden label.
    const footerClose = screen
      .getAllByRole('button', { name: 'Close' })
      .find((button) => !button.querySelector('.sr-only'));
    expect(footerClose).toBeDefined();
    await user.click(footerClose as HTMLElement);

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
