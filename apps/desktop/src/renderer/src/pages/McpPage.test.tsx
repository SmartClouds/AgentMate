import type { McpRepository, McpServer } from '@runova/core';
import { BOWORA_MCP_REPOSITORY_ID } from '@runova/core';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../test/renderer/renderWithProviders';

/**
 * The MCP marketplace: pick a project, pick a repository, then install a server into that
 * project. Nearly everything here is a bridge call with a project id attached, so the tests
 * follow what the page asks the bridge for rather than what it draws.
 */

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    dismiss: vi.fn(),
  }),
);
vi.mock('sonner', () => ({ toast, Toaster: () => null }));

const confirm = vi.hoisted(() => ({ confirmDialog: vi.fn(async () => true) }));
vi.mock('@/stores/confirmStore', () => confirm);

const { default: McpPage } = await import('./McpPage');

function server(overrides: Partial<McpServer> & { id: string; name: string }): McpServer {
  return {
    description: 'Does a useful thing.',
    category: 'Developer Tools',
    tags: [],
    author: 'Acme',
    version: '1.0.0',
    official: false,
    popularity: 0,
    requiredEnv: [],
    config: { transport: 'stdio', command: 'npx', args: [], env: {} },
    ...overrides,
  };
}

const filesystem = server({
  id: 'filesystem',
  name: 'Filesystem',
  description: 'Read and write files in a folder.',
  category: 'Developer Tools',
  author: 'Anthropic',
  official: true,
  popularity: 90,
  websiteUrl: 'https://example.com/filesystem',
  repositoryUrl: 'https://github.com/example/filesystem',
});

const postgres = server({
  id: 'postgres',
  name: 'Postgres',
  description: 'Query a Postgres database.',
  category: 'Databases',
  author: 'Community',
  popularity: 40,
  requiredEnv: ['DATABASE_URL'],
});

/** No command and no url, so it can only be set up by hand. */
const manualOnly = server({
  id: 'manual',
  name: 'Manual Server',
  category: 'Databases',
  config: { transport: 'stdio', args: [], env: {} },
});

const community: McpRepository = {
  id: 'repo-1',
  name: 'Community repository',
  sourceType: 'git',
  source: 'https://github.com/example/mcp-servers.git',
  addedAt: '2026-01-01T00:00:00.000Z',
  lastRefreshedAt: null,
};

const builtIn: McpRepository = {
  ...community,
  id: BOWORA_MCP_REPOSITORY_ID,
  name: 'Built-in directory',
  sourceType: 'bundled',
};

/** Only the fields the page reads; the bridge answers are untyped on purpose. */
const projects = [
  { id: 'p1', name: 'Aurora', folderPath: '/code/aurora' },
  { id: 'p2', name: 'Borealis', folderPath: '/code/borealis' },
];

function renderPage(bridge: Record<string, unknown> = {}, route = '/mcp') {
  return renderWithProviders(<McpPage />, { route, bridge });
}

/** The card a server's name heads, so a click lands on the intended server. */
function serverCard(name: string): HTMLElement {
  const title = screen.getByText(name);
  let element: HTMLElement | null = title.parentElement;
  while (element) {
    if (within(element).queryAllByRole('button').length > 0) return element;
    element = element.parentElement;
  }
  throw new Error(`No card found around "${name}"`);
}

const withCatalog = {
  'projects.list': projects,
  'mcp.listRepositories': [community],
  'mcp.getRepositoryIndex': async () => ({
    name: 'Community repository',
    servers: [filesystem, postgres],
  }),
};

