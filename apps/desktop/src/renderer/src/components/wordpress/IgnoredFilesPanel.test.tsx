import type { Project } from '@runova/core';
import { useQuery } from '@tanstack/react-query';
import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryKeys } from '@/lib/queryKeys';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { deferred, wpProject } from '../projects/wordpress/testing/fixtures';

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
);
vi.mock('sonner', () => ({ toast }));

const { IgnoredFilesPanel } = await import('./IgnoredFilesPanel');

/**
 * What a project leaves out of its deploys, listed where it can be undone, and a way to add a
 * pattern by hand. Saving goes through the main process; the panel shows what came back.
 */

type Link = NonNullable<Project['wordpress']>;

/** The sample project with its saved ignore list set, or cleared when there is none. */
function withList(project: Project, ignore?: Record<string, string[]>): Project {
  const { ignore: _old, ...link } = project.wordpress as Link;
  return {
    ...project,
    wordpress: ignore && Object.keys(ignore).length > 0 ? { ...link, ignore } : link,
  };
}

function withIgnore(ignore?: Record<string, string[]>): Project {
  return withList(wpProject(), ignore);
}

/** The panel as the app uses it: the project comes from the projects query. */
function Harness({
  id,
  onChanged,
  context,
}: {
  id: string;
  onChanged?: () => void;
  context?: 'review' | 'section';
}): React.JSX.Element | null {
  const { data } = useQuery({
    queryKey: queryKeys.projects,
    queryFn: () => window.runova.projects.list(),
  });
  const project = data?.find((entry) => entry.id === id);
  return project ? (
    <IgnoredFilesPanel project={project} onChanged={onChanged} context={context} />
  ) : null;
}

function renderPanel(
  initial: Project,
  bridge: Record<string, unknown> = {},
  onChanged?: () => void,
  context?: 'review' | 'section',
) {
  let current = initial;
  const view = renderWithProviders(
    <Harness id={initial.id} onChanged={onChanged} context={context} />,
    {
      bridge: {
        'projects.list': async () => [current],
        'deployWordPress.setProjectIgnore': async (input: { ignore: Record<string, string[]> }) => {
          current = withList(current, input.ignore);
          return current;
        },
        ...bridge,
      },
    },
  );
  return view;
}

/** What setProjectIgnore was called with; the bridge refuses to name a call nobody made. */
function saved(bridge: { $fn: (path: string) => { mock: { calls: unknown[][] } } }): unknown[] {
  try {
    return bridge.$fn('deployWordPress.setProjectIgnore').mock.calls.map((call) => call[0]);
  } catch {
    return [];
  }
}

