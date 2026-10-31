import { permissionDeniedMessage } from '@shared/cloudflare/permissions';
import { encodeCloudflareError } from '@shared/cloudflareErrors';
import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialogHost } from '@/components/ConfirmDialog';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { deferred, ipcError, OTHER_WIDGET, WIDGET, ZONE } from '../testing/fixtures';

/**
 * The zone's Turnstile tab. Widgets belong to the Cloudflare account, so the tab shows the ones
 * that cover this domain, with the rest of the account one click away. Each widget has its site
 * key to copy, its secret on request, the code to paste, and edit, rotate and delete.
 */

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const { TurnstileCard } = await import('./TurnstileCard');

function renderCard(bridge: Record<string, unknown> = {}) {
  return renderWithProviders(
    <>
      <TurnstileCard zone={ZONE} />
      <ConfirmDialogHost />
    </>,
    {
      bridge: {
        'cloudflare.listTurnstileWidgets': async () => [WIDGET, OTHER_WIDGET],
        ...bridge,
      },
    },
  );
}

function widgets(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    ...WIDGET,
    sitekey: `0x4AAAAAAAlist${String(index).padStart(6, '0')}`,
    name: index === 4 ? 'Newsletter' : `Form ${index}`,
  }));
}

beforeEach(() => {
  toast.success.mockClear();
  toast.error.mockClear();
});