describe('McpPage catalogue', () => {
  it('renders against an empty bridge and asks for a repository', async () => {
    renderPage();

    expect(await screen.findByText('No servers yet')).toBeTruthy();
    expect(screen.getByText('Choose a project to install servers into it.')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /Add repository/ }).length).toBeGreaterThan(0);
  });

  it('lists the servers in the first repository, most popular first', async () => {
    renderPage(withCatalog);

    expect(await screen.findByText('Filesystem')).toBeTruthy();
    expect(screen.getByText('Read and write files in a folder.')).toBeTruthy();
    expect(screen.getByText('Postgres')).toBeTruthy();
    expect(screen.getByText('2 servers')).toBeTruthy();

    const names = screen.getAllByText(/^(Filesystem|Postgres)$/).map((node) => node.textContent);
    expect(names).toEqual(['Filesystem', 'Postgres']);
  });

  it('says the repository is empty rather than leaving a blank grid', async () => {
    renderPage({
      'mcp.listRepositories': [community],
      'mcp.getRepositoryIndex': async () => ({ name: 'Community repository', servers: [] }),
    });

    expect(await screen.findByText('Community repository is empty')).toBeTruthy();
  });

  it('reports a repository that will not load, with a way to retry', async () => {
    renderPage({
      'mcp.listRepositories': [community],
      'mcp.getRepositoryIndex': () => Promise.reject(new Error('git clone failed')),
    });

    expect(await screen.findByText("Couldn't load this repository.")).toBeTruthy();
    expect(screen.getByRole('button', { name: /Try again/ })).toBeTruthy();
  });

  it('filters by search text across name, author and category', async () => {
    const { user } = renderPage(withCatalog);
    await screen.findByText('Filesystem');

    await user.type(screen.getByLabelText('Search MCP servers'), 'postgres');

    await waitFor(() => expect(screen.queryByText('Filesystem')).toBeNull());
    expect(screen.getByText('Postgres')).toBeTruthy();
    expect(screen.getByText('1 of 2')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(await screen.findByText('Filesystem')).toBeTruthy();
  });

  it('filters by category and by the official badge', async () => {
    const { user } = renderPage(withCatalog);
    await screen.findByText('Filesystem');

    // Categories are rows in the sidebar, and each one says how many servers it holds.
    const categories = within(screen.getByRole('group', { name: 'Categories' }));
    await user.click(categories.getByRole('button', { name: /^Databases/ }));
    await waitFor(() => expect(screen.queryByText('Filesystem')).toBeNull());
    expect(categories.getByRole('button', { name: /^Databases/ })).toHaveAttribute(
      'aria-current',
      'true',
    );

    await user.click(categories.getByRole('button', { name: /^All/ }));
    await user.click(screen.getByRole('button', { name: 'Official' }));

    await waitFor(() => expect(screen.queryByText('Postgres')).toBeNull());
    expect(screen.getByText('Filesystem')).toBeTruthy();
  });

  it('offers a way back when the filters hide everything', async () => {
    const { user } = renderPage(withCatalog);
    await screen.findByText('Filesystem');

    await user.type(screen.getByLabelText('Search MCP servers'), 'nothing matches this');

    expect(await screen.findByText('No servers match')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(await screen.findByText('Filesystem')).toBeTruthy();
  });
});

