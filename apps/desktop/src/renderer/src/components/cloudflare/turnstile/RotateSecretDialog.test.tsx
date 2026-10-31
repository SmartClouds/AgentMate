import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { ipcError, WIDGET, ZONE } from '../testing/fixtures';

/**
 * A new secret for a widget. The old one keeps working for two hours by default, so servers can
 * be moved over; after a leak it can stop at once. The new secret is shown right away.
 */

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const { RotateSecretDialog } = await import('./RotateSecretDialog');

const NEW_SECRET = '0x4AAAAAAABkMYrotated999';

function renderDialog(rotate: (...args: unknown[]) => Promise<unknown>) {
  const onOpenChange = vi.fn();
  const view = renderWithProviders(
    <RotateSecretDialog open zone={ZONE} widget={WIDGET} onOpenChange={onOpenChange} />,
    { bridge: { 'cloudflare.rotateTurnstileSecret': rotate } },
  );
  return { ...view, onOpenChange };
}

beforeEach(() => {
  toast.success.mockClear();
});

describe('RotateSecretDialog', () => {
  it('keeps the old secret for two hours unless asked, and shows the new one', async () => {
    const rotate = vi.fn(async () => ({ widget: WIDGET, secret: NEW_SECRET }));
    const { user, onOpenChange } = renderDialog(rotate);

    expect(
      screen.getByRole('radio', { name: /Keep the old secret working for 2 hours/ }),
    ).toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Rotate secret' }));

    expect(rotate).toHaveBeenCalledWith(ZONE.id, WIDGET.sitekey, false);
    await user.click(await screen.findByRole('button', { name: 'Show secret' }));
    expect(screen.getByText(NEW_SECRET)).toBeTruthy();
    expect(screen.getByText(/TURNSTILE_SECRET/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Copy secret' }));
    expect(await navigator.clipboard.readText()).toBe(NEW_SECRET);
    expect(toast.success).toHaveBeenCalledWith('Made a new secret for Contact form.');

    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('stops the old secret at once when that is picked', async () => {
    const rotate = vi.fn(async () => ({ widget: WIDGET, secret: NEW_SECRET }));
    const { user } = renderDialog(rotate);

    await user.click(screen.getByRole('radio', { name: /Stop the old secret now/ }));
    await user.click(screen.getByRole('button', { name: 'Rotate secret' }));

    expect(rotate).toHaveBeenCalledWith(ZONE.id, WIDGET.sitekey, true);
  });

  it('says what went wrong and lets the user try again', async () => {
    const rotate = vi.fn(async () => {
      throw ipcError('rotateTurnstileSecret', 'Cloudflare took too long to answer.');
    });
    const { user } = renderDialog(rotate);

    await user.click(screen.getByRole('button', { name: 'Rotate secret' }));

    expect(await screen.findByText('Cloudflare took too long to answer.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Rotate secret' })).toBeEnabled();
  });
});
