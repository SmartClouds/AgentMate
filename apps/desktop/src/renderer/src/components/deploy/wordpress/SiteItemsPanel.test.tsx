import type { Project, WpItem, WpItemRef } from '@agentmat/core';
import type { DeployWordPressSite } from '@shared/deployWordPressTypes';
import { screen, waitFor, within } from '@testing-library/react';
import { useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { wpItem, wpProject, wpSite, wpSiteInfo } from './testing/fixtures';

/**
 * The site's themes and plugins with the projects that hold them, and the way into a pull or a
 * reviewed deploy. Deploy stays off, with the reason on hover, for a read-only key or a site with
 * file changes switched off. From each row an item can also go into a project, a new one, or
 * leave the one it is in.
 */

interface FlowProps {
  open: boolean;
  projectId: string;
  siteId: string;
  items?: WpItemRef[];
}

interface AddProps {
  open: boolean;
  site: DeployWordPressSite;
  item: WpItem;
  mode: 'add' | 'move';
  from?: Project;
  onNewProject: () => void;
}

interface NewProjectProps {
  open: boolean;
  initialSiteId?: string;
  initialItems?: WpItemRef[];
}

interface NewItemProps {
  open: boolean;
  site: DeployWordPressSite;
  project?: Project;
  onOpenChange: (open: boolean) => void;
  onAdded: (project: Project, items: WpItemRef[]) => void;
}

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }),
);
vi.mock('sonner', () => ({ toast, Toaster: () => null }));

// The confirmation modal lives in the app shell, outside this panel.
const confirm = vi.hoisted(() => ({ confirmDialog: vi.fn(async () => true) }));
vi.mock('@/stores/confirmStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/confirmStore')>();
  return { ...actual, confirmDialog: confirm.confirmDialog };
});

// The flow dialogs belong to the Projects workstream; here only how they are opened matters.
vi.mock('@/components/wordpress/DeployFlowDialog', () => ({
  DeployFlowDialog: (props: FlowProps) =>
    props.open ? <div data-testid="deploy-flow">{JSON.stringify(props)}</div> : null,
}));
vi.mock('@/components/wordpress/PullFlowDialog', () => ({
  PullFlowDialog: (props: FlowProps) =>
    props.open ? <div data-testid="pull-flow">{JSON.stringify(props)}</div> : null,
}));
// So do the project dialogs, which have tests of their own.
vi.mock('./AddToProjectDialog', () => ({
  AddToProjectDialog: (props: AddProps) =>
    props.open ? (
      <div data-testid="add-dialog">
        <pre>{JSON.stringify(props)}</pre>
        <button type="button" onClick={props.onNewProject}>
          Mock new project
        </button>
      </div>
    ) : null,
}));
vi.mock('@/components/projects/wordpress/NewWordPressProjectDialog', () => ({
  NewWordPressProjectDialog: (props: NewProjectProps) =>
    props.open ? <div data-testid="new-project">{JSON.stringify(props)}</div> : null,
}));

// And the new theme or plugin dialog, which has its own tests.
const NEW_ITEMS: WpItemRef[] = [{ kind: 'plugin', slug: 'fresh' }];
vi.mock('./NewItemDialog', () => ({
  NewItemDialog: (props: NewItemProps) =>
    props.open ? (
      <div data-testid="new-item">
        <span>{props.site.id}</span>
        <button
          type="button"
          onClick={() => {
            props.onOpenChange(false);
            props.onAdded(wpProject({ id: 'proj-new' }), NEW_ITEMS);
          }}
        >
          Mock added
        </button>
      </div>
    ) : null,
}));

const { SiteItemsPanel } = await import('./SiteItemsPanel');

