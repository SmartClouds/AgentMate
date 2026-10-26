import type { DeployAccess, DeployServer } from '@shared/deployTypes';
import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';

/**
 * Whether this computer can manage a core, said in words for each state, with the one step that
 * gets it further: sign in, enroll (again), or turn two-factor on.
 */

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const { CoreAccessCard } = await import('./CoreAccessCard');

const SERVER: DeployServer = {
  id: 'srv-1',
  nickname: 'Production',
  host: 'prod.example',
  port: 22,
  username: 'deployer',
  core: {
    version: '1.53.0',
    release: '/opt/runova-core/releases/1.53.0-abababababab',
    transport: 'streamlocal',
    installedAt: 0,
    os: 'Ubuntu 24.04.1 LTS',
    architecture: 'x86_64',
  },
  enrolled: true,
};

const SIGNED_IN: DeployAccess = {
  state: 'signed-in',
  user: { userName: 'maria', roles: ['owner'], twoFactorEnabled: false },
};

function renderCard(access: unknown, server = SERVER, bridge: Record<string, unknown> = {}) {
  return renderWithProviders(<CoreAccessCard server={server} />, {
    bridge: { 'deploy.access': access, ...bridge },
  });
}

beforeEach(() => {
  toast.success.mockClear();
  toast.error.mockClear();
});

