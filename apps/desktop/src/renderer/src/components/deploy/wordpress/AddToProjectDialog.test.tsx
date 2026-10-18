import type { Project, WpItemRef } from '@agentmat/core';
import { screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  useWordPressOperationStore,
  type WordPressOperationRun,
} from '@/stores/wordpressOperationStore';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { projectChoicesFor } from './itemProjects';
import { wpItem, wpProject, wpSite } from './testing/fixtures';

/**
 * Putting one of a site's themes or plugins into a project from the Deploy side, or moving it
 * from the project that holds it to another one. A move adds first, so a failed add leaves the
 * old project alone.
 */

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
);
vi.mock('sonner', () => ({ toast }));

const { AddToProjectDialog, ProjectChoiceList } = await import('./AddToProjectDialog');

const SITE = wpSite();
const OTHER_SITE = wpSite({ id: 'site-2', label: 'Blog', siteUrl: 'https://blog.example' });
const ITEM = wpItem();
const THEME: WpItemRef = { kind: 'theme', slug: 'crumb-child' };
const PLUGIN: WpItemRef = { kind: 'plugin', slug: 'oven-timer' };
const UUID = /^[0-9a-f-]{36}$/;

function linked(id: string, name: string, items: WpItemRef[], siteId = SITE.id): Project {
  return wpProject({
    id,
    name,
    folderPath: `C:\\Projects\\${id}`,
    wordpress: { siteId, items, linkedAt: '2026-10-01T00:00:00Z' },
  });
}

function plain(id: string, name: string, folderPath = `C:\\Projects\\${id}`): Project {
  return wpProject({ id, name, folderPath, wordpress: undefined });
}

const SHOP = linked('shop', 'Bakery shop', [PLUGIN]);
const LOOSE = plain('loose', 'Loose');
const ELSEWHERE = linked('elsewhere', 'Elsewhere', [PLUGIN], OTHER_SITE.id);

interface DialogProps {
  mode?: 'add' | 'move';
  from?: Project;
  onNewProject?: () => void;
  onOpenChange?: (open: boolean) => void;
}

function renderDialog(
  projects: Project[],
  bridge: Record<string, unknown> = {},
  props: DialogProps = {},
) {
  const onOpenChange = props.onOpenChange ?? vi.fn();
  const onNewProject = props.onNewProject ?? vi.fn();
  const view = renderWithProviders(
    <AddToProjectDialog
      open
      onOpenChange={onOpenChange}
      site={SITE}
      item={ITEM}
      mode={props.mode ?? 'add'}
      from={props.from}
      onNewProject={onNewProject}
    />,
    {
      bridge: {
        'projects.list': projects,
        'deployWordPress.listSites': [SITE, OTHER_SITE],
        'deployWordPress.localChanges': {
          projectId: props.from?.id ?? '',
          added: 0,
          modified: 0,
          deleted: 0,
          checkedAt: Date.now(),
        },
        ...bridge,
      },
    },
  );
  return { ...view, onOpenChange, onNewProject };
}

function runningRun(overrides: Partial<WordPressOperationRun> = {}): WordPressOperationRun {
  return {
    operationId: 'op-elsewhere',
    kind: 'pull',
    siteId: SITE.id,
    projectId: 'shop',
    phases: [],
    progress: {},
    latest: null,
    status: 'running',
    cancelling: false,
    error: null,
    errorCode: null,
    result: null,
    owned: false,
    startedAt: Date.now(),
    finishedAt: null,
    ...overrides,
  };
}

