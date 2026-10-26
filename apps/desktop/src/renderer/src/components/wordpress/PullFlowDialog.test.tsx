import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { change, wpPlan, wpProject, wpSite } from '../projects/wordpress/testing/fixtures';

vi.mock('@/components/editor/MonacoDiffEditor', async () => ({
  MonacoDiffEditor: (await import('../deploy/sites/testing/monacoMocks')).FakeMonacoDiffEditor,
}));

const { PullFlowDialog } = await import('./PullFlowDialog');

/**
 * Pulling a WordPress project from the outside: the incoming changes, a choice per conflicting
 * file sent as resolutions, and the copies the pull keeps.
 */

const styleConflict = change({
  path: 'style.css',
  local: 'modified',
  remote: 'modified',
  action: 'conflict',
  expectedRemote: null,
});
const pluginConflict = change({
  item: { kind: 'plugin', slug: 'woocommerce' },
  path: 'includes/cart.php',
  local: 'deleted',
  remote: 'modified',
  action: 'conflict',
  expectedRemote: null,
});

const pullPlan = wpPlan({
  direction: 'pull',
  changes: [
    change({ path: 'header.php', local: null, remote: 'modified', action: 'download', size: 300 }),
    change({ path: 'gone.php', local: null, remote: 'deleted', action: 'deleteLocal', size: 0 }),
    styleConflict,
    pluginConflict,
  ],
  conflicts: [styleConflict, pluginConflict],
  uploadBytes: 0,
  downloadBytes: 300,
});

function renderDialog(bridge: Record<string, unknown> = {}) {
  return renderWithProviders(
    <PullFlowDialog open onOpenChange={() => undefined} projectId="p1" siteId="site-1" />,
    {
      bridge: {
        'projects.list': [wpProject()],
        'deployWordPress.listSites': [wpSite()],
        'deployWordPress.planPull': pullPlan,
        'deployWordPress.pull': {
          downloaded: 1,
          deletedLocal: 1,
          conflictCopies: ['.runova/wordpress/conflicts/theme-storefront/style.css'],
          leftOut: [],
        },
        ...bridge,
      },
    },
  );
}

describe('PullFlowDialog', () => {
  it('shows what is coming and asks about each conflict', async () => {
    renderDialog();

    expect(await screen.findByText('header.php')).toBeTruthy();
    expect(screen.getByText('gone.php')).toBeTruthy();
    expect(
      screen.getByText(/1 file to download \(300 B\), 1 to remove here, 2 in conflict/),
    ).toBeTruthy();
    const conflicts = screen.getByRole('region', { name: 'Conflicts' });
    expect(within(conflicts).getByText('Deleted here, changed on the site.')).toBeTruthy();
    expect(
      within(conflicts).getByRole('group', { name: 'Which copy of style.css to keep' }),
    ).toBeTruthy();
  });

  it('sends a resolution for every conflict, keyed by item and path', async () => {
    const { user, bridge } = renderDialog();
    const conflicts = await screen.findByRole('region', { name: 'Conflicts' });

    await user.click(
      within(
        within(conflicts).getByRole('group', { name: 'Which copy of style.css to keep' }),
      ).getByRole('button', { name: "Take the site's" }),
    );
    await user.click(screen.getByRole('button', { name: /^Pull$/ }));

    await waitFor(() =>
      expect(bridge.$fn('deployWordPress.pull')).toHaveBeenCalledWith(
        expect.objectContaining({
          planId: 'plan-1',
          force: false,
          resolutions: {
            'theme:storefront/style.css': 'takeRemote',
            'plugin:woocommerce/includes/cart.php': 'keepLocal',
          },
        }),
      ),
    );
  });

  it('can take every file from the site at once', async () => {
    const { user, bridge } = renderDialog();
    await user.click(await screen.findByRole('button', { name: 'Take all from the site' }));
    await user.click(screen.getByRole('button', { name: /^Pull$/ }));

    await waitFor(() =>
      expect(bridge.$fn('deployWordPress.pull').mock.calls[0][0].resolutions).toEqual({
        'theme:storefront/style.css': 'takeRemote',
        'plugin:woocommerce/includes/cart.php': 'takeRemote',
      }),
    );
  });

  it('lists the conflict copies it kept, by path', async () => {
    const { user } = renderDialog();
    await user.click(await screen.findByRole('button', { name: /^Pull$/ }));

    expect(await screen.findByText('Pulled')).toBeTruthy();
    const copies = screen.getByRole('list', { name: 'Conflict copies' });
    expect(
      within(copies).getByText('.runova/wordpress/conflicts/theme-storefront/style.css'),
    ).toBeTruthy();
  });

  it('sends no resolutions when nothing conflicts', async () => {
    const { user, bridge } = renderDialog({
      'deployWordPress.planPull': wpPlan({
        direction: 'pull',
        changes: [change({ path: 'a.php', local: null, remote: 'added', action: 'download' })],
      }),
    });
    await user.click(await screen.findByRole('button', { name: /^Pull$/ }));
    await waitFor(() => expect(bridge.$fn('deployWordPress.pull')).toHaveBeenCalled());
    expect(bridge.$fn('deployWordPress.pull').mock.calls[0][0]).not.toHaveProperty('resolutions');
  });

  it('has nothing to pull when nothing changed on the site', async () => {
    renderDialog({
      'deployWordPress.planPull': wpPlan({ direction: 'pull', changes: [] }),
    });
    expect(await screen.findByText('Nothing new on the site since the last sync.')).toBeTruthy();
    expect((screen.getByRole('button', { name: /^Pull$/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('says why a pull failed', async () => {
    const { user } = renderDialog({
      'deployWordPress.pull': async () => {
        throw new Error('[wp:operationBusy] A deploy to this site is still running.');
      },
    });
    await user.click(await screen.findByRole('button', { name: /^Pull$/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'A deploy to this site is still running.',
    );
    expect(screen.getByText(/Try again when it ends/)).toBeTruthy();
  });
});
