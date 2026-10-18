import type { LinkCandidateProject, RemoteProject } from '@agentmat/core';
import type { ErrorIssueQuery } from '@shared/errorTrackingTypes';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { connection, detail, issue, link, page, project, remoteProject } from './testing/fixtures';

vi.mock('@/lib/workspace/launch', () => ({
  launchPromptTab: vi.fn(() => 'tab-1'),
  projectCliId: () => 'claude-code',
}));
vi.mock('@/components/promptBuilder/RunRecommendation', () => ({
  useRunRecommendation: () => ({
    status: 'idle',
    recommendation: null,
    choice: null,
    analyze: vi.fn(),
  }),
  RunRecommendationPanel: () => <div>sizing panel</div>,
}));
const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    dismiss: vi.fn(),
  }),
);
vi.mock('sonner', () => ({ toast }));
vi.mock('@agentmat/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agentmat/core')>()),
  suggestRemoteProjects: (candidate: LinkCandidateProject, remote: readonly RemoteProject[]) =>
    remote.filter((one) => one.slug.startsWith(candidate.name.toLowerCase())),
}));

const { ErrorsBoard } = await import('./ErrorsBoard');

const projects = [project(), project({ id: 'p2', name: 'Admin' })];
const TITLE = "TypeError: Cannot read properties of undefined (reading 'total')";

function connected(bridge: Record<string, unknown> = {}) {
  return {
    'projects.list': projects,
    'errorTracking.listConnections': [connection()],
    'errorTracking.listLinks': [
      link(),
      link({ projectId: 'p2', remoteProjectId: '13', remoteSlug: 'admin', remoteName: 'admin' }),
    ],
    'errorTracking.environments': [],
    'errorTracking.listIssues': async () =>
      page({
        issues: [
          issue(),
          issue({ id: '4502', shortId: 'ADM-1', title: 'Admin crash', projectId: 'p2' }),
        ],
      }),
    'errorTracking.getIssue': async () => detail(),
    ...bridge,
  };
}

function renderBoard(
  options: { projectId?: string; route?: string; bridge?: Record<string, unknown> } = {},
) {
  return renderWithProviders(<ErrorsBoard projectId={options.projectId} />, {
    route: options.route ?? '/monitoring?view=errors',
    path: 'monitoring',
    bridge: options.bridge ?? connected(),
  });
}

function lastQuery(bridge: { $fn: (path: string) => { mock: { calls: unknown[][] } } }) {
  const calls = bridge.$fn('errorTracking.listIssues').mock.calls;
  return calls.at(-1)?.[0] as ErrorIssueQuery;
}

