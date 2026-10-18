import type { Project, WpItemRef } from '@agentmat/core';
import { screen, waitFor, within } from '@testing-library/react';
import { useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { SiteProjectsPanel } from './SiteProjectsPanel';
import { SiteSections, siteSectionFromView } from './SiteSections';
import { SiteView } from './SiteView';
import { wpItem, wpProject, wpSite } from './testing/fixtures';

/**
 * Every project on this computer that works on the site, with the ways to open one, pull into it
 * or unlink it, and to start a new one or link one that is not linked anywhere yet.
 */

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

interface NewProps {
  open: boolean;
  initialSiteId?: string;
}

interface LinkProps {
  open: boolean;
  project: Project;
  onLinked: () => void;
  initialSiteId?: string;
}

interface PullProps {
  open: boolean;
  projectId: string;
  siteId: string;
  items?: WpItemRef[];
}

// The flows have their own tests; here only how they are opened matters.
vi.mock('@/components/projects/wordpress/NewWordPressProjectDialog', () => ({
  NewWordPressProjectDialog: (props: NewProps) =>
    props.open ? <div data-testid="new-project">{JSON.stringify(props)}</div> : null,
}));
vi.mock('@/components/projects/wordpress/LinkWordPressDialog', () => ({
  LinkWordPressDialog: (props: LinkProps) =>
    props.open ? (
      <div data-testid="link-project">
        {JSON.stringify({
          open: props.open,
          projectId: props.project.id,
          initialSiteId: props.initialSiteId,
        })}
        <button type="button" onClick={props.onLinked}>
          Finish linking
        </button>
      </div>
    ) : null,
}));
vi.mock('@/components/wordpress/PullFlowDialog', () => ({
  PullFlowDialog: (props: PullProps) =>
    props.open ? <div data-testid="pull-flow">{JSON.stringify(props)}</div> : null,
}));
// The site page test pulls in the other panels, and with them the editors.
vi.mock('@/components/editor/MonacoEditor', async () => ({
  MonacoEditor: (await import('../sites/testing/monacoMocks')).FakeMonacoEditor,
}));
vi.mock('@/components/editor/MonacoDiffEditor', async () => ({
  MonacoDiffEditor: (await import('../sites/testing/monacoMocks')).FakeMonacoDiffEditor,
}));

const SITE = wpSite();

const ITEMS = [
  wpItem(),
  wpItem({ kind: 'plugin', slug: 'oven', name: 'Oven Tools', active: true }),
];

const BAKERY = wpProject();
const SHOP = wpProject({
  id: 'proj-2',
  name: 'Shop plugins',
  folderPath: 'C:\\Projects\\shop',
  wordpress: {
    siteId: SITE.id,
    items: [
      { kind: 'plugin', slug: 'oven' },
      { kind: 'plugin', slug: 'gone-plugin' },
    ],
    linkedAt: new Date().toISOString(),
  },
});
const ELSEWHERE = wpProject({
  id: 'proj-3',
  name: 'Other site work',
  wordpress: {
    siteId: 'another-site',
    items: [{ kind: 'theme', slug: 'other' }],
    linkedAt: new Date().toISOString(),
  },
});
const NOTES = wpProject({
  id: 'proj-4',
  name: 'Notes',
  folderPath: 'C:\\Projects\\notes',
  wordpress: undefined,
});

const PROJECTS = [BAKERY, SHOP, ELSEWHERE, NOTES];

function LocationProbe(): React.JSX.Element {
  const location = useLocation();
  return <span data-testid="location">{`${location.pathname}${location.search}`}</span>;
}

function renderPanel(bridge: Record<string, unknown> = {}) {
  return renderWithProviders(
    <>
      <LocationProbe />
      <SiteProjectsPanel site={SITE} />
    </>,
    {
      route: '/deploy?site=site-1&view=projects',
      bridge: {
        'projects.list': async () => PROJECTS,
        'deployWordPress.listItems': async () => ITEMS,
        ...bridge,
      },
    },
  );
}

function row(name: string): HTMLElement {
  const list = screen.getByRole('list', { name: 'Projects on this site' });
  return within(list).getByText(name).closest('li') as HTMLElement;
}

describe('SiteProjectsPanel', () => {
  it("lists only this site's projects with the names of what they sync", async () => {
    renderPanel();

    const list = await screen.findByRole('list', { name: 'Projects on this site' });
    expect(within(list).getByText('Bakery theme')).toBeTruthy();
    expect(within(list).getByText('Shop plugins')).toBeTruthy();
    expect(within(list).queryByText('Other site work')).toBeNull();
    expect(within(list).queryByText('Notes')).toBeNull();
    expect(within(row('Bakery theme')).getByText('C:\\Projects\\bakery')).toBeTruthy();

    // Names come from the site once its items load; an item it no longer has is marked.
    expect(await within(row('Bakery theme')).findByText('Crumb Child')).toBeTruthy();
    const shop = row('Shop plugins');
    expect(within(shop).getByText('Oven Tools')).toBeTruthy();
    expect(within(shop).getByText('gone-plugin')).toBeTruthy();
    expect(within(shop).getAllByText(/not on the site/)).toHaveLength(1);

    const heading = screen.getByRole('heading', { name: 'Projects' });
    expect(heading.parentElement?.textContent).toContain('2');
  });

  it('falls back to the slugs while the site items are not there', async () => {
    renderPanel({ 'deployWordPress.listItems': () => new Promise(() => undefined) });

    await screen.findByRole('list', { name: 'Projects on this site' });
    expect(within(row('Bakery theme')).getByText('crumb-child')).toBeTruthy();
    expect(screen.queryByText(/not on the site/)).toBeNull();
  });

  it('shimmers while the projects load', () => {
    const { container } = renderPanel({ 'projects.list': () => new Promise(() => undefined) });

    expect(container.querySelectorAll('[aria-busy="true"] .shimmer').length).toBeGreaterThan(0);
    expect(screen.queryByRole('list', { name: 'Projects on this site' })).toBeNull();
  });

  it('says so when the projects did not load', async () => {
    renderPanel({
      'projects.list': async () => {
        throw new Error('disk is gone');
      },
    });

    expect(await screen.findByText(/Your projects did not load/)).toBeTruthy();
  });

  it('explains an empty site and offers both ways in', async () => {
    renderPanel({ 'projects.list': async () => [ELSEWHERE, NOTES] });

    expect(
      await screen.findByText(
        'No project on this computer works on this site yet. Start a new one from its themes and plugins, or link a project you already have.',
      ),
    ).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'New project' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Link an existing project' })).toHaveLength(1);
  });

  it('opens a new project for this site', async () => {
    const { user } = renderPanel();

    await screen.findByRole('list', { name: 'Projects on this site' });
    await user.click(screen.getByRole('button', { name: 'New project' }));

    const flow = JSON.parse(screen.getByTestId('new-project').textContent ?? '{}') as NewProps;
    expect(flow).toMatchObject({ open: true, initialSiteId: SITE.id });
  });

  it('links a project that is not linked anywhere, then goes to its WordPress tab', async () => {
    const { user } = renderPanel();

    await screen.findByRole('list', { name: 'Projects on this site' });
    await user.click(screen.getByRole('button', { name: 'Link an existing project' }));

    const picker = await screen.findByRole('dialog', { name: 'Link an existing project' });
    const choices = within(picker).getByRole('radiogroup');
    expect(within(choices).getAllByRole('radio')).toHaveLength(1);
    expect(within(choices).getByText('Notes')).toBeTruthy();
    expect(within(choices).queryByText('Bakery theme')).toBeNull();
    expect(within(choices).queryByText('Other site work')).toBeNull();

    const next = within(picker).getByRole('button', { name: /Next/ }) as HTMLButtonElement;
    expect(next.disabled).toBe(true);
    await user.click(within(choices).getByRole('radio', { name: /Notes/ }));
    expect(next.disabled).toBe(false);
    await user.click(next);

    const link = await screen.findByTestId('link-project');
    expect(JSON.parse(link.firstChild?.textContent ?? '{}')).toEqual({
      open: true,
      projectId: 'proj-4',
      initialSiteId: SITE.id,
    });
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Link an existing project' })).toBeNull(),
    );

    await user.click(within(link).getByRole('button', { name: 'Finish linking' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/projects/proj-4?tab=wordpress');
  });

  it('says every project is linked when there is none to pick', async () => {
    const { user } = renderPanel({ 'projects.list': async () => [BAKERY, ELSEWHERE] });

    await screen.findByRole('list', { name: 'Projects on this site' });
    await user.click(screen.getByRole('button', { name: 'Link an existing project' }));

    const picker = await screen.findByRole('dialog', { name: 'Link an existing project' });
    expect(
      within(picker).getByText(
        'Every project is already linked to a site. Make a new one instead.',
      ),
    ).toBeTruthy();
    expect(within(picker).queryByRole('radiogroup')).toBeNull();

    await user.click(within(picker).getByRole('button', { name: 'New project' }));
    expect(screen.getByTestId('new-project')).toBeTruthy();
  });

  it('offers a search in the picker once there are many projects', async () => {
    const many = Array.from({ length: 8 }, (_, index) =>
      wpProject({
        id: `plain-${index}`,
        name: `Plain ${index}`,
        folderPath: `C:\\Projects\\plain-${index}`,
        wordpress: undefined,
      }),
    );
    const { user } = renderPanel({ 'projects.list': async () => [BAKERY, ...many] });

    await screen.findByRole('list', { name: 'Projects on this site' });
    await user.click(screen.getByRole('button', { name: 'Link an existing project' }));

    const picker = await screen.findByRole('dialog', { name: 'Link an existing project' });
    expect(within(picker).getAllByRole('radio')).toHaveLength(8);
    await user.type(within(picker).getByRole('textbox', { name: 'Search projects' }), 'plain 3');
    expect(within(picker).getAllByRole('radio')).toHaveLength(1);
    expect(within(picker).getByText('Plain 3')).toBeTruthy();
  });

  it("opens the pull for the row's project", async () => {
    const { user } = renderPanel();

    await screen.findByRole('list', { name: 'Projects on this site' });
    await user.click(screen.getByRole('button', { name: 'Pull into Shop plugins' }));

    const flow = JSON.parse(screen.getByTestId('pull-flow').textContent ?? '{}') as PullProps;
    expect(flow).toMatchObject({ open: true, projectId: 'proj-2', siteId: SITE.id });
  });

  it('opens the project on its WordPress tab', async () => {
    const { user } = renderPanel();

    await screen.findByRole('list', { name: 'Projects on this site' });
    await user.click(screen.getByRole('button', { name: 'Open Bakery theme' }));

    expect(screen.getByTestId('location')).toHaveTextContent('/projects/proj-1?tab=wordpress');
  });

  it('unlinks from the menu after the confirmation, with a spinner meanwhile', async () => {
    let finish: (project: Project) => void = () => undefined;
    const { user, bridge } = renderPanel({
      'deployWordPress.unlinkProject': () =>
        new Promise<Project>((resolve) => {
          finish = resolve;
        }),
    });

    await screen.findByRole('list', { name: 'Projects on this site' });
    await user.click(screen.getByRole('button', { name: 'More actions for Bakery theme' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Unlink from this site' }));

    expect(confirm.confirmDialog).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Unlink this project from the site?' }),
    );
    await waitFor(() =>
      expect(bridge.$fn('deployWordPress.unlinkProject')).toHaveBeenCalledWith('proj-1'),
    );
    expect(within(row('Bakery theme')).getByRole('status')).toHaveTextContent('Unlinking');
    expect(within(row('Shop plugins')).queryByRole('status')).toBeNull();

    finish({ ...BAKERY, wordpress: undefined } as Project);
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        'Unlinked. It is a regular project again, with every file still in its folder.',
      ),
    );
  });

  it('keeps the project when the confirmation is turned down', async () => {
    confirm.confirmDialog.mockClear();
    confirm.confirmDialog.mockResolvedValueOnce(false);
    const { user, bridge } = renderPanel();

    await screen.findByRole('list', { name: 'Projects on this site' });
    await user.click(screen.getByRole('button', { name: 'More actions for Bakery theme' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Unlink from this site' }));

    await waitFor(() => expect(confirm.confirmDialog).toHaveBeenCalled());
    expect(() => bridge.$fn('deployWordPress.unlinkProject')).toThrow(/has not been touched/);
    expect(within(row('Bakery theme')).queryByRole('status')).toBeNull();
  });
});

describe('the Projects section', () => {
  it('sits in the section strip and is read from the address', async () => {
    const onChange = vi.fn();
    const { user } = renderWithProviders(<SiteSections value="projects" onChange={onChange} />);

    const strip = screen.getByRole('navigation', { name: 'Site sections' });
    const projects = within(strip).getByRole('button', { name: 'Projects' });
    expect(projects.getAttribute('aria-current')).toBe('page');
    await user.click(within(strip).getByRole('button', { name: 'Overview' }));
    expect(onChange).toHaveBeenCalledWith('overview');

    expect(siteSectionFromView('projects')).toBe('projects');
    expect(siteSectionFromView('items')).toBe('items');
    expect(siteSectionFromView('nope')).toBe('overview');
  });

  it('shows the projects panel on the site page', async () => {
    renderWithProviders(
      <SiteView
        site={SITE}
        section="projects"
        onSectionChange={() => undefined}
        onDisconnected={() => undefined}
      />,
      {
        bridge: {
          'projects.list': async () => PROJECTS,
          'deployWordPress.listItems': async () => ITEMS,
        },
      },
    );

    expect(await screen.findByRole('list', { name: 'Projects on this site' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Projects' })).toBeTruthy();
  });
});
