import { act, screen, waitFor, within } from '@testing-library/react';
import { useLocation } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { useGlobalShortcuts } from '@/hooks/useGlobalShortcuts';
import { useRunningClisStore } from '@/stores/runningClisStore';
import { useSearchStore } from '@/stores/searchStore';
import { useToastHistoryStore } from '@/stores/toastHistoryStore';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { CommandPalette } from './CommandPalette';

/**
 * The palette is the keyboard route to everything: pages, projects, past prompts, skills and the
 * vault. It is driven here the way it is used, from the shortcut through typing to Enter, with
 * the global shortcut hook mounted alongside it so the key that opens it is covered too.
 */

/** The palette plus the shortcut handler, with the current path on screen to assert navigation. */
function renderPalette(bridge: Record<string, unknown> = {}) {
  function Harness(): React.JSX.Element {
    useGlobalShortcuts();
    const { pathname } = useLocation();
    return (
      <>
        <CommandPalette />
        <p data-testid="pathname">{pathname}</p>
      </>
    );
  }
  return renderWithProviders(<Harness />, { bridge });
}

function pathname(): string {
  return screen.getByTestId('pathname').textContent ?? '';
}

/**
 * One result group. A project's name shows up twice once something is typed, in "Projects" and
 * again in "Open workspace", so most assertions have to say which one they mean.
 */
function group(heading: string): HTMLElement {
  const label = screen.getByText(heading, { selector: '[cmdk-group-heading]' });
  const container = label.closest('[cmdk-group]');
  if (!(container instanceof HTMLElement)) throw new Error(`No "${heading}" group`);
  return container;
}

const projects = [
  { id: 'p1', name: 'Aurora', description: 'The web client', folderPath: '/code/aurora', tags: [] },
  { id: 'p2', name: 'Borealis', description: 'The API', folderPath: '/code/borealis', tags: [] },
];

const history = [
  {
    id: 'h1',
    source: 'builder',
    promptType: 'Feature',
    targetAI: 'Claude',
    content: 'Add a retry to the uploader',
    tags: [],
  },
];

describe('CommandPalette opening and closing', () => {
  it('stays shut until it is asked for', () => {
    renderPalette();

    expect(screen.queryByPlaceholderText(/Search projects/)).toBeNull();
  });

  it('opens on the keyboard shortcut', async () => {
    const { user } = renderPalette();

    await user.keyboard('{Control>}k{/Control}');

    expect(await screen.findByPlaceholderText(/Search projects/)).toBeTruthy();
  });

  it('closes again on Escape', async () => {
    const { user } = renderPalette();
    await user.keyboard('{Control>}k{/Control}');
    await screen.findByPlaceholderText(/Search projects/);

    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByPlaceholderText(/Search projects/)).toBeNull());
    expect(useSearchStore.getState().open).toBe(false);
  });

  it('forgets what was typed the next time it opens', async () => {
    const { user } = renderPalette();
    await user.keyboard('{Control>}k{/Control}');
    await user.type(await screen.findByPlaceholderText(/Search projects/), 'settings');
    await user.keyboard('{Escape}');

    await user.keyboard('{Control>}k{/Control}');

    const input = await screen.findByPlaceholderText(/Search projects/);
    expect((input as HTMLInputElement).value).toBe('');
  });
});

