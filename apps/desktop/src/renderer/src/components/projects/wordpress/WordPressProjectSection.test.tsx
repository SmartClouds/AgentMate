import { act, screen, waitFor, within } from '@testing-library/react';
import { useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { SITE_ITEMS, wpProject, wpSite } from './testing/fixtures';

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }),
);
vi.mock('sonner', () => ({ toast, Toaster: () => null }));

// The confirmation modal lives in the app shell, outside this section.
const confirm = vi.hoisted(() => ({ confirmDialog: vi.fn(async () => true) }));
vi.mock('@/stores/confirmStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/confirmStore')>();
  return { ...actual, confirmDialog: confirm.confirmDialog };
});

vi.mock('@/components/editor/MonacoDiffEditor', async () => ({
  MonacoDiffEditor: (await import('../../deploy/sites/testing/monacoMocks')).FakeMonacoDiffEditor,
}));

const { WordPressProjectSection, READ_ONLY_HINT } = await import('./WordPressProjectSection');

/**
 * The WordPress section of a linked project: the site, its items, how far the folder has moved,
 * and the ways to pull, deploy, relink or unlink.
 */

const changes = { projectId: 'p1', added: 2, modified: 5, deleted: 1, checkedAt: 1 };

function renderSection(bridge: Record<string, unknown> = {}, project = wpProject()) {
  return renderWithProviders(<WordPressProjectSection project={project} />, {
    bridge: {
      'deployWordPress.listSites': [wpSite()],
      'deployWordPress.listItems': SITE_ITEMS,
      'deployWordPress.localChanges': changes,
      ...bridge,
    },
  });
}

