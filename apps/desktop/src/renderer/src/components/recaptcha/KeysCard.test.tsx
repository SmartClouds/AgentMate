import { encodeRecaptchaError } from '@shared/recaptchaErrors';
import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialogHost } from '@/components/ConfirmDialog';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { ACCOUNT, CHECKBOX_KEY, ipcError, SCORE_KEY } from './testing/fixtures';

/**
 * A project's keys: each with its type, domains and site key to copy, the secret only on request,
 * and the code to paste one click away. With many keys there is a search and a type filter.
 */

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const { KeysCard } = await import('./KeysCard');

const PROJECT = { accountId: ACCOUNT.id, projectId: 'shop-project' };

function renderCard(bridge: Record<string, unknown> = {}, route = '/deploy?recaptcha=1') {
  return renderWithProviders(
    <>
      <KeysCard project={PROJECT} />
      <ConfirmDialogHost />
    </>,
    {
      route,
      bridge: {
        'deployRecaptcha.listKeys': async () => [SCORE_KEY, CHECKBOX_KEY],
        'deployWordPress.listSites': async () => [],
        ...bridge,
      },
    },
  );
}

beforeEach(() => {
  toast.success.mockClear();
  toast.error.mockClear();
});

describe('KeysCard', () => {
  it('lists each key with its type, domains and site key', async () => {
    const { user } = renderCard();
    const list = await screen.findByRole('list', { name: 'Keys' });
    const shop = within(list).getByRole('listitem', { name: 'Shop' });
    expect(within(shop).getByText('Score')).toBeTruthy();
    expect(within(shop).getByText('www.shop.com')).toBeTruthy();
    expect(within(shop).getByText(SCORE_KEY.id)).toBeTruthy();
    await user.click(within(shop).getByRole('button', { name: 'Copy site key' }));
    expect(await navigator.clipboard.readText()).toBe(SCORE_KEY.id);

    const blog = within(list).getByRole('listitem', { name: 'Blog comments' });
    expect(within(blog).getByText('Checkbox')).toBeTruthy();
    expect(within(blog).getByText('c.blog.com')).toBeTruthy();
    expect(within(blog).queryByText('d.blog.com')).toBeNull();
    expect(within(blog).getByText('+1')).toBeTruthy();
  });

  it('says a key works anywhere when it was set up that way', async () => {
    renderCard({
      'deployRecaptcha.listKeys': async () => [
        { ...SCORE_KEY, domains: [], allowAllDomains: true },
      ],
    });
    expect(await screen.findByText('Any domain')).toBeTruthy();
  });

  it('reads a secret only when asked', async () => {
    const secret = vi.fn(async () => '6LcSecret');
    const { user } = renderCard({ 'deployRecaptcha.secret': secret });
    const shop = await screen.findByRole('listitem', { name: 'Shop' });
    expect(secret).not.toHaveBeenCalled();
    await user.click(within(shop).getByRole('button', { name: 'Get secret' }));
    expect(secret).toHaveBeenCalledWith({ ...PROJECT, keyId: SCORE_KEY.id });
  });

  it('opens the code to paste, and the editor', async () => {
    const { user } = renderCard();
    const shop = await screen.findByRole('listitem', { name: 'Shop' });
    await user.click(within(shop).getByRole('button', { name: 'Add to your site' }));
    expect(await screen.findByRole('dialog', { name: 'Add Shop to your site' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Done' }));
    await user.click(within(shop).getByRole('button', { name: 'Edit Shop' }));
    expect(await screen.findByRole('dialog', { name: 'Edit Shop' })).toBeTruthy();
  });

  it('deletes a key after asking', async () => {
    const deleteKey = vi.fn(async () => undefined);
    const { user } = renderCard({ 'deployRecaptcha.deleteKey': deleteKey });
    const shop = await screen.findByRole('listitem', { name: 'Shop' });
    await user.click(within(shop).getByRole('button', { name: 'Delete Shop' }));
    const confirm = await screen.findByRole('dialog', { name: /Delete the key for Shop/ });
    expect(within(confirm).getByText(/stop passing checks right away/)).toBeTruthy();
    await user.click(within(confirm).getByRole('button', { name: 'Delete key' }));
    expect(deleteKey).toHaveBeenCalledWith({ ...PROJECT, keyId: SCORE_KEY.id });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Deleted Shop.'));
  });

  it('keeps the key when the delete is called off', async () => {
    const deleteKey = vi.fn(async () => undefined);
    const { user } = renderCard({ 'deployRecaptcha.deleteKey': deleteKey });
    const shop = await screen.findByRole('listitem', { name: 'Shop' });
    await user.click(within(shop).getByRole('button', { name: 'Delete Shop' }));
    await user.click(
      within(await screen.findByRole('dialog', { name: /Delete the key for Shop/ })).getByRole(
        'button',
        { name: 'Cancel' },
      ),
    );
    expect(deleteKey).not.toHaveBeenCalled();
  });

  it('welcomes a project with no keys', async () => {
    const { user } = renderCard({ 'deployRecaptcha.listKeys': async () => [] });
    expect(await screen.findByText('No keys yet')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Create your first key' }));
    expect(await screen.findByRole('dialog', { name: 'New reCAPTCHA key' })).toBeTruthy();
  });

  it('opens a new key from the header button', async () => {
    const { user } = renderCard();
    await screen.findByRole('list', { name: 'Keys' });
    await user.click(screen.getByRole('button', { name: 'New key' }));
    expect(await screen.findByRole('dialog', { name: 'New reCAPTCHA key' })).toBeTruthy();
  });

  it('searches and filters once there are many keys', async () => {
    const many = Array.from({ length: 7 }, (_, index) => ({
      ...SCORE_KEY,
      id: `6LcKey${index}`,
      name: `Site ${index}`,
      domains: [`site${index}.com`],
    }));
    const { user } = renderCard({
      'deployRecaptcha.listKeys': async () => [...many, CHECKBOX_KEY],
    });
    const list = await screen.findByRole('list', { name: 'Keys' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(8);

    await user.type(screen.getByRole('searchbox', { name: 'Search keys' }), 'site3');
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((item) => item.getAttribute('aria-label')),
    ).toEqual(['Site 3']);
    await user.clear(screen.getByRole('searchbox', { name: 'Search keys' }));
    await user.click(screen.getByRole('button', { name: 'Checkbox' }));
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((item) => item.getAttribute('aria-label')),
    ).toEqual(['Blog comments']);
  });

  it('opens the create dialog filled in from a link', async () => {
    renderCard({}, '/deploy?recaptcha=1&newKey=shop.com,www.shop.com,bad..domain&label=Shop');
    const dialog = await screen.findByRole('dialog', { name: 'New reCAPTCHA key' });
    expect(within(dialog).getByLabelText('Name')).toHaveValue('Shop');
    expect(within(dialog).getByRole('button', { name: 'Remove www.shop.com' })).toBeTruthy();
    expect(within(dialog).queryByText('bad..domain')).toBeNull();
  });

  it('says why the keys did not load, and tries again', async () => {
    let calls = 0;
    const { user } = renderCard({
      'deployRecaptcha.listKeys': async () => {
        calls += 1;
        if (calls === 1) throw ipcError('listKeys', 'Could not reach Google.');
        return [SCORE_KEY];
      },
    });
    expect(await screen.findByText('Could not reach Google.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /Try again/ }));
    expect(await screen.findByRole('listitem', { name: 'Shop' })).toBeTruthy();
  });

  it('names the role it needs when the account may not read the keys', async () => {
    renderCard({
      'deployRecaptcha.listKeys': async () => {
        throw ipcError('listKeys', encodeRecaptchaError('permission', 'Not allowed.'));
      },
    });
    expect(await screen.findByText(/reCAPTCHA Enterprise Admin/)).toBeTruthy();
  });

  it('turns reCAPTCHA back on when it was turned off in the project', async () => {
    let off = true;
    const prepare = vi.fn(async () => {
      off = false;
    });
    const { user } = renderCard({
      'deployRecaptcha.prepareProject': prepare,
      'deployRecaptcha.listKeys': async () => {
        if (off)
          throw ipcError(
            'listKeys',
            encodeRecaptchaError('api-disabled', 'reCAPTCHA is turned off in this project.'),
          );
        return [SCORE_KEY];
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Turn reCAPTCHA on' }));
    expect(prepare).toHaveBeenCalledWith(PROJECT);
    expect(await screen.findByRole('listitem', { name: 'Shop' })).toBeTruthy();
  });
});
