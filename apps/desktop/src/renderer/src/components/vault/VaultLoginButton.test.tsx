// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useVaultStore } from '@/stores/vaultStore';
import {
  createVaultApiMock,
  expectNoNativeTitles,
  installDomShims,
  installVaultApi,
  renderWithVaultProviders,
  summary,
  type VaultApiMock,
} from './testing/mockVaultApi';

installDomShims();

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), dismiss: vi.fn() }),
);
vi.mock('sonner', () => ({ toast }));
const workspace = vi.hoisted(() => ({
  openLoginInWorkspace: vi.fn(async () => ({ ok: true, clearsAt: null })),
}));
vi.mock('@/lib/vault/openInWorkspace', () => workspace);
const clipboardToast = vi.hoisted(() => ({
  showCopiedToast: vi.fn(),
  settleClipboardToast: vi.fn(),
}));
vi.mock('@/lib/vault/clipboardToast', () => clipboardToast);

const { VaultLoginButton } = await import('./VaultLoginButton');

const github = summary({
  id: 'gh',
  title: 'GitHub',
  username: 'octocat',
  urls: ['https://github.com/login'],
  host: 'github.com',
});

let mock: VaultApiMock;

function renderButton(entry = github, variant: 'full' | 'icon' = 'full') {
  return renderWithVaultProviders(<VaultLoginButton entry={entry} variant={variant} />);
}

beforeEach(() => {
  mock = createVaultApiMock();
  installVaultApi(mock);
  vi.mocked(window.runova.projects.list).mockResolvedValue([
    { id: 'p1', name: 'Website' },
    { id: 'p2', name: 'Mobile app' },
  ] as never);
  useVaultStore.setState({ loginTarget: { kind: 'window' } });
  vi.clearAllMocks();
});

afterEach(() => {
  expectNoNativeTitles();
  cleanup();
});

describe('VaultLoginButton', () => {
  it('logs in through the Runova window by default', async () => {
    renderButton();
    fireEvent.click(screen.getByRole('button', { name: 'Log in to github.com' }));
    await waitFor(() => expect(mock.api.openLogin).toHaveBeenCalledWith('gh', 'window'));
  });

  it('opens the default browser and says the password was copied', async () => {
    const user = userEvent.setup();
    mock.api.openLogin.mockResolvedValue({ ok: true, clearsAt: Date.now() + 30_000 });
    renderButton();
    await user.click(screen.getByRole('button', { name: 'Choose where to log in' }));
    await user.click(await screen.findByRole('menuitemradio', { name: /Default browser/ }));
    await waitFor(() => expect(mock.api.openLogin).toHaveBeenCalledWith('gh', 'system'));
    expect(clipboardToast.showCopiedToast).toHaveBeenCalledWith('Password', expect.any(Number));
    expect(useVaultStore.getState().loginTarget).toEqual({ kind: 'system' });
  });

  it('opens a Workspace tab in the project picked, and remembers it', async () => {
    const user = userEvent.setup();
    renderButton();
    await user.click(screen.getByRole('button', { name: 'Choose where to log in' }));
    await user.click(await screen.findByRole('menuitem', { name: /Workspace tab/ }));
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Mobile app' }));
    await waitFor(() =>
      expect(workspace.openLoginInWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({
          entryId: 'gh',
          url: 'https://github.com/login',
          projectId: 'p2',
        }),
      ),
    );
    expect(useVaultStore.getState().loginTarget).toEqual({ kind: 'workspace', projectId: 'p2' });
    expect(mock.api.openLogin).not.toHaveBeenCalled();

    // The next click goes straight there.
    fireEvent.click(screen.getByRole('button', { name: 'Log in to github.com' }));
    await waitFor(() => expect(workspace.openLoginInWorkspace).toHaveBeenCalledTimes(2));
  });

  it('falls back to the Runova window when the remembered project is gone', async () => {
    useVaultStore.setState({ loginTarget: { kind: 'workspace', projectId: 'deleted' } });
    renderButton();
    await waitFor(() => expect(window.runova.projects.list).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Log in to github.com' }));
    await waitFor(() => expect(mock.api.openLogin).toHaveBeenCalledWith('gh', 'window'));
  });

  it('explains a refusal from main', async () => {
    mock.api.openLogin.mockResolvedValue({ ok: false, reason: 'no-url' });
    renderButton();
    fireEvent.click(screen.getByRole('button', { name: 'Log in to github.com' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Could not log in', {
        description: 'Add a website to this login first.',
      }),
    );
  });

  it('is a single icon in the list rows', async () => {
    renderButton(github, 'icon');
    expect(screen.queryByRole('button', { name: 'Choose where to log in' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Log in to github.com' }));
    await waitFor(() => expect(mock.api.openLogin).toHaveBeenCalledWith('gh', 'window'));
  });

  it('is not offered for a login without a website, or for other entry types', () => {
    const { container } = renderButton(summary({ id: 'x', urls: [] }));
    expect(container.textContent).toBe('');
    cleanup();
    const note = renderButton(summary({ id: 'n', type: 'note', urls: ['https://x.io'] }));
    expect(note.container.textContent).toBe('');
  });
});
