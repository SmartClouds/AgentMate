// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
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
} from '@/components/vault/testing/mockVaultApi';
import { useVaultEvents } from '@/hooks/useVaultEvents';
import { usePanelWidthStore } from '@/stores/panelWidthStore';
import { useVaultStore } from '@/stores/vaultStore';

installDomShims();

const clipboardToast = vi.hoisted(() => ({
  showCopiedToast: vi.fn(),
  settleClipboardToast: vi.fn(),
}));
vi.mock('@/lib/vault/clipboardToast', () => clipboardToast);
const confirm = vi.hoisted(() => ({ confirmDialog: vi.fn(async () => true) }));
vi.mock('@/stores/confirmStore', () => confirm);
const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), dismiss: vi.fn() }),
);
vi.mock('sonner', () => ({ toast }));

const { default: VaultPage } = await import('./VaultPage');

function Harness(): React.JSX.Element {
  useVaultEvents();
  return <VaultPage />;
}

const github = summary({
  id: 'gh',
  title: 'GitHub',
  username: 'octocat',
  urls: ['https://github.com/login'],
  host: 'github.com',
  tags: ['Work'],
  favorite: true,
  hasNotes: true,
});
const gitlab = summary({ id: 'gl', title: 'GitLab', username: 'dev', host: 'gitlab.com' });
const stripe = summary({
  id: 'st',
  type: 'apiKey',
  title: 'Stripe',
  service: 'Stripe',
  keyId: 'pk_live_1',
  hasPassword: false,
  hasSecret: true,
});
const wifi = summary({
  id: 'wf',
  type: 'note',
  title: 'Home Wi-Fi',
  hasPassword: false,
  hasNotes: true,
  tags: ['Home'],
});

let mock: VaultApiMock;

function renderPage(entries = [github, gitlab, stripe, wifi]) {
  mock.api.list.mockResolvedValue(entries);
  return renderWithVaultProviders(<Harness />);
}

const listbox = () => screen.getByRole('listbox', { name: 'Vault entries' });
const titlesInList = () =>
  within(listbox())
    .getAllByRole('option')
    .map((option) => option.getAttribute('data-title'));

beforeEach(() => {
  mock = createVaultApiMock({ state: 'unlocked' });
  installVaultApi(mock);
  useVaultStore.getState().resetView();
  useVaultStore.getState().setSort('title');
  vi.clearAllMocks();
});

afterEach(() => {
  expectNoNativeTitles();
  cleanup();
  vi.useRealTimers();
});

describe('VaultPage states', () => {
  it('shows the setup screen when there is no vault yet', async () => {
    mock.status.state = 'uninitialized';
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Create your vault' })).toBeTruthy();
    expect(mock.api.list).not.toHaveBeenCalled();
  });

  it('shows the lock screen and never asks for entries while locked', async () => {
    mock.status.state = 'locked';
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Vault is locked' })).toBeTruthy();
    expect(mock.api.list).not.toHaveBeenCalled();
  });

  it('switches to the lock screen and drops every title the moment main locks', async () => {
    renderPage();
    await screen.findByRole('listbox', { name: 'Vault entries' });
    act(() => mock.emitState({ state: 'locked', reason: 'manual' }));
    expect(await screen.findByRole('heading', { name: 'Vault is locked' })).toBeTruthy();
    expect(document.body.textContent).not.toContain('GitHub');
    expect(document.body.textContent).not.toContain('octocat');
  });
});