describe('McpPage repositories', () => {
  it('adds a repository from the dialog and reports it', async () => {
    const { bridge, user } = renderPage({ 'mcp.listRepositories': [] });
    await screen.findByText('No servers yet');

    await user.click(screen.getAllByRole('button', { name: /Add repository/ })[0]);
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getAllByRole('textbox')[0], 'Community repository');

    // Type defaults to a local folder, which has no free-text field; switch to git first.
    await user.click(within(dialog).getByRole('combobox'));
    await user.click(await screen.findByText('Git repository'));
    await user.type(
      within(dialog).getByPlaceholderText('https://github.com/org/mcp-servers.git'),
      'https://github.com/example/mcp-servers.git',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Add' }));

    await waitFor(() =>
      expect(bridge.$fn('mcp.addRepository')).toHaveBeenCalledWith({
        name: 'Community repository',
        sourceType: 'git',
        source: 'https://github.com/example/mcp-servers.git',
      }),
    );
    expect(toast.success).toHaveBeenCalledWith('Repository added.');
  });

  it('will not add a repository with nothing filled in', async () => {
    const { user } = renderPage({ 'mcp.listRepositories': [] });
    await screen.findByText('No servers yet');

    await user.click(screen.getAllByRole('button', { name: /Add repository/ })[0]);
    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).getByRole('button', { name: 'Add' })).toBeDisabled();
  });

  it('says what went wrong when the repository cannot be added', async () => {
    const { user } = renderPage({
      'mcp.listRepositories': [],
      'mcp.addRepository': () => Promise.reject(new Error('Not a git repository')),
      'mcp.pickLocalRepository': async () => '/code/servers',
    });
    await screen.findByText('No servers yet');

    await user.click(screen.getAllByRole('button', { name: /Add repository/ })[0]);
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getAllByRole('textbox')[0], 'Local servers');
    await user.click(within(dialog).getByRole('button', { name: 'Browse for a folder' }));
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Add' })).not.toBeDisabled(),
    );

    await user.click(within(dialog).getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Not a git repository'));
  });

  it('refreshes the selected repository on request', async () => {
    const { bridge, user } = renderPage(withCatalog);
    await screen.findByText('Filesystem');

    await user.click(screen.getByRole('button', { name: 'Refresh repository' }));

    await waitFor(() => expect(bridge.$fn('mcp.refreshRepository')).toHaveBeenCalledWith('repo-1'));
    expect(toast.success).toHaveBeenCalledWith('Repository refreshed.');
  });

  it('removes a repository only after the user confirms', async () => {
    const { bridge, user } = renderPage(withCatalog);
    await screen.findByText('Filesystem');

    await user.click(screen.getByRole('button', { name: 'Remove repository' }));

    await waitFor(() =>
      expect(confirm.confirmDialog).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Remove "Community repository"?' }),
      ),
    );
    await waitFor(() => expect(bridge.$fn('mcp.removeRepository')).toHaveBeenCalledWith('repo-1'));
  });

  it('keeps a repository the user decided against', async () => {
    confirm.confirmDialog.mockResolvedValueOnce(false);
    const { bridge, user } = renderPage(withCatalog);
    await screen.findByText('Filesystem');

    await user.click(screen.getByRole('button', { name: 'Remove repository' }));

    await waitFor(() => expect(confirm.confirmDialog).toHaveBeenCalled());
    expect(() => bridge.$fn('mcp.removeRepository')).toThrow();
  });

  it('marks the bundled directory as built in, with nothing to refresh or remove', async () => {
    renderPage({
      'projects.list': projects,
      'mcp.listRepositories': [builtIn],
      'mcp.getRepositoryIndex': async () => ({ name: 'Built-in', servers: [filesystem] }),
    });

    expect(await screen.findByText('Built-in')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Refresh repository' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove repository' })).toBeNull();
  });
});

