import type { WpItemRef } from '@agentmat/core';
import type { DeployWordPressLinkProjectResult } from '@shared/deployWordPressTypes';
import { act, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useWordPressOperationStore } from '@/stores/wordpressOperationStore';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { LINK_FOLDER_NOTE, LinkWordPressDialog } from './LinkWordPressDialog';
import { deferred, SITE_ITEMS, wpProject, wpSite } from './testing/fixtures';

/**
 * Turning an existing project into a WordPress project: the site, its themes and plugins, the
 * link, and what it says about folders that already held files.
 */

const PLAIN = wpProject({ id: 'p-plain', name: 'Shop code', wordpress: undefined });

interface StartingPoint {
  initialSiteId?: string;
  initialItems?: WpItemRef[];
}

function renderDialog(bridge: Record<string, unknown> = {}, props: StartingPoint = {}) {
  const onLinked = vi.fn();
  const rendered = renderWithProviders(
    <LinkWordPressDialog
      open
      onOpenChange={() => undefined}
      project={PLAIN}
      onLinked={onLinked}
      {...props}
    />,
    {
      route: '/projects/p-plain',
      bridge: {
        'deployWordPress.listSites': [
          wpSite(),
          wpSite({ id: 'site-2', label: 'Blog', siteUrl: 'https://blog.example.com' }),
        ],
        'deployWordPress.listItems': SITE_ITEMS,
        ...bridge,
      },
    },
  );
  return { ...rendered, onLinked };
}

async function toItems(user: ReturnType<typeof renderDialog>['user']): Promise<void> {
  await user.click(await screen.findByRole('button', { name: /Acme Shop/ }));
  await user.click(screen.getByRole('button', { name: /Next/ }));
  await screen.findByText('Storefront');
}

describe('LinkWordPressDialog', () => {
  it('links the project to the picked items and opens its WordPress section', async () => {
    const call = deferred<DeployWordPressLinkProjectResult>();
    const { user, bridge, onLinked } = renderDialog({
      'deployWordPress.linkProject': () => call.promise,
    });
    await toItems(user);
    expect(screen.getByText(LINK_FOLDER_NOTE)).toBeTruthy();
    await user.click(screen.getByRole('checkbox', { name: /WooCommerce/ }));
    await user.click(screen.getByRole('button', { name: /^Link$/ }));

    await waitFor(() => expect(bridge.$fn('deployWordPress.linkProject')).toHaveBeenCalled());
    expect(bridge.$fn('deployWordPress.linkProject').mock.calls[0][0]).toEqual({
      operationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      projectId: 'p-plain',
      siteId: 'site-1',
      items: [
        { kind: 'theme', slug: 'storefront' },
        { kind: 'plugin', slug: 'woocommerce' },
      ],
    });

    await act(async () => call.resolve({ project: wpProject({ id: 'p-plain' }), notPulled: [] }));
    expect(await screen.findByText('Shop code is now a WordPress project')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /Open the WordPress section/ }));
    expect(onLinked).toHaveBeenCalledTimes(1);
  });

  it('says which folders were left alone because they already held files', async () => {
    const { user } = renderDialog({
      'deployWordPress.linkProject': async () => ({
        project: wpProject({ id: 'p-plain' }),
        notPulled: [{ kind: 'theme', slug: 'storefront' }],
      }),
    });
    await toItems(user);
    await user.click(screen.getByRole('button', { name: /^Link$/ }));

    expect(
      await screen.findByText(
        /wp-content\/themes\/storefront already held files, so it was left as it is\. Use Pull latest/,
      ),
    ).toBeTruthy();
  });

  it('explains a failure and goes back to the items', async () => {
    const { user } = renderDialog({
      'deployWordPress.linkProject': async () => {
        throw new Error('[wp:itemUnknown] The site has no wp-content/plugins/woocommerce.');
      },
    });
    await toItems(user);
    await user.click(screen.getByRole('button', { name: /^Link$/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The site has no wp-content/plugins/woocommerce.',
    );
    await user.click(screen.getByRole('button', { name: /^Back$/ }));
    expect(await screen.findByText('Storefront')).toBeTruthy();
  });

  describe('opened for a site from its Deploy page', () => {
    it('opens on the items step for that site with its active theme ticked', async () => {
      const { user, bridge } = renderDialog({}, { initialSiteId: 'site-2' });

      expect(await screen.findByText('Storefront')).toBeTruthy();
      expect(screen.getByText('Which themes and plugins?')).toBeTruthy();
      expect(bridge.$fn('deployWordPress.listItems')).toHaveBeenCalledWith('site-2');
      expect(screen.getByRole('checkbox', { name: /Storefront/ })).toHaveAttribute(
        'data-state',
        'checked',
      );

      await user.click(screen.getByRole('button', { name: /^Link$/ }));
      await waitFor(() => expect(bridge.$fn('deployWordPress.linkProject')).toHaveBeenCalled());
      expect(bridge.$fn('deployWordPress.linkProject').mock.calls[0][0]).toMatchObject({
        siteId: 'site-2',
        items: [{ kind: 'theme', slug: 'storefront' }],
      });
    });

    it('ticks exactly the starting items the site has', async () => {
      const { user } = renderDialog(
        {},
        {
          initialSiteId: 'site-2',
          initialItems: [
            { kind: 'plugin', slug: 'woocommerce' },
            { kind: 'plugin', slug: 'gone-plugin' },
          ],
        },
      );

      expect(await screen.findByRole('checkbox', { name: /WooCommerce/ })).toHaveAttribute(
        'data-state',
        'checked',
      );
      expect(screen.getByRole('checkbox', { name: /Storefront/ })).toHaveAttribute(
        'data-state',
        'unchecked',
      );

      // Back on the site step, the site stays picked and another one gets the usual ticks.
      await user.click(screen.getByRole('button', { name: /^Back$/ }));
      await user.click(await screen.findByRole('button', { name: /Acme Shop/ }));
      await user.click(screen.getByRole('button', { name: /Next/ }));
      expect(await screen.findByRole('checkbox', { name: /Storefront/ })).toHaveAttribute(
        'data-state',
        'checked',
      );
      expect(screen.getByRole('checkbox', { name: /WooCommerce/ })).toHaveAttribute(
        'data-state',
        'unchecked',
      );
    });

    it('still shows a link running for the project instead', async () => {
      useWordPressOperationStore.setState({
        runs: {
          'op-1': {
            operationId: 'op-1',
            kind: 'items',
            siteId: 'site-1',
            projectId: 'p-plain',
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
      renderDialog({}, { initialSiteId: 'site-2' });

      expect(await screen.findByRole('list', { name: 'Progress' })).toBeTruthy();
      expect(screen.getByText('Linking')).toBeTruthy();
      expect(screen.queryByRole('checkbox')).toBeNull();
    });
  });
});
