// @vitest-environment jsdom
import type { VaultEntry } from '@runova/core';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  category,
  createVaultApiMock,
  expectNoNativeTitles,
  installDomShims,
  installVaultApi,
  renderWithVaultProviders,
  summary,
  type VaultApiMock,
} from './testing/mockVaultApi';

installDomShims();

const confirm = vi.hoisted(() => ({ confirmDialog: vi.fn(async () => true) }));
vi.mock('@/stores/confirmStore', () => confirm);
const toast = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const { VaultEntryDialog } = await import('./VaultEntryDialog');

let mock: VaultApiMock;
const onOpenChange = vi.fn();
const onSaved = vi.fn();

function renderDialog(
  target: Parameters<typeof VaultEntryDialog>[0]['target'],
  knownTags: string[] = [],
) {
  return renderWithVaultProviders(
    <VaultEntryDialog
      open
      onOpenChange={onOpenChange}
      target={target}
      knownTags={knownTags}
      onSaved={onSaved}
    />,
  );
}

const dialog = () => screen.getByRole('dialog');
const field = (label: string) => within(dialog()).getByLabelText(label) as HTMLInputElement;
const type = (label: string, value: string) =>
  fireEvent.change(field(label), { target: { value } });
const save = () => within(dialog()).getByRole('button', { name: 'Save' });

const storedLogin: VaultEntry = {
  id: 'gh',
  type: 'login',
  title: 'GitHub',
  tags: ['Work'],
  favorite: false,
  notes: 'old notes',
  createdAt: 1,
  updatedAt: 1,
  lastUsedAt: null,
  username: 'octocat',
  password: 'old-password-123',
  urls: ['https://github.com'],
  totpSecret: '',
  passwordUpdatedAt: 1,
};

beforeEach(() => {
  mock = createVaultApiMock();
  installVaultApi(mock);
  vi.clearAllMocks();
  mock.api.save.mockImplementation(async (input: { title: string }) =>
    summary({ id: 'saved', title: input.title }),
  );
});

afterEach(() => {
  expectNoNativeTitles();
  cleanup();
});

describe('VaultEntryDialog: new entries', () => {
  it('needs a title, then saves a login with everything filled in', async () => {
    renderDialog({ mode: 'new' }, ['Work', 'Personal']);
    expect(screen.getByRole('dialog', { name: 'New entry' })).toBeTruthy();
    expect(document.activeElement).toBe(field('Title'));
    expect(save().hasAttribute('disabled')).toBe(true);

    type('Title', 'GitHub');
    type('Username or email', 'octocat');
    type('Password', 'n3w-Pa55word!');
    type('Website', 'github.com/login');
    type('Notes', 'backup codes in drawer');
    fireEvent.change(field('Tags'), { target: { value: 'wor' } });
    fireEvent.click(within(dialog()).getByRole('option', { name: 'Work' }));
    fireEvent.change(field('Tags'), { target: { value: 'side project' } });
    fireEvent.keyDown(field('Tags'), { key: 'Enter' });
    fireEvent.click(within(dialog()).getByRole('switch', { name: 'Favorite' }));
    expect(within(dialog()).getByRole('meter', { name: 'Password strength' })).toBeTruthy();

    fireEvent.click(save());
    await waitFor(() =>
      expect(mock.api.save).toHaveBeenCalledWith({
        type: 'login',
        title: 'GitHub',
        tags: ['Work', 'side project'],
        favorite: true,
        notes: 'backup codes in drawer',
        username: 'octocat',
        password: 'n3w-Pa55word!',
        urls: ['github.com/login'],
        totpSecret: '',
        autoSubmit: false,
      }),
    );
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ id: 'saved' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(JSON.stringify(toast.success.mock.calls)).not.toContain('n3w-Pa55word');
  });

  it('starts from a title and type passed in, and keeps the title when switching type', () => {
    renderDialog({ mode: 'new', title: 'Stripe' });
    expect(field('Title').value).toBe('Stripe');
    fireEvent.click(within(dialog()).getByRole('radio', { name: 'API key' }));
    expect(field('Title').value).toBe('Stripe');
    expect(field('Service')).toBeTruthy();
    expect(field('Key ID')).toBeTruthy();
    expect(field('Secret')).toBeTruthy();
    expect(within(dialog()).queryByLabelText('Username or email')).toBeNull();
  });

  it('fills the password from the generator', () => {
    renderDialog({ mode: 'new' });
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Generate a password' }));
    const generated = screen.getByTestId('generated-password').textContent ?? '';
    fireEvent.click(screen.getByRole('button', { name: 'Use password' }));
    expect(field('Password').value).toBe(generated);
  });

  it('builds custom fields and saves a note', async () => {
    const view = renderDialog({ mode: 'new', type: 'custom' });
    type('Title', 'Router');
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Add field' }));
    type('Field 1 name', 'Admin PIN');
    type('Field 1 value', '4242');
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Add field' }));
    type('Field 2 name', 'Model');
    type('Field 2 value', 'AX3000');
    fireEvent.click(within(dialog()).getByRole('switch', { name: 'Hide field 2' }));
    fireEvent.click(save());
    await waitFor(() =>
      expect(mock.api.save).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'custom',
          fields: [
            { label: 'Admin PIN', value: '4242', concealed: true },
            { label: 'Model', value: 'AX3000', concealed: false },
          ],
        }),
      ),
    );
    view.unmount();

    renderDialog({ mode: 'new', type: 'note' });
    type('Title', 'Wi-Fi');
    type('Note', 'guest: hello');
    fireEvent.click(save());
    await waitFor(() =>
      expect(mock.api.save).toHaveBeenLastCalledWith({
        type: 'note',
        title: 'Wi-Fi',
        tags: [],
        favorite: false,
        notes: 'guest: hello',
      }),
    );
  });

  it('shows why saving failed and stays open', async () => {
    mock.api.save.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'vault:save': Error: [vault:locked] The vault is locked.",
      ),
    );
    renderDialog({ mode: 'new' });
    type('Title', 'GitHub');
    fireEvent.click(save());
    expect((await within(dialog()).findByRole('alert')).textContent).toContain(
      'The vault is locked.',
    );
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it('saves with Ctrl+Enter', async () => {
    renderDialog({ mode: 'new' });
    type('Title', 'Quick');
    fireEvent.keyDown(field('Title'), { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(mock.api.save).toHaveBeenCalled());
  });
});