describe('CoreAccessCard', () => {
  it('shimmers while the core is asked', () => {
    const { container } = renderCard(() => new Promise(() => undefined));

    expect(container.querySelector('[aria-busy="true"] .shimmer')).not.toBeNull();
  });

  it('names who is signed in, their role, and nudges toward two-factor', async () => {
    const { user } = renderCard(async () => SIGNED_IN);

    expect(await screen.findByText('maria')).toBeTruthy();
    expect(screen.getByText('owner')).toBeTruthy();
    expect(screen.getByText(/Two-factor is off/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /Turn on two-factor/ }));

    expect(await screen.findByRole('dialog', { name: /Turn on two-factor/ })).toBeTruthy();
  });

  it('offers to turn two-factor off once it is on', async () => {
    renderCard(async () => ({
      ...SIGNED_IN,
      user: { userName: 'maria', roles: ['owner'], twoFactorEnabled: true },
    }));

    expect(await screen.findByRole('button', { name: /Turn off two-factor/ })).toBeTruthy();
    expect(screen.getByText(/Two-factor is on/)).toBeTruthy();
  });

  it('says nothing about a password until this computer remembers one', async () => {
    renderCard(async () => SIGNED_IN);

    await screen.findByText('maria');

    expect(screen.queryByText(/remembers your password/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Forget it' })).toBeNull();
  });

  it('says it remembers the password, and forgets it on request', async () => {
    const { user, bridge } = renderCard(
      async () => ({ ...SIGNED_IN, passwordSaved: true }),
      SERVER,
      {
        'deploy.forgetPassword': async () => undefined,
      },
    );

    expect(await screen.findByText(/remembers your password/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Forget it' }));

    expect(bridge.$fn('deploy.forgetPassword')).toHaveBeenCalledWith('srv-1');
    expect(toast.success).toHaveBeenCalledWith(
      'Your password for Production is forgotten on this computer.',
    );
    await waitFor(() => expect(bridge.$fn('deploy.access')).toHaveBeenCalledTimes(2));
  });

  it('signs out and asks the core again', async () => {
    const { user, bridge } = renderCard(async () => SIGNED_IN, SERVER, {
      'deploy.signOut': async () => undefined,
    });

    await user.click(await screen.findByRole('button', { name: 'Sign out' }));

    expect(bridge.$fn('deploy.signOut')).toHaveBeenCalledWith('srv-1');
    expect(toast.success).toHaveBeenCalledWith('Signed out of Production.');
    await waitFor(() => expect(bridge.$fn('deploy.access')).toHaveBeenCalledTimes(2));
  });

  it('says why a sign-out failed', async () => {
    const { user } = renderCard(async () => SIGNED_IN, SERVER, {
      'deploy.signOut': async () => {
        throw new Error(
          "Error invoking remote method 'deploy:signOut': Error: The Servers vault is locked.",
        );
      },
    });

    await user.click(await screen.findByRole('button', { name: 'Sign out' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('The Servers vault is locked.'));
  });

  it('opens the sign-in dialog when the session is over, and asks again once signed in', async () => {
    let signedIn = false;
    const { user, bridge } = renderCard(
      async () => (signedIn ? SIGNED_IN : { state: 'needs-sign-in' }),
      SERVER,
      {
        'deploy.signIn': async () => {
          signedIn = true;
          return SIGNED_IN;
        },
      },
    );

    expect(await screen.findByText('Sign in to manage this core.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    const dialog = await screen.findByRole('dialog', { name: 'Sign in to Production' });
    await user.type(screen.getByLabelText('Password'), 'correct horse battery staple');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(dialog.isConnected).toBe(false));
    expect(await screen.findByText('maria')).toBeTruthy();
    expect(bridge.$fn('deploy.signIn')).toHaveBeenCalledTimes(1);
  });

  it('asks the core again once a dialog closes, so a revocation found there shows', async () => {
    let revoked = false;
    const { user } = renderCard(
      async () => (revoked ? { state: 'needs-re-enroll' } : SIGNED_IN),
      SERVER,
      {
        'deploy.stepUp': async () => {
          revoked = true;
          throw new Error(
            "Error invoking remote method 'deploy:stepUp': Error: [core:deviceRevoked] This device was revoked. Enroll it again to sign in.",
          );
        },
      },
    );

    await user.click(await screen.findByRole('button', { name: /Turn on two-factor/ }));
    await user.type(await screen.findByLabelText('Password'), 'correct horse battery staple');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'This device was revoked. Enroll it again to sign in.',
    );
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(await screen.findByRole('button', { name: /Enroll again/ })).toBeTruthy();
  });

  it("passes on the core's reason when the account is locked", async () => {
    renderCard(async () => ({
      state: 'needs-sign-in',
      message: 'Too many wrong attempts. This account is locked for 15 minutes.',
    }));

    expect(await screen.findByText(/locked for 15 minutes/)).toBeTruthy();
  });

  it('explains a revoked computer and offers to enroll it again', async () => {
    const { user } = renderCard(async () => ({ state: 'needs-re-enroll' }));

    expect(await screen.findByText(/no longer accepts this computer/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /Enroll again/ }));

    expect(
      await screen.findByRole('dialog', { name: 'Enroll this computer on Production' }),
    ).toBeTruthy();
  });

  it('offers an enrollment code as the way in that needs no sudo, and asks again once joined', async () => {
    let joined = false;
    const { user } = renderCard(
      async () => (joined ? SIGNED_IN : { state: 'not-enrolled' }),
      SERVER,
      {
        'deploySecurity.redeemEnrollmentCode': async () => {
          joined = true;
          return SIGNED_IN;
        },
      },
    );

    await user.click(await screen.findByRole('button', { name: /Use an enrollment code/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Join Production with a code' });
    await user.type(screen.getByLabelText('Enrollment code'), 'K7Q2M-X9PLR');
    await user.type(screen.getByLabelText('User name'), 'maria');
    await user.type(screen.getByLabelText('Password'), 'correct horse battery staple');
    await user.click(screen.getByRole('button', { name: 'Join' }));

    await waitFor(() => expect(dialog.isConnected).toBe(false));
    expect(await screen.findByText('maria')).toBeTruthy();
  });

  it('offers enrollment for a computer that never was, except on the DevHost', async () => {
    const { unmount } = renderCard(async () => ({ state: 'not-enrolled' }));
    expect(await screen.findByRole('button', { name: /Enroll this computer/ })).toBeTruthy();
    unmount();

    renderCard(async () => ({ state: 'not-enrolled' }), { ...SERVER, id: 'devhost', dev: true });
    expect(await screen.findByText('This computer is not enrolled on this core yet.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Enroll/ })).toBeNull();
  });

  it('says so when the core cannot be reached, and asks again on request', async () => {
    let calls = 0;
    const { user } = renderCard(async () => {
      calls += 1;
      return calls === 1
        ? { state: 'unreachable', message: 'Could not reach prod.example: connection refused' }
        : SIGNED_IN;
    });

    expect(await screen.findByText(/connection refused/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /Try again/ }));

    expect(await screen.findByText('maria')).toBeTruthy();
  });

  it('says so when asking failed altogether', async () => {
    renderCard(async () => {
      throw new Error("Error invoking remote method 'deploy:access': Error: boom");
    });

    expect(await screen.findByText('The core could not be asked who is signed in.')).toBeTruthy();
  });
});
