import { type CoreErrorCode, encodeCoreError } from '@shared/coreErrors';
import type { DeployServer } from '@shared/deployTypes';
import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { SignInDialog, signInProblem } from './SignInDialog';

/**
 * Signing in to a core. This computer's key signs on its own, so the dialog only asks for the
 * password, then for a code when the account has two-factor, and says in words why a try failed.
 */

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

function refused(code: CoreErrorCode, message = 'Refused.'): Error {
  return new Error(
    `Error invoking remote method 'deploy:signIn': Error: ${encodeCoreError(code, message)}`,
  );
}

function renderDialog(signIn: (input: unknown) => Promise<unknown>, server = SERVER) {
  const onOpenChange = vi.fn();
  const onSignedIn = vi.fn();
  const view = renderWithProviders(
    <SignInDialog server={server} open onOpenChange={onOpenChange} onSignedIn={onSignedIn} />,
    { bridge: { 'deploy.signIn': signIn } },
  );
  return { ...view, onOpenChange, onSignedIn };
}

describe('signInProblem', () => {
  it.each<[CoreErrorCode, string]>([
    ['invalidCredentials', 'That password is not right.'],
    [
      'totpInvalid',
      'That code is not right, or it was used already. Codes change every 30 seconds.',
    ],
    ['deviceRevoked', 'The core no longer accepts this computer. Close this and enroll it again.'],
    ['deviceUnknown', 'The core no longer accepts this computer. Close this and enroll it again.'],
    ['rateLimited', 'Too many attempts. Wait a minute and try again.'],
  ])('puts %s in words', (code, message) => {
    expect(signInProblem(refused(code))).toBe(message);
  });

  it("passes the core's own words on for anything else, without the code", () => {
    expect(signInProblem(refused('lockedOut', 'This account is locked for 15 minutes.'))).toBe(
      'This account is locked for 15 minutes.',
    );
  });
});

describe('SignInDialog', () => {
  it('signs in with the password alone when the account has no two-factor', async () => {
    const { user, bridge, onOpenChange, onSignedIn } = renderDialog(async () => ({
      state: 'signed-in',
    }));
    const submit = screen.getByRole('button', { name: 'Sign in' });
    expect((submit as HTMLButtonElement).disabled).toBe(true);

    await user.type(screen.getByLabelText('Password'), PASSWORD);
    await user.click(submit);

    expect(bridge.$fn('deploy.signIn')).toHaveBeenCalledWith({
      serverId: 'srv-1',
      password: PASSWORD,
    });
    expect(onSignedIn).toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('asks for the authenticator code when the account has two-factor', async () => {
    let calls = 0;
    const { user, bridge, onSignedIn } = renderDialog(async () => {
      calls += 1;
      if (calls === 1) throw refused('totpRequired', 'Enter the code from your authenticator app.');
      return { state: 'signed-in' };
    });

    await user.type(screen.getByLabelText('Password'), PASSWORD);
    await user.keyboard('{Enter}');
    await user.type(await screen.findByLabelText('Authenticator code'), '123 456');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(bridge.$fn('deploy.signIn')).toHaveBeenLastCalledWith({
      serverId: 'srv-1',
      password: PASSWORD,
      totpCode: '123456',
    });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(onSignedIn).toHaveBeenCalledTimes(1);
  });

  it('takes a recovery code instead when the phone is gone', async () => {
    let calls = 0;
    const { user, bridge } = renderDialog(async () => {
      calls += 1;
      if (calls === 1) throw refused('totpRequired');
      return { state: 'signed-in' };
    });

    await user.type(screen.getByLabelText('Password'), PASSWORD);
    await user.keyboard('{Enter}');
    await user.click(await screen.findByRole('button', { name: /Use a recovery code/ }));
    await user.type(screen.getByLabelText('Recovery code'), ' k3v9x-q2m7p ');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(bridge.$fn('deploy.signIn')).toHaveBeenLastCalledWith({
      serverId: 'srv-1',
      password: PASSWORD,
      recoveryCode: 'k3v9x-q2m7p',
    });
  });

  it('says why a try failed and stays open for another', async () => {
    const { user, onOpenChange, onSignedIn } = renderDialog(async () => {
      throw refused('invalidCredentials', 'The user name or password is not right.');
    });

    await user.type(screen.getByLabelText('Password'), 'not the password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect((await screen.findByRole('alert')).textContent).toBe('That password is not right.');
    expect(onSignedIn).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("tells the DevHost's user and password, and no one else's", () => {
    const { unmount } = renderDialog(async () => undefined, {
      ...SERVER,
      id: 'devhost',
      dev: true,
    });
    expect(screen.getByText('runova-local-password')).toBeTruthy();
    unmount();

    renderDialog(async () => undefined);
    expect(screen.queryByText('runova-local-password')).toBeNull();
  });
});
