import { screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { ipcError, TURNSTILE_SECRET, WIDGET, ZONE } from '../testing/fixtures';

/**
 * Making or changing a Turnstile widget in one screen: the zone's own domain and a name are filled
 * in, Managed is picked, and the Enterprise options wait under Advanced. A widget just made opens
 * on its site key, its secret and the code to paste.
 */

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const { WidgetDialog } = await import('./WidgetDialog');

const onOpenChange = vi.fn();

function renderDialog(
  mode: Parameters<typeof WidgetDialog>[0]['mode'],
  bridge: Record<string, unknown> = {},
) {
  return renderWithProviders(
    <WidgetDialog open zone={ZONE} mode={mode} onOpenChange={onOpenChange} />,
    { bridge },
  );
}

beforeEach(() => {
  onOpenChange.mockClear();
  toast.success.mockClear();
});

describe('WidgetDialog', () => {
  it('starts from the zone, makes the widget and opens on its keys and code', async () => {
    const create = vi.fn(async () => ({
      widget: { ...WIDGET, domains: ['example.com'], name: 'example.com' },
      secret: TURNSTILE_SECRET,
    }));
    const secret = vi.fn(async () => 'never asked');
    const { user } = renderDialog(
      { kind: 'create' },
      { 'cloudflare.createTurnstileWidget': create, 'cloudflare.turnstileSecret': secret },
    );

    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('example.com');
    expect(screen.getByText('example.com', { selector: 'span' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: /Managed/ })).toBeChecked();
    expect(screen.getByText('1 of 10')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Create widget' }));

    expect(create).toHaveBeenCalledWith(ZONE.id, {
      name: 'example.com',
      domains: ['example.com'],
      mode: 'managed',
      clearance: 'no_clearance',
      region: 'world',
      offlabel: false,
      ephemeralId: false,
    });
    expect(await screen.findByRole('heading', { name: 'Your widget is ready' })).toBeTruthy();
    expect(screen.getByText(WIDGET.sitekey)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Show secret' }));
    expect(screen.getByText(TURNSTILE_SECRET)).toBeTruthy();
    expect(secret).not.toHaveBeenCalled();
    expect(screen.getByTestId('snippet').textContent).toContain(WIDGET.sitekey);
    expect(screen.getByRole('button', { name: /Testing on localhost/ })).toBeTruthy();
    expect(toast.success).toHaveBeenCalledWith('Created the example.com widget.');

    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('cannot be made without a name or a domain', async () => {
    const { user } = renderDialog({ kind: 'create' });
    const create = screen.getByRole('button', { name: 'Create widget' });

    await user.clear(screen.getByRole('textbox', { name: 'Name' }));
    expect(create).toBeDisabled();
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Login');
    expect(create).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Remove example.com' }));
    expect(create).toBeDisabled();
  });

  it('picks the mode with the keyboard and sends the advanced options', async () => {
    const create = vi.fn(async () => ({ widget: WIDGET, secret: TURNSTILE_SECRET }));
    const { user } = renderDialog(
      { kind: 'create' },
      { 'cloudflare.createTurnstileWidget': create },
    );

    screen.getByRole('radio', { name: /Managed/ }).focus();
    await user.keyboard('{ArrowRight}{ArrowRight}');
    expect(screen.getByRole('radio', { name: /Invisible/ })).toBeChecked();

    expect(screen.queryByRole('group', { name: 'Pre-clearance' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Advanced' }));
    const clearance = screen.getByRole('group', { name: 'Pre-clearance' });
    await user.click(within(clearance).getByRole('button', { name: 'Managed' }));
    await user.click(screen.getByRole('button', { name: 'China' }));
    await user.click(screen.getByRole('switch', { name: 'Hide Cloudflare branding' }));
    await user.click(screen.getByRole('switch', { name: 'Ephemeral IDs' }));
    expect(screen.getAllByText('Enterprise').length).toBeGreaterThanOrEqual(3);

    await user.click(screen.getByRole('button', { name: 'Create widget' }));

    expect(create).toHaveBeenCalledWith(ZONE.id, {
      name: 'example.com',
      domains: ['example.com'],
      mode: 'invisible',
      clearance: 'managed',
      region: 'china',
      offlabel: true,
      ephemeralId: true,
    });
  });

  it('shows what Cloudflare said when it refuses, and stays open', async () => {
    const create = vi.fn(async () => {
      throw ipcError('createTurnstileWidget', 'Cloudflare said: offlabel requires Enterprise');
    });
    const { user } = renderDialog(
      { kind: 'create' },
      { 'cloudflare.createTurnstileWidget': create },
    );

    await user.click(screen.getByRole('button', { name: 'Create widget' }));

    expect(await screen.findByText('Cloudflare said: offlabel requires Enterprise')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create widget' })).toBeEnabled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('edits a widget with its own values, advanced ones open when set, and saves it whole', async () => {
    const widget = { ...WIDGET, clearance: 'interactive' as const };
    const update = vi.fn(async () => widget);
    const { user } = renderDialog(
      { kind: 'edit', widget },
      { 'cloudflare.updateTurnstileWidget': update },
    );

    expect(screen.getByRole('heading', { name: 'Edit Contact form' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Contact form');
    expect(screen.getByText('3 of 10')).toBeTruthy();
    const clearance = screen.getByRole('group', { name: 'Pre-clearance' });
    expect(within(clearance).getByRole('button', { name: 'Interactive' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await user.clear(screen.getByRole('textbox', { name: 'Name' }));
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Contact');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(update).toHaveBeenCalledWith(ZONE.id, WIDGET.sitekey, {
      name: 'Contact',
      domains: WIDGET.domains,
      mode: 'managed',
      clearance: 'interactive',
      region: 'world',
      offlabel: false,
      ephemeralId: false,
    });
    expect(toast.success).toHaveBeenCalledWith('Saved Contact.');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('opens a listed widget straight on its code, with the secret on request', async () => {
    renderDialog({ kind: 'ready', widget: WIDGET });
    expect(screen.getByRole('heading', { name: 'Add Contact form to your site' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Get secret' })).toBeTruthy();
  });
});