describe('VaultPage layout', () => {
  it('resizes the entry list from the keyboard and remembers the width', async () => {
    renderPage();
    await screen.findByRole('listbox', { name: 'Vault entries' });

    const handle = screen.getByRole('separator', { name: 'Resize entry list' });
    const before = Number(handle.getAttribute('aria-valuenow'));
    fireEvent.keyDown(handle, { key: 'ArrowRight' });

    expect(Number(handle.getAttribute('aria-valuenow'))).toBe(before + 16);
    expect(usePanelWidthStore.getState().widths.vaultList).toBe(before + 16);
  });

  it('marks the type filter that is on', async () => {
    renderPage();
    await screen.findByRole('listbox', { name: 'Vault entries' });

    expect(screen.getByRole('tab', { name: /All/ })).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(screen.getByRole('tab', { name: /API keys/ }));
    expect(screen.getByRole('tab', { name: /API keys/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /All/ })).toHaveAttribute('aria-selected', 'false');
  });
});

describe('VaultPage list', () => {
  it('lists favorites first, then everything by title', async () => {
    renderPage();
    await screen.findByRole('listbox', { name: 'Vault entries' });
    expect(titlesInList()).toEqual(['GitHub', 'GitLab', 'Home Wi-Fi', 'Stripe']);
    expect(within(listbox()).getByRole('group', { name: 'Favorites' })).toBeTruthy();
  });

  it('offers a friendly start for an empty vault', async () => {
    renderPage([]);
    expect(await screen.findByText('Your vault is empty')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add your first entry' }));
    expect(await screen.findByRole('dialog', { name: 'New entry' })).toBeTruthy();
  });

  it('searches as you type, ranks results and highlights the match', async () => {
    renderPage();
    await screen.findByRole('listbox', { name: 'Vault entries' });
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search the vault' }), {
      target: { value: 'git' },
    });
    expect(titlesInList()).toEqual(['GitHub', 'GitLab']);
    expect(screen.getByText('2 results')).toBeTruthy();
    expect(within(listbox()).getAllByText('Git', { selector: 'mark' })).toHaveLength(2);
  });

  it('offers to create an entry named after a search with no results', async () => {
    renderPage();
    await screen.findByRole('listbox', { name: 'Vault entries' });
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search the vault' }), {
      target: { value: 'Netflix' },
    });
    expect(screen.getByText('Nothing matches "Netflix"')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Create "Netflix"' }));
    const dialog = await screen.findByRole('dialog', { name: 'New entry' });
    expect((within(dialog).getByLabelText('Title') as HTMLInputElement).value).toBe('Netflix');
  });

  it('filters by type and by tag', async () => {
    renderPage();
    await screen.findByRole('listbox', { name: 'Vault entries' });
    fireEvent.click(screen.getByRole('tab', { name: /API keys/ }));
    expect(titlesInList()).toEqual(['Stripe']);
    fireEvent.click(screen.getByRole('tab', { name: /All/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Home', pressed: false }));
    expect(titlesInList()).toEqual(['Home Wi-Fi']);
  });

  it('moves the selection with the arrow keys from the search box and clears it with Escape', async () => {
    renderPage();
    await screen.findByRole('listbox', { name: 'Vault entries' });
    const search = screen.getByRole('searchbox', { name: 'Search the vault' });
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    expect(useVaultStore.getState().selectedId).toBe('gh');
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    expect(useVaultStore.getState().selectedId).toBe('wf');
    fireEvent.keyDown(search, { key: 'ArrowUp' });
    expect(useVaultStore.getState().selectedId).toBe('gl');
    expect(listbox().getAttribute('aria-activedescendant')).toContain('gl');

    fireEvent.change(search, { target: { value: 'strip' } });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(useVaultStore.getState().selectedId).toBe('st');
    fireEvent.keyDown(search, { key: 'Escape' });
    expect((search as HTMLInputElement).value).toBe('');
  });

  it('stops showing an entry the search has filtered out', async () => {
    renderPage();
    await screen.findByRole('listbox', { name: 'Vault entries' });
    fireEvent.click(within(listbox()).getByRole('option', { name: /GitHub/ }));
    expect(await screen.findByRole('region', { name: 'GitHub' })).toBeTruthy();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search the vault' }), {
      target: { value: 'wi-fi' },
    });
    expect(screen.queryByRole('region', { name: 'GitHub' })).toBeNull();
    expect(screen.getByText('Pick an entry to see its details')).toBeTruthy();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search the vault' }), {
      target: { value: '' },
    });
    expect(screen.getByRole('region', { name: 'GitHub' })).toBeTruthy();
  });

  it('copies a password straight from the row without selecting it', async () => {
    renderPage();
    await screen.findByRole('listbox', { name: 'Vault entries' });
    const row = within(listbox()).getByRole('option', { name: /GitLab/ });
    fireEvent.click(within(row).getByRole('button', { name: 'Copy password' }));
    await waitFor(() => expect(mock.api.copy).toHaveBeenCalledWith('gl', 'password'));
    expect(clipboardToast.showCopiedToast).toHaveBeenCalledWith('Password', expect.any(Number));
  });
});