describe('ProjectChoiceList', () => {
  it('shows a shimmer while the projects load, not the list', () => {
    renderWithProviders(
      <ProjectChoiceList
        choices={{ siteProjects: [], unlinked: [], otherSite: [], holding: [] }}
        selectedId={null}
        onSelect={() => undefined}
        loading
      />,
    );
    expect(screen.getByRole('status', { name: 'Loading projects' })).toBeTruthy();
    expect(screen.queryByRole('radio')).toBeNull();
  });

  it('shows only the groups asked for', () => {
    const choices = projectChoicesFor([SHOP, LOOSE, ELSEWHERE], SITE.id, THEME);
    renderWithProviders(
      <ProjectChoiceList
        choices={choices}
        selectedId={null}
        onSelect={() => undefined}
        loading={false}
        show={['unlinked']}
      />,
    );
    expect(screen.getByRole('radio', { name: /Loose/ })).toBeTruthy();
    expect(screen.queryByRole('radio', { name: /Bakery shop/ })).toBeNull();
    expect(screen.queryByRole('radio', { name: /Elsewhere/ })).toBeNull();
    expect(screen.queryByText('Projects on this site')).toBeNull();
  });

  it('moves the choice with the arrow keys, skipping projects it cannot pick', async () => {
    const choices = projectChoicesFor(
      [SHOP, ELSEWHERE, plain('aa', 'Apple'), LOOSE],
      SITE.id,
      THEME,
    );
    const onSelect = vi.fn();
    const { user } = renderWithProviders(
      <ProjectChoiceList choices={choices} selectedId="shop" onSelect={onSelect} loading={false} />,
    );
    screen.getByRole('radio', { name: /Bakery shop/ }).focus();
    await user.keyboard('{ArrowDown}');
    expect(onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'aa' }));
    expect(screen.getByRole('radio', { name: /Apple/ })).toHaveFocus();
  });
});

