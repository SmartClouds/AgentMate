import type { Project } from '@runova/core';
import { AGENT_TYPE_LABELS } from '@runova/core';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../test/renderer/renderWithProviders';

/**
 * The Projects page from the outside: what the list shows, the create dialog and the folder
 * picker behind it, and the pin/archive controls on a card. Nothing here reaches into the
 * component, it all goes through the same bridge the real preload script provides.
 */

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    message: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
    custom: vi.fn(),
  }),
);
vi.mock('sonner', () => ({ toast, Toaster: () => null }));

const { default: ProjectsPage } = await import('./ProjectsPage');

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'Apollo',
    folderPath: 'C:\\code\\apollo',
    description: 'The control room.',
    tags: ['web'],
    agentType: 'claude-code',
    notes: '',
    runCommands: [{ id: 'r1', label: 'dev', command: 'npm run dev' }],
    prompt: '',
    notifications: {
      completion: { enabled: false, cliId: null, message: '' },
      confirmation: { enabled: false, cliId: null, message: '' },
      pet: { enabled: false, cliId: null, message: '' },
    },
    cliId: null,
    iconDataUrl: null,
    iconFile: null,
    iconBgColor: null,
    iconColor: null,
    websiteUrl: '',
    repoUrl: '',
    githubActionsMuted: [],
    worktreeSetup: { command: '', copyGlobs: null },
    pinned: false,
    archived: false,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-02T00:00:00.000Z',
    ...overrides,
  };
}

/** The dialog's Create button, which doubles as the form's validity readout. */
function createButton(dialog: HTMLElement): HTMLButtonElement {
  return within(dialog).getByRole('button', { name: 'Create project' }) as HTMLButtonElement;
}

