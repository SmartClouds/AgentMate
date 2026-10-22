import type { Project, WpItemRef } from '@agentmat/core';
import type { DeployWordPressLocalItem } from '@shared/deployWordPressTypes';
import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { SITE_ITEMS, wpProject, wpSite } from '../../projects/wordpress/testing/fixtures';

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
);
vi.mock('sonner', () => ({ toast }));

const { NewItemDialog } = await import('./NewItemDialog');

/**
 * Deploying a theme or plugin the site does not have yet: the folders found in the project that
 * the site lacks, ticked and linked as new, with the review of their first deploy to follow.
 */

const SITE = wpSite();
const UUID = /^[0-9a-f-]{36}$/;
const BAKERY: WpItemRef = { kind: 'theme', slug: 'bakery' };
const OVEN: WpItemRef = { kind: 'plugin', slug: 'oven-timer' };

const LOCAL: DeployWordPressLocalItem[] = [
  { kind: 'theme', slug: 'storefront', isFile: false, linked: true },
  { kind: 'theme', slug: 'twentytwentyfive', isFile: false, linked: false },
  { kind: 'theme', slug: 'bakery', isFile: false, linked: false },
  { kind: 'plugin', slug: 'oven-timer', isFile: false, linked: false },
  { kind: 'plugin', slug: 'solo.php', isFile: true, linked: false },
  { kind: 'plugin', slug: 'agentmate-connector', isFile: false, linked: false },
];

const SHOP = wpProject();
const LOOSE: Project = wpProject({
  id: 'loose',
  name: 'Loose',
  folderPath: 'C:\\code\\loose',
  wordpress: undefined,
});
const ELSEWHERE: Project = wpProject({
  id: 'elsewhere',
  name: 'Elsewhere',
  wordpress: { siteId: 'site-2', items: [{ kind: 'theme', slug: 'x' }], linkedAt: '2026-10-01' },
});

function renderDialog(props: { project?: Project } = {}, bridge: Record<string, unknown> = {}) {
  const onOpenChange = vi.fn();
  const onAdded = vi.fn();
  const view = renderWithProviders(
    <NewItemDialog
      open
      onOpenChange={onOpenChange}
      site={SITE}
      project={props.project}
      onAdded={onAdded}
    />,
    {
      bridge: {
        'projects.list': [SHOP, LOOSE, ELSEWHERE],
        'deployWordPress.listSites': [SITE],
        'deployWordPress.listItems': SITE_ITEMS,
        'deployWordPress.localItems': LOCAL,
        ...bridge,
      },
    },
  );
  return { ...view, onOpenChange, onAdded };
}