describe('WordPressProjectSection', () => {
  it('shows the site, the linked items and the local change counts', async () => {
    renderSection();

    expect(await screen.findByText('Acme Shop')).toBeTruthy();
    expect(screen.getByText('shop.example.com')).toBeTruthy();
    expect(screen.getByText('Read and write')).toBeTruthy();
    const items = screen.getByRole('region', { name: 'Linked themes and plugins' });
    expect(await within(items).findByText('Storefront')).toBeTruthy();
    expect(within(items).getByText('WooCommerce')).toBeTruthy();
    expect(within(items).getByText('wp-content/themes/storefront')).toBeTruthy();

    const counts = screen.getByRole('region', { name: 'Local changes' });
    expect(await within(counts).findByText('5')).toBeTruthy();
    expect(within(counts).getByText('2')).toBeTruthy();
    expect(within(counts).getByText('1')).toBeTruthy();
  });

  it('lists what the project ignores in its own section, and saves changes from there', async () => {
    const base = wpProject();
    const project = {
      ...base,
      wordpress: { ...base.wordpress, ignore: { 'theme:storefront': ['/vendor/'] } },
    } as typeof base;
    const { user, bridge } = renderSection(
      { 'deployWordPress.setProjectIgnore': async () => base },
      project,
    );

    const section = await screen.findByRole('region', { name: 'Ignored files' });
    const list = within(section).getByRole('list', { name: 'Ignored files and folders' });
    expect(within(list).getByText('vendor/')).toBeTruthy();
    expect(within(section).getByText(/Never deployed/)).toBeTruthy();
    await user.click(
      within(section).getByRole('button', { name: 'Stop ignoring vendor/ in storefront' }),
    );
    await waitFor(() =>
      expect(bridge.$fn('deployWordPress.setProjectIgnore')).toHaveBeenCalledWith({
        projectId: 'p1',
        ignore: {},
      }),
    );
  });

  it('checks the local changes again when the window gets focus back', async () => {
    const { bridge } = renderSection();
    await screen.findByText('5');
    const before = bridge.$fn('deployWordPress.localChanges').mock.calls.length;

    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() =>
      expect(bridge.$fn('deployWordPress.localChanges').mock.calls.length).toBeGreaterThan(before),
    );
    expect(bridge.$fn('deployWordPress.localChanges')).toHaveBeenCalledWith('p1');
  });

  it('keeps a read-only site from being deployed to, and says why on hover', async () => {
    const { user } = renderSection({ 'deployWordPress.listSites': [wpSite({ scope: 'read' })] });

    expect(await screen.findByText('Read only')).toBeTruthy();
    const deploy = screen.getByRole('button', { name: /Review and deploy/ }) as HTMLButtonElement;
    expect(deploy.disabled).toBe(true);
    expect(
      (screen.getByRole('button', { name: /Pull latest/ }) as HTMLButtonElement).disabled,
    ).toBe(false);
    await user.hover(deploy.parentElement as HTMLElement);
    expect(await screen.findByRole('tooltip')).toHaveTextContent(READ_ONLY_HINT);
  });

  it('opens the deploy review for a read-write site', async () => {
    const { user, bridge } = renderSection({
      'deployWordPress.planDeploy': new Promise(() => undefined),
    });
    await user.click(await screen.findByRole('button', { name: /Review and deploy/ }));
    expect(await screen.findByRole('dialog', { name: /Deploy to Acme Shop/ })).toBeTruthy();
    expect(bridge.$fn('deployWordPress.planDeploy')).toHaveBeenCalledWith({ projectId: 'p1' });
  });

  it('opens the pull review', async () => {
    const { user, bridge } = renderSection({
      'deployWordPress.planPull': new Promise(() => undefined),
    });
    await user.click(await screen.findByRole('button', { name: /Pull latest/ }));
    expect(await screen.findByRole('dialog', { name: /Pull from Acme Shop/ })).toBeTruthy();
    expect(bridge.$fn('deployWordPress.planPull')).toHaveBeenCalledWith({ projectId: 'p1' });
  });

  it('unlinks after the confirmation, keeps the files and goes back to the Overview', async () => {
    function WithLocation(): React.JSX.Element {
      const location = useLocation();
      return (
        <>
          <span data-testid="search">{location.search}</span>
          <WordPressProjectSection project={wpProject()} />
        </>
      );
    }
    const { user, bridge } = renderWithProviders(<WithLocation />, {
      route: '/projects/p1?tab=wordpress',
      bridge: {
        'deployWordPress.listSites': [wpSite()],
        'deployWordPress.listItems': SITE_ITEMS,
        'deployWordPress.localChanges': changes,
        'deployWordPress.unlinkProject': wpProject({ wordpress: undefined }),
      },
    });
    expect(screen.getByTestId('search')).toHaveTextContent('?tab=wordpress');
    await user.click(await screen.findByRole('button', { name: /Unlink/ }));

    expect(confirm.confirmDialog).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Unlink this project from the site?' }),
    );
    await waitFor(() =>
      expect(bridge.$fn('deployWordPress.unlinkProject')).toHaveBeenCalledWith('p1'),
    );
    expect(toast.success).toHaveBeenCalledWith(
      'Unlinked. It is a regular project again, with every file still in its folder.',
    );
    await waitFor(() => expect(screen.getByTestId('search')).toBeEmptyDOMElement());
  });

  it('says why an item could not be dropped, in the words of the error', async () => {
    const { user } = renderSection({
      'deployWordPress.setProjectItems': async () => {
        throw new Error('[wp:operationBusy] A pull from this site is still running.');
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Stop syncing woocommerce' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('A pull from this site is still running.'),
    );
  });

  it('shows the vault hint when the site list cannot be read', async () => {
    renderSection({
      'deployWordPress.listSites': async () => {
        throw new Error('[wp:vaultLocked] The Servers vault is locked.');
      },
    });
    expect(await screen.findByText(/Unlock the Servers vault in Deploy/)).toBeTruthy();
  });

  it('does nothing when the unlink is declined', async () => {
    confirm.confirmDialog.mockResolvedValueOnce(false);
    const { user, bridge } = renderSection();
    await user.click(await screen.findByRole('button', { name: /Unlink/ }));
    await waitFor(() => expect(confirm.confirmDialog).toHaveBeenCalled());
    expect(() => bridge.$fn('deployWordPress.unlinkProject')).toThrow();
  });

  it('stops syncing an item, keeping the rest', async () => {
    const { user, bridge } = renderSection({
      'deployWordPress.setProjectItems': wpProject(),
    });
    await user.click(await screen.findByRole('button', { name: 'Stop syncing woocommerce' }));

    await waitFor(() =>
      expect(bridge.$fn('deployWordPress.setProjectItems')).toHaveBeenCalledWith({
        operationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        projectId: 'p1',
        items: [{ kind: 'theme', slug: 'storefront' }],
      }),
    );
  });

  it('adds more of the site items, offering only ones not linked yet', async () => {
    const { user, bridge } = renderSection({
      'deployWordPress.setProjectItems': wpProject(),
    });
    await user.click(await screen.findByRole('button', { name: /^Add$/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Add themes and plugins' });

    expect(within(dialog).queryByRole('checkbox', { name: /Storefront/ })).toBeNull();
    expect(within(dialog).queryByRole('checkbox', { name: /WooCommerce/ })).toBeNull();
    await user.click(within(dialog).getByRole('checkbox', { name: /Tweaks/ }));
    await user.click(within(dialog).getByRole('button', { name: /Add and pull/ }));

    await waitFor(() =>
      expect(bridge.$fn('deployWordPress.setProjectItems')).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 'p1',
          items: [
            { kind: 'theme', slug: 'storefront' },
            { kind: 'plugin', slug: 'woocommerce' },
            { kind: 'mu-plugin', slug: 'tweaks.php' },
          ],
        }),
      ),
    );
    expect(toast.success).toHaveBeenCalledWith('Added tweaks.php.');
  });

  it('adds a new theme or plugin made in the project, then reviews its first deploy', async () => {
    const fresh = { kind: 'plugin', slug: 'fresh' };
    const base = wpProject();
    const updated = {
      ...base,
      wordpress: { ...base.wordpress, items: [...(base.wordpress?.items ?? []), fresh] },
    };
    const { user, bridge } = renderSection({
      'deployWordPress.localItems': [{ ...fresh, isFile: false, linked: false }],
      'deployWordPress.setProjectItems': updated,
      'deployWordPress.planDeploy': new Promise(() => undefined),
    });
    await user.click(await screen.findByRole('button', { name: 'New theme or plugin' }));
    const dialog = await screen.findByRole('dialog', { name: 'New theme or plugin' });
    await user.click(await within(dialog).findByRole('checkbox', { name: /fresh/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Add and review deploy' }));

    await waitFor(() =>
      expect(bridge.$fn('deployWordPress.setProjectItems')).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: 'p1', newItems: [fresh] }),
      ),
    );
    expect(await screen.findByRole('dialog', { name: /Deploy to Acme Shop/ })).toBeTruthy();
    expect(bridge.$fn('deployWordPress.planDeploy')).toHaveBeenCalledWith({
      projectId: 'p1',
      items: [fresh],
    });
  });

  it('keeps a new theme or plugin off for a read-only site, like any deploy', async () => {
    renderSection({ 'deployWordPress.listSites': [wpSite({ scope: 'read' })] });
    await screen.findByText('Read only');
    expect(
      (screen.getByRole('button', { name: 'New theme or plugin' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('offers to link a project whose site is gone to a connected one', async () => {
    const { user, bridge } = renderSection(
      {
        'deployWordPress.listSites': [
          wpSite({ id: 'site-9', label: 'Other', siteUrl: 'https://other.example.com' }),
          wpSite({ id: 'site-2', label: 'Acme again', siteUrl: 'https://shop.example.com' }),
        ],
        'deployWordPress.setProjectItems': wpProject(),
      },
      wpProject({ websiteUrl: 'https://shop.example.com' }),
    );

    expect(await screen.findByText(/isn't connected any more/)).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: /Review and deploy/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await user.click(screen.getByRole('button', { name: /Link to a connected site/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Link to a connected site' });
    const sites = within(dialog).getAllByRole('button', { name: /example\.com/ });
    // The site at the project's own address comes first.
    expect(sites[0]).toHaveTextContent('Acme again');
    expect(sites[0]).toHaveTextContent('Same address');

    await user.click(sites[0]);
    await user.click(within(dialog).getByRole('button', { name: /^Link$/ }));
    await waitFor(() =>
      expect(bridge.$fn('deployWordPress.setProjectItems')).toHaveBeenCalledWith({
        operationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        projectId: 'p1',
        siteId: 'site-2',
        items: [
          { kind: 'theme', slug: 'storefront' },
          { kind: 'plugin', slug: 'woocommerce' },
        ],
      }),
    );
    expect(toast.success).toHaveBeenCalledWith('Linked to the site again.');
  });

  it('shows why a relink failed', async () => {
    const { user } = renderSection({
      'deployWordPress.listSites': [wpSite({ id: 'site-2' })],
      'deployWordPress.setProjectItems': async () => {
        throw new Error('[wp:itemUnknown] The site has no theme named storefront.');
      },
    });
    await user.click(await screen.findByRole('button', { name: /Link to a connected site/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Link to a connected site' });
    await user.click(within(dialog).getByRole('button', { name: /Acme Shop/ }));
    await user.click(within(dialog).getByRole('button', { name: /^Link$/ }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'The site has no theme named storefront.',
    );
  });
});
