import type { DeployServer } from '@shared/deployTypes';
import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';

/**
 * Joining a core with an enrollment code an Owner made: no sudo, no root shell, only the code,
 * the user name and the password. This computer makes its own key; the password goes to the core
 * and is not saved here. Each refusal says what to do about it.
 */

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const { RedeemCodeDialog } = await import('./RedeemCodeDialog');

const SERVER: DeployServer = {
  id: 'srv-2',
  nickname: 'Staging',
  host: 'staging.example',
  port: 22,
  username: 'sam',
  core: null,
  enrolled: false,
};

const PASSWORD = 'another long passphrase';

function renderDialog(redeem: (input: unknown) => Promise<unknown>) {
  const onOpenChange = vi.fn();
  const onEnrolled = vi.fn();
  const view = renderWithProviders(
    <RedeemCodeDialog server={SERVER} open onOpenChange={onOpenChange} onEnrolled={onEnrolled} />,
    { bridge: { 'deploySecurity.redeemEnrollmentCode': redeem } },
  );
  return { ...view, onOpenChange, onEnrolled };
}

async function fill(user: ReturnType<typeof renderDialog>['user'], code = 'k7q2m-x9plr') {
  await user.type(screen.getByLabelText('Enrollment code'), code);
  await user.type(screen.getByLabelText('User name'), 'sam');
  await user.type(screen.getByLabelText('Password'), PASSWORD);
}

const refused = (code: string, message: string) => async () => {
  throw new Error(
    `Error invoking remote method 'deploySecurity:redeemEnrollmentCode': Error: [core:${code}] ${message}`,
  );
};

beforeEach(() => {
  toast.success.mockClear();
});

describe('RedeemCodeDialog', () => {
  it('joins with the code, user name and password, then closes signed in', async () => {
    const { user, bridge, onOpenChange, onEnrolled } = renderDialog(async () => ({
      state: 'signed-in',
    }));
    const join = screen.getByRole('button', { name: 'Join' }) as HTMLButtonElement;
    expect(join.disabled).toBe(true);

    await fill(user);
    await user.click(join);

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(bridge.$fn('deploySecurity.redeemEnrollmentCode')).toHaveBeenCalledWith({
      serverId: 'srv-2',
      code: 'k7q2m-x9plr',
      userName: 'sam',
      password: PASSWORD,
    });
    expect(onEnrolled).toHaveBeenCalledWith({ state: 'signed-in' });
    expect(toast.success).toHaveBeenCalledWith('This computer joined Staging and is signed in.');
  });

  it('leaves the authenticator code for the sign-in when two-factor is on', async () => {
    const { user, onEnrolled } = renderDialog(async () => ({ state: 'needs-sign-in' }));

    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Join' }));

    await waitFor(() => expect(onEnrolled).toHaveBeenCalled());
    expect(toast.success).toHaveBeenCalledWith('This computer joined Staging.', {
      description: 'Sign in with a code from your authenticator app to finish.',
    });
  });

  it.each([
    ['enrollmentCodeInvalid', 'That code is wrong, used or expired. Ask an Owner for a new one.'],
    ['invalidCredentials', 'That password is not right.'],
    ['rateLimited', 'Too many attempts. Wait a minute and try again.'],
    ['lockedOut', 'This account is disabled. An Owner of this core can turn it on again.'],
  ])('says what to do when the core answers %s', async (code, shown) => {
    const { user, onOpenChange } = renderDialog(refused(code, shown));

    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Join' }));

    expect((await screen.findByRole('alert')).textContent).toBe(shown);
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('passes on what stood in the way of reaching the core at all', async () => {
    const { user } = renderDialog(async () => {
      throw new Error(
        "Error invoking remote method 'deploySecurity:redeemEnrollmentCode': Error: The server core runs here, but your login sam cannot reach it: it is not in the runova group.",
      );
    });

    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Join' }));

    expect((await screen.findByRole('alert')).textContent).toMatch(/not in the runova group/);
  });
});