describe('VaultEntryDialog: editing', () => {
  it('loads the entry, hides the type picker and leaves untouched secrets out of the save', async () => {
    mock.api.getForEdit.mockResolvedValue(storedLogin);
    renderDialog({ mode: 'edit', id: 'gh' });
    expect(await screen.findByRole('dialog', { name: 'Edit entry' })).toBeTruthy();
    await waitFor(() => expect(field('Title').value).toBe('GitHub'));
    expect(field('Password').value).toBe('old-password-123');
    expect(within(dialog()).queryByRole('radio', { name: 'API key' })).toBeNull();

    type('Title', 'GitHub (work)');
    fireEvent.click(save());
    await waitFor(() => expect(mock.api.save).toHaveBeenCalled());
    const input = mock.api.save.mock.calls[0][0] as Record<string, unknown>;
    expect(input).toMatchObject({
      id: 'gh',
      type: 'login',
      title: 'GitHub (work)',
      username: 'octocat',
    });
    expect(input.password).toBeUndefined();
    expect(input.notes).toBeUndefined();
    expect(input.totpSecret).toBeUndefined();
  });

  it('sends a secret once it was changed', async () => {
    mock.api.getForEdit.mockResolvedValue(storedLogin);
    renderDialog({ mode: 'edit', id: 'gh' });
    await waitFor(() => expect(field('Password').value).toBe('old-password-123'));
    type('Password', 'brand-new-password-9');
    fireEvent.click(save());
    await waitFor(() =>
      expect(mock.api.save).toHaveBeenCalledWith(
        expect.objectContaining({ password: 'brand-new-password-9' }),
      ),
    );
  });

  it('asks before throwing away changes', async () => {
    confirm.confirmDialog.mockResolvedValueOnce(false);
    mock.api.getForEdit.mockResolvedValue(storedLogin);
    renderDialog({ mode: 'edit', id: 'gh' });
    await waitFor(() => expect(field('Title').value).toBe('GitHub'));

    fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);

    onOpenChange.mockClear();
    type('Title', 'Changed');
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(confirm.confirmDialog).toHaveBeenCalled());
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});