describe('ErrorsBoard, first run', () => {
  it('explains the three steps and opens the connect dialog', async () => {
    const { user } = renderBoard({
      bridge: { 'projects.list': projects, 'errorTracking.listConnections': [] },
    });
    expect(await screen.findByText('See what breaks for your users')).toBeInTheDocument();
    const steps = screen.getByRole('list', { name: 'How to start' });
    expect(within(steps).getAllByRole('listitem')).toHaveLength(3);
    expect(steps).toHaveTextContent('org:read');
    expect(steps).toHaveTextContent('project:read');
    expect(steps).toHaveTextContent('event:read');
    expect(steps).toHaveTextContent('event:write');
    expect(within(steps).getByRole('link', { name: /token page/ })).toHaveAttribute(
      'href',
      'https://sentry.io/settings/account/api/auth-tokens/',
    );

    await user.click(within(steps).getByRole('button', { name: 'Copy scopes' }));
    expect(await navigator.clipboard.readText()).toBe(
      'org:read, project:read, event:read, event:write',
    );

    await user.click(screen.getByRole('button', { name: 'Connect Sentry' }));
    expect(
      await screen.findByRole('dialog', { name: 'Error tracking connections' }),
    ).toBeInTheDocument();
  });

  it('shimmers per row while it loads, without a page overlay', async () => {
    const { queryClient } = renderBoard({
      bridge: {
        'projects.list': projects,
        'errorTracking.listConnections': () => new Promise(() => undefined),
      },
    });
    expect(await screen.findAllByTestId('issue-row-skeleton')).not.toHaveLength(0);
    const loud = queryClient
      .getQueryCache()
      .getAll()
      .filter((query) => query.queryKey[0] === 'error-tracking' && !query.meta?.silentLoading);
    expect(loud).toHaveLength(0);
  });

  it('says so when the connections cannot be read', async () => {
    renderBoard({
      bridge: {
        'projects.list': projects,
        'errorTracking.listConnections': async () => {
          throw new Error('Store unreadable');
        },
      },
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('Store unreadable');
  });
});

describe('ErrorsBoard, the list', () => {
  it('groups the issues by project on the Monitoring page', async () => {
    const { bridge } = renderBoard();
    const list = await screen.findByRole('list', { name: 'Issues' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual(['Admin', 'Storefront']);
    expect(lastQuery(bridge)).toEqual({
      status: 'unresolved',
      period: '14d',
      sort: 'lastSeen',
      cursor: null,
    });
    expect(screen.getByRole('group', { name: 'Projects' })).toBeInTheDocument();
  });

  it('narrows to one project with its chip', async () => {
    const { user, bridge } = renderBoard();
    await screen.findByRole('list', { name: 'Issues' });
    await user.click(screen.getByRole('button', { name: 'Admin' }));
    await waitFor(() => expect(lastQuery(bridge).projectId).toBe('p2'));
  });

  it('sends every filter to the main process', async () => {
    const { user, bridge } = renderBoard({
      bridge: connected({ 'errorTracking.environments': ['production', 'staging'] }),
    });
    await screen.findByRole('list', { name: 'Issues' });

    await user.click(
      within(screen.getByRole('group', { name: 'Issue status' })).getByRole('button', {
        name: 'Resolved',
      }),
    );
    await waitFor(() => expect(lastQuery(bridge).status).toBe('resolved'));

    await user.click(
      within(screen.getByRole('group', { name: 'Period' })).getByRole('button', { name: '24h' }),
    );
    await waitFor(() => expect(lastQuery(bridge).period).toBe('24h'));

    await user.click(screen.getByRole('combobox', { name: 'Sort issues' }));
    await user.click(await screen.findByRole('option', { name: 'Most events' }));
    await waitFor(() => expect(lastQuery(bridge).sort).toBe('events'));

    await user.click(await screen.findByRole('combobox', { name: 'Environment filter' }));
    await user.click(await screen.findByRole('option', { name: 'production' }));
    await waitFor(() => expect(lastQuery(bridge).environment).toBe('production'));

    await user.type(screen.getByLabelText('Search issues'), 'checkout');
    await waitFor(() => expect(lastQuery(bridge).search).toBe('checkout'), { timeout: 2000 });
  });

  it('refreshes past the cache and says when it last read', async () => {
    const { user, bridge } = renderBoard();
    await screen.findByRole('list', { name: 'Issues' });
    expect(screen.getByText(/Updated .* ago|Updated just now/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Refresh issues' }));
    await waitFor(() => expect(lastQuery(bridge).refresh).toBe(true));
  });

  it('keeps the rows and shows a notice when a refresh fails', async () => {
    let fail = false;
    const { user } = renderBoard({
      bridge: connected({
        'errorTracking.listIssues': async () => {
          if (fail) throw new Error('Sentry is rate limiting, try again in 30s');
          return page();
        },
      }),
    });
    await screen.findByRole('list', { name: 'Issues' });
    fail = true;
    await user.click(screen.getByRole('button', { name: 'Refresh issues' }));
    expect(await screen.findByText(/Could not refresh/)).toHaveTextContent('rate limiting');
    expect(screen.getByRole('list', { name: 'Issues' })).toBeInTheDocument();
  });

  it('shows the failure when the first read fails', async () => {
    renderBoard({
      bridge: connected({
        'errorTracking.listIssues': async () => {
          throw new Error('Token rejected');
        },
      }),
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('Token rejected');
  });

  it('names a connection that failed while the others answered', async () => {
    renderBoard({
      bridge: connected({
        'errorTracking.listIssues': async () =>
          page({
            failures: [
              { connectionId: 'c2', label: 'Side', message: 'Token rejected', locked: false },
            ],
          }),
      }),
    });
    expect(await screen.findByText(/Could not read Side/)).toHaveTextContent('Token rejected');
  });

  it('shows the failure, not an all clear, when every connection failed', async () => {
    renderBoard({
      bridge: connected({
        'errorTracking.listIssues': async () =>
          page({
            issues: [],
            failures: [
              { connectionId: 'c1', label: 'Acme', message: 'Token rejected', locked: false },
            ],
          }),
      }),
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not read Acme: Token rejected',
    );
    expect(screen.queryByText(/No unresolved errors/)).toBeNull();
  });

  it('offers to unlock when the vault shut a connection', async () => {
    renderBoard({
      bridge: connected({
        'errorTracking.listIssues': async () =>
          page({
            issues: [],
            failures: [{ connectionId: 'c1', label: 'Acme', message: 'Locked', locked: true }],
          }),
      }),
    });
    expect(await screen.findByText(/locked with a passkey/)).toBeInTheDocument();
    expect(screen.queryByText(/No unresolved errors/)).toBeNull();
  });

  it('offers to unlock a locked vault', async () => {
    const { user } = renderBoard({
      bridge: connected({ 'errorTracking.listConnections': [connection({ locked: true })] }),
    });
    expect(await screen.findByText(/locked with a passkey/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Unlock' }));
    expect(await screen.findByRole('dialog', { name: /Unlock/ })).toBeInTheDocument();
  });

  it('loads more with the cursor', async () => {
    const list = vi.fn(async (query: ErrorIssueQuery) =>
      query.cursor
        ? page({ issues: [issue({ id: '9', title: 'Second page issue' })] })
        : page({ nextCursor: '0:100:0' }),
    );
    const { user } = renderBoard({ bridge: connected({ 'errorTracking.listIssues': list }) });
    await screen.findByRole('list', { name: 'Issues' });
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByRole('button', { name: 'Second page issue' })).toBeInTheDocument();
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: '0:100:0' }));
  });

  it('says there is nothing to fix when the list is empty', async () => {
    renderBoard({
      bridge: connected({ 'errorTracking.listIssues': async () => page({ issues: [] }) }),
    });
    expect(await screen.findByText(/No unresolved errors/)).toBeInTheDocument();
  });

  it('opens an issue from its row and from a ?issue link', async () => {
    const first = renderBoard();
    await first.user.click(await screen.findByRole('button', { name: TITLE }));
    expect(await screen.findByRole('dialog', { name: TITLE })).toBeInTheDocument();
    first.unmount();

    renderBoard({ route: '/monitoring?view=errors&issue=c1:4501' });
    expect(await screen.findByRole('dialog', { name: TITLE })).toBeInTheDocument();
  });

  it('copies the prompt from a row', async () => {
    const { user } = renderBoard({
      bridge: connected({
        'errorTracking.fixPrompt': async () => ({ prompt: 'Fix WEB-3F now.', copy: 'plain' }),
      }),
    });
    const list = await screen.findByRole('list', { name: 'Issues' });
    const row = within(list).getAllByRole('listitem')[1];
    await user.click(within(row).getByRole('button', { name: 'Copy for AI' }));
    await waitFor(async () => expect(await navigator.clipboard.readText()).toBe('Fix WEB-3F now.'));
  });

  it('opens Fix with AI from a row', async () => {
    const { user } = renderBoard({
      bridge: connected({
        'errorTracking.fixPrompt': async () => ({ prompt: 'Fix WEB-3F now.', copy: 'plain' }),
      }),
    });
    const list = await screen.findByRole('list', { name: 'Issues' });
    const row = within(list).getAllByRole('listitem')[1];
    await user.click(within(row).getByRole('button', { name: 'Fix with AI' }));
    expect(await screen.findByRole('dialog', { name: 'Fix WEB-3F with AI' })).toBeInTheDocument();
  });
});

describe('ErrorsBoard on a project tab', () => {
  it('lists that project flat, without project groups', async () => {
    const { bridge } = renderBoard({
      projectId: 'p1',
      bridge: connected({ 'errorTracking.listLinks': [link()] }),
    });
    const list = await screen.findByRole('list', { name: 'Issues' });
    expect(within(list).getAllByRole('listitem').length).toBeGreaterThan(0);
    expect(screen.queryByRole('heading', { level: 2 })).toBeNull();
    expect(screen.queryByRole('group', { name: 'Projects' })).toBeNull();
    expect(lastQuery(bridge).projectId).toBe('p1');
  });

  it('offers to link the project when Sentry is connected but this project is not', async () => {
    const setLinks = vi.fn(async () => [link()]);
    const { user } = renderBoard({
      projectId: 'p1',
      bridge: connected({
        'errorTracking.listLinks': [],
        'errorTracking.remoteProjects': [remoteProject()],
        'errorTracking.setLinks': setLinks,
      }),
    });
    const picker = await screen.findByRole('combobox', { name: 'Sentry projects for Storefront' });
    await waitFor(() => expect(picker).toHaveTextContent('storefront-web'));
    expect(screen.queryByRole('combobox', { name: 'Sentry projects for Admin' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Save links' }));
    await waitFor(() =>
      expect(setLinks).toHaveBeenCalledWith('p1', [
        expect.objectContaining({ remoteProjectId: '11' }),
      ]),
    );
  });
});

describe('ErrorsBoard, connected with nothing linked', () => {
  it('asks to link projects on the Monitoring page', async () => {
    const { user } = renderBoard({
      bridge: connected({ 'errorTracking.listLinks': [], 'errorTracking.remoteProjects': [] }),
    });
    await user.click(await screen.findByRole('button', { name: 'Link projects' }));
    expect(
      await screen.findByRole('dialog', { name: 'Error tracking connections' }),
    ).toBeInTheDocument();
  });
});
