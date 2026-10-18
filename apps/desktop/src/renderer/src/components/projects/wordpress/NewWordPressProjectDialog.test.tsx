import type { Project, WpItemRef } from '@agentmat/core';
import { act, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { useWordPressOperationStore } from '@/stores/wordpressOperationStore';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { FOLDER_NOTE, NewWordPressProjectDialog } from './NewWordPressProjectDialog';
import { deferred, SITE_ITEMS, wpProject, wpSite } from './testing/fixtures';

/**
 * Making a project from a WordPress site, step by step: the site, its themes and plugins, the
 * name and folder, the pull, and opening the result.
 */

interface StartingPoint {
  initialSiteId?: string;
  initialItems?: WpItemRef[];
}

function Harness(props: StartingPoint): React.JSX.Element {
  const location = useLocation();
  return (
    <>
      <span data-testid="location">{location.pathname}</span>
      <NewWordPressProjectDialog open onOpenChange={() => undefined} {...props} />
    </>
  );
}

function renderDialog(bridge: Record<string, unknown> = {}, props: StartingPoint = {}) {
  return renderWithProviders(<Harness {...props} />, {
    route: '/projects',
    bridge: {
      'deployWordPress.listSites': [
        wpSite(),
        wpSite({ id: 'site-2', label: 'Blog', siteUrl: 'https://blog.example.com' }),
      ],
      'deployWordPress.listItems': SITE_ITEMS,
      'settings.get': { projectsRootPath: 'D:\\Sites' },
      ...bridge,
    },
  });
}

async function toItems(user: ReturnType<typeof renderDialog>['user']): Promise<void> {
  await user.click(await screen.findByRole('button', { name: /Acme Shop/ }));
  await user.click(screen.getByRole('button', { name: /Next/ }));
  await screen.findByText('Storefront');
}

async function toDetails(user: ReturnType<typeof renderDialog>['user']): Promise<void> {
  await toItems(user);
  await user.click(screen.getByRole('button', { name: /Next/ }));
  await screen.findByLabelText('Name');
}

describe('NewWordPressProjectDialog', () => {
  it('waits for a site to be picked before going on', async () => {
    renderDialog();
    expect(await screen.findByRole('button', { name: /Blog/ })).toBeTruthy();
    expect((screen.getByRole('button', { name: /Next/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('button', { name: /Connect a new site/ })).toBeTruthy();
  });

  it('opens the connect dialog from the site step', async () => {
    const { user } = renderDialog({ 'deployWordPress.listSites': [] });
    expect(await screen.findByText(/No WordPress sites are connected yet/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /Connect a new site/ }));
    expect(await screen.findByRole('dialog', { name: /connect/i })).toBeTruthy();
  });

  it("ticks the site's active theme, hides the connector and shows versions and active state", async () => {
    const { user, bridge } = renderDialog();
    await toItems(user);

    expect(bridge.$fn('deployWordPress.listItems')).toHaveBeenCalledWith('site-1');
    expect(screen.getByRole('checkbox', { name: /Storefront/ })).toHaveAttribute(
      'data-state',
      'checked',
    );
    expect(screen.getByRole('checkbox', { name: /Twenty Twenty-Five/ })).toHaveAttribute(
      'data-state',
      'unchecked',
    );
    expect(screen.getByRole('checkbox', { name: /WooCommerce/ })).toHaveAttribute(
      'data-state',
      'unchecked',
    );
    expect(screen.queryByText('AgentMate Connector')).toBeNull();
    expect(screen.getByText(/version 4\.5/)).toBeTruthy();
    expect(screen.getAllByText('Active')).toHaveLength(2);

    // With nothing ticked there is nothing to make a project from.
    await user.click(screen.getByRole('checkbox', { name: /Storefront/ }));
    expect((screen.getByRole('button', { name: /Next/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('names the project after the site and puts it in the projects folder by default', async () => {
    const { user } = renderDialog();
    await toDetails(user);

    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Acme Shop');
    expect((screen.getByLabelText('Folder') as HTMLInputElement).value).toBe(
      'D:\\Sites\\acme-shop',
    );
    expect(screen.getByText(FOLDER_NOTE)).toBeTruthy();

    // The folder follows the name until it is picked or typed.
    await user.clear(screen.getByLabelText('Name'));
    await user.type(screen.getByLabelText('Name'), 'Shop Redesign!');
    expect((screen.getByLabelText('Folder') as HTMLInputElement).value).toBe(
      'D:\\Sites\\shop-redesign',
    );
  });

  it('takes a folder from the picker, and needs one when there is no projects folder', async () => {
    const { user } = renderDialog({
      'settings.get': { projectsRootPath: null },
      'projects.pickFolder': async () => 'E:\\work\\shop',
    });
    await toDetails(user);

    expect((screen.getByLabelText('Folder') as HTMLInputElement).value).toBe('');
    expect(
      (screen.getByRole('button', { name: /Create project/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await user.click(screen.getByRole('button', { name: /Browse/ }));
    await waitFor(() =>
      expect((screen.getByLabelText('Folder') as HTMLInputElement).value).toBe('E:\\work\\shop'),
    );
    expect(
      (screen.getByRole('button', { name: /Create project/ }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('creates the project with an operation id, shows the pull and opens the project', async () => {
    const call = deferred<Project>();
    const { user, bridge } = renderDialog({
      'deployWordPress.createProject': () => call.promise,
    });
    await toItems(user);
    await user.click(screen.getByRole('checkbox', { name: /WooCommerce/ }));
    await user.click(screen.getByRole('button', { name: /Next/ }));
    await user.click(await screen.findByRole('button', { name: /Create project/ }));

    await waitFor(() => expect(bridge.$fn('deployWordPress.createProject')).toHaveBeenCalled());
    const input = bridge.$fn('deployWordPress.createProject').mock.calls[0][0];
    expect(input).toEqual({
      operationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      siteId: 'site-1',
      items: [
        { kind: 'theme', slug: 'storefront' },
        { kind: 'plugin', slug: 'woocommerce' },
      ],
      folderPath: 'D:\\Sites\\acme-shop',
      name: 'Acme Shop',
      agentType: 'claude-code',
    });

    const event = {
      operationId: input.operationId,
      siteId: 'site-1',
      projectId: null,
      kind: 'createProject' as const,
    };
    act(() => {
      bridge.$emit('deployWordPress.onProgress', {
        ...event,
        phase: 'connecting',
        done: 0,
        total: 0,
      });
      bridge.$emit('deployWordPress.onProgress', {
        ...event,
        phase: 'download',
        done: 4,
        total: 10,
      });
    });
    const progress = await screen.findByRole('list', { name: 'Progress' });
    expect(within(progress).getByLabelText('Downloading files: in progress')).toHaveTextContent(
      '4 of 10',
    );

    await act(async () => call.resolve(wpProject({ id: 'new-project' })));
    expect(await screen.findByText('Acme Shop is ready')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /Open the project/ }));
    expect(screen.getByTestId('location')).toHaveTextContent('/projects/new-project');
  });

  it('explains a failure and goes back to the details', async () => {
    const { user } = renderDialog({
      'deployWordPress.createProject': async () => {
        throw new Error('[wp:folderNotEmpty] wp-content/themes/storefront already holds files.');
      },
    });
    await toDetails(user);
    await user.click(screen.getByRole('button', { name: /Create project/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'wp-content/themes/storefront already holds files.',
    );
    expect(screen.getByText('Pick an empty folder, or a new one.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /^Back$/ }));
    expect(await screen.findByLabelText('Folder')).toBeTruthy();
  });

  describe('opened for a site from its Deploy page', () => {
    const fromSite = {
      initialSiteId: 'site-2',
      initialItems: [{ kind: 'theme', slug: 'twentytwentyfive' }],
    } satisfies StartingPoint;

    it('opens on the items step with the clicked theme ticked and the name set to the site label', async () => {
      const { user, bridge } = renderDialog({}, fromSite);

      expect(await screen.findByText('Twenty Twenty-Five')).toBeTruthy();
      expect(screen.getByText('Which themes and plugins?')).toBeTruthy();
      expect(bridge.$fn('deployWordPress.listItems')).toHaveBeenCalledWith('site-2');
      expect(screen.getByRole('checkbox', { name: /Twenty Twenty-Five/ })).toHaveAttribute(
        'data-state',
        'checked',
      );
      // Only what was clicked, not the site's active theme as well.
      expect(screen.getByRole('checkbox', { name: /Storefront/ })).toHaveAttribute(
        'data-state',
        'unchecked',
      );

      await user.click(screen.getByRole('button', { name: /Next/ }));
      expect(((await screen.findByLabelText('Name')) as HTMLInputElement).value).toBe('Blog');
      expect((screen.getByLabelText('Folder') as HTMLInputElement).value).toBe('D:\\Sites\\blog');
    });

    it('ticks the new item when it opens again for the same site', async () => {
      function Reopen(): React.JSX.Element {
        const [open, setOpen] = useState(true);
        const [items, setItems] = useState<WpItemRef[]>(fromSite.initialItems);
        return (
          <>
            <button
              type="button"
              onClick={() => {
                setItems([{ kind: 'plugin', slug: 'woocommerce' }]);
                setOpen(true);
              }}
            >
              Reopen
            </button>
            <NewWordPressProjectDialog
              open={open}
              onOpenChange={setOpen}
              initialSiteId="site-2"
              initialItems={items}
            />
          </>
        );
      }
      const { user } = renderWithProviders(<Reopen />, {
        route: '/projects',
        bridge: {
          'deployWordPress.listSites': [wpSite({ id: 'site-2', label: 'Blog' })],
          'deployWordPress.listItems': SITE_ITEMS,
          'settings.get': { projectsRootPath: 'D:\\Sites' },
        },
      });
      expect(await screen.findByRole('checkbox', { name: /Twenty Twenty-Five/ })).toHaveAttribute(
        'data-state',
        'checked',
      );

      await user.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      await user.click(screen.getByRole('button', { name: 'Reopen' }));

      await waitFor(() =>
        expect(screen.getByRole('checkbox', { name: /WooCommerce/ })).toHaveAttribute(
          'data-state',
          'checked',
        ),
      );
      expect(screen.getByRole('checkbox', { name: /Twenty Twenty-Five/ })).toHaveAttribute(
        'data-state',
        'unchecked',
      );
    });

    it('still shows a project being made instead', async () => {
      useWordPressOperationStore.setState({
        runs: {
          'op-1': {
            operationId: 'op-1',
            kind: 'createProject',
            siteId: 'site-1',
            projectId: null,
            phases: ['download'],
            progress: { download: { done: 2, total: 5 } },
            latest: null,
            status: 'running',
            cancelling: false,
            error: null,
            errorCode: null,
            result: null,
            owned: false,
            startedAt: 1,
            finishedAt: null,
          },
        },
      });
      renderDialog({}, fromSite);

      expect(await screen.findByRole('list', { name: 'Progress' })).toBeTruthy();
      expect(screen.getByText('Pulling the files')).toBeTruthy();
      expect(screen.getByRole('button', { name: /Hide/ })).toBeTruthy();
      expect(screen.queryByRole('checkbox')).toBeNull();
    });

    it('keeps the ticks through a refetch and goes back to the sites', async () => {
      let listed = 0;
      const { user, queryClient } = renderDialog(
        {
          // A refetch that brings something new, so the items really change under the ticks.
          'deployWordPress.listItems': async () =>
            SITE_ITEMS.map((item) => ({ ...item, version: `${item.version}.${listed++}` })),
        },
        fromSite,
      );
      await user.click(await screen.findByRole('checkbox', { name: /WooCommerce/ }));
      await user.click(screen.getByRole('checkbox', { name: /Twenty Twenty-Five/ }));
      await act(() => queryClient.refetchQueries());
      expect(listed).toBeGreaterThan(SITE_ITEMS.length);
      await waitFor(() => expect(screen.queryByText(/version 4\.5\.0\b/)).toBeNull());
      expect(screen.getByRole('checkbox', { name: /WooCommerce/ })).toHaveAttribute(
        'data-state',
        'checked',
      );
      expect(screen.getByRole('checkbox', { name: /Twenty Twenty-Five/ })).toHaveAttribute(
        'data-state',
        'unchecked',
      );

      // Back on the site step, another site works the way it always does.
      await user.click(screen.getByRole('button', { name: /^Back$/ }));
      await user.click(await screen.findByRole('button', { name: /Acme Shop/ }));
      await user.click(screen.getByRole('button', { name: /Next/ }));
      await screen.findByText('Storefront');
      expect(screen.getByRole('checkbox', { name: /Storefront/ })).toHaveAttribute(
        'data-state',
        'checked',
      );
      expect(screen.getByRole('checkbox', { name: /Twenty Twenty-Five/ })).toHaveAttribute(
        'data-state',
        'unchecked',
      );
      await user.click(screen.getByRole('button', { name: /Next/ }));
      expect(((await screen.findByLabelText('Name')) as HTMLInputElement).value).toBe('Acme Shop');
    });
  });
});