describe('ProjectsPage list', () => {
  it('shows the empty state when there are no projects at all', async () => {
    renderWithProviders(<ProjectsPage />);

    expect(await screen.findByText('No projects yet')).toBeTruthy();
    // Both the header and the empty state offer the same way forward.
    expect(screen.getAllByRole('button', { name: /New Project/ }).length).toBeGreaterThan(0);
  });

  it('lists what the bridge returns, with the folder, the agent and the tags', async () => {
    renderWithProviders(<ProjectsPage />, {
      bridge: {
        'projects.list': [
          project(),
          project({ id: 'p2', name: 'Hermes', folderPath: '/srv/hermes', tags: ['api'] }),
        ],
      },
    });

    expect(await screen.findByRole('button', { name: 'Apollo' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Hermes' })).toBeTruthy();
    expect(screen.getByText('2 projects')).toBeTruthy();
    // Only the last path segment is shown, the full path lives in the tooltip.
    expect(screen.getByText('apollo')).toBeTruthy();
    expect(screen.getByText('hermes')).toBeTruthy();
    expect(screen.getAllByText(AGENT_TYPE_LABELS['claude-code']).length).toBe(2);
    expect(screen.getByText('web')).toBeTruthy();
  });

  it('filters as you search and offers a way back out of an empty result', async () => {
    const { user } = renderWithProviders(<ProjectsPage />, {
      bridge: {
        'projects.list': [project(), project({ id: 'p2', name: 'Hermes' })],
      },
    });
    await screen.findByRole('button', { name: 'Apollo' });

    await user.type(screen.getByRole('textbox', { name: 'Search projects' }), 'herm');
    expect(screen.queryByRole('button', { name: 'Apollo' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Hermes' })).toBeTruthy();
    expect(screen.getByText('1 of 2')).toBeTruthy();

    await user.clear(screen.getByRole('textbox', { name: 'Search projects' }));
    await user.type(screen.getByRole('textbox', { name: 'Search projects' }), 'zeus');
    expect(screen.getByText('No matching projects')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(await screen.findByRole('button', { name: 'Apollo' })).toBeTruthy();
  });

  it('opens a project when its name is clicked', async () => {
    // Only `/projects` is routed here, so navigating to the detail route shows up as this page
    // leaving the screen, which is the observable half of the navigation.
    const { user } = renderWithProviders(<ProjectsPage />, {
      route: '/projects',
      path: 'projects',
      bridge: { 'projects.list': [project()] },
    });

    await user.click(await screen.findByRole('button', { name: 'Apollo' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Apollo' })).toBeNull());
  });
});

describe('ProjectsPage pinning and archiving', () => {
  it('pins a project and moves it under the Pinned heading', async () => {
    const pinned = project({ pinned: true });
    const { user, bridge } = renderWithProviders(<ProjectsPage />, {
      bridge: {
        'projects.list': [project(), project({ id: 'p2', name: 'Hermes' })],
        'projects.setPinned': async () => pinned,
      },
    });
    await screen.findByRole('button', { name: 'Apollo' });
    expect(screen.queryByText('Pinned')).toBeNull();

    await user.click(screen.getAllByRole('button', { name: 'Pin to top' })[0]);

    expect(bridge.$fn('projects.setPinned')).toHaveBeenCalledWith('p1', true);
    expect(await screen.findByText('Pinned')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Unpin project' })).toBeTruthy();
  });

  it('archives a project, says so, and hides it behind the Archived toggle', async () => {
    const archived = project({ archived: true });
    const { user, bridge } = renderWithProviders(<ProjectsPage />, {
      bridge: {
        'projects.list': [project(), project({ id: 'p2', name: 'Hermes' })],
        'projects.setArchived': async () => archived,
      },
    });
    await screen.findByRole('button', { name: 'Apollo' });

    await user.click(screen.getAllByRole('button', { name: 'Archive project' })[0]);

    expect(bridge.$fn('projects.setArchived')).toHaveBeenCalledWith('p1', true);
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Archived “Apollo”.'));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Apollo' })).toBeNull());

    // The toggle is the only way back to it, and shows how many are hiding there.
    const toggle = screen.getByRole('button', { name: /Archived/ });
    await user.click(toggle);
    expect(await screen.findByRole('button', { name: 'Apollo' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Restore project' })).toBeTruthy();
  });
});

describe('ProjectsPage create dialog', () => {
  it('refuses to submit until both the name and the folder are filled in', async () => {
    const { user } = renderWithProviders(<ProjectsPage />);
    await screen.findByText('No projects yet');

    await user.click(screen.getAllByRole('button', { name: /New Project/ })[0]);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('New project')).toBeTruthy();
    expect(createButton(dialog).disabled).toBe(true);
    expect(within(dialog).getByText('Name and folder are required')).toBeTruthy();

    // A name on its own is not enough: without a folder there is nothing to work in.
    await user.type(within(dialog).getByLabelText(/^Name/), 'Apollo');
    expect(createButton(dialog).disabled).toBe(true);

    await user.type(within(dialog).getByLabelText(/^Folder/), 'C:\\code\\apollo');
    expect(createButton(dialog).disabled).toBe(false);
    expect(within(dialog).getByText('Ctrl+Enter to save')).toBeTruthy();
  });

  it('opens itself when the page is reached with ?new=1', async () => {
    renderWithProviders(<ProjectsPage />, { route: '/projects?new=1', path: '*' });

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('New project')).toBeTruthy();
  });

  it('fills the folder and the name from the folder picker, then creates the project', async () => {
    const { user, bridge } = renderWithProviders(<ProjectsPage />, {
      bridge: { 'projects.pickFolder': async () => 'C:\\code\\apollo' },
    });
    await screen.findByText('No projects yet');
    await user.click(screen.getAllByRole('button', { name: /New Project/ })[0]);
    const dialog = await screen.findByRole('dialog');

    await user.click(within(dialog).getByRole('button', { name: /Browse/ }));

    expect(bridge.$fn('projects.pickFolder')).toHaveBeenCalled();
    await waitFor(() =>
      expect((within(dialog).getByLabelText(/^Folder/) as HTMLInputElement).value).toBe(
        'C:\\code\\apollo',
      ),
    );
    // An empty name is worth guessing at; the folder's own name is the usual answer.
    expect((within(dialog).getByLabelText(/^Name/) as HTMLInputElement).value).toBe('apollo');

    await user.click(createButton(dialog));

    expect(bridge.$fn('projects.create')).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'apollo',
        folderPath: 'C:\\code\\apollo',
        agentType: 'claude-code',
      }),
    );
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Project created.'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('never overwrites a name that was already typed, and does nothing when the picker is cancelled', async () => {
    const { user } = renderWithProviders(<ProjectsPage />, {
      // An undefined answer is what the bridge gives back when the native dialog is dismissed.
      bridge: { 'projects.pickFolder': async () => undefined },
    });
    await screen.findByText('No projects yet');
    await user.click(screen.getAllByRole('button', { name: /New Project/ })[0]);
    const dialog = await screen.findByRole('dialog');

    await user.type(within(dialog).getByLabelText(/^Name/), 'Mission Control');
    await user.click(within(dialog).getByRole('button', { name: /Browse/ }));

    expect((within(dialog).getByLabelText(/^Name/) as HTMLInputElement).value).toBe(
      'Mission Control',
    );
    expect((within(dialog).getByLabelText(/^Folder/) as HTMLInputElement).value).toBe('');
    expect(createButton(dialog).disabled).toBe(true);
  });

  it('carries the tags typed in the chip field through to the created project', async () => {
    const { user, bridge } = renderWithProviders(<ProjectsPage />, {
      bridge: { 'projects.pickFolder': async () => '/srv/hermes' },
    });
    await screen.findByText('No projects yet');
    await user.click(screen.getAllByRole('button', { name: /New Project/ })[0]);
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /Browse/ }));
    await waitFor(() =>
      expect((within(dialog).getByLabelText(/^Name/) as HTMLInputElement).value).toBe('hermes'),
    );

    const tags = within(dialog).getByLabelText(/^Tags/);
    await user.type(tags, 'api{Enter}');
    expect(within(dialog).getByRole('button', { name: 'Remove api' })).toBeTruthy();
    // A tag still sitting in the box when Create is pressed counts too.
    await user.type(tags, 'infra');
    await user.click(createButton(dialog));

    expect(bridge.$fn('projects.create')).toHaveBeenCalledWith(
      expect.objectContaining({ tags: ['api', 'infra'] }),
    );
  });
});

describe('ProjectsPage when the bridge refuses', () => {
  it('says why an icon could not be read instead of failing silently', async () => {
    const { user } = renderWithProviders(<ProjectsPage />, {
      bridge: {
        'projects.pickIcon': async () => {
          // Electron wraps anything thrown in main; the toast should carry only the message.
          throw new Error(
            "Error invoking remote method 'projects:pickIcon': Error: That file is not an image.",
          );
        },
      },
    });
    await screen.findByText('No projects yet');
    await user.click(screen.getAllByRole('button', { name: /New Project/ })[0]);
    const dialog = await screen.findByRole('dialog');

    await user.click(within(dialog).getByRole('tab', { name: /Appearance/ }));
    await user.click(within(dialog).getByRole('button', { name: /Choose image/ }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('That file is not an image.'));
    // The dialog stays put so the work in it is not lost.
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('keeps the dialog open and usable when creating the project fails', async () => {
    const { user } = renderWithProviders(<ProjectsPage />, {
      bridge: {
        'projects.pickFolder': async () => '/srv/hermes',
        'projects.create': async () => {
          throw new Error('disk is read only');
        },
      },
    });
    await screen.findByText('No projects yet');
    await user.click(screen.getAllByRole('button', { name: /New Project/ })[0]);
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /Browse/ }));
    await waitFor(() =>
      expect((within(dialog).getByLabelText(/^Name/) as HTMLInputElement).value).toBe('hermes'),
    );

    await user.click(createButton(dialog));

    // No success toast, the dialog is still there, and the button is pressable again.
    await waitFor(() => expect(createButton(dialog).disabled).toBe(false));
    expect(toast.success).not.toHaveBeenCalledWith('Project created.');
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('falls back to the empty state when the project list cannot be read', async () => {
    renderWithProviders(<ProjectsPage />, {
      bridge: {
        'projects.list': async () => {
          throw new Error('database locked');
        },
      },
    });

    expect(await screen.findByText('No projects yet')).toBeTruthy();
  });
});

describe('ProjectsPage WordPress projects', () => {
  it('opens the WordPress flow when the page is reached with ?new=wordpress', async () => {
    renderWithProviders(<ProjectsPage />, {
      route: '/projects?new=wordpress',
      path: '*',
      bridge: { 'deployWordPress.listSites': [] },
    });

    expect(
      await screen.findByRole('dialog', { name: 'New project from a WordPress site' }),
    ).toBeTruthy();
    expect(await screen.findByText(/No WordPress sites are connected yet/)).toBeTruthy();
  });

  it('offers an empty project or a WordPress site next to New Project', async () => {
    const { user } = renderWithProviders(<ProjectsPage />, {
      bridge: { 'deployWordPress.listSites': [] },
    });
    await screen.findByText('No projects yet');

    await user.click(screen.getByRole('button', { name: 'More kinds of project' }));
    await user.click(await screen.findByRole('menuitem', { name: /WordPress site/ }));
    expect(
      await screen.findByRole('dialog', { name: 'New project from a WordPress site' }),
    ).toBeTruthy();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    await user.click(screen.getByRole('button', { name: 'More kinds of project' }));
    await user.click(await screen.findByRole('menuitem', { name: /Empty project/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('New project')).toBeTruthy();
  });
});

describe('ProjectsPage GitHub auto-clone', () => {
  it('shows the clone preview when a GitHub link is typed in a new project', async () => {
    const { user } = renderWithProviders(<ProjectsPage />);
    await screen.findByText('No projects yet');
    await user.click(screen.getAllByRole('button', { name: /New Project/ })[0]);
    const dialog = await screen.findByRole('dialog');

    await user.type(within(dialog).getByLabelText(/^Folder/), 'C:\\code\\apollo');
    await user.type(within(dialog).getByLabelText(/Git repository/), 'github.com/me/my-app');

    expect(await within(dialog).findByText(/Will clone into/)).toBeTruthy();
  });

  it('clones into the folder before creating, then lands on the Git tab', async () => {
    const created = project({ id: 'p9', repoUrl: 'https://github.com/me/my-app' });
    const { user, bridge } = renderWithProviders(<ProjectsPage />, {
      route: '/projects',
      path: 'projects',
      bridge: {
        'projects.pickFolder': async () => 'C:\\code\\apollo',
        'git.cloneInto': async () => ({ ok: true, message: 'Cloned.' }),
        'projects.create': async () => created,
      },
    });
    await screen.findByText('No projects yet');
    await user.click(screen.getAllByRole('button', { name: /New Project/ })[0]);
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /Browse/ }));
    await waitFor(() =>
      expect((within(dialog).getByLabelText(/^Name/) as HTMLInputElement).value).toBe('apollo'),
    );
    await user.type(within(dialog).getByLabelText(/Git repository/), 'github.com/me/my-app');
    await user.click(createButton(dialog));

    await waitFor(() =>
      expect(bridge.$fn('git.cloneInto')).toHaveBeenCalledWith({
        folderPath: 'C:\\code\\apollo',
        repoUrl: 'https://github.com/me/my-app',
      }),
    );
    expect(bridge.$fn('projects.create')).toHaveBeenCalledWith(
      expect.objectContaining({ repoUrl: 'https://github.com/me/my-app' }),
    );
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Project created and repository cloned.'),
    );
    // A successful clone lands on the Git tab so Fetch/Pull are one click away.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Apollo' })).toBeNull());
  });

  it('still creates the project when the clone fails, and lands on the Git tab to retry', async () => {
    const created = project({ id: 'p10', name: 'Apollo' });
    const { user, bridge } = renderWithProviders(<ProjectsPage />, {
      route: '/projects',
      path: 'projects',
      bridge: {
        'projects.pickFolder': async () => 'C:\\code\\apollo',
        'git.cloneInto': async () => ({
          ok: false,
          message: 'Folder is not empty. Choose an empty folder to clone into.',
        }),
        'projects.create': async () => created,
      },
    });
    await screen.findByText('No projects yet');
    await user.click(screen.getAllByRole('button', { name: /New Project/ })[0]);
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /Browse/ }));
    await waitFor(() =>
      expect((within(dialog).getByLabelText(/^Folder/) as HTMLInputElement).value).toBe(
        'C:\\code\\apollo',
      ),
    );
    await user.type(within(dialog).getByLabelText(/Git repository/), 'github.com/me/my-app');
    await user.click(createButton(dialog));

    await waitFor(() => expect(bridge.$fn('git.cloneInto')).toHaveBeenCalled());
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'Project created, but the clone failed: Folder is not empty. Choose an empty folder to clone into.',
        { description: 'Use Clone from GitHub on the Git tab to try again.' },
      ),
    );
    expect(bridge.$fn('projects.create')).toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalledWith('Project created.');
    // The retry lives on the Git tab, so a failed clone lands there too.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Apollo' })).toBeNull());
  });
});