const ITEMS = [
  wpItem(),
  wpItem({ kind: 'theme', slug: 'crumb', name: 'Crumb', active: false, parentTheme: undefined }),
  wpItem({ kind: 'plugin', slug: 'oven', name: 'Oven <b>Tools</b>', active: true }),
  wpItem({
    kind: 'plugin',
    slug: 'agentmate-connector',
    name: 'AgentMate Connector',
    protected: true,
    writable: false,
  }),
  wpItem({ kind: 'mu-plugin', slug: 'cache.php', name: 'cache.php', isFile: true, active: true }),
];

const CHILD: WpItemRef = { kind: 'theme', slug: 'crumb-child' };
const OVEN: WpItemRef = { kind: 'plugin', slug: 'oven' };

/** Bakery theme syncing both Crumb Child and Oven, so neither is its last item. */
function twoItemProject(): Project {
  return wpProject({
    wordpress: { siteId: wpSite().id, items: [CHILD, OVEN], linkedAt: '2026-10-01T00:00:00Z' },
  });
}

function WithLocation({ site }: { site: DeployWordPressSite }): React.JSX.Element {
  const location = useLocation();
  return (
    <>
      <span data-testid="location">{`${location.pathname}${location.search}`}</span>
      <SiteItemsPanel site={site} />
    </>
  );
}

function renderPanel(bridge: Record<string, unknown> = {}, site = wpSite()) {
  return renderWithProviders(<WithLocation site={site} />, {
    route: '/deploy/wordpress',
    bridge: {
      'deployWordPress.listItems': async () => ITEMS,
      'deployWordPress.siteInfo': async () => wpSiteInfo(),
      'projects.list': async () => [
        wpProject(),
        wpProject({ id: 'proj-2', name: 'Unrelated', wordpress: undefined }),
      ],
      ...bridge,
    },
  });
}

function shown<T>(testId: string): T {
  return JSON.parse(screen.getByTestId(testId).textContent ?? '{}') as T;
}