describe('AddToProjectDialog', () => {
  it('sorts the projects into the three groups and leaves out the one that holds the item', async () => {
    const holder = linked('holder', 'Bakery theme', [THEME]);
    renderDialog([SHOP, LOOSE, ELSEWHERE, holder]);

    expect(
      await screen.findByRole('dialog', { name: 'Add Crumb Child to a project' }),
    ).toBeTruthy();
    expect(screen.getByText("It's pulled from the site into the project's folder.")).toBeTruthy();
    await screen.findByRole('radio', { name: /Bakery shop/ });
    expect(screen.getByText('Projects on this site')).toBeTruthy();
    expect(screen.getByText('Other projects')).toBeTruthy();
    expect(screen.getByText('Gets linked to this site')).toBeTruthy();
    expect(screen.getByText('Linked to another site')).toBeTruthy();

    const shop = screen.getByRole('radio', { name: /Bakery shop/ });
    expect(within(shop).getByText('C:\\Projects\\shop')).toBeTruthy();
    expect(within(shop).getByText('1 theme or plugin')).toBeTruthy();
    expect(screen.getByRole('radio', { name: /Loose/ })).toBeTruthy();
    expect(screen.queryByRole('radio', { name: /Bakery theme/ })).toBeNull();
  });

  it("can't pick a project linked to another site, and says why in the row", async () => {
    const { user } = renderDialog([SHOP, ELSEWHERE]);

    const row = await screen.findByRole('radio', { name: /Elsewhere/ });
    expect(row).toHaveAttribute('aria-disabled', 'true');
    expect(within(row).getByText('Linked to Blog')).toBeTruthy();

    await user.click(row);
    expect(row).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('button', { name: /Add and pull/ })).toBeDisabled();
  });

  it('names the other site generically when it is not connected here', async () => {
    renderDialog([linked('gone', 'Orphan', [PLUGIN], 'site-gone')]);
    const row = await screen.findByRole('radio', { name: /Orphan/ });
    expect(within(row).getByText('Linked to another site')).toBeTruthy();
  });

  it("adds the item to a project on the site, keeping that project's items", async () => {
    const { user, bridge, onOpenChange } = renderDialog([SHOP, LOOSE], {
      'deployWordPress.setProjectItems': linked('shop', 'Bakery shop', [PLUGIN, THEME]),
    });

    const add = await screen.findByRole('button', { name: /Add and pull/ });
    expect(add).toBeDisabled();
    await user.click(await screen.findByRole('radio', { name: /Bakery shop/ }));
    expect(screen.getByRole('radio', { name: /Bakery shop/ })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await user.click(add);

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Added Crumb Child to Bakery shop.'),
    );
    expect(bridge.$fn('deployWordPress.setProjectItems')).toHaveBeenCalledWith({
      operationId: expect.stringMatching(UUID),
      projectId: 'shop',
      items: [PLUGIN, THEME],
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('links a plain project with just the item, and says so before and after', async () => {
    const { user, bridge } = renderDialog([SHOP, LOOSE], {
      'deployWordPress.linkProject': {
        project: linked('loose', 'Loose', [THEME]),
        notPulled: [THEME],
      },
    });

    await user.click(await screen.findByRole('radio', { name: /Loose/ }));
    expect(screen.getByText('Loose becomes a WordPress project linked to Bakery.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /Add and pull/ }));

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        'Added Crumb Child to Loose. Its folder already had files, so they were kept as they are. Pull to compare them with the site.',
      ),
    );
    expect(bridge.$fn('deployWordPress.linkProject')).toHaveBeenCalledWith({
      operationId: expect.stringMatching(UUID),
      projectId: 'loose',
      siteId: SITE.id,
      items: [THEME],
    });
  });

  it('moves by adding to the new project before taking it out of the old one', async () => {
    const from = linked('from', 'Bakery theme', [THEME, PLUGIN]);
    const { user, bridge } = renderDialog(
      [from, SHOP, LOOSE],
      {
        'deployWordPress.setProjectItems': async (input: { projectId: string }) =>
          input.projectId === 'shop'
            ? linked('shop', 'Bakery shop', [PLUGIN, THEME])
            : linked('from', 'Bakery theme', [PLUGIN]),
      },
      { mode: 'move', from },
    );

    expect(
      await screen.findByRole('dialog', { name: 'Move Crumb Child to another project' }),
    ).toBeTruthy();
    expect(screen.queryByRole('radio', { name: /Bakery theme/ })).toBeNull();
    await user.click(await screen.findByRole('radio', { name: /Bakery shop/ }));
    expect(
      screen.getByText(
        "Bakery shop gets the site's copy. Bakery theme stops syncing it, and its files stay in Bakery theme's folder.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/gets unlinked from this site/)).toBeNull();
    await user.click(screen.getByRole('button', { name: /^Move$/ }));

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Moved Crumb Child to Bakery shop.'),
    );
    const calls = bridge.$fn('deployWordPress.setProjectItems').mock.calls;
    expect(calls.map(([input]) => [input.projectId, input.items])).toEqual([
      ['shop', [PLUGIN, THEME]],
      ['from', [PLUGIN]],
    ]);
  });

  it('unlinks the old project when the item was its last one, and warns first', async () => {
    const from = linked('from', 'Bakery theme', [THEME]);
    const { user, bridge } = renderDialog(
      [from, LOOSE],
      {
        'deployWordPress.linkProject': {
          project: linked('loose', 'Loose', [THEME]),
          notPulled: [],
        },
        'deployWordPress.unlinkProject': plain('from', 'Bakery theme'),
      },
      { mode: 'move', from },
    );

    expect(
      await screen.findByText(
        'Bakery theme has no other themes or plugins, so it gets unlinked from this site. Its files stay.',
      ),
    ).toBeTruthy();
    await user.click(await screen.findByRole('radio', { name: /Loose/ }));
    await user.click(screen.getByRole('button', { name: /^Move$/ }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Moved Crumb Child to Loose.'));
    const link = bridge.$fn('deployWordPress.linkProject');
    const unlink = bridge.$fn('deployWordPress.unlinkProject');
    expect(unlink).toHaveBeenCalledWith('from');
    expect(link.mock.invocationCallOrder[0]).toBeLessThan(unlink.mock.invocationCallOrder[0]);
  });

  it("warns about undeployed changes, counting them when the item is the project's only one", async () => {
    const from = linked('from', 'Bakery theme', [THEME]);
    const { user, bridge } = renderDialog(
      [from, LOOSE],
      {
        'deployWordPress.localChanges': {
          projectId: 'from',
          added: 2,
          modified: 1,
          deleted: 0,
          checkedAt: Date.now(),
        },
      },
      { mode: 'move', from },
    );

    expect(
      await screen.findByText(
        "Bakery theme has 3 changed files that aren't deployed. They stay in Bakery theme's folder, and the other project gets the site's copy.",
      ),
    ).toBeTruthy();
    expect(bridge.$fn('deployWordPress.localChanges')).toHaveBeenCalledWith('from');

    await user.click(await screen.findByRole('radio', { name: /Loose/ }));
    expect(
      screen.getByText(
        "Bakery theme has 3 changed files that aren't deployed. They stay in Bakery theme's folder, and Loose gets the site's copy.",
      ),
    ).toBeTruthy();
  });

  it('warns about undeployed changes in the item folder when the project keeps others', async () => {
    const from = linked('from', 'Bakery theme', [THEME, PLUGIN]);
    renderDialog(
      [from, LOOSE],
      {
        'deployWordPress.localChanges': {
          projectId: 'from',
          added: 0,
          modified: 0,
          deleted: 1,
          checkedAt: Date.now(),
        },
      },
      { mode: 'move', from },
    );

    expect(
      await screen.findByText(
        "Bakery theme has changes that aren't deployed. Anything changed in wp-content/themes/crumb-child stays in Bakery theme's folder, and the other project gets the site's copy.",
      ),
    ).toBeTruthy();
  });

  it('says nothing about changes when the old project has none', async () => {
    const from = linked('from', 'Bakery theme', [THEME, PLUGIN]);
    const { bridge } = renderDialog(
      [from, LOOSE],
      {
        'deployWordPress.localChanges': {
          projectId: 'from',
          added: 0,
          modified: 0,
          deleted: 0,
          checkedAt: Date.now(),
        },
      },
      { mode: 'move', from },
    );
    await screen.findByRole('radio', { name: /Loose/ });
    await waitFor(() => expect(bridge.$fn('deployWordPress.localChanges')).toHaveBeenCalled());
    expect(screen.queryByText(/aren't deployed/)).toBeNull();
  });

  it('shows why a failed add failed, never takes the item out, and goes back to the list', async () => {
    const from = linked('from', 'Bakery theme', [THEME]);
    const { user, bridge, onOpenChange } = renderDialog(
      [from, LOOSE],
      {
        'deployWordPress.linkProject': async () => {
          throw new Error('[wp:operationBusy] A pull from this site is still running.');
        },
      },
      { mode: 'move', from },
    );

    await user.click(await screen.findByRole('radio', { name: /Loose/ }));
    await user.click(screen.getByRole('button', { name: /^Move$/ }));

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('A pull from this site is still running.')).toBeTruthy();
    expect(() => bridge.$fn('deployWordPress.unlinkProject')).toThrow();
    expect(() => bridge.$fn('deployWordPress.setProjectItems')).toThrow();
    expect(toast.success).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);

    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(await screen.findByRole('radio', { name: /Loose/ })).toBeTruthy();
    expect(useWordPressOperationStore.getState().runs).toEqual({});
  });

  it('says the item is in both projects when the move only got halfway, and offers Close', async () => {
    const from = linked('from', 'Bakery theme', [THEME]);
    const { user, onOpenChange } = renderDialog(
      [from, LOOSE],
      {
        'deployWordPress.linkProject': {
          project: linked('loose', 'Loose', [THEME]),
          notPulled: [],
        },
        'deployWordPress.unlinkProject': async () => {
          throw new Error('The project folder is gone.');
        },
      },
      { mode: 'move', from },
    );

    await user.click(await screen.findByRole('radio', { name: /Loose/ }));
    await user.click(screen.getByRole('button', { name: /^Move$/ }));

    expect(
      await screen.findByText(
        "Added to Loose, but it's still in Bakery theme. The project folder is gone.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
    await user.click(screen.getAllByRole('button', { name: 'Close' }).at(-1) as HTMLElement);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('hands off to the new project flow from the first row', async () => {
    const { user, onNewProject } = renderDialog([SHOP]);
    await user.click(await screen.findByRole('button', { name: /New project for this site/ }));
    expect(onNewProject).toHaveBeenCalledTimes(1);
  });

  it('offers a search once there are more than six projects to pick from, by name or folder', async () => {
    const many = [
      plain('p1', 'Alpha'),
      plain('p2', 'Bravo'),
      plain('p3', 'Charlie'),
      plain('p4', 'Delta'),
      plain('p5', 'Echo'),
      plain('p6', 'Foxtrot', 'D:\\Work\\kitchen-site'),
      linked('p7', 'Golf', [PLUGIN]),
    ];
    const { user } = renderDialog(many);

    const search = await screen.findByRole('textbox', { name: /Search projects/ });
    await user.type(search, 'GOLF');
    expect(screen.getByRole('radio', { name: /Golf/ })).toBeTruthy();
    expect(screen.queryByRole('radio', { name: /Alpha/ })).toBeNull();

    await user.clear(search);
    await user.type(search, 'kitchen');
    expect(screen.getByRole('radio', { name: /Foxtrot/ })).toBeTruthy();
    expect(screen.queryByRole('radio', { name: /Golf/ })).toBeNull();
  });

  it('has no search for a short list', async () => {
    renderDialog([SHOP, LOOSE]);
    await screen.findByRole('radio', { name: /Loose/ });
    expect(screen.queryByRole('textbox', { name: /Search projects/ })).toBeNull();
  });

  it('holds the action while another run for the site is going, and says why', async () => {
    useWordPressOperationStore.setState({ runs: { 'op-elsewhere': runningRun() } });
    const { user } = renderDialog([SHOP, LOOSE]);

    await user.click(await screen.findByRole('radio', { name: /Bakery shop/ }));
    expect(screen.getByRole('button', { name: /Add and pull/ })).toBeDisabled();
    expect(screen.getByText(/A pull from this site is still running/)).toBeTruthy();
  });

  it("doesn't count a run for a different site as busy", async () => {
    useWordPressOperationStore.setState({
      runs: { 'op-elsewhere': runningRun({ siteId: OTHER_SITE.id }) },
    });
    const { user } = renderDialog([SHOP, LOOSE]);

    await user.click(await screen.findByRole('radio', { name: /Bakery shop/ }));
    expect(screen.getByRole('button', { name: /Add and pull/ })).toBeEnabled();
  });

  it('shows the progress while it runs, with Hide in place of Cancel', async () => {
    let finish!: (project: Project) => void;
    const { user } = renderDialog([SHOP], {
      'deployWordPress.setProjectItems': () =>
        new Promise<Project>((resolve) => {
          finish = resolve;
        }),
    });

    await user.click(await screen.findByRole('radio', { name: /Bakery shop/ }));
    await user.click(screen.getByRole('button', { name: /Add and pull/ }));

    expect(await screen.findByRole('list', { name: 'Progress' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Hide' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Add and pull/ })).toBeDisabled();
    expect(screen.queryByText(/still running/)).toBeNull();

    finish(linked('shop', 'Bakery shop', [PLUGIN, THEME]));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
  });

  it('starts fresh each time it opens', async () => {
    function Harness(): React.JSX.Element {
      const [open, setOpen] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open again
          </button>
          <AddToProjectDialog
            open={open}
            onOpenChange={setOpen}
            site={SITE}
            item={ITEM}
            mode="add"
            onNewProject={() => undefined}
          />
        </>
      );
    }
    const { user } = renderWithProviders(<Harness />, {
      bridge: { 'projects.list': [SHOP, LOOSE], 'deployWordPress.listSites': [SITE] },
    });

    await user.click(await screen.findByRole('radio', { name: /Loose/ }));
    expect(screen.getByRole('radio', { name: /Loose/ })).toHaveAttribute('aria-checked', 'true');

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await user.click(screen.getByRole('button', { name: 'Open again' }));
    expect(await screen.findByRole('radio', { name: /Loose/ })).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });
});
