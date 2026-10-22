import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialogHost } from '@/components/ConfirmDialog';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { KIM, LEE, MARIA, MINUTE, SAM, SERVER } from './testing/fixtures';

/**
 * The Owner's list of who can sign in to a core: role, two-factor, lockout and last sign-in for
 * each, said in words, and every change behind the core's step-up. Removing someone takes their
 * name typed out; nothing here keeps a password.
 */

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const { UsersCard } = await import('./UsersCard');

const PASSWORD = 'a brand new passphrase';

function renderCard(bridge: Record<string, unknown> = {}) {
  return renderWithProviders(
    <>
      <UsersCard server={SERVER} />
      <ConfirmDialogHost />
    </>,
    {
      bridge: {
        'deploySecurity.listUsers': async () => [MARIA, SAM, LEE, KIM],
        // A step-up from a few minutes ago, so changes go ahead without the password dialog.
        'deploy.account': async () => ({ stepUpUntilUnixMs: Date.now() + 5 * MINUTE }),
        ...bridge,
      },
    },
  );
}

const row = (name: string) => screen.getByRole('listitem', { name });

async function openActions(user: ReturnType<typeof renderCard>['user'], name: string) {
  await user.click(await screen.findByRole('button', { name: `Actions for ${name}` }));
}

beforeEach(() => {
  toast.success.mockClear();
  toast.error.mockClear();
});