describe('VaultEntryDialog: site icon', () => {
  const ICON = 'data:image/png;base64,iVBORw0KGgo=';

  it('fetches the favicon once when the website field is left and saves it with the entry', async () => {
    mock.api.fetchIcon.mockResolvedValue(ICON);
    renderDialog({ mode: 'new' });
    type('Title', 'GitHub');
    type('Website', 'github.com');
    fireEvent.blur(field('Website'));
    await waitFor(() =>
      expect(within(dialog()).getByRole('button', { name: 'Remove site icon' })).toBeTruthy(),
    );
    fireEvent.blur(field('Website'));
    expect(mock.api.fetchIcon).toHaveBeenCalledTimes(1);
    expect(mock.api.fetchIcon).toHaveBeenCalledWith('github.com');

    fireEvent.click(save());
    await waitFor(() => expect(mock.api.save).toHaveBeenCalled());
    expect(mock.api.save.mock.calls[0][0]).toMatchObject({ icon: ICON });
  });

  it('stays quiet when the automatic fetch finds nothing, but says so when asked', async () => {
    mock.api.fetchIcon.mockResolvedValue(null);
    renderDialog({ mode: 'new' });
    type('Website', 'no-icon.example');
    fireEvent.blur(field('Website'));
    await waitFor(() => expect(mock.api.fetchIcon).toHaveBeenCalledTimes(1));
    expect(toast.error).not.toHaveBeenCalled();

    fireEvent.click(within(dialog()).getByRole('button', { name: 'Use site icon' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
  });

  it('sends null to drop a stored icon', async () => {
    mock.api.getForEdit.mockResolvedValue({ ...storedLogin, icon: ICON });
    renderDialog({ mode: 'edit', id: 'gh' });
    fireEvent.click(await within(dialog()).findByRole('button', { name: 'Remove site icon' }));
    fireEvent.click(save());
    await waitFor(() => expect(mock.api.save).toHaveBeenCalled());
    expect(mock.api.save.mock.calls[0][0]).toMatchObject({ icon: null });
  });
});

describe('VaultEntryDialog: category and one-click login', () => {
  const work = category({ id: 'work', name: 'Work', color: 'blue', icon: 'briefcase' });
  const bank = category({ id: 'bank', name: 'Banking', color: 'green', icon: 'bank' });

  beforeEach(() => {
    mock.api.listCategories.mockResolvedValue([work, bank]);
  });

  const picker = () => within(dialog()).getByRole('button', { name: /^Category/ });

  it('files a new entry under the category picked', async () => {
    const user = userEvent.setup();
    renderDialog({ mode: 'new' });
    type('Title', 'Bank login');
    expect(picker().textContent).toContain('No category');
    await user.click(picker());
    await user.click(await screen.findByRole('menuitemradio', { name: 'Banking' }));
    expect(picker().textContent).toContain('Banking');
    fireEvent.click(save());
    await waitFor(() =>
      expect(mock.api.save).toHaveBeenCalledWith(expect.objectContaining({ categoryId: 'bank' })),
    );
  });

  it('starts a new entry in the category the list was showing', async () => {
    renderDialog({ mode: 'new', categoryId: 'work' });
    await waitFor(() => expect(picker().textContent).toContain('Work'));
    type('Title', 'Jira');
    fireEvent.click(save());
    await waitFor(() =>
      expect(mock.api.save).toHaveBeenCalledWith(expect.objectContaining({ categoryId: 'work' })),
    );
  });

  it('leaves the category out of an edit that did not touch it, and sends null to clear it', async () => {
    const user = userEvent.setup();
    mock.api.getForEdit.mockResolvedValue({ ...storedLogin, categoryId: 'work' });
    renderDialog({ mode: 'edit', id: 'gh' });
    await waitFor(() => expect(picker().textContent).toContain('Work'));
    type('Title', 'GitHub (work)');
    fireEvent.click(save());
    await waitFor(() => expect(mock.api.save).toHaveBeenCalledTimes(1));
    expect(mock.api.save.mock.calls[0][0]).not.toHaveProperty('categoryId', expect.anything());

    await user.click(picker());
    await user.click(await screen.findByRole('menuitemradio', { name: 'No category' }));
    fireEvent.click(save());
    await waitFor(() => expect(mock.api.save).toHaveBeenCalledTimes(2));
    expect(mock.api.save.mock.calls[1][0]).toMatchObject({ categoryId: null });
  });

  it('makes a new category from the picker and files the entry there', async () => {
    const user = userEvent.setup();
    mock.api.saveCategory.mockResolvedValue(
      category({ id: 'fresh', name: 'Clients', color: 'pink', icon: 'heart' }),
    );
    renderDialog({ mode: 'new' });
    type('Title', 'Acme portal');
    await user.click(picker());
    await user.click(await screen.findByRole('menuitem', { name: 'New category...' }));
    const categoryDialog = await screen.findByRole('dialog', { name: 'New category' });
    fireEvent.change(within(categoryDialog).getByLabelText('Name'), {
      target: { value: 'Clients' },
    });
    fireEvent.click(within(categoryDialog).getByRole('button', { name: 'Create category' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New category' })).toBeNull());
    await waitFor(() => expect(picker().textContent).toContain('Clients'));
    fireEvent.click(save());
    await waitFor(() =>
      expect(mock.api.save).toHaveBeenCalledWith(expect.objectContaining({ categoryId: 'fresh' })),
    );
  });

  it('saves the sign in automatically choice for a login', async () => {
    renderDialog({ mode: 'new' });
    type('Title', 'GitHub');
    const toggle = within(dialog()).getByRole('switch', { name: 'Sign in automatically' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(toggle);
    fireEvent.click(save());
    await waitFor(() =>
      expect(mock.api.save).toHaveBeenCalledWith(expect.objectContaining({ autoSubmit: true })),
    );
  });

  it('only offers sign in automatically on logins', () => {
    renderDialog({ mode: 'new', type: 'note' });
    expect(within(dialog()).queryByRole('switch', { name: 'Sign in automatically' })).toBeNull();
  });
});