describe('NewItemDialog', () => {
  beforeEach(() => {
    toast.success.mockClear();
    toast.error.mockClear();
  });

  it('offers only the folders the site and the project do not have, by kind', async () => {
    const { bridge } = renderDialog({ project: SHOP });
    expect(await screen.findByRole('checkbox', { name: /bakery/ })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: /oven-timer/ })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: /solo\.php/ })).toBeTruthy();
    // Linked already, on the site already, or the connector itself.
    expect(screen.queryByRole('checkbox', { name: /storefront/ })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: /twentytwentyfive/ })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: /agentmate-connector/ })).toBeNull();
    expect(screen.getByText('wp-content/themes/bakery')).toBeTruthy();
    expect(screen.getByText('Single file')).toBeTruthy();
    expect(screen.getByText('Themes')).toBeTruthy();
    expect(screen.getByText('Plugins')).toBeTruthy();
    expect(bridge.$fn('deployWordPress.localItems')).toHaveBeenCalledWith('p1');
    // The project is fixed, so there is no list of projects to pick from.
    expect(screen.queryByRole('radiogroup')).toBeNull();
  });

  it('adds the ticked folders to a linked project as new, then hands them to the review', async () => {
    const updated = {
      ...SHOP,
      wordpress: { ...SHOP.wordpress, items: [...(SHOP.wordpress?.items ?? []), BAKERY, OVEN] },
    } as Project;
    const { user, bridge, onAdded, onOpenChange } = renderDialog(
      { project: SHOP },
      { 'deployWordPress.setProjectItems': updated },
    );
    const oven = await screen.findByRole('checkbox', { name: /oven-timer/ });
    const add = screen.getByRole('button', { name: 'Add and review deploy' }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);

    await user.click(oven);
    await user.click(screen.getByRole('checkbox', { name: /bakery/ }));
    expect(add.disabled).toBe(false);
    await user.click(add);

    await waitFor(() =>
      expect(bridge.$fn('deployWordPress.setProjectItems')).toHaveBeenCalledWith({
        operationId: expect.stringMatching(UUID),
        projectId: 'p1',
        items: [...(SHOP.wordpress?.items ?? []), BAKERY, OVEN],
        newItems: [BAKERY, OVEN],
      }),
    );
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith(updated, [BAKERY, OVEN]));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(toast.success).toHaveBeenCalledWith(
      'Added bakery and oven-timer. Review the deploy next.',
    );
  });

  it('asks which project first when none is fixed, and links a plain project', async () => {
    const linkedProject = {
      ...LOOSE,
      wordpress: { siteId: SITE.id, items: [BAKERY], linkedAt: '2026-10-22' },
    } as Project;
    const { user, bridge, onAdded } = renderDialog(
      {},
      { 'deployWordPress.linkProject': { project: linkedProject, notPulled: [BAKERY] } },
    );
    const choices = await screen.findByRole('radiogroup', { name: 'Projects' });
    // Projects linked to another site can't take it, so they are not offered.
    expect(within(choices).queryByText('Elsewhere')).toBeNull();
    expect(within(choices).getByText('Acme Shop')).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: /bakery/ })).toBeNull();

    await user.click(within(choices).getByRole('radio', { name: /Loose/ }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(await screen.findByRole('checkbox', { name: /bakery/ }));
    expect(bridge.$fn('deployWordPress.localItems')).toHaveBeenCalledWith('loose');
    expect(screen.getByText(/becomes a WordPress project linked to Acme Shop/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Add and review deploy' }));

    await waitFor(() =>
      expect(bridge.$fn('deployWordPress.linkProject')).toHaveBeenCalledWith({
        operationId: expect.stringMatching(UUID),
        projectId: 'loose',
        siteId: 'site-1',
        items: [BAKERY],
        newItems: [BAKERY],
      }),
    );
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith(linkedProject, [BAKERY]));
  });

  it('goes back to the projects from the folders', async () => {
    const { user } = renderDialog();
    await user.click(await screen.findByRole('radio', { name: /Acme Shop/ }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByRole('checkbox', { name: /bakery/ })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByRole('radiogroup', { name: 'Projects' })).toBeTruthy();
  });

  it('explains where to put a new theme or plugin when there is none yet, and looks again', async () => {
    const { user, bridge } = renderDialog(
      { project: SHOP },
      { 'deployWordPress.localItems': [LOCAL[0]] },
    );
    expect(await screen.findByText(/No new themes or plugins/)).toBeTruthy();
    expect(screen.getByText(/wp-content\/themes\/<name>/)).toBeTruthy();
    expect(screen.getByText('C:\\code\\acme-shop')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Add and review deploy' }) as HTMLButtonElement).disabled,
    ).toBe(true);

    bridge.$set('deployWordPress.localItems', LOCAL);
    await user.click(screen.getByRole('button', { name: 'Check again' }));
    expect(await screen.findByRole('checkbox', { name: /bakery/ })).toBeTruthy();
  });

  it('shows why adding failed, and goes back to the ticks', async () => {
    const { user, onAdded } = renderDialog(
      { project: SHOP },
      {
        'deployWordPress.setProjectItems': async () => {
          throw new Error('[wp:badRequest] wp-content/themes/bakery has no files yet.');
        },
      },
    );
    await user.click(await screen.findByRole('checkbox', { name: /bakery/ }));
    await user.click(screen.getByRole('button', { name: 'Add and review deploy' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'wp-content/themes/bakery has no files yet.',
    );
    expect(onAdded).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Back' }));
    const box = await screen.findByRole('checkbox', { name: /bakery/ });
    expect(box.getAttribute('data-state')).toBe('checked');
  });

  it('shows why the folders could not be read', async () => {
    renderDialog(
      { project: SHOP },
      {
        'deployWordPress.localItems': async () => {
          throw new Error('[wp:projectNotLinked] That project no longer exists.');
        },
      },
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('That project no longer exists.');
  });
});