describe('VaultPage deep links', () => {
  it('opens the entry picked in the command palette, even when filters would hide it', async () => {
    useVaultStore.getState().setTypeFilter('apiKey');
    mock.api.list.mockResolvedValue([github, gitlab, stripe, wifi]);
    renderWithVaultProviders(<Harness />, undefined, [
      { pathname: '/vault', state: { entryId: 'gl' } },
    ]);
    expect(await screen.findByRole('region', { name: 'GitLab' })).toBeTruthy();
    expect(useVaultStore.getState()).toMatchObject({ selectedId: 'gl', typeFilter: 'all' });
  });
});

describe('VaultPage detail', () => {
  async function openGithub() {
    renderPage();
    await screen.findByRole('listbox', { name: 'Vault entries' });
    fireEvent.click(within(listbox()).getByRole('option', { name: /GitHub/ }));
    return screen.findByRole('region', { name: 'GitHub' });
  }

  it('shows fields with the password hidden until asked, then hides it again', async () => {
    mock.api.reveal.mockResolvedValue('S3cr3t!pw');
    const detail = await openGithub();
    expect(within(detail).getByText('octocat')).toBeTruthy();
    expect(within(detail).getByText('github.com')).toBeTruthy();
    expect(detail.textContent).not.toContain('S3cr3t');

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await act(async () => {
      fireEvent.click(within(detail).getByRole('button', { name: 'Show password' }));
    });
    expect(mock.api.reveal).toHaveBeenCalledWith('gh', 'password');
    expect(detail.textContent).toContain('S3cr3t!pw');

    act(() => vi.advanceTimersByTime(20_000));
    expect(detail.textContent).not.toContain('S3cr3t');
  });

  it('copies fields, opens the website and toggles favorite', async () => {
    mock.api.patch.mockResolvedValue({ ...github, favorite: false });
    const detail = await openGithub();
    fireEvent.click(within(detail).getByRole('button', { name: 'Copy username' }));
    await waitFor(() => expect(mock.api.copy).toHaveBeenCalledWith('gh', 'username'));
    fireEvent.click(within(detail).getByRole('button', { name: 'Open github.com' }));
    expect(window.runova.shell.openExternal).toHaveBeenCalledWith('https://github.com/login');
    fireEvent.click(within(detail).getByRole('button', { name: 'Remove from favorites' }));
    await waitFor(() => expect(mock.api.patch).toHaveBeenCalledWith('gh', { favorite: false }));
  });

  it('reveals notes on request', async () => {
    mock.api.reveal.mockResolvedValue('recovery codes 1234');
    const detail = await openGithub();
    await act(async () => {
      fireEvent.click(within(detail).getByRole('button', { name: 'Show notes' }));
    });
    expect(mock.api.reveal).toHaveBeenCalledWith('gh', 'notes');
    expect(detail.textContent).toContain('recovery codes 1234');
  });

  it('deletes after confirming', async () => {
    const detail = await openGithub();
    fireEvent.click(within(detail).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(mock.api.remove).toHaveBeenCalledWith(['gh']));
    expect(confirm.confirmDialog).toHaveBeenCalledWith(
      expect.objectContaining({ variant: 'destructive' }),
    );
    expect(useVaultStore.getState().selectedId).toBeNull();
  });
});

