import type { DeployServer, DeployTotpSetup } from '@shared/deployTypes';
import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';

/**
 * Turning two-factor on or off. Both begin with the password (the core's step-up), so a token
 * lifted from this computer cannot change the second factor by itself; recovery codes are shown
 * once, right after the code from the app checks out.
 */

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const { TwoFactorDialog } = await import('./TwoFactorDialog');

const SERVER: DeployServer = {
  id: 'srv-1',
  nickname: 'Production',
  host: 'prod.example',
  port: 22,
  username: 'deployer',
  core: null,
  enrolled: true,
};

const PASSWORD = 'correct horse battery staple';

const SETUP: DeployTotpSetup = {
  sharedKey: 'jbsw y3dp ehpk 3pxp',
  authenticatorUri: 'otpauth://totp/Runova%20Core:maria?secret=JBSWY3DPEHPK3PXP',
  qrDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
};

function renderDialog(mode: 'on' | 'off', bridge: Record<string, unknown>) {
  const onOpenChange = vi.fn();
  const onChanged = vi.fn();
  const view = renderWithProviders(
    <TwoFactorDialog
      server={SERVER}
      mode={mode}
      open
      onOpenChange={onOpenChange}
      onChanged={onChanged}
    />,
    { bridge: { 'deploy.stepUp': async () => ({ stepUpUntil: Date.now() + 600_000 }), ...bridge } },
  );
  return { ...view, onOpenChange, onChanged };
}

beforeEach(() => {
  toast.success.mockClear();
});

describe('TwoFactorDialog', () => {
  it('turns two-factor on: password, then the key, then the recovery codes', async () => {
    const { user, bridge, onOpenChange, onChanged } = renderDialog('on', {
      'deploy.beginTotp': async () => SETUP,
      'deploy.confirmTotp': async () => ({ codes: ['k3v9x-q2m7p', 'b8n4w-r6t1z'] }),
    });

    await user.type(screen.getByLabelText('Password'), PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(bridge.$fn('deploy.stepUp')).toHaveBeenCalledWith({
      serverId: 'srv-1',
      password: PASSWORD,
    });
    const qr = (await screen.findByAltText(
      'QR code with the new authenticator key',
    )) as HTMLImageElement;
    expect(qr.src).toBe(SETUP.qrDataUrl);
    expect(screen.getByLabelText('Authenticator key').textContent).toBe(SETUP.sharedKey);
    await user.click(screen.getByRole('button', { name: 'Copy the key' }));
    expect(await navigator.clipboard.readText()).toBe('jbswy3dpehpk3pxp');

    await user.type(screen.getByLabelText('Code from the app'), '123 456');
    await user.click(screen.getByRole('button', { name: 'Turn on' }));

    expect(bridge.$fn('deploy.confirmTotp')).toHaveBeenCalledWith('srv-1', '123456');
    const codes = await screen.findByRole('list', { name: 'Recovery codes' });
    expect(codes.textContent).toContain('k3v9x-q2m7p');
    expect(codes.textContent).toContain('b8n4w-r6t1z');
    expect(onChanged).toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Copy all' }));
    expect(await navigator.clipboard.readText()).toBe('k3v9x-q2m7p\nb8n4w-r6t1z');
    await user.click(screen.getByRole('button', { name: 'I saved them' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('turns two-factor off with the password and a current code', async () => {
    const beginTotp = vi.fn(async () => SETUP);
    const { user, bridge, onOpenChange, onChanged } = renderDialog('off', {
      'deploy.beginTotp': beginTotp,
      'deploy.disableTotp': async () => undefined,
    });

    await user.type(screen.getByLabelText('Password'), PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.type(await screen.findByLabelText('Code from the app'), '654321');
    expect(screen.queryByAltText('QR code with the new authenticator key')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Turn off' }));

    expect(bridge.$fn('deploy.disableTotp')).toHaveBeenCalledWith('srv-1', '654321');
    expect(beginTotp).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith('Two-factor is off.');
    expect(onChanged).toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('says so when the password is wrong and stays on that step', async () => {
    const beginTotp = vi.fn(async () => SETUP);
    const { user } = renderDialog('on', {
      'deploy.beginTotp': beginTotp,
      'deploy.stepUp': async () => {
        throw new Error("Error invoking remote method 'deploy:stepUp': Error: That is not right.");
      },
    });

    await user.type(screen.getByLabelText('Password'), 'not the password');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect((await screen.findByRole('alert')).textContent).toBe('That is not right.');
    expect(screen.getByLabelText('Password')).toBeTruthy();
    expect(beginTotp).not.toHaveBeenCalled();
  });

  it('keeps the code step open when the code does not check out', async () => {
    const { user, onChanged } = renderDialog('on', {
      'deploy.beginTotp': async () => SETUP,
      'deploy.confirmTotp': async () => {
        throw new Error(
          "Error invoking remote method 'deploy:confirmTotp': Error: That code is not right, or it was used already. Codes change every 30 seconds.",
        );
      },
    });

    await user.type(screen.getByLabelText('Password'), PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.type(await screen.findByLabelText('Code from the app'), '000000');
    await user.click(screen.getByRole('button', { name: 'Turn on' }));

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe(
        'That code is not right, or it was used already. Codes change every 30 seconds.',
      ),
    );
    expect(screen.queryByRole('list', { name: 'Recovery codes' })).toBeNull();
    expect(onChanged).not.toHaveBeenCalled();
  });
});
