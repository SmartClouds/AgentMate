import type { RecaptchaKeyInput } from '@shared/deployRecaptchaTypes';
import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { ACCOUNT, CHECKBOX_KEY, deferred, ipcError, SCORE_KEY } from './testing/fixtures';

/**
 * Making a key in one screen: start from one of your sites or type the domains, pick how it
 * checks people (invisible score is the default), and get the site key, the secret and the code
 * to paste right away. Editing changes the name, domains and difficulty, never the type.
 */

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const { KeyDialog } = await import('./KeyDialog');

const PROJECT = { accountId: ACCOUNT.id, projectId: 'shop-project' };
const NEW_KEY = { ...SCORE_KEY, id: '6LcBrandNewKey', name: 'Blog' };

function renderDialog(
  mode: React.ComponentProps<typeof KeyDialog>['mode'],
  bridge: Record<string, unknown> = {},
) {
  const onOpenChange = vi.fn();
  const view = renderWithProviders(
    <KeyDialog open project={PROJECT} mode={mode} onOpenChange={onOpenChange} />,
    {
      bridge: {
        'deployWordPress.listSites': async () => [
          { id: 'wp-1', label: 'My blog', siteUrl: 'https://blog.example.org' },
        ],
        'deployRecaptcha.createKey': async () => NEW_KEY,
        'deployRecaptcha.updateKey': async () => SCORE_KEY,
        'deployRecaptcha.secret': async () => '6LcSecretValue',
        ...bridge,
      },
    },
  );
  return { ...view, onOpenChange };
}

beforeEach(() => {
  toast.success.mockClear();
  toast.error.mockClear();
});

describe('KeyDialog create', () => {
  it('starts on the invisible score type and only creates once named with a domain', async () => {
    const { user, bridge } = renderDialog({ kind: 'create' });
    const dialog = await screen.findByRole('dialog', { name: 'New reCAPTCHA key' });
    expect(within(dialog).getByRole('radio', { name: /Invisible score/ })).toBeChecked();
    expect(within(dialog).getByText('Recommended')).toBeTruthy();
    const create = within(dialog).getByRole('button', { name: 'Create key' });
    expect(create).toBeDisabled();

    await user.type(within(dialog).getByLabelText('Name'), 'Blog');
    await user.type(within(dialog).getByRole('textbox', { name: 'Domains' }), 'blog.com{Enter}');
    expect(create).toBeEnabled();
    await user.click(create);

    expect(bridge.$fn('deployRecaptcha.createKey')).toHaveBeenCalledWith(PROJECT, {
      name: 'Blog',
      type: 'score',
      domains: ['blog.com'],
    } satisfies RecaptchaKeyInput);
    expect(await screen.findByRole('heading', { name: 'Your key is ready' })).toBeTruthy();
    expect(toast.success).toHaveBeenCalledWith('Created the key for Blog.');
  });

  it('fills the name and domains from one of your sites', async () => {
    const { user, bridge } = renderDialog({ kind: 'create' });
    await user.click(await screen.findByRole('button', { name: 'Use My blog' }));
    expect(screen.getByLabelText('Name')).toHaveValue('My blog');
    expect(screen.getByRole('button', { name: 'Remove blog.example.org' })).toBeTruthy();
    await user.click(screen.getByRole('radio', { name: /Checkbox/ }));
    await user.click(screen.getByRole('button', { name: 'Create key' }));
    expect(bridge.$fn('deployRecaptcha.createKey')).toHaveBeenCalledWith(PROJECT, {
      name: 'My blog',
      type: 'checkbox',
      domains: ['blog.example.org'],
    });
  });

  it('starts filled in from a link', async () => {
    renderDialog({
      kind: 'create',
      initial: { name: 'Shop', domains: ['shop.com', 'www.shop.com'] },
    });
    expect(await screen.findByLabelText('Name')).toHaveValue('Shop');
    expect(screen.getByRole('button', { name: 'Remove www.shop.com' })).toBeTruthy();
  });

  it('offers the challenge difficulty only for keys that challenge people', async () => {
    const { user, bridge } = renderDialog({ kind: 'create' });
    expect(screen.queryByRole('button', { name: /More options/ })).toBeNull();
    await user.click(await screen.findByRole('radio', { name: /Invisible challenge/ }));
    await user.click(screen.getByRole('button', { name: /More options/ }));
    await user.click(screen.getByRole('button', { name: 'Harder' }));
    await user.type(screen.getByLabelText('Name'), 'Login');
    await user.type(screen.getByRole('textbox', { name: 'Domains' }), 'app.com{Enter}');
    await user.click(screen.getByRole('button', { name: 'Create key' }));
    expect(bridge.$fn('deployRecaptcha.createKey')).toHaveBeenCalledWith(PROJECT, {
      name: 'Login',
      type: 'invisible',
      domains: ['app.com'],
      challenge: 'security',
    });
  });

  it('keeps the form and says what Google refused', async () => {
    const { user } = renderDialog(
      { kind: 'create', initial: { name: 'Shop', domains: ['shop.com'] } },
      {
        'deployRecaptcha.createKey': async () => {
          throw ipcError('createKey', 'Google refused that: Display name is too long.');
        },
      },
    );
    await user.click(await screen.findByRole('button', { name: 'Create key' }));
    expect(await screen.findByText('Google refused that: Display name is too long.')).toBeTruthy();
    expect(screen.getByLabelText('Name')).toHaveValue('Shop');
  });

  it('shows that it is working while Google makes the key', async () => {
    const pending = deferred<typeof NEW_KEY>();
    const { user } = renderDialog(
      { kind: 'create', initial: { name: 'Shop', domains: ['shop.com'] } },
      { 'deployRecaptcha.createKey': () => pending.promise },
    );
    await user.click(await screen.findByRole('button', { name: 'Create key' }));
    expect(screen.getByRole('button', { name: /Creating/ })).toBeDisabled();
    pending.resolve(NEW_KEY);
    expect(await screen.findByRole('heading', { name: 'Your key is ready' })).toBeTruthy();
  });
});