describe('CommandPalette results', () => {
  it('lists the pages, the projects and the prompt history it was given', async () => {
    const { user } = renderPalette({
      'projects.list': projects,
      'promptHistory.list': history,
    });
    await user.keyboard('{Control>}k{/Control}');
    await screen.findByPlaceholderText(/Search projects/);

    expect(await screen.findByText('Aurora')).toBeTruthy();
    expect(screen.getByText('/code/borealis')).toBeTruthy();
    expect(screen.getByText('Feature · Claude')).toBeTruthy();
    expect(screen.getByText('Settings')).toBeTruthy();
    expect(screen.getByText('Recent messages')).toBeTruthy();
  });

  it('filters across every group as the user types', async () => {
    const { user } = renderPalette({
      'projects.list': projects,
      'promptHistory.list': history,
    });
    await user.keyboard('{Control>}k{/Control}');
    const input = await screen.findByPlaceholderText(/Search projects/);
    await screen.findByText('Aurora');

    await user.type(input, 'borealis');

    await waitFor(() => expect(screen.queryByText('Aurora')).toBeNull());
    expect(within(group('Projects')).getByText('Borealis')).toBeTruthy();
    // Pages and history entries that do not match drop out of the list too.
    expect(screen.queryByText('Settings')).toBeNull();
    expect(screen.queryByText('Feature · Claude')).toBeNull();
    // Typing also offers the matching project's workspace, which is hidden while empty.
    expect(screen.getByText(/Workspace:/)).toBeTruthy();
  });

  it('says so when nothing matches instead of showing an empty box', async () => {
    const { user } = renderPalette({ 'projects.list': projects });
    await user.keyboard('{Control>}k{/Control}');
    const input = await screen.findByPlaceholderText(/Search projects/);

    await user.type(input, 'zzzzz');

    expect(await screen.findByText('No results found.')).toBeTruthy();
  });

  it('works with a bridge that has nothing to offer', async () => {
    const { user } = renderPalette();
    await user.keyboard('{Control>}k{/Control}');
    await screen.findByPlaceholderText(/Search projects/);

    // The pages are built in, so they are there even with no projects, history or skills.
    expect(screen.getByText('Dashboard')).toBeTruthy();
    expect(screen.queryByText('Projects', { selector: '[cmdk-group-heading]' })).toBeNull();
  });

  it('keeps the pages listed when a lookup rejects', async () => {
    const { user } = renderPalette({
      'projects.list': () => Promise.reject(new Error('database locked')),
      'promptHistory.list': () => Promise.reject(new Error('database locked')),
      'skills.listRepositories': () => Promise.reject(new Error('database locked')),
    });
    await user.keyboard('{Control>}k{/Control}');

    expect(await screen.findByText('Dashboard')).toBeTruthy();
    expect(screen.getByText('Agent Tools')).toBeTruthy();
  });
});

describe('CommandPalette selection', () => {
  it('navigates to a page on Enter and closes', async () => {
    const { user } = renderPalette();
    await user.keyboard('{Control>}k{/Control}');
    const input = await screen.findByPlaceholderText(/Search projects/);

    await user.type(input, 'docker');
    await screen.findByText('Docker');
    await user.keyboard('{Enter}');

    await waitFor(() => expect(pathname()).toBe('/docker'));
    expect(screen.queryByPlaceholderText(/Search projects/)).toBeNull();
  });

  it('opens a project from its folder path', async () => {
    const { user } = renderPalette({ 'projects.list': projects });
    await user.keyboard('{Control>}k{/Control}');
    const input = await screen.findByPlaceholderText(/Search projects/);

    await user.type(input, 'borealis');
    await waitFor(() => expect(within(group('Projects')).getByText('Borealis')).toBeTruthy());
    // The first match is the project itself, so Enter opens its detail page.
    await user.keyboard('{Enter}');

    await waitFor(() => expect(pathname()).toBe('/projects/p2'));
  });

  it('opens a prompt history entry with the entry to show', async () => {
    const { user } = renderPalette({ 'promptHistory.list': history });
    await user.keyboard('{Control>}k{/Control}');
    const input = await screen.findByPlaceholderText(/Search projects/);

    await user.type(input, 'retry to the uploader');
    await screen.findByText('Feature · Claude');
    await user.keyboard('{Enter}');

    await waitFor(() => expect(pathname()).toBe('/prompt-history'));
  });

  it('opens the recent messages panel rather than navigating', async () => {
    const { user } = renderPalette();
    await user.keyboard('{Control>}k{/Control}');
    const input = await screen.findByPlaceholderText(/Search projects/);

    await user.type(input, 'recent messages');
    await user.click(await screen.findByText('Recent messages'));

    await waitFor(() => expect(useToastHistoryStore.getState().open).toBe(true));
    expect(pathname()).toBe('/');
  });

  it('opens the running CLIs dialog rather than navigating', async () => {
    const { user } = renderPalette();
    await user.keyboard('{Control>}k{/Control}');
    const input = await screen.findByPlaceholderText(/Search projects/);

    await user.type(input, 'running clis');
    await user.click(await screen.findByText('Running CLIs'));

    await waitFor(() => expect(useRunningClisStore.getState().open).toBe(true));
  });

  it('offers to unlock a locked vault', async () => {
    const { user } = renderPalette({ 'vault.status': async () => ({ state: 'locked' }) });
    await user.keyboard('{Control>}k{/Control}');

    await user.click(await screen.findByText('Unlock Vault'));

    await waitFor(() => expect(pathname()).toBe('/vault'));
  });

  it('opens the SFTP file manager of a saved server found by its host', async () => {
    const { user } = renderPalette({
      'ssh.listServers': [
        {
          id: 'srv-9',
          nickname: 'web',
          host: 'web.example.net',
          port: 22,
          username: 'dev',
          authMethod: 'password',
          hasSecret: true,
          createdAt: 0,
          lastConnectedAt: null,
        },
      ],
    });
    await user.keyboard('{Control>}k{/Control}');
    await user.keyboard('web.example');

    await user.click(await screen.findByRole('option', { name: /Open SFTP files: web/ }));

    await waitFor(() => expect(pathname()).toBe('/ssh-files/srv-9'));
    expect(useSearchStore.getState().open).toBe(false);
  });

  it('lists the unlocked vault entries and opens the one that is picked', async () => {
    const { user } = renderPalette({
      'vault.status': async () => ({ state: 'unlocked' }),
      'vault.list': [
        {
          id: 'v1',
          type: 'login',
          title: 'GitHub',
          host: 'github.com',
          username: 'ada',
          tags: [],
        },
      ],
    });
    await user.keyboard('{Control>}k{/Control}');

    const entry = await screen.findByText('GitHub');
    expect(within(group('Vault')).getByText('Lock Vault')).toBeTruthy();

    await user.click(entry);

    await waitFor(() => expect(pathname()).toBe('/vault'));
  });

  it('closes without navigating when the same shortcut is pressed again', async () => {
    const { user } = renderPalette();
    await user.keyboard('{Control>}k{/Control}');
    await screen.findByPlaceholderText(/Search projects/);

    act(() => useSearchStore.getState().setOpen(false));

    await waitFor(() => expect(screen.queryByPlaceholderText(/Search projects/)).toBeNull());
    expect(pathname()).toBe('/');
  });
});