describe('TurnstileCard', () => {
  it('shows a placeholder in place while the widgets load', () => {
    const { container } = renderCard({
      'cloudflare.listTurnstileWidgets': () => deferred<unknown[]>().promise,
    });
    expect(container.querySelector('[aria-busy="true"]')).toBeTruthy();
  });

  it("lists this domain's widgets with their mode, domains and site key", async () => {
    const { user } = renderCard();
    const list = await screen.findByRole('list', { name: 'Turnstile widgets' });
    const row = within(list).getByRole('listitem', { name: 'Contact form' });

    expect(within(row).getByText('Managed')).toBeTruthy();
    expect(within(row).getByText('example.com')).toBeTruthy();
    expect(within(row).getByText('www.example.com')).toBeTruthy();
    expect(within(row).getByText('+1')).toBeTruthy();
    expect(within(row).getByText(WIDGET.sitekey)).toBeTruthy();
    expect(within(list).queryByRole('listitem', { name: 'Blog comments' })).toBeNull();
    expect(screen.getByText('1 for example.com, 2 in this Cloudflare account')).toBeTruthy();

    await user.click(within(row).getByRole('button', { name: 'Copy site key' }));
    expect(await navigator.clipboard.readText()).toBe(WIDGET.sitekey);
  });

  it('shows every widget in the account when asked', async () => {
    const { user } = renderCard();
    await screen.findByRole('listitem', { name: 'Contact form' });

    await user.click(screen.getByRole('button', { name: /All in account/ }));

    expect(screen.getByRole('listitem', { name: 'Blog comments' })).toBeTruthy();
    expect(screen.getByRole('listitem', { name: 'Contact form' })).toBeTruthy();
  });

  it('offers a widget for the domain when none covers it, and the rest of the account', async () => {
    const { user } = renderCard({ 'cloudflare.listTurnstileWidgets': async () => [OTHER_WIDGET] });

    expect(await screen.findByText('No widget covers example.com yet')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'See 1 widget in this account' }));
    expect(screen.getByRole('listitem', { name: 'Blog comments' })).toBeTruthy();
  });

  it('starts the first widget from the domain', async () => {
    const { user } = renderCard({ 'cloudflare.listTurnstileWidgets': async () => [] });

    expect(await screen.findByText('No Turnstile widgets yet')).toBeTruthy();
    expect(screen.getByText(/stops bots on your forms/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Add a widget for example.com' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('textbox', { name: 'Name' })).toHaveValue('example.com');
  });

  it('reads a secret only when asked', async () => {
    const secret = vi.fn(async () => 'secret-value');
    const { user } = renderCard({ 'cloudflare.turnstileSecret': secret });
    const row = await screen.findByRole('listitem', { name: 'Contact form' });
    expect(secret).not.toHaveBeenCalled();

    await user.click(within(row).getByRole('button', { name: 'Get secret' }));

    expect(secret).toHaveBeenCalledWith(ZONE.id, WIDGET.sitekey);
  });

  it('opens the code, the editor and the secret rotation from a row', async () => {
    const { user } = renderCard();
    const row = await screen.findByRole('listitem', { name: 'Contact form' });

    await user.click(within(row).getByRole('button', { name: 'Add to your site' }));
    expect(
      await screen.findByRole('heading', { name: 'Add Contact form to your site' }),
    ).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Done' }));

    await user.click(within(row).getByRole('button', { name: 'Edit Contact form' }));
    expect(await screen.findByRole('heading', { name: 'Edit Contact form' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    await user.click(
      within(row).getByRole('button', { name: 'Rotate the secret of Contact form' }),
    );
    expect(
      await screen.findByRole('heading', { name: 'Rotate the secret of Contact form' }),
    ).toBeTruthy();
  });

  it('deletes a widget once confirmed, and refreshes the list', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce([WIDGET, OTHER_WIDGET])
      .mockResolvedValue([OTHER_WIDGET]);
    const remove = vi.fn(async () => undefined);
    const { user } = renderCard({
      'cloudflare.listTurnstileWidgets': list,
      'cloudflare.deleteTurnstileWidget': remove,
    });
    const row = await screen.findByRole('listitem', { name: 'Contact form' });

    await user.click(within(row).getByRole('button', { name: 'Delete Contact form' }));
    const confirm = await screen.findByRole('dialog', { name: /Delete the Contact form widget/ });
    expect(within(confirm).getByText(new RegExp(WIDGET.sitekey))).toBeTruthy();
    await user.click(within(confirm).getByRole('button', { name: 'Delete widget' }));

    expect(remove).toHaveBeenCalledWith(ZONE.id, WIDGET.sitekey);
    expect(toast.success).toHaveBeenCalledWith('Deleted Contact form.');
    expect(await screen.findByText('No widget covers example.com yet')).toBeTruthy();
  });

  it('keeps the widget when the delete is cancelled', async () => {
    const remove = vi.fn(async () => undefined);
    const { user } = renderCard({ 'cloudflare.deleteTurnstileWidget': remove });
    const row = await screen.findByRole('listitem', { name: 'Contact form' });

    await user.click(within(row).getByRole('button', { name: 'Delete Contact form' }));
    await user.click(
      within(
        await screen.findByRole('dialog', { name: /Delete the Contact form widget/ }),
      ).getByRole('button', { name: 'Cancel' }),
    );

    expect(remove).not.toHaveBeenCalled();
  });

  it('says why a delete failed', async () => {
    const { user } = renderCard({
      'cloudflare.deleteTurnstileWidget': async () => {
        throw ipcError('deleteTurnstileWidget', 'Cloudflare took too long to answer.');
      },
    });
    const row = await screen.findByRole('listitem', { name: 'Contact form' });

    await user.click(within(row).getByRole('button', { name: 'Delete Contact form' }));
    await user.click(
      within(
        await screen.findByRole('dialog', { name: /Delete the Contact form widget/ }),
      ).getByRole('button', { name: 'Delete widget' }),
    );

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Cloudflare took too long to answer.'),
    );
  });

  it('says exactly what to add when the token cannot manage Turnstile, and tries again', async () => {
    const refused = ipcError(
      'listTurnstileWidgets',
      encodeCloudflareError(
        'missing-permission',
        permissionDeniedMessage('turnstile'),
        'turnstile',
      ),
    );
    const list = vi.fn().mockRejectedValueOnce(refused).mockResolvedValue([WIDGET]);
    const { user } = renderCard({ 'cloudflare.listTurnstileWidgets': list });

    const fix = await screen.findByRole('alert');
    expect(within(fix).getByText('Account > Turnstile > Edit')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add widget' })).toBeNull();

    await user.click(within(fix).getByRole('button', { name: 'I added it, try again' }));
    expect(await screen.findByRole('listitem', { name: 'Contact form' })).toBeTruthy();
  });

  it('says what went wrong otherwise, with a retry', async () => {
    const pending = deferred<unknown[]>();
    const list = vi
      .fn()
      .mockRejectedValueOnce(ipcError('listTurnstileWidgets', 'Could not reach Cloudflare.'))
      .mockReturnValueOnce(pending.promise);
    const { user } = renderCard({ 'cloudflare.listTurnstileWidgets': list });

    expect(await screen.findByText('Could not reach Cloudflare.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /Try again/ }));
    pending.resolve([WIDGET]);
    expect(await screen.findByRole('listitem', { name: 'Contact form' })).toBeTruthy();
  });

  it('offers a search once there are many widgets', async () => {
    const { user } = renderCard({ 'cloudflare.listTurnstileWidgets': async () => widgets(8) });
    await screen.findByRole('listitem', { name: 'Form 0' });

    await user.type(screen.getByRole('searchbox', { name: 'Search widgets' }), 'news');

    const list = screen.getByRole('list', { name: 'Turnstile widgets' });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((row) => row.getAttribute('aria-label')),
    ).toEqual(['Newsletter']);
    await user.clear(screen.getByRole('searchbox', { name: 'Search widgets' }));
    await user.type(screen.getByRole('searchbox', { name: 'Search widgets' }), 'nothing like it');
    expect(screen.getByText('No widget matches that.')).toBeTruthy();
  });
});