describe('VaultPage actions when main refuses', () => {
  it('tells you when a copy fails and puts a favorite back when saving it fails', async () => {
    mock.api.copy.mockRejectedValueOnce(new Error('[vault:locked] The vault is locked.'));
    mock.api.patch.mockRejectedValueOnce(new Error('disk full'));
    renderPage();
    await screen.findByRole('listbox', { name: 'Vault entries' });
    const row = within(listbox()).getByRole('option', { name: /GitLab/ });
    fireEvent.click(within(row).getByRole('button', { name: 'Copy password' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Could not copy the password', {
        description: 'The vault is locked.',
      }),
    );

    fireEvent.click(row);
    const detail = await screen.findByRole('region', { name: 'GitLab' });
    fireEvent.click(within(detail).getByRole('button', { name: 'Add to favorites' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Could not update favorites', expect.anything()),
    );
    expect(within(detail).getByRole('button', { name: 'Add to favorites' })).toBeTruthy();
  });

  it('duplicates and selects the copy, and keeps the entry when delete is cancelled', async () => {
    mock.api.duplicate.mockResolvedValue(summary({ id: 'gh-copy', title: 'GitHub (copy)' }));
    confirm.confirmDialog.mockResolvedValueOnce(false);
    renderPage();
    await screen.findByRole('listbox', { name: 'Vault entries' });
    fireEvent.click(within(listbox()).getByRole('option', { name: /GitHub/ }));
    const detail = await screen.findByRole('region', { name: 'GitHub' });
    fireEvent.click(within(detail).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(confirm.confirmDialog).toHaveBeenCalled());
    expect(mock.api.remove).not.toHaveBeenCalled();

    fireEvent.click(within(detail).getByRole('button', { name: 'Duplicate' }));
    await waitFor(() => expect(useVaultStore.getState().selectedId).toBe('gh-copy'));
    expect(toast.success).toHaveBeenCalledWith('Entry duplicated');
  });

  it('shows why the vault could not be opened and retries', async () => {
    mock.api.status.mockRejectedValueOnce(new Error('ipc down'));
    renderPage();
    expect(await screen.findByText('The vault could not be opened')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('listbox', { name: 'Vault entries' })).toBeTruthy();
  });
});

describe('VaultPage shortcuts', () => {
  it('Ctrl+F searches, Ctrl+N adds and Ctrl+L locks', async () => {
    renderPage();
    await screen.findByRole('listbox', { name: 'Vault entries' });
    fireEvent.keyDown(window, { key: 'f', code: 'KeyF', ctrlKey: true });
    expect(document.activeElement).toBe(
      screen.getByRole('searchbox', { name: 'Search the vault' }),
    );

    fireEvent.keyDown(window, { key: 'n', code: 'KeyN', ctrlKey: true });
    expect(await screen.findByRole('dialog', { name: 'New entry' })).toBeTruthy();
    fireEvent.keyDown(window, { key: 'l', code: 'KeyL', ctrlKey: true });
    expect(mock.api.lock).not.toHaveBeenCalled();

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.keyDown(window, { key: 'l', code: 'KeyL', ctrlKey: true });
    await waitFor(() => expect(mock.api.lock).toHaveBeenCalled());
  });
});

describe('VaultPage categories', () => {
  const work = category({ id: 'work', name: 'Work', color: 'blue', icon: 'briefcase' });
  const home = category({ id: 'home', name: 'Home', color: 'green', icon: 'home' });
  const filed = [
    { ...github, categoryId: 'work' },
    gitlab,
    stripe,
    { ...wifi, categoryId: 'home' },
  ];

  /** The column on a wide window. The strip of pills is the same filters, for narrow ones. */
  const rail = () => screen.getAllByRole('navigation', { name: 'Categories' })[0];

  async function renderFiled() {
    mock.api.listCategories.mockResolvedValue([work, home]);
    renderPage(filed);
    await screen.findByRole('listbox', { name: 'Vault entries' });
    await within(rail()).findByRole('button', { name: 'Work (1)' });
  }

  it('filters the list to the category picked, and to entries with none', async () => {
    await renderFiled();
    fireEvent.click(within(rail()).getByRole('button', { name: 'Work (1)' }));
    expect(titlesInList()).toEqual(['GitHub']);
    fireEvent.click(within(rail()).getByRole('button', { name: 'Uncategorized (2)' }));
    expect(titlesInList()).toEqual(['GitLab', 'Stripe']);
    fireEvent.click(within(rail()).getByRole('button', { name: 'All items (4)' }));
    expect(titlesInList()).toHaveLength(4);
  });

  it('moves an entry dragged onto a category', async () => {
    mock.api.moveEntries.mockResolvedValue(1);
    await renderFiled();
    const row = within(listbox()).getByRole('option', { name: /GitLab/ });
    const data = new Map<string, string>();
    const dataTransfer = {
      setData: (type: string, value: string) => data.set(type, value),
      getData: (type: string) => data.get(type) ?? '',
      get types() {
        return [...data.keys()];
      },
      effectAllowed: 'none',
      dropEffect: 'none',
    };
    fireEvent.dragStart(row, { dataTransfer });
    fireEvent.drop(within(rail()).getByRole('button', { name: 'Home (1)' }), { dataTransfer });
    await waitFor(() => expect(mock.api.moveEntries).toHaveBeenCalledWith(['gl'], 'home'));
    expect(toast.success).toHaveBeenCalledWith('Moved to Home', expect.anything());
  });

  it('deletes a category after confirming, and goes back to all items', async () => {
    const user = userEvent.setup();
    mock.api.deleteCategory.mockResolvedValue(1);
    await renderFiled();
    fireEvent.click(within(rail()).getByRole('button', { name: 'Work (1)' }));
    await user.click(within(rail()).getByRole('button', { name: 'Options for Work' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    await waitFor(() => expect(mock.api.deleteCategory).toHaveBeenCalledWith('work'));
    expect(confirm.confirmDialog).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Delete "Work"?', variant: 'destructive' }),
    );
    expect(confirm.confirmDialog).toHaveBeenCalledWith(
      expect.objectContaining({ description: expect.stringContaining('1 entry') }),
    );
    expect(useVaultStore.getState().categoryFilter).toBe('all');
  });

  it('keeps the category when deleting is cancelled', async () => {
    const user = userEvent.setup();
    confirm.confirmDialog.mockResolvedValueOnce(false);
    await renderFiled();
    await user.click(within(rail()).getByRole('button', { name: 'Options for Home' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    await waitFor(() => expect(confirm.confirmDialog).toHaveBeenCalled());
    expect(mock.api.deleteCategory).not.toHaveBeenCalled();
  });

  it('opens the category editor from the rail', async () => {
    await renderFiled();
    fireEvent.click(within(rail()).getByRole('button', { name: 'New category' }));
    expect(await screen.findByRole('dialog', { name: 'New category' })).toBeTruthy();
  });

  it('saves a new order after a category is moved', async () => {
    const user = userEvent.setup();
    await renderFiled();
    await user.click(within(rail()).getByRole('button', { name: 'Options for Home' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Move up' }));
    await waitFor(() => expect(mock.api.reorderCategories).toHaveBeenCalledWith(['home', 'work']));
  });

  it('says when a category is empty and adds the next entry to it', async () => {
    const empty = category({ id: 'empty', name: 'Travel', color: 'teal', icon: 'globe' });
    mock.api.listCategories.mockResolvedValue([work, home, empty]);
    renderPage(filed);
    await screen.findByRole('listbox', { name: 'Vault entries' });
    fireEvent.click(await within(rail()).findByRole('button', { name: 'Travel (0)' }));
    expect(await screen.findByText('Nothing in Travel yet')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add an entry to Travel' }));
    const dialog = await screen.findByRole('dialog', { name: 'New entry' });
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: /^Category/ }).textContent).toContain(
        'Travel',
      ),
    );
  });

  it('shows the category in the detail and moves the entry from there', async () => {
    const user = userEvent.setup();
    mock.api.moveEntries.mockResolvedValue(1);
    await renderFiled();
    fireEvent.click(within(listbox()).getByRole('option', { name: /GitHub/ }));
    const detail = await screen.findByRole('region', { name: 'GitHub' });

    fireEvent.click(within(detail).getByRole('button', { name: 'Show everything in Work' }));
    expect(useVaultStore.getState().categoryFilter).toBe('work');

    await user.click(within(detail).getByRole('button', { name: 'Move to category' }));
    await user.click(await screen.findByRole('menuitemradio', { name: 'Home' }));
    await waitFor(() => expect(mock.api.moveEntries).toHaveBeenCalledWith(['gh'], 'home'));
  });
});

describe('VaultPage one-click login', () => {
  it('logs in from the detail pane', async () => {
    renderPage();
    await screen.findByRole('listbox', { name: 'Vault entries' });
    fireEvent.click(within(listbox()).getByRole('option', { name: /GitHub/ }));
    const detail = await screen.findByRole('region', { name: 'GitHub' });
    fireEvent.click(within(detail).getByRole('button', { name: 'Log in to github.com' }));
    await waitFor(() => expect(mock.api.openLogin).toHaveBeenCalledWith('gh', 'window'));
  });

  it('logs in from a row without selecting it, and only for logins with a website', async () => {
    renderPage();
    await screen.findByRole('listbox', { name: 'Vault entries' });
    const row = within(listbox()).getByRole('option', { name: /GitHub/ });
    fireEvent.click(within(row).getByRole('button', { name: 'Log in to github.com' }));
    await waitFor(() => expect(mock.api.openLogin).toHaveBeenCalledWith('gh', 'window'));
    expect(useVaultStore.getState().selectedId).toBeNull();
    const gitlabRow = within(listbox()).getByRole('option', { name: /GitLab/ });
    expect(within(gitlabRow).queryByRole('button', { name: /Log in/ })).toBeNull();
  });

  it('logs in to the selected entry with Ctrl+Enter', async () => {
    renderPage();
    await screen.findByRole('listbox', { name: 'Vault entries' });
    fireEvent.click(within(listbox()).getByRole('option', { name: /GitHub/ }));
    fireEvent.keyDown(window, { key: 'Enter', code: 'Enter', ctrlKey: true });
    await waitFor(() => expect(mock.api.openLogin).toHaveBeenCalledWith('gh', 'window'));
  });

  it('says how the login went once the page is filled', async () => {
    renderPage();
    await screen.findByRole('listbox', { name: 'Vault entries' });
    act(() =>
      mock.emitLoginFilled({
        entryId: 'gh',
        host: 'github.com',
        result: 'filled',
        submitted: true,
      }),
    );
    expect(toast.success).toHaveBeenCalledWith('Signed in to github.com', expect.anything());
    act(() =>
      mock.emitLoginFilled({
        entryId: 'gh',
        host: 'github.com',
        result: 'filled',
        submitted: false,
      }),
    );
    expect(toast.success).toHaveBeenCalledWith(
      'Filled in your login on github.com',
      expect.anything(),
    );
    act(() =>
      mock.emitLoginFilled({
        entryId: 'gh',
        host: 'github.com',
        result: 'no-form',
        submitted: false,
      }),
    );
    expect(toast.error).toHaveBeenCalledWith(
      'No login form found on github.com',
      expect.anything(),
    );
  });
});