/** A box on screen: where an item's top-left corner sits, and how big it is. */
interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

describe('ProjectsPage drag to reorder', () => {
  afterEach(() => {
    // A finished drag swallows the next click for 300 ms. Use that up here, so it cannot eat the
    // first click of whichever test runs after this one.
    window.dispatchEvent(new MouseEvent('click'));
    localStorage.removeItem('runova.projects.view');
    vi.restoreAllMocks();
  });

  /**
   * Jsdom has no layout, so each card or row reads its box from `boxAt`, by the place it sits in
   * the page. The drag works out where everything is from those boxes.
   */
  function mockLayout(boxAt: (index: number) => Box): void {
    const boxOf = (element: HTMLElement): Box => {
      const index = Array.from(element.parentElement?.children ?? []).indexOf(element);
      return index < 0 ? { left: 0, top: 0, width: 0, height: 0 } : boxAt(index);
    };
    vi.spyOn(HTMLElement.prototype, 'offsetLeft', 'get').mockImplementation(function (
      this: HTMLElement,
    ) {
      return boxOf(this).left;
    });
    vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(function (
      this: HTMLElement,
    ) {
      return boxOf(this).top;
    });
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (
      this: HTMLElement,
    ) {
      return boxOf(this).width;
    });
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
      this: HTMLElement,
    ) {
      return boxOf(this).height;
    });
  }

  function itemOf(container: HTMLElement, id: string): HTMLElement {
    const item = container.querySelector<HTMLElement>(`[data-reorder-id="${id}"]`);
    if (!item) throw new Error(`No item for ${id}`);
    return item;
  }

  function gripOf(container: HTMLElement, id: string): HTMLElement {
    const grip = itemOf(container, id).querySelector<HTMLElement>('[data-drag-grip]');
    if (!grip) throw new Error(`${id} has no drag grip`);
    return grip;
  }

  function orderOf(container: HTMLElement): string[] {
    return Array.from(container.querySelectorAll<HTMLElement>('[data-reorder-id]'), (item) =>
      String(item.dataset.reorderId),
    );
  }

  it('moves a row when its grip is dragged, and saves the order it lands in', async () => {
    const projects = [
      project(),
      project({ id: 'p2', name: 'Hermes' }),
      project({ id: 'p3', name: 'Zeus' }),
    ];
    // Rows stack 60px tall, all with the same left edge and width.
    mockLayout((index) => ({ left: 0, top: index * 60, width: 300, height: 60 }));
    const { container, user, bridge } = renderWithProviders(<ProjectsPage />, {
      bridge: {
        'projects.list': projects,
        'projects.reorder': (ids: string[]) => ids.map((id) => projects.find((p) => p.id === id)),
      },
    });
    await user.click(await screen.findByRole('button', { name: 'List view' }));

    const grip = gripOf(container, 'p1');
    fireEvent.pointerDown(grip, { button: 0, clientX: 0, clientY: 0, pointerId: 1 });
    fireEvent.pointerMove(grip, { clientX: 0, clientY: 130, pointerId: 1 });
    fireEvent.pointerUp(grip, { pointerId: 1 });

    await waitFor(() =>
      expect(bridge.$fn('projects.reorder')).toHaveBeenCalledWith(['p2', 'p3', 'p1']),
    );
    expect(orderOf(container)).toEqual(['p2', 'p3', 'p1']);
  });

  it('moves a card across the grid and saves the order it lands in', async () => {
    const projects = [
      project(),
      project({ id: 'p2', name: 'Hermes' }),
      project({ id: 'p3', name: 'Zeus' }),
    ];
    // Two columns of cards, 300px apart across and 200px down. The grid is the default view.
    mockLayout((index) => ({
      left: (index % 2) * 300,
      top: Math.floor(index / 2) * 200,
      width: 280,
      height: 180,
    }));
    const { container, bridge } = renderWithProviders(<ProjectsPage />, {
      bridge: {
        'projects.list': projects,
        'projects.reorder': (ids: string[]) => ids.map((id) => projects.find((p) => p.id === id)),
      },
    });
    await screen.findByRole('button', { name: 'Apollo' });

    const grip = gripOf(container, 'p1');
    fireEvent.pointerDown(grip, { button: 0, clientX: 0, clientY: 0, pointerId: 1 });
    fireEvent.pointerMove(grip, { clientX: 300, clientY: 0, pointerId: 1 });
    // Hermes steps back into the cell Apollo is being held over.
    expect(itemOf(container, 'p2').style.transform).toBe('translate(-300px, 0px)');
    fireEvent.pointerUp(grip, { pointerId: 1 });

    await waitFor(() =>
      expect(bridge.$fn('projects.reorder')).toHaveBeenCalledWith(['p2', 'p1', 'p3']),
    );
    expect(orderOf(container)).toEqual(['p2', 'p1', 'p3']);
  });

  it('keeps a drag inside its pin group, with the pinned projects still saved first', async () => {
    const projects = [
      project({ pinned: true }),
      project({ id: 'p2', name: 'Hermes', pinned: true }),
      project({ id: 'p3', name: 'Zeus' }),
      project({ id: 'p4', name: 'Athena' }),
    ];
    mockLayout((index) => ({
      left: (index % 2) * 300,
      top: Math.floor(index / 2) * 200,
      width: 280,
      height: 180,
    }));
    const { container, bridge } = renderWithProviders(<ProjectsPage />, {
      bridge: {
        'projects.list': projects,
        'projects.reorder': (ids: string[]) => ids.map((id) => projects.find((p) => p.id === id)),
      },
    });
    await screen.findByRole('button', { name: 'Apollo' });

    // Hermes is the second pinned card, so one cell left puts it first in the pinned group.
    const grip = gripOf(container, 'p2');
    fireEvent.pointerDown(grip, { button: 0, clientX: 300, clientY: 0, pointerId: 1 });
    fireEvent.pointerMove(grip, { clientX: 0, clientY: 0, pointerId: 1 });
    fireEvent.pointerUp(grip, { pointerId: 1 });

    await waitFor(() =>
      expect(bridge.$fn('projects.reorder')).toHaveBeenCalledWith(['p2', 'p1', 'p3', 'p4']),
    );
    expect(orderOf(container)).toEqual(['p2', 'p1', 'p3', 'p4']);
  });
});

/** Shows where the page navigated to, since the test router has no other pages. */
function LocationProbe(): React.JSX.Element {
  const location = useLocation();
  return <output aria-label="Location">{location.pathname + location.search}</output>;
}

describe('ProjectsPage Run on a project with no run command', () => {
  function renderEmpty() {
    return renderWithProviders(
      <>
        <ProjectsPage />
        <LocationProbe />
      </>,
      { bridge: { 'projects.list': [project({ runCommands: [] })] } },
    );
  }

  it('opens the project on the AI helper, so Run leads to a run command', async () => {
    const { user } = renderEmpty();
    await screen.findByRole('button', { name: 'Apollo' });

    await user.click(screen.getByRole('button', { name: 'Run' }));

    await waitFor(() =>
      expect(screen.getByRole('status', { name: 'Location' })).toHaveTextContent(
        '/projects/p1?createRun=ai',
      ),
    );
  });

  it('says in the Run tooltip that an AI agent can create one', async () => {
    const { user } = renderEmpty();
    await screen.findByRole('button', { name: 'Apollo' });

    await user.hover(screen.getByRole('button', { name: 'Run' }));

    expect((await screen.findAllByText(/create one with AI/))[0]).toBeTruthy();
  });
});