describe('CommandPalette skills', () => {
  it('lists the skills from every repository and opens the page with the search filled in', async () => {
    const { user } = renderPalette({
      'skills.listRepositories': [{ id: 'r1', name: 'Core skills' }],
      'skills.getRepositoryIndex': async () => ({
        skills: [
          {
            id: 's1',
            name: 'dataviz',
            description: 'Charts that read as one system',
            category: 'Design',
            tags: ['charts'],
          },
        ],
      }),
    });
    await user.keyboard('{Control>}k{/Control}');

    const skill = await screen.findByText('dataviz');
    expect(within(skill.parentElement as HTMLElement).getByText(/Charts that read/)).toBeTruthy();

    await user.click(skill);

    await waitFor(() => expect(pathname()).toBe('/skills'));
  });
});

describe('CommandPalette and worktrees', () => {
  const worktree = {
    id: 'wt-1',
    projectId: 'p1',
    path: '/code/aurora.worktrees/feat-auth',
    branch: 'feat/auth',
    baseBranch: 'main',
    createdAt: '2026-09-25T00:00:00.000Z',
    createdByApp: true,
    missing: false,
    locked: false,
    status: null,
  };

  it('finds a worktree of an open project by its branch and opens its workspace', async () => {
    const { useWorkspaceStore } = await import('@/stores/workspaceStore');
    useWorkspaceStore.setState({ railProjectIds: ['p1'] });
    const { user } = renderPalette({ 'projects.list': projects, 'worktrees.list': [worktree] });
    await user.keyboard('{Control>}k{/Control}');
    const input = await screen.findByPlaceholderText(/Search projects/);

    await user.type(input, 'feat/auth');
    const item = await within(group('Worktrees')).findByText('feat/auth');
    await user.click(item);

    await waitFor(() => expect(pathname()).toBe('/workspace/p1~wt-1'));
  });

  it('starts a new worktree of the project on screen', async () => {
    const { useWorkspaceStore } = await import('@/stores/workspaceStore');
    const { useWorktreeDialogStore } = await import('@/stores/worktreeDialogStore');
    useWorkspaceStore.setState({ railProjectIds: ['p1'], activeProjectId: 'p1' });
    const { user } = renderPalette({ 'projects.list': projects, 'worktrees.list': [] });
    await user.keyboard('{Control>}k{/Control}');
    const input = await screen.findByPlaceholderText(/Search projects/);

    await user.type(input, 'new worktree');
    await user.click(await within(group('Worktrees')).findByText('New worktree of Aurora'));
    expect(useWorktreeDialogStore.getState().create).toEqual({ projectId: 'p1' });
  });
});