function addProps(): AddProps {
  return JSON.parse(
    within(screen.getByTestId('add-dialog')).getByText(/^\{/).textContent ?? '{}',
  ) as AddProps;
}

async function openMenu(user: ReturnType<typeof renderPanel>['user'], name: string) {
  await user.click(await screen.findByRole('button', { name }));
}

describe('SiteItemsPanel', () => {
  it('shimmers in each group while the items load', () => {
    const { container } = renderPanel({
      'deployWordPress.listItems': () => new Promise(() => undefined),
    });

    expect(container.querySelectorAll('[aria-busy="true"] .shimmer').length).toBeGreaterThan(0);
    expect(container.querySelectorAll('[aria-busy="true"]').length).toBe(3);
  });

  it('groups items by kind with active state, version and linked projects', async () => {
    renderPanel();

    const themes = await screen.findByRole('list', { name: 'Themes' });
    expect(within(themes).getByText('Crumb Child')).toBeTruthy();
    expect(within(themes).getAllByText('Active')).toHaveLength(1);
    expect(within(themes).getAllByText(/version 1\.2\.0/).length).toBeGreaterThan(0);
    expect(within(themes).getByRole('list', { name: 'Projects with Crumb Child' })).toBeTruthy();
    expect(within(themes).getByText('Bakery theme')).toBeTruthy();
    expect(within(themes).queryByText('Unrelated')).toBeNull();
    expect(within(themes).getAllByText('Not in a project yet.')).toHaveLength(1);

    // Site strings are text, never markup.
    const plugins = screen.getByRole('list', { name: 'Plugins' });
    expect(within(plugins).getByText('Oven <b>Tools</b>')).toBeTruthy();
    expect(within(plugins).getByText(/the AgentMate Connector itself/)).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Must-use plugins' })).toBeTruthy();
  });

  it('opens the deploy review for the linked project and that item', async () => {
    const { user } = renderPanel();

    await user.click(
      await screen.findByRole('button', {
        name: 'Review and deploy Crumb Child from Bakery theme',
      }),
    );

    expect(shown<FlowProps>('deploy-flow')).toMatchObject({
      open: true,
      projectId: 'proj-1',
      siteId: wpSite().id,
      items: [{ kind: 'theme', slug: 'crumb-child' }],
    });
  });

  it('opens the pull for the linked project and that item', async () => {
    const { user } = renderPanel();

    await user.click(
      await screen.findByRole('button', { name: 'Pull Crumb Child into Bakery theme' }),
    );

    expect(shown<FlowProps>('pull-flow')).toMatchObject({
      projectId: 'proj-1',
      items: [{ kind: 'theme', slug: 'crumb-child' }],
    });
  });

  it('keeps deploy off for a read-only key, says why, and still allows a pull', async () => {
    const { user } = renderPanel({}, wpSite({ scope: 'read' }));

    const deploy = (await screen.findByRole('button', {
      name: 'Review and deploy Crumb Child from Bakery theme',
    })) as HTMLButtonElement;
    expect(deploy.disabled).toBe(true);
    expect(
      screen.getAllByText('Read-only key. You can pull files from this site but not deploy to it.')
        .length,
    ).toBeGreaterThan(0);
    await user.hover(deploy.parentElement as HTMLElement);
    expect(
      await screen.findByRole('tooltip', {
        name: 'Read-only key. You can pull files from this site but not deploy to it.',
      }),
    ).toBeTruthy();
    const pull = screen.getByRole('button', { name: 'Pull Crumb Child into Bakery theme' });
    expect((pull as HTMLButtonElement).disabled).toBe(false);
  });

  it('keeps deploy off when the site switched file changes off', async () => {
    renderPanel({ 'deployWordPress.siteInfo': async () => wpSiteInfo({ fileModsDisabled: true }) });

    const deploy = (await screen.findByRole('button', {
      name: 'Review and deploy Crumb Child from Bakery theme',
    })) as HTMLButtonElement;
    await screen.findAllByText(/DISALLOW_FILE_MODS is set/);
    expect(deploy.disabled).toBe(true);
  });

  describe('a theme or plugin the site does not have yet', () => {
    it('opens the new item dialog for this site', async () => {
      const { user } = renderPanel();
      await user.click(await screen.findByRole('button', { name: 'New theme or plugin' }));
      expect(within(screen.getByTestId('new-item')).getByText(wpSite().id)).toBeTruthy();
    });

    it('goes on to the deploy review of the items it added, in the project they went into', async () => {
      const { user } = renderPanel();
      await user.click(await screen.findByRole('button', { name: 'New theme or plugin' }));
      await user.click(screen.getByRole('button', { name: 'Mock added' }));
      expect(shown<FlowProps>('deploy-flow')).toMatchObject({
        open: true,
        projectId: 'proj-new',
        siteId: wpSite().id,
        items: NEW_ITEMS,
      });
    });

    it('keeps it off for a read-only key, and says why on hover', async () => {
      const { user } = renderPanel({}, wpSite({ scope: 'read' }));
      const button = (await screen.findByRole('button', {
        name: 'New theme or plugin',
      })) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      await user.hover(button.parentElement as HTMLElement);
      expect(
        await screen.findByRole('tooltip', {
          name: 'Read-only key. You can pull files from this site but not deploy to it.',
        }),
      ).toBeTruthy();
    });
  });

  it('says why the items did not load', async () => {
    renderPanel({
      'deployWordPress.listItems': async () => {
        throw new Error('[wp:timeout] slow');
      },
    });

    expect(await screen.findByText(/took too long to answer/)).toBeTruthy();
  });

  describe('an item in no project', () => {
    it('no longer sends the user off to the Projects page', async () => {
      renderPanel();

      await screen.findByRole('list', { name: 'Themes' });
      expect(screen.queryByRole('button', { name: /Make a WordPress project/ })).toBeNull();
    });

    it('adds it to a project through the add dialog, with this site and item', async () => {
      const { user } = renderPanel();

      const themes = await screen.findByRole('list', { name: 'Themes' });
      await user.click(within(themes).getByRole('button', { name: 'Add to a project' }));

      expect(addProps()).toMatchObject({
        open: true,
        mode: 'add',
        site: { id: wpSite().id },
        item: { kind: 'theme', slug: 'crumb', name: 'Crumb' },
      });
      expect(addProps().from).toBeUndefined();
    });

    it('opens the new project wizard in place with the site and item ticked', async () => {
      const { user } = renderPanel();

      const plugins = await screen.findByRole('list', { name: 'Plugins' });
      const button = within(plugins).getByRole('button', {
        name: 'New project with Oven <b>Tools</b>',
      });
      await user.hover(button);
      expect(
        await screen.findByRole('tooltip', { name: 'New project with this plugin' }),
      ).toBeTruthy();
      await user.click(button);

      expect(shown<NewProjectProps>('new-project')).toEqual({
        open: true,
        initialSiteId: wpSite().id,
        initialItems: [OVEN],
      });
      expect(screen.getByTestId('location')).toHaveTextContent('/deploy/wordpress');
    });

    it('goes on to the new project wizard when the add dialog asks for one', async () => {
      const { user } = renderPanel();

      const themes = await screen.findByRole('list', { name: 'Themes' });
      await user.click(within(themes).getByRole('button', { name: 'Add to a project' }));
      await user.click(screen.getByRole('button', { name: 'Mock new project' }));

      expect(screen.queryByTestId('add-dialog')).toBeNull();
      expect(shown<NewProjectProps>('new-project')).toMatchObject({
        initialSiteId: wpSite().id,
        initialItems: [{ kind: 'theme', slug: 'crumb' }],
      });
    });

    it('offers no "Add to another project" until it is in one', async () => {
      renderPanel();

      const themes = await screen.findByRole('list', { name: 'Themes' });
      // Only Crumb Child is in a project.
      expect(
        within(themes).getAllByRole('button', { name: 'Add to another project' }),
      ).toHaveLength(1);
      const plugins = screen.getByRole('list', { name: 'Plugins' });
      expect(within(plugins).queryByRole('button', { name: 'Add to another project' })).toBeNull();
    });
  });

  describe('an item in a project', () => {
    const MORE = 'More for Crumb Child in Bakery theme';

    it('adds it to another project as well', async () => {
      const { user } = renderPanel();

      await user.click(await screen.findByRole('button', { name: 'Add to another project' }));

      expect(addProps()).toMatchObject({
        mode: 'add',
        item: { kind: 'theme', slug: 'crumb-child' },
      });
    });

    it('offers open, move and remove when the project syncs other items too', async () => {
      const { user } = renderPanel({ 'projects.list': [twoItemProject()] });

      await openMenu(user, MORE);

      expect(await screen.findByRole('menuitem', { name: 'Open project' })).toBeTruthy();
      expect(screen.getByRole('menuitem', { name: 'Move to another project…' })).toBeTruthy();
      expect(screen.getByRole('menuitem', { name: 'Remove from this project' })).toBeTruthy();
      expect(screen.queryByRole('menuitem', { name: /Unlink/ })).toBeNull();
    });

    it('offers to unlink instead when it is the last item', async () => {
      const { user } = renderPanel();

      await openMenu(user, MORE);

      expect(
        await screen.findByRole('menuitem', { name: 'Unlink Bakery theme from this site' }),
      ).toBeTruthy();
      expect(screen.queryByRole('menuitem', { name: 'Remove from this project' })).toBeNull();
    });

    it('keeps the project menu on a read-only site', async () => {
      const { user } = renderPanel({}, wpSite({ scope: 'read' }));

      const trigger = await screen.findByRole('button', { name: MORE });
      expect(trigger).toBeEnabled();
      await user.click(trigger);
      expect(await screen.findByRole('menuitem', { name: 'Open project' })).toBeTruthy();
    });

    it('opens the project on its WordPress tab', async () => {
      const { user } = renderPanel();

      await openMenu(user, MORE);
      await user.click(await screen.findByRole('menuitem', { name: 'Open project' }));

      expect(screen.getByTestId('location')).toHaveTextContent('/projects/proj-1?tab=wordpress');
    });

    it('moves it through the dialog, from this project', async () => {
      const { user } = renderPanel();

      await openMenu(user, MORE);
      await user.click(await screen.findByRole('menuitem', { name: 'Move to another project…' }));

      expect(addProps()).toMatchObject({
        open: true,
        mode: 'move',
        item: { slug: 'crumb-child' },
        from: { id: 'proj-1', name: 'Bakery theme' },
      });
    });

    it('stops syncing it after asking, keeping the rest of the project', async () => {
      const { user, bridge } = renderPanel({
        'projects.list': [twoItemProject()],
        'deployWordPress.setProjectItems': wpProject({
          wordpress: { siteId: wpSite().id, items: [OVEN], linkedAt: '2026-10-01T00:00:00Z' },
        }),
      });

      await openMenu(user, MORE);
      await user.click(await screen.findByRole('menuitem', { name: 'Remove from this project' }));

      expect(confirm.confirmDialog).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Stop syncing crumb-child in Bakery theme?',
          description:
            "Its files stay in wp-content/themes/crumb-child, but they won't be pulled or deployed any more.",
          confirmLabel: 'Stop syncing',
        }),
      );
      await waitFor(() =>
        expect(bridge.$fn('deployWordPress.setProjectItems')).toHaveBeenCalledWith(
          expect.objectContaining({ projectId: 'proj-1', items: [OVEN] }),
        ),
      );
      await waitFor(() =>
        expect(toast.success).toHaveBeenCalledWith(
          'Crumb Child is no longer synced in Bakery theme.',
        ),
      );
    });

    it('says what went wrong when the remove fails', async () => {
      const { user } = renderPanel({
        'projects.list': [twoItemProject()],
        'deployWordPress.setProjectItems': async () => {
          throw new Error('The project folder is gone.');
        },
      });

      await openMenu(user, MORE);
      await user.click(await screen.findByRole('menuitem', { name: 'Remove from this project' }));

      await waitFor(() => expect(toast.error).toHaveBeenCalled());
      expect(toast.success).not.toHaveBeenCalled();
    });

    it('leaves the project alone when the remove is cancelled', async () => {
      confirm.confirmDialog.mockResolvedValueOnce(false);
      const { user, bridge } = renderPanel({
        'projects.list': [twoItemProject()],
        'deployWordPress.setProjectItems': twoItemProject(),
      });

      await openMenu(user, MORE);
      await user.click(await screen.findByRole('menuitem', { name: 'Remove from this project' }));

      await waitFor(() => expect(confirm.confirmDialog).toHaveBeenCalled());
      // Never reached the bridge at all.
      expect(() => bridge.$fn('deployWordPress.setProjectItems')).toThrow();
      expect(toast.success).not.toHaveBeenCalled();
    });

    it('unlinks the project when it is the last item, and spins meanwhile', async () => {
      let finish: (project: Project) => void = () => undefined;
      const { user, bridge } = renderPanel({
        'deployWordPress.unlinkProject': () =>
          new Promise<Project>((resolve) => {
            finish = resolve;
          }),
      });

      await openMenu(user, MORE);
      await user.click(
        await screen.findByRole('menuitem', { name: 'Unlink Bakery theme from this site' }),
      );

      expect(confirm.confirmDialog).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Unlink this project from the site?' }),
      );
      await waitFor(() =>
        expect(bridge.$fn('deployWordPress.unlinkProject')).toHaveBeenCalledWith('proj-1'),
      );
      await waitFor(() => expect(screen.getByRole('button', { name: MORE })).toBeDisabled());

      finish(wpProject({ wordpress: undefined }));
      await waitFor(() => expect(toast.success).toHaveBeenCalled());
    });
  });
});
