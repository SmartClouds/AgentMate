import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { HOUR, NOW, SERVER } from './testing/fixtures';

/**
 * An Owner makes a single-use code so another computer can join as a user. The core keeps only
 * its hash, so this is the one time anybody sees it: shown with when it runs out, and copyable.
 */

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const { EnrollmentCodeDialog } = await import('./EnrollmentCodeDialog');

const CODE = { code: 'K7Q2M-X9PLR-4TVWC-H3NBD', userName: 'sam', expiresAtUnixMs: NOW + HOUR };

type Run = <T>(work: () => Promise<T>) => Promise<T | undefined>;
const straight: Run = (work) => work();

function renderDialog(
  options: { create?: unknown; run?: Run; self?: boolean; open?: boolean } = {},
) {
  const onOpenChange = vi.fn();
  const view = renderWithProviders(
    <EnrollmentCodeDialog
      server={SERVER}
      userName="sam"
      self={options.self ?? false}
      open={options.open ?? true}
      onOpenChange={onOpenChange}
      run={options.run ?? straight}
    />,
    { bridge: { 'deploySecurity.createEnrollmentCode': options.create ?? (async () => CODE) } },
  );
  return { ...view, onOpenChange };
}

beforeEach(() => {
  toast.success.mockClear();
  toast.error.mockClear();
});

describe('EnrollmentCodeDialog', () => {
  it('makes a code for as long as the Owner picked, and shows it once with its end', async () => {
    const { user, bridge } = renderDialog({
      create: async () => ({ ...CODE, expiresAtUnixMs: Date.now() + HOUR + 30_000 }),
    });

    expect(screen.getByText(/together with sam's password/)).toBeTruthy();
    await user.click(screen.getByRole('combobox', { name: 'Valid for' }));
    await user.click(await screen.findByRole('option', { name: '1 hour' }));
    await user.click(screen.getByRole('button', { name: 'Make the code' }));

    expect((await screen.findByLabelText('Enrollment code')).textContent).toBe(CODE.code);
    expect(bridge.$fn('deploySecurity.createEnrollmentCode')).toHaveBeenCalledWith({
      serverId: 'srv-1',
      userName: 'sam',
      validMinutes: 60,
    });
    expect(screen.getByText(/Works once, until .+ \(in 1h\)\./)).toBeTruthy();
    expect(screen.getByText(/only time it is shown/)).toBeTruthy();
  });

  it('copies the code', async () => {
    const { user } = renderDialog();
    await user.click(screen.getByRole('button', { name: 'Make the code' }));

    await user.click(await screen.findByRole('button', { name: /Copy the code/ }));

    expect(await navigator.clipboard.readText()).toBe(CODE.code);
    expect(toast.success).toHaveBeenCalledWith('Enrollment code copied.');
  });

  it('forgets the code once the dialog closes', async () => {
    const { user, rerender, onOpenChange } = renderDialog();
    await user.click(screen.getByRole('button', { name: 'Make the code' }));
    await user.click(await screen.findByRole('button', { name: 'Done' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);

    rerender(
      <EnrollmentCodeDialog
        server={SERVER}
        userName="sam"
        self={false}
        open={false}
        onOpenChange={onOpenChange}
        run={straight}
      />,
    );
    rerender(
      <EnrollmentCodeDialog
        server={SERVER}
        userName="sam"
        self={false}
        open
        onOpenChange={onOpenChange}
        run={straight}
      />,
    );

    await waitFor(() => expect(screen.queryByLabelText('Enrollment code')).toBeNull());
    expect(screen.getByRole('button', { name: 'Make the code' })).toBeTruthy();
  });

  it('says why the core would not make one', async () => {
    const { user } = renderDialog({
      create: async () => {
        throw new Error(
          "Error invoking remote method 'deploySecurity:createEnrollmentCode': Error: There is no user called sam.",
        );
      },
    });

    await user.click(screen.getByRole('button', { name: 'Make the code' }));

    expect((await screen.findByRole('alert')).textContent).toBe('There is no user called sam.');
  });

  it('stays put when the password confirmation is backed out of', async () => {
    const { user, bridge } = renderDialog({ run: async () => undefined });

    await user.click(screen.getByRole('button', { name: 'Make the code' }));

    expect(screen.getByRole('button', { name: 'Make the code' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(() => bridge.$fn('deploySecurity.createEnrollmentCode')).toThrow();
  });

  it('reads as your own when the code is for another computer of the signed-in user', () => {
    renderDialog({ self: true });

    expect(screen.getByRole('dialog', { name: 'Enrollment code for another computer of yours' }));
    expect(screen.getByText(/together with your password/)).toBeTruthy();
  });
});