describe('KeyDialog ready', () => {
  it('gives the site key, the secret on request and code for each language', async () => {
    const secret = vi.fn(async () => '6LcSecretValue');
    const { user } = renderDialog(
      { kind: 'ready', key: SCORE_KEY },
      { 'deployRecaptcha.secret': secret },
    );
    expect(await screen.findByRole('heading', { name: 'Add Shop to your site' })).toBeTruthy();
    expect(screen.getAllByText(SCORE_KEY.id).length).toBeGreaterThan(0);

    await user.click(screen.getByRole('button', { name: 'Copy site key' }));
    expect(await navigator.clipboard.readText()).toBe(SCORE_KEY.id);

    expect(secret).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Get secret' }));
    expect(secret).toHaveBeenCalledWith({ ...PROJECT, keyId: SCORE_KEY.id });
    expect(await screen.findByText('••••••••••••••••')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Show secret' }));
    expect(screen.getByText('6LcSecretValue')).toBeTruthy();

    const code = screen.getByTestId('snippet');
    expect(code.textContent).toContain(`api.js?render=${SCORE_KEY.id}`);
    await user.click(screen.getByRole('button', { name: 'PHP check' }));
    expect(screen.getByTestId('snippet').textContent).toContain("getenv('RECAPTCHA_SECRET')");
    await user.click(screen.getByRole('button', { name: 'Copy code' }));
    expect(await navigator.clipboard.readText()).toContain('siteverify');
  });

  it('fetches the secret by itself right after a key is made', async () => {
    const { user, bridge } = renderDialog({
      kind: 'create',
      initial: { name: 'Blog', domains: ['blog.com'] },
    });
    await user.click(await screen.findByRole('button', { name: 'Create key' }));
    await screen.findByRole('heading', { name: 'Your key is ready' });
    await waitFor(() =>
      expect(bridge.$fn('deployRecaptcha.secret')).toHaveBeenCalledWith({
        ...PROJECT,
        keyId: NEW_KEY.id,
      }),
    );
  });

  it('closes with Done', async () => {
    const { user, onOpenChange } = renderDialog({ kind: 'ready', key: SCORE_KEY });
    await user.click(await screen.findByRole('button', { name: 'Done' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe('KeyDialog edit', () => {
  it('changes the name, domains and difficulty, with the type locked', async () => {
    const { user, bridge, onOpenChange } = renderDialog({ kind: 'edit', key: CHECKBOX_KEY });
    const dialog = await screen.findByRole('dialog', { name: 'Edit Blog comments' });
    expect(within(dialog).getByRole('radio', { name: /Checkbox/ })).toBeChecked();
    expect(within(dialog).getByRole('radio', { name: /Invisible score/ })).toBeDisabled();
    expect(within(dialog).getByText(/type cannot change/)).toBeTruthy();

    await user.clear(within(dialog).getByLabelText('Name'));
    await user.type(within(dialog).getByLabelText('Name'), 'Comments');
    await user.click(within(dialog).getByRole('button', { name: 'Remove d.blog.com' }));
    await user.click(within(dialog).getByRole('button', { name: /More options/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Easier' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    expect(bridge.$fn('deployRecaptcha.updateKey')).toHaveBeenCalledWith(
      { ...PROJECT, keyId: CHECKBOX_KEY.id },
      'checkbox',
      {
        name: 'Comments',
        domains: ['blog.com', 'a.blog.com', 'b.blog.com', 'c.blog.com'],
        challenge: 'usability',
      },
    );
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(toast.success).toHaveBeenCalledWith('Saved Comments.');
  });
});
