import type {
  GithubActionsActivity,
  GithubActionsHistoryItem,
  GithubRunner,
  GithubRunnersResult,
} from '@shared/apiTypes';
import { act, screen, waitFor, within } from '@testing-library/react';
import { useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { queryKeys } from '@/lib/queryKeys';
import { useTerminalStore } from '@/stores/terminalStore';
import { renderWithProviders } from '../../../test/renderer/renderWithProviders';

/**
 * Pipelines is a read-only list of GitHub Actions runs plus the few things the user can do with
 * one: open it, stop it, mark its failure notice read. Most of the page is really about what to
 * say when there is nothing to show, since gh may be missing, signed out or simply empty.
 *
 * Order matters in this file. useLastGoodData keeps the last good response in a module-level
 * map that outlives a test, so the cases that need "nothing saved yet" come before the ones
 * that load runs.
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

const { default: PipelinesPage } = await import('./PipelinesPage');

function run(overrides: Partial<GithubActionsHistoryItem> & { id: number }) {
  const item: GithubActionsHistoryItem = {
    projectId: 'p1',
    projectName: 'Aurora',
    repo: 'acme/aurora',
    workflowName: 'CI',
    displayTitle: 'Tighten the retry loop',
    runNumber: 41,
    headBranch: 'main',
    status: 'completed',
    conclusion: 'success',
    htmlUrl: 'https://github.com/acme/aurora/actions/runs/1',
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-01T10:04:00.000Z',
    ...overrides,
  };
  return item;
}

const passed = run({ id: 1 });
const failed = run({
  id: 2,
  conclusion: 'failure',
  displayTitle: 'Break the build',
  runNumber: 42,
  repo: 'acme/borealis',
  projectId: 'p2',
  projectName: 'Borealis',
  htmlUrl: 'https://github.com/acme/borealis/actions/runs/2',
});
const running = run({
  id: 3,
  status: 'in_progress',
  conclusion: null,
  displayTitle: 'Deploy docs',
  runNumber: 43,
  htmlUrl: 'https://github.com/acme/aurora/actions/runs/3',
});

function activity(overrides: Partial<GithubActionsActivity> = {}): GithubActionsActivity {
  return {
    ok: true,
    cliAvailable: true,
    authenticated: true,
    days: [],
    runs: [passed, failed, running],
    weekPassed: 1,
    weekFailed: 1,
    runningCount: 1,
    repoCount: 2,
    ...overrides,
  };
}

/**
 * The page plus a probe for the current URL, since two of its behaviours (opening a project,
 * consuming a deep link's query string) are only visible as a route change.
 */
function renderPage(bridge: Record<string, unknown> = {}, route = '/pipelines') {
  function Harness(): React.JSX.Element {
    const location = useLocation();
    return (
      <>
        <PipelinesPage />
        <p data-testid="location">{`${location.pathname}${location.search}`}</p>
      </>
    );
  }
  return renderWithProviders(<Harness />, { route, bridge });
}

function currentLocation(): string {
  return screen.getByTestId('location').textContent ?? '';
}

/** The row a run's title heads. */
function runRow(title: string): HTMLElement {
  const row = screen.getByText(title).closest('li');
  if (!row) throw new Error(`No row for "${title}"`);
  return row;
}

/**
 * One of the outcome tabs. They are matched on their own text (label plus count) because
 * "Failed" also appears on the rows themselves.
 */
function filterTab(label: string): HTMLElement {
  const tab = screen
    .getAllByRole('button')
    .find((button) => new RegExp(`^${label}\\d+$`).test(button.textContent ?? ''));
  if (!tab) throw new Error(`No "${label}" filter tab`);
  return tab;
}

describe('PipelinesPage when there is nothing to show', () => {
  it('asks for a GitHub remote when gh is signed in but no repo is watched', async () => {
    renderPage({
      'pipelines.dashboardActivity': async () => activity({ runs: [], repoCount: 0 }),
    });

    expect(
      await screen.findByText(
        'Add a GitHub remote on a project and its Actions runs show up here.',
      ),
    ).toBeTruthy();
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
  });

  it('points at the GitHub CLI when it is not installed', async () => {
    renderPage({
      'pipelines.dashboardActivity': async () =>
        activity({ ok: false, cliAvailable: false, authenticated: false, runs: [], repoCount: 0 }),
    });

    expect(await screen.findByRole('button', { name: 'GitHub CLI' })).toBeTruthy();
  });

  it('offers to sign in when gh is installed but logged out', async () => {
    const { user } = renderPage({
      'pipelines.dashboardActivity': async () =>
        activity({ ok: false, authenticated: false, runs: [], repoCount: 0 }),
    });

    await user.click(await screen.findByRole('button', { name: 'gh auth login' }));

    const session = useTerminalStore
      .getState()
      .sessions.find((one) => one.title === 'GitHub login');
    expect(session?.initialInput).toBe('gh auth login');
    expect(toast.info).toHaveBeenCalledWith('Press Enter in the terminal to sign in to GitHub.');
  });

  it('explains a failed load and offers to try again', async () => {
    const { bridge, user } = renderPage({
      'pipelines.dashboardActivity': async () =>
        activity({ ok: false, error: 'HTTP 403: rate limit exceeded', runs: [], repoCount: 0 }),
    });

    await user.click(await screen.findByRole('button', { name: /Try again/ }));

    await waitFor(() =>
      expect(bridge.$fn('pipelines.dashboardActivity').mock.calls.length).toBeGreaterThan(1),
    );
  });

  it('says to add a GitHub remote when no repo was found', async () => {
    renderPage({
      'pipelines.dashboardActivity': async () => activity({ runs: [], repoCount: 0 }),
    });

    expect(
      await screen.findByText(
        'Add a GitHub remote on a project and its Actions runs show up here.',
      ),
    ).toBeTruthy();
  });

  it('survives the bridge rejecting outright', async () => {
    renderPage({
      'pipelines.dashboardActivity': () => Promise.reject(new Error('gh: command not found')),
    });

    // No saved list to fall back on, so the page shows its own empty state rather than breaking.
    expect(
      await screen.findByText(
        'Add a GitHub remote on a project and its Actions runs show up here.',
      ),
    ).toBeTruthy();
  });

  it('says there are no runs yet when the repos are there but have never run', async () => {
    renderPage({
      'pipelines.dashboardActivity': async () => activity({ runs: [], repoCount: 3 }),
    });

    expect(await screen.findByText('No workflow runs yet.')).toBeTruthy();
  });

  it('leaves the runner panel out until GitHub is connected', async () => {
    renderPage({
      // `ok: true` so the page shows this answer rather than a list an earlier test saved.
      'pipelines.dashboardActivity': async () =>
        activity({ authenticated: false, runs: [], repoCount: 0 }),
      'pipelines.runners': async () => ({
        ok: true,
        runners: [],
        waiting: [],
        hiddenOrgs: ['acme'],
      }),
    });

    await screen.findByRole('button', { name: 'gh auth login' });
    expect(screen.queryByRole('region', { name: 'Self-hosted runners' })).toBeNull();
  });
});

describe('PipelinesPage run list', () => {
  const withRuns = { 'pipelines.dashboardActivity': async () => activity() };

  it('lists every run with its repo, workflow, branch and outcome', async () => {
    renderPage(withRuns);

    await screen.findByText('Tighten the retry loop');
    const row = runRow('Tighten the retry loop');
    expect(within(row).getByText('acme/aurora')).toBeTruthy();
    expect(within(row).getByText('CI')).toBeTruthy();
    expect(within(row).getByText('main')).toBeTruthy();
    expect(within(row).getByText('#41')).toBeTruthy();
    expect(within(row).getByText('Passed')).toBeTruthy();

    expect(within(runRow('Break the build')).getByText('Failed')).toBeTruthy();
    expect(within(runRow('Deploy docs')).getByText('Running')).toBeTruthy();
    expect(screen.getByText('Showing 3 of 3 runs across 2 repos.')).toBeTruthy();
  });

  it('filters by outcome, with a count on every tab', async () => {
    const { user } = renderPage(withRuns);
    await screen.findByText('Tighten the retry loop');

    await user.click(filterTab('Failed'));

    await waitFor(() => expect(screen.queryByText('Tighten the retry loop')).toBeNull());
    expect(screen.getByText('Break the build')).toBeTruthy();
    expect(screen.getByText('Showing 1 of 3 runs across 2 repos.')).toBeTruthy();
  });

  it('filters by search text and says so when nothing matches', async () => {
    const { user } = renderPage(withRuns);
    await screen.findByText('Tighten the retry loop');

    await user.type(screen.getByPlaceholderText('Search runs'), 'docs');
    await waitFor(() => expect(screen.queryByText('Break the build')).toBeNull());
    expect(screen.getByText('Deploy docs')).toBeTruthy();

    await user.clear(screen.getByPlaceholderText('Search runs'));
    await user.type(screen.getByPlaceholderText('Search runs'), 'nothing like this');

    expect(await screen.findByText('No runs match these filters')).toBeTruthy();
    expect(screen.getByText(/3 runs loaded across 2 repos/)).toBeTruthy();
  });

  it('filters by repository and clears every filter at once', async () => {
    const { user } = renderPage(withRuns);
    await screen.findByText('Tighten the retry loop');

    // The repo name is on the rows too, so the pick has to come from the filter card's list.
    const repos = screen.getByRole('group', { name: 'Repositories' });
    expect(within(repos).getByRole('button', { name: /^All repos/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    const borealis = within(repos).getByRole('button', { name: /^acme\/borealis/ });
    // Each repo says how many of the loaded runs are its own.
    expect(borealis.textContent).toBe('acme/borealis1');
    await user.click(borealis);

    await waitFor(() => expect(screen.queryByText('Tighten the retry loop')).toBeNull());
    expect(borealis).toHaveAttribute('aria-pressed', 'true');

    await user.click(screen.getByRole('button', { name: 'Clear' }));

    expect(await screen.findByText('Tighten the retry loop')).toBeTruthy();
    expect(within(repos).getByRole('button', { name: /^All repos/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('marks the status filter that is on', async () => {
    const { user } = renderPage(withRuns);
    await screen.findByText('Tighten the retry loop');

    expect(filterTab('All')).toHaveAttribute('aria-pressed', 'true');
    await user.click(filterTab('Running'));

    expect(filterTab('Running')).toHaveAttribute('aria-pressed', 'true');
    expect(filterTab('All')).toHaveAttribute('aria-pressed', 'false');
  });

  it('lays the filters and the run list out as two resizable cards', async () => {
    const { user } = renderPage(withRuns);
    await screen.findByText('Tighten the retry loop');

    const filters = screen.getByRole('complementary', { name: 'Run filters' });
    expect(within(filters).getByRole('group', { name: 'Status' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Runs' })).toBeTruthy();

    const handle = screen.getByRole('separator', { name: 'Resize filters' });
    const before = Number(handle.getAttribute('aria-valuenow'));
    handle.focus();
    await user.keyboard('{ArrowRight}');
    expect(Number(handle.getAttribute('aria-valuenow'))).toBe(before + 16);
  });

  it('keeps the filter card out of the way until there are runs to filter', async () => {
    renderPage({ 'pipelines.dashboardActivity': async () => activity({ runs: [] }) });

    expect(await screen.findByText('No workflow runs yet.')).toBeTruthy();
    expect(screen.queryByRole('complementary', { name: 'Run filters' })).toBeNull();
    // Refresh stays on the run card, so an empty answer can be asked for again.
    expect(screen.getByRole('button', { name: 'Refresh runs' })).toBeTruthy();
  });

  it('opens a run in the browser when its row is clicked', async () => {
    const { bridge, user } = renderPage(withRuns);
    await screen.findByText('Break the build');

    await user.click(screen.getByText('Break the build'));

    expect(bridge.$fn('shell.openExternal')).toHaveBeenCalledWith(
      'https://github.com/acme/borealis/actions/runs/2',
    );
  });

  it('opens the project a run belongs to, on its git tab', async () => {
    const { user } = renderPage(withRuns);
    await screen.findByText('Break the build');

    await user.click(
      within(runRow('Break the build')).getByRole('button', { name: 'Open Borealis' }),
    );

    await waitFor(() => expect(currentLocation()).toBe('/projects/p2?tab=git'));
  });

  it('refreshes on demand', async () => {
    const { bridge, user } = renderPage(withRuns);
    await screen.findByText('Tighten the retry loop');
    const before = bridge.$fn('pipelines.dashboardActivity').mock.calls.length;

    await user.click(screen.getByRole('button', { name: 'Refresh runs' }));

    await waitFor(() =>
      expect(bridge.$fn('pipelines.dashboardActivity').mock.calls.length).toBeGreaterThan(before),
    );
  });
});

describe('PipelinesPage failure notices', () => {
  const notification = {
    id: 'n1',
    kind: 'pipeline-failed',
    title: 'CI failed',
    body: 'acme/borealis #42',
    projectId: 'p2',
    projectName: 'Borealis',
    htmlUrl: 'https://github.com/acme/borealis/actions/runs/2',
    createdAt: '2026-09-01T10:05:00.000Z',
    read: false,
  };

  it('marks the run that raised an unread notice', async () => {
    renderPage({
      'pipelines.dashboardActivity': async () => activity(),
      'appNotifications.list': [notification],
    });

    await screen.findByText('Break the build');
    const row = runRow('Break the build');
    expect(await within(row).findByText('New')).toBeTruthy();
    expect(within(runRow('Tighten the retry loop')).queryByText('New')).toBeNull();
  });

  it('marks the notice read when its run is opened', async () => {
    const { bridge, user } = renderPage({
      'pipelines.dashboardActivity': async () => activity(),
      'appNotifications.list': [notification],
    });
    await screen.findByText('Break the build');

    await user.click(screen.getByText('Break the build'));

    await waitFor(() => expect(bridge.$fn('appNotifications.markRead')).toHaveBeenCalledWith('n1'));
  });

  it('lists unread notices that open a page in the app, and follows their route', async () => {
    const alert = {
      ...notification,
      id: 'd1',
      kind: 'deploy-warning',
      title: 'Production: disk filling up',
      body: '/ is 91% full.',
      projectId: null,
      projectName: '',
      htmlUrl: null,
      route: '/deploy?server=srv-1',
    };
    const { bridge, user } = renderPage({
      'pipelines.dashboardActivity': async () => activity(),
      'appNotifications.list': [
        notification,
        alert,
        { ...alert, id: 'd2', route: '//evil.example' },
      ],
    });
    const list = await screen.findByRole('list', { name: 'Other notices' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);

    await user.click(within(list).getByRole('button', { name: /Production: disk filling up/ }));

    await waitFor(() => expect(bridge.$fn('appNotifications.markRead')).toHaveBeenCalledWith('d1'));
    expect(currentLocation()).toBe('/deploy?server=srv-1');
  });

  it('marks every notice read at once', async () => {
    const { bridge, user } = renderPage({
      'pipelines.dashboardActivity': async () => activity(),
      'appNotifications.list': [notification],
    });

    await user.click(await screen.findByRole('button', { name: /Mark all read/ }));

    await waitFor(() => expect(bridge.$fn('appNotifications.markAllRead')).toHaveBeenCalled());
  });

  it('reloads when the main process reports a notification change', async () => {
    const { bridge } = renderPage({
      'pipelines.dashboardActivity': async () => activity(),
      'appNotifications.list': [],
    });
    await screen.findByText('Break the build');
    const before = bridge.$fn('appNotifications.list').mock.calls.length;

    act(() => bridge.$emit('appNotifications.onChanged'));

    await waitFor(() =>
      expect(bridge.$fn('appNotifications.list').mock.calls.length).toBeGreaterThan(before),
    );
  });
});

describe('PipelinesPage deep links', () => {
  function renderDeepLink(route: string) {
    return renderPage({ 'pipelines.dashboardActivity': async () => activity() }, route);
  }

  it('shows the run the pet announced, with no filter left over from last time', async () => {
    renderDeepLink('/pipelines?run=2&repo=acme/borealis');

    expect(await screen.findByText('Break the build')).toBeTruthy();
    // Arriving on a run must not hide the rest of the list.
    expect(screen.getByText('Tighten the retry loop')).toBeTruthy();
  });

  it('drops the query string so a later refresh does not jump around again', async () => {
    renderDeepLink('/pipelines?run=2&repo=acme/borealis');

    await waitFor(() => expect(currentLocation()).toBe('/pipelines'));
  });

  it('ignores a query string that names no run', async () => {
    renderDeepLink('/pipelines?run=not-a-number');

    expect(await screen.findByText('Break the build')).toBeTruthy();
    // Nothing was consumed, since there was nothing to act on.
    expect(currentLocation()).toBe('/pipelines?run=not-a-number');
  });
});

describe('PipelinesPage keeping the last list', () => {
  it('keeps showing the runs that did load when a later refresh fails', async () => {
    let fail = false;
    const { bridge, user } = renderPage({
      'pipelines.dashboardActivity': async () =>
        fail ? activity({ ok: false, error: 'HTTP 500', runs: [], repoCount: 0 }) : activity(),
    });
    await screen.findByText('Tighten the retry loop');

    fail = true;
    await user.click(screen.getByRole('button', { name: 'Refresh runs' }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'Could not refresh runs',
        expect.objectContaining({
          description: 'HTTP 500 Showing the last data that loaded.',
        }),
      ),
    );
    // The list the user was reading is still on screen, and the button says the refresh failed.
    expect(screen.getByText('Tighten the retry loop')).toBeTruthy();
    expect(
      await screen.findByRole('button', { name: 'Refresh runs, last refresh failed' }),
    ).toBeTruthy();
    expect(bridge.$fn('pipelines.dashboardActivity')).toHaveBeenCalled();
  });
});

/**
 * Last on purpose: these load runners, and the runner panel keeps the last good answer in the
 * same kind of module-level map, so anything after them would see a panel it did not ask for.
 */
describe('PipelinesPage self-hosted runners', () => {
  function runners(overrides: Partial<GithubRunner> = {}): GithubRunnersResult {
    return {
      ok: true,
      runners: [
        {
          name: 'deploy-box',
          scope: { kind: 'org', name: 'acme' },
          os: 'Linux',
          arch: 'X64',
          state: 'busy',
          labels: ['self-hosted', 'Linux', 'X64'],
          customLabels: [],
          currentJob: {
            repo: 'acme/aurora',
            runId: 3,
            jobName: 'publish',
            workflowName: 'Docs',
            htmlUrl: 'https://github.com/acme/aurora/actions/runs/3/job/30',
          },
          ...overrides,
        },
      ],
      waiting: [],
      hiddenOrgs: ['acme'],
    };
  }

  function renderWithRunners(answer: GithubRunnersResult = runners()) {
    return renderPage({
      'pipelines.dashboardActivity': async () => activity(),
      'pipelines.runners': async () => answer,
    });
  }

  it('shows the runner panel above the run filters', async () => {
    renderWithRunners();

    const region = await screen.findByRole('region', { name: 'Self-hosted runners' });
    await screen.findByText('deploy-box');

    expect(
      region.compareDocumentPosition(filterTab('All')) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('brings up the run a busy runner is on, clearing filters that hide it', async () => {
    const { bridge, user } = renderWithRunners();
    await screen.findByText('Deploy docs');
    await user.click(filterTab('Failed'));
    await waitFor(() => expect(screen.queryByText('Deploy docs')).toBeNull());

    await user.click(await screen.findByRole('button', { name: 'Docs · publish' }));

    await waitFor(() => expect(runRow('Deploy docs').className).toContain('run-blink'));
    // The run is right here, so nothing should have gone to the browser.
    expect(() => bridge.$fn('shell.openExternal')).toThrow(/not been touched/);
  });

  it('opens the job on GitHub when its run is not in the list', async () => {
    const elsewhere = runners({
      currentJob: {
        repo: 'acme/other',
        runId: 999,
        jobName: 'publish',
        workflowName: 'Docs',
        htmlUrl: 'https://github.com/acme/other/actions/runs/999/job/1',
      },
    });
    const { bridge, user } = renderWithRunners(elsewhere);

    await user.click(await screen.findByRole('button', { name: 'Docs · publish' }));

    await waitFor(() =>
      expect(bridge.$fn('shell.openExternal')).toHaveBeenCalledWith(
        'https://github.com/acme/other/actions/runs/999/job/1',
      ),
    );
  });

  it('opens a terminal to grant org admin access', async () => {
    const { user } = renderWithRunners();

    await user.click(await screen.findByRole('button', { name: 'Grant access' }));

    const session = useTerminalStore
      .getState()
      .sessions.find((one) => one.title === 'GitHub org access');
    expect(session?.initialInput).toBe('gh auth refresh -h github.com -s admin:org');
    expect(toast.info).toHaveBeenCalledWith(
      'Press Enter in the terminal, then approve the new scope in your browser.',
    );
  });

  it('refreshes the runners with the runs', async () => {
    const { bridge, user } = renderWithRunners();
    await screen.findByText('deploy-box');
    const before = bridge.$fn('pipelines.runners').mock.calls.length;

    await user.click(screen.getByRole('button', { name: 'Refresh runs' }));

    await waitFor(() =>
      expect(bridge.$fn('pipelines.runners').mock.calls.length).toBeGreaterThan(before),
    );
  });
});

/** Also after the runner tests, for the same reason. */
describe('PipelinesPage runner follow-ups', () => {
  const answer: GithubRunnersResult = {
    ok: true,
    runners: [
      {
        name: 'deploy-box',
        scope: { kind: 'org', name: 'acme' },
        os: 'Linux',
        arch: 'X64',
        state: 'busy',
        labels: ['self-hosted', 'Linux', 'X64'],
        customLabels: [],
        currentJob: {
          repo: 'acme/aurora',
          runId: 3,
          jobName: 'publish',
          workflowName: 'Docs',
          htmlUrl: 'https://github.com/acme/aurora/actions/runs/3/job/30',
        },
      },
    ],
    waiting: [],
    hiddenOrgs: [],
  };

  function renderWithRunners() {
    return renderPage({
      'pipelines.dashboardActivity': async () => activity(),
      'pipelines.runners': async () => answer,
    });
  }

  it('asks GitHub afresh for runners on a refresh, and only for that one lookup', async () => {
    const { bridge, user, queryClient } = renderWithRunners();
    await screen.findByText('deploy-box');
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    const calls = bridge.$fn('pipelines.runners');
    expect(calls.mock.lastCall?.[0]).not.toHaveProperty('fresh');
    const before = calls.mock.calls.length;

    await user.click(screen.getByRole('button', { name: 'Refresh runs' }));

    await waitFor(() => expect(calls).toHaveBeenCalledTimes(before + 1));
    expect(calls.mock.lastCall?.[0]).toMatchObject({ fresh: true });
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));

    // The next poll goes back to the normal lookup.
    await act(() => queryClient.refetchQueries({ queryKey: queryKeys.githubRunners }));
    expect(calls).toHaveBeenCalledTimes(before + 2);
    expect(calls.mock.lastCall?.[0]).not.toHaveProperty('fresh');
  });

  it('scrolls to the run a runner is on', async () => {
    const scrolled: Element[] = [];
    const scrollIntoView = vi
      .spyOn(Element.prototype, 'scrollIntoView')
      .mockImplementation(function (this: Element) {
        scrolled.push(this);
      });
    try {
      const { user } = renderWithRunners();
      await screen.findByText('Deploy docs');

      await user.click(await screen.findByRole('button', { name: 'Docs · publish' }));

      await waitFor(() => expect(scrolled).toContain(runRow('Deploy docs')));
    } finally {
      scrollIntoView.mockRestore();
    }
  });

  it('blinks the row again when the same job is clicked a second time', async () => {
    // jsdom has no Web Animations, so the row's CSS animations are faked here.
    const blink = { animationName: 'run-blink', currentTime: 1200 as number | null, play: vi.fn() };
    const other = { animationName: 'fade', currentTime: 300 as number | null, play: vi.fn() };
    const original = Object.getOwnPropertyDescriptor(Element.prototype, 'getAnimations');
    Object.defineProperty(Element.prototype, 'getAnimations', {
      configurable: true,
      writable: true,
      value(this: Element) {
        return this.classList.contains('run-blink') ? [blink, other] : [];
      },
    });
    try {
      const { user } = renderWithRunners();
      await screen.findByText('Deploy docs');
      const job = await screen.findByRole('button', { name: 'Docs · publish' });

      await user.click(job);
      await waitFor(() => expect(runRow('Deploy docs').className).toContain('run-blink'));
      blink.currentTime = 1500;
      blink.play.mockClear();

      await user.click(job);

      await waitFor(() => expect(blink.play).toHaveBeenCalled());
      expect(blink.currentTime).toBe(0);
      expect(other.play).not.toHaveBeenCalled();
      expect(other.currentTime).toBe(300);
    } finally {
      if (original) Object.defineProperty(Element.prototype, 'getAnimations', original);
      else delete (Element.prototype as { getAnimations?: unknown }).getAnimations;
    }
  });
});

describe('PipelinesPage auto-fix', () => {
  const live = { ...running, workflowId: 9 };
  const withLiveRun = {
    'pipelines.dashboardActivity': async () => activity({ runs: [passed, failed, live] }),
  };
  const session = {
    id: 'fix-1',
    projectId: 'p1',
    projectName: 'Aurora',
    repo: 'acme/aurora',
    workflowId: 9,
    workflowName: 'CI',
    branch: 'main',
    cliId: 'claude-code',
    runArgs: [],
    runLabel: null,
    maxAttempts: 3,
    runId: 3,
    runNumber: 43,
    waitFor: null,
    phase: 'watching',
    blocker: null,
    message: null,
    attempts: [],
    agent: null,
    createdAt: 0,
    updatedAt: 0,
  };

  it('offers auto-fix on a run that is still going, and only there', async () => {
    renderPage(withLiveRun);
    await screen.findByText('Deploy docs');
    expect(
      within(runRow('Deploy docs')).getByRole('button', { name: 'Auto-fix this run if it fails' }),
    ).toBeTruthy();
    expect(
      within(runRow('Break the build')).queryByRole('button', {
        name: 'Auto-fix this run if it fails',
      }),
    ).toBeNull();
  });

  it('shows the auto-fix chip on the run and counts the sessions in progress', async () => {
    renderPage({ ...withLiveRun, 'ciAutoFix.list': [session] });
    await screen.findByText('Deploy docs');
    expect(
      await within(runRow('Deploy docs')).findByRole('button', { name: /Auto-fix: Auto-fix on/ }),
    ).toBeTruthy();
    expect(await screen.findByText('1 auto-fix on')).toBeTruthy();
  });
});