describe('UsersCard', () => {
  it('shimmers while the users load', () => {
    const { container } = renderCard({
      'deploySecurity.listUsers': () => new Promise(() => undefined),
    });

    expect(container.querySelector('[aria-busy="true"] .shimmer')).not.toBeNull();
  });

  it('says why the users could not be read, and asks again on request', async () => {
    let calls = 0;
    const { user } = renderCard({
      'deploySecurity.listUsers': async () => {
        calls += 1;
        if (calls === 1) {
          throw new Error(
            "Error invoking remote method 'deploySecurity:listUsers': Error: WebSocket closed",
          );
        }
        return [MARIA];
      },
    });

    expect(await screen.findByText('WebSocket closed')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /Try again/ }));

    expect(await screen.findByRole('listitem', { name: 'maria' })).toBeTruthy();
  });

  it('describes each user in words: role, two-factor, last sign-in, devices and status', async () => {
    renderCard();

    await screen.findByRole('listitem', { name: 'maria' });
    const maria = within(row('maria'));
    expect(maria.getByText('You')).toBeTruthy();
    expect(maria.getByText('Owner')).toBeTruthy();
    expect(maria.getByText(/Two-factor on/)).toBeTruthy();
    expect(maria.getByText(/Signed in 5m ago/)).toBeTruthy();
    expect(maria.getByText(/2 devices/)).toBeTruthy();
    expect(maria.getByText('Active')).toBeTruthy();
    const sam = within(row('sam'));
    expect(sam.getByText('Operator')).toBeTruthy();
    expect(sam.getByText(/Two-factor off/)).toBeTruthy();
    expect(sam.getByText(/Never signed in/)).toBeTruthy();
    expect(sam.getByText(/No devices/)).toBeTruthy();
    expect(within(row('lee')).getByText(/^Locked until /)).toBeTruthy();
    expect(within(row('lee')).getByText(/1 device$/)).toBeTruthy();
    expect(within(row('kim')).getByText('Disabled')).toBeTruthy();
  });

  it('adds a user with a role and a first password, then offers an enrollment code', async () => {
    const { user, bridge } = renderCard({
      'deploySecurity.createUser': async () => ({ ...SAM, userName: 'ana', role: 'admin' }),
    });

    await user.click(await screen.findByRole('button', { name: /Add a user/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a user' });
    await user.type(within(dialog).getByLabelText('User name'), 'ana');
    await user.click(within(dialog).getByRole('combobox', { name: 'Role' }));
    await user.click(await screen.findByRole('option', { name: 'Admin' }));
    expect(within(dialog).getByText(/Runs the server/)).toBeTruthy();
    await user.type(within(dialog).getByLabelText('First password'), PASSWORD);
    await user.type(within(dialog).getByLabelText('Confirm the password'), PASSWORD);
    await user.click(within(dialog).getByRole('button', { name: 'Add the user' }));

    await waitFor(() => expect(dialog.isConnected).toBe(false));
    expect(bridge.$fn('deploySecurity.createUser')).toHaveBeenCalledWith({
      serverId: 'srv-1',
      userName: 'ana',
      password: PASSWORD,
      role: 'admin',
    });
    expect(toast.success).toHaveBeenCalledWith(
      'ana can sign in to Production now.',
      expect.objectContaining({ action: expect.objectContaining({ label: 'Make a code' }) }),
    );
    // The toast's action opens the code dialog for the new user.
    const [, options] = toast.success.mock.calls[0] as [
      string,
      { action: { onClick: () => void } },
    ];
    options.action.onClick();
    expect(await screen.findByRole('dialog', { name: 'Enrollment code for ana' })).toBeTruthy();
  });

  it("keeps the dialog open with the core's reason when it refuses the new user", async () => {
    const { user } = renderCard({
      'deploySecurity.createUser': async () => {
        throw new Error(
          "Error invoking remote method 'deploySecurity:createUser': Error: That password is too common; it appears in lists attackers try first.",
        );
      },
    });

    await user.click(await screen.findByRole('button', { name: /Add a user/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a user' });
    await user.type(within(dialog).getByLabelText('User name'), 'ana');
    await user.type(within(dialog).getByLabelText('First password'), PASSWORD);
    await user.type(within(dialog).getByLabelText('Confirm the password'), PASSWORD);
    await user.click(within(dialog).getByRole('button', { name: 'Add the user' }));

    expect((await within(dialog).findByRole('alert')).textContent).toMatch(/too common/);
    expect(dialog.isConnected).toBe(true);
  });

  it('asks for the password first when the step-up has run out', async () => {
    const { user, bridge } = renderCard({
      'deploy.account': async () => ({ twoFactorEnabled: false }),
      'deploy.stepUp': async () => ({ stepUpUntilUnixMs: Date.now() + 10 * MINUTE }),
      'deploySecurity.setUserDisabled': async () => ({ ...KIM, disabled: false }),
    });

    await openActions(user, 'kim');
    await user.click(await screen.findByRole('menuitem', { name: /Enable/ }));
    const stepUp = await screen.findByRole('dialog', { name: 'Confirm it is you' });
    await user.type(within(stepUp).getByLabelText('Password'), 'correct horse battery staple');
    await user.click(within(stepUp).getByRole('button', { name: 'Confirm' }));

    await waitFor(() =>
      expect(bridge.$fn('deploySecurity.setUserDisabled')).toHaveBeenCalledWith({
        serverId: 'srv-1',
        userId: KIM.id,
        disabled: false,
      }),
    );
    expect(toast.success).toHaveBeenCalledWith('kim can sign in again.');
  });

  it('changes a role once confirmed, and passes on a refusal in words', async () => {
    const setUserRole = vi
      .fn()
      .mockResolvedValueOnce({ ...SAM, role: 'admin' })
      .mockRejectedValueOnce(
        new Error(
          "Error invoking remote method 'deploySecurity:setUserRole': Error: maria is the only Owner. Make someone else an Owner first.",
        ),
      );
    const { user } = renderCard({ 'deploySecurity.setUserRole': setUserRole });

    await openActions(user, 'sam');
    await user.click(await screen.findByRole('menuitemradio', { name: 'Admin' }));
    const confirm = await screen.findByRole('dialog', { name: 'Make sam an Admin?' });
    expect(confirm.textContent).toMatch(/open connections to the core close/);
    await user.click(within(confirm).getByRole('button', { name: 'Change the role' }));
    await waitFor(() =>
      expect(setUserRole).toHaveBeenCalledWith({
        serverId: 'srv-1',
        userId: SAM.id,
        role: 'admin',
      }),
    );
    expect(toast.success).toHaveBeenCalledWith('sam is an Admin now.');

    await openActions(user, 'maria');
    await user.click(await screen.findByRole('menuitemradio', { name: 'Viewer' }));
    const own = await screen.findByRole('dialog', { name: 'Make maria a Viewer?' });
    expect(own.textContent).toMatch(/You can no longer manage users/);
    await user.click(within(own).getByRole('button', { name: 'Change the role' }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'maria is the only Owner. Make someone else an Owner first.',
      ),
    );
  });

  it('does nothing when the confirmation is declined', async () => {
    const { user } = renderCard({ 'deploySecurity.setUserRole': vi.fn() });

    await openActions(user, 'sam');
    await user.click(await screen.findByRole('menuitemradio', { name: 'Viewer' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));

    expect(toast.success).not.toHaveBeenCalled();
  });

  it('disables a user after a destructive confirmation', async () => {
    const { user, bridge } = renderCard({
      'deploySecurity.setUserDisabled': async () => ({ ...SAM, disabled: true }),
    });

    await openActions(user, 'sam');
    await user.click(await screen.findByRole('menuitem', { name: /Disable/ }));
    const confirm = await screen.findByRole('dialog', { name: 'Disable sam?' });
    expect(confirm.textContent).toMatch(/signed out everywhere/);
    await user.click(within(confirm).getByRole('button', { name: 'Disable' }));

    await waitFor(() =>
      expect(bridge.$fn('deploySecurity.setUserDisabled')).toHaveBeenCalledWith({
        serverId: 'srv-1',
        userId: SAM.id,
        disabled: true,
      }),
    );
    expect(toast.success).toHaveBeenCalledWith('sam is disabled and signed out everywhere.');
  });

  it('resets a password through its own dialog', async () => {
    const { user, bridge } = renderCard({
      'deploySecurity.resetUserPassword': async () => undefined,
    });

    await openActions(user, 'sam');
    await user.click(await screen.findByRole('menuitem', { name: /Reset the password/ }));
    const dialog = await screen.findByRole('dialog', { name: "Reset sam's password" });
    const submit = within(dialog).getByRole('button', { name: 'Reset the password' });
    await user.type(within(dialog).getByLabelText('New password'), PASSWORD);
    await user.type(
      within(dialog).getByLabelText('Confirm the password'),
      'something else entirely',
    );
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    expect(within(dialog).getByText('The two passwords differ.')).toBeTruthy();
    await user.clear(within(dialog).getByLabelText('Confirm the password'));
    await user.type(within(dialog).getByLabelText('Confirm the password'), PASSWORD);
    await user.click(submit);

    await waitFor(() => expect(dialog.isConnected).toBe(false));
    expect(bridge.$fn('deploySecurity.resetUserPassword')).toHaveBeenCalledWith({
      serverId: 'srv-1',
      userId: SAM.id,
      password: PASSWORD,
    });
    expect(toast.success).toHaveBeenCalledWith(
      "sam's password is reset, and every session of theirs ended.",
    );
  });

  it('removes a user only once their name is typed out', async () => {
    const { user, bridge } = renderCard({ 'deploySecurity.deleteUser': async () => undefined });

    await openActions(user, 'sam');
    await user.click(await screen.findByRole('menuitem', { name: /Remove/ }));
    const confirm = await screen.findByRole('dialog', { name: 'Remove sam?' });
    const remove = within(confirm).getByRole('button', { name: 'Remove the user' });
    expect((remove as HTMLButtonElement).disabled).toBe(true);
    await user.type(within(confirm).getByLabelText('Type sam to confirm'), 'sam');
    await user.click(remove);

    await waitFor(() =>
      expect(bridge.$fn('deploySecurity.deleteUser')).toHaveBeenCalledWith({
        serverId: 'srv-1',
        userId: SAM.id,
      }),
    );
    expect(toast.success).toHaveBeenCalledWith('sam is removed.');
  });

  it('makes an enrollment code for a user, or for another computer of the signed-in one', async () => {
    const { user } = renderCard();

    await openActions(user, 'sam');
    await user.click(await screen.findByRole('menuitem', { name: /Enrollment code/ }));
    expect(await screen.findByRole('dialog', { name: 'Enrollment code for sam' })).toBeTruthy();
    await user.keyboard('{Escape}');
    await openActions(user, 'maria');
    await user.click(await screen.findByRole('menuitem', { name: /Enrollment code/ }));

    expect(
      await screen.findByRole('dialog', { name: 'Enrollment code for another computer of yours' }),
    ).toBeTruthy();
  });

  it("offers nothing on the signed-in user's own row that the core would refuse", async () => {
    const { user } = renderCard();

    await openActions(user, 'maria');

    expect(await screen.findByRole('menuitem', { name: /Enrollment code/ })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: /Disable/ })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: /Reset the password/ })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: /Remove/ })).toBeNull();
  });
});