describe('IgnoredFilesPanel', () => {
  beforeEach(() => {
    toast.success.mockClear();
    toast.error.mockClear();
  });

  it('says nothing is ignored yet, and what is left out on its own', async () => {
    renderPanel(withIgnore());
    expect(await screen.findByText(/Nothing is ignored yet/)).toBeTruthy();
    const note = screen.getByText(/Left out on their own/);
    expect(note.textContent).toContain('.gitignore');
    expect(note.textContent).toContain('.claude');
    expect(note.textContent).toContain('.runova');
    expect(screen.queryByRole('list', { name: 'Ignored files and folders' })).toBeNull();
  });

  it('says where to start in the words of the screen it is on', async () => {
    const section = renderPanel(withIgnore());
    expect(await screen.findByText(/ignore files while you review a deploy/)).toBeTruthy();
    expect(screen.queryByText(/eye button/)).toBeNull();
    section.unmount();

    renderPanel(withIgnore(), {}, undefined, 'review');
    expect(await screen.findByText(/Use the eye button on a file/)).toBeTruthy();
    expect(screen.queryByText(/while you review a deploy/)).toBeNull();
  });

  it('lists the saved lines as folders, files and patterns, with where each applies', async () => {
    renderPanel(
      withIgnore({
        '*': ['*.map'],
        'theme:storefront': ['/vendor/', '/inc/a.php'],
        'plugin:gone': ['/x/'],
      }),
    );
    const list = await screen.findByRole('list', { name: 'Ignored files and folders' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('*.map'),
      expect.stringContaining('vendor/'),
      expect.stringContaining('inc/a.php'),
    ]);
    expect(within(rows[0]).getByText('Every theme and plugin')).toBeTruthy();
    expect(within(rows[1]).getByText('storefront')).toBeTruthy();
  });

  it('stops ignoring one line and keeps the rest', async () => {
    const { user, bridge } = renderPanel(
      withIgnore({ '*': ['*.map'], 'theme:storefront': ['/vendor/', '/docs/'] }),
    );
    await user.click(
      await screen.findByRole('button', { name: 'Stop ignoring vendor/ in storefront' }),
    );
    await waitFor(() =>
      expect(saved(bridge)).toEqual([
        { projectId: 'p1', ignore: { '*': ['*.map'], 'theme:storefront': ['/docs/'] } },
      ]),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: 'Stop ignoring vendor/ in storefront' }),
      ).toBeNull(),
    );
    expect(screen.getByRole('button', { name: 'Stop ignoring docs/ in storefront' })).toBeTruthy();
  });

  it('adds a pattern for every item, tells the user, and offers an undo', async () => {
    const { user, bridge } = renderPanel(withIgnore({ 'theme:storefront': ['/vendor/'] }));
    const field = await screen.findByRole('textbox', { name: 'File, folder or pattern to ignore' });
    const add = screen.getByRole('button', { name: 'Ignore' });
    expect((add as HTMLButtonElement).disabled).toBe(true);

    await user.type(field, '*.map');
    await user.click(add);
    await waitFor(() =>
      expect(saved(bridge)).toEqual([
        { projectId: 'p1', ignore: { 'theme:storefront': ['/vendor/'], '*': ['*.map'] } },
      ]),
    );
    expect((field as HTMLInputElement).value).toBe('');
    expect(toast.success).toHaveBeenCalledWith(
      'Ignored *.map in every theme and plugin.',
      expect.objectContaining({ action: expect.objectContaining({ label: 'Undo' }) }),
    );

    const options = toast.success.mock.calls.at(-1)?.[1] as { action: { onClick: () => void } };
    options.action.onClick();
    await waitFor(() =>
      expect(saved(bridge).at(-1)).toEqual({
        projectId: 'p1',
        ignore: { 'theme:storefront': ['/vendor/'] },
      }),
    );
  });

  it('adds a pattern for one theme or plugin picked from the list', async () => {
    const { user, bridge } = renderPanel(withIgnore());
    await user.type(
      await screen.findByRole('textbox', { name: 'File, folder or pattern to ignore' }),
      'docs/',
    );
    await user.click(screen.getByRole('combobox', { name: 'Where it applies' }));
    await user.click(await screen.findByRole('option', { name: /woocommerce/ }));
    await user.click(screen.getByRole('button', { name: 'Ignore' }));
    await waitFor(() =>
      expect(saved(bridge)).toEqual([
        { projectId: 'p1', ignore: { 'plugin:woocommerce': ['docs/'] } },
      ]),
    );
    expect(toast.success).toHaveBeenCalledWith('Ignored docs/ in woocommerce.', expect.anything());
  });

  it('adds the pattern when Enter is pressed in the field', async () => {
    const { user, bridge } = renderPanel(withIgnore());
    await user.type(
      await screen.findByRole('textbox', { name: 'File, folder or pattern to ignore' }),
      'tests/{Enter}',
    );
    await waitFor(() =>
      expect(saved(bridge)).toEqual([{ projectId: 'p1', ignore: { '*': ['tests/'] } }]),
    );
  });

  it('shows what the main process says is wrong with a pattern, and keeps what was typed', async () => {
    const { user } = renderPanel(withIgnore(), {
      'deployWordPress.setProjectIgnore': async () => {
        throw new Error(
          'Line 1 of the ignore list for every item cannot be read: a [ is never closed. Fix it and try again. [wp:badRequest]',
        );
      },
    });
    const field = await screen.findByRole('textbox', { name: 'File, folder or pattern to ignore' });
    await user.type(field, '[[a');
    await user.click(screen.getByRole('button', { name: 'Ignore' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('a [ is never closed');
    expect(alert.textContent).not.toContain('[wp:badRequest]');
    expect((field as HTMLInputElement).value).toBe('[a');
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('says so, and saves nothing, when the line is already there', async () => {
    const { user, bridge } = renderPanel(withIgnore({ '*': ['*.map'] }));
    await user.type(
      await screen.findByRole('textbox', { name: 'File, folder or pattern to ignore' }),
      '*.map',
    );
    await user.click(screen.getByRole('button', { name: 'Ignore' }));
    expect(await screen.findByText(/already ignored/i)).toBeTruthy();
    expect(saved(bridge)).toEqual([]);
  });

  it('holds the buttons while a save is on its way', async () => {
    const pending = deferred<Project>();
    const { user } = renderPanel(withIgnore({ '*': ['*.map'] }), {
      'deployWordPress.setProjectIgnore': () => pending.promise,
    });
    await user.click(
      await screen.findByRole('button', { name: 'Stop ignoring *.map in every theme and plugin' }),
    );
    await waitFor(() =>
      expect(
        (
          screen.getByRole('button', {
            name: 'Stop ignoring *.map in every theme and plugin',
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true),
    );
    pending.resolve(withIgnore());
  });

  it('tells its parent after a change was saved', async () => {
    const onChanged = vi.fn();
    const { user } = renderPanel(withIgnore({ '*': ['*.map'] }), {}, onChanged);
    await user.click(
      await screen.findByRole('button', { name: 'Stop ignoring *.map in every theme and plugin' }),
    );
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });

  it('does not tell its parent about a change that failed', async () => {
    const onChanged = vi.fn();
    const { user } = renderPanel(
      withIgnore(),
      {
        'deployWordPress.setProjectIgnore': async () => {
          throw new Error('nope');
        },
      },
      onChanged,
    );
    await user.type(
      await screen.findByRole('textbox', { name: 'File, folder or pattern to ignore' }),
      'x/',
    );
    await user.click(screen.getByRole('button', { name: 'Ignore' }));
    await screen.findByRole('alert');
    expect(onChanged).not.toHaveBeenCalled();
  });
});