describe('McpPage install and remove', () => {
  it('cannot install until a project is chosen', async () => {
    renderPage({
      'mcp.listRepositories': [community],
      'mcp.getRepositoryIndex': async () => ({ name: 'Community', servers: [filesystem] }),
    });
    await screen.findByText('Filesystem');

    expect(
      within(serverCard('Filesystem')).getByRole('button', { name: /Install/ }),
    ).toBeDisabled();
  });

  it('installs into the chosen project', async () => {
    const { bridge, user } = renderPage(withCatalog);
    await screen.findByText('Filesystem');

    // The first combobox is the project picker, the second is the repository.
    await user.click(screen.getAllByRole('combobox')[0]);
    await user.click(await screen.findByText('Aurora'));
    await user.click(within(serverCard('Filesystem')).getByRole('button', { name: /Install/ }));

    await waitFor(() =>
      expect(bridge.$fn('mcp.install')).toHaveBeenCalledWith({
        projectId: 'p1',
        repositoryId: 'repo-1',
        serverId: 'filesystem',
        env: undefined,
      }),
    );
    expect(toast.success).toHaveBeenCalledWith('MCP server installed.');
  });

  it('asks for the secrets a server needs before installing it', async () => {
    const { bridge, user } = renderPage(withCatalog);
    await screen.findByText('Postgres');
    await user.click(screen.getAllByRole('combobox')[0]);
    await user.click(await screen.findByText('Aurora'));

    await user.click(within(serverCard('Postgres')).getByRole('button', { name: /Install/ }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('Configure Postgres');
    // Nothing is installed while a required value is still blank.
    expect(within(dialog).getByRole('button', { name: /Install/ })).toBeDisabled();

    await user.type(screen.getByLabelText('DATABASE_URL'), 'postgres://localhost/app');
    await user.click(within(dialog).getByRole('button', { name: /Install/ }));

    await waitFor(() =>
      expect(bridge.$fn('mcp.install')).toHaveBeenCalledWith({
        projectId: 'p1',
        repositoryId: 'repo-1',
        serverId: 'postgres',
        env: { DATABASE_URL: 'postgres://localhost/app' },
      }),
    );
  });

  it('reports an install that the main process refused', async () => {
    const { user } = renderPage({
      ...withCatalog,
      'mcp.install': () => Promise.reject(new Error('.mcp.json is read-only')),
    });
    await screen.findByText('Filesystem');
    await user.click(screen.getAllByRole('combobox')[0]);
    await user.click(await screen.findByText('Aurora'));

    await user.click(within(serverCard('Filesystem')).getByRole('button', { name: /Install/ }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('.mcp.json is read-only'));
  });

  it('marks what is already installed and removes it after a confirmation', async () => {
    const { bridge, user } = renderPage({
      ...withCatalog,
      'mcp.listInstalled': [
        {
          serverId: 'filesystem',
          repositoryId: 'repo-1',
          version: '1.0.0',
          installedAt: '2026-01-02T00:00:00.000Z',
        },
      ],
    });
    await screen.findByText('Filesystem');
    await user.click(screen.getAllByRole('combobox')[0]);
    await user.click(await screen.findByText('Aurora'));

    const card = serverCard('Filesystem');
    expect(await within(card).findByText('Installed')).toBeTruthy();

    await user.click(within(card).getByRole('button', { name: /Remove/ }));

    await waitFor(() =>
      expect(confirm.confirmDialog).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Remove "Filesystem"?',
          description: 'This removes it from Aurora.',
        }),
      ),
    );
    await waitFor(() =>
      expect(bridge.$fn('mcp.remove')).toHaveBeenCalledWith({
        projectId: 'p1',
        serverId: 'filesystem',
      }),
    );
  });

  it('offers to show only what is installed once a project is picked', async () => {
    const { user } = renderPage({
      ...withCatalog,
      'mcp.listInstalled': [
        {
          serverId: 'filesystem',
          repositoryId: 'repo-1',
          version: '1.0.0',
          installedAt: '2026-01-02T00:00:00.000Z',
        },
      ],
    });
    await screen.findByText('Filesystem');
    // The filter is meaningless without a project, so it only appears with one.
    expect(screen.queryByRole('button', { name: /^Installed/ })).toBeNull();

    await user.click(screen.getAllByRole('combobox')[0]);
    await user.click(await screen.findByText('Aurora'));

    await user.click(await screen.findByRole('button', { name: 'Installed (1)' }));

    await waitFor(() => expect(screen.queryByText('Postgres')).toBeNull());
    expect(screen.getByText('Filesystem')).toBeTruthy();
  });

  it('does not offer an install it cannot run', async () => {
    renderPage({
      'projects.list': projects,
      'mcp.listRepositories': [community],
      'mcp.getRepositoryIndex': async () => ({ name: 'Community', servers: [manualOnly] }),
    });

    await screen.findByText('Manual Server');
    const card = serverCard('Manual Server');
    expect(within(card).getByText('Manual setup')).toBeTruthy();
    expect(within(card).getByRole('button', { name: /Install/ })).toBeDisabled();
  });

  it('opens a server website and repository in the system browser', async () => {
    const { bridge, user } = renderPage(withCatalog);
    await screen.findByText('Filesystem');

    await user.click(screen.getByRole('button', { name: 'Open Filesystem website' }));
    await user.click(screen.getByRole('button', { name: 'Open Filesystem source repository' }));

    expect(bridge.$fn('shell.openExternal')).toHaveBeenCalledWith('https://example.com/filesystem');
    expect(bridge.$fn('shell.openExternal')).toHaveBeenLastCalledWith(
      'https://github.com/example/filesystem',
    );
  });

  it('starts with the project the URL came in with', async () => {
    const { bridge } = renderPage(withCatalog, '/mcp?projectId=p2');

    await screen.findByText('Filesystem');
    await waitFor(() => expect(bridge.$fn('mcp.listInstalled')).toHaveBeenCalledWith('p2'));
    expect(screen.getByText('Borealis')).toBeTruthy();
  });
});
