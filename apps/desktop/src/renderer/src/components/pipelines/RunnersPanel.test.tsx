import type {
  GithubActionsHistoryItem,
  GithubRunner,
  GithubRunnersResult,
  GithubRunnerWaitingJob,
} from '@shared/apiTypes';
import { act, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';

/**
 * The runner panel sits on top of the Pipelines page and shows what each self-hosted runner is
 * doing, plus the jobs stuck waiting for one. Most users have no self-hosted runners at all, so
 * "render nothing" is as important as anything it draws.
 *
 * Order matters in this file. useLastGoodData keeps the last good response in a module-level
 * map that outlives a test, so the cases that need "nothing saved yet" come first.
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

const { RunnersPanel } = await import('./RunnersPanel');

const MINUTE = 60_000;

function ago(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

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
    htmlUrl: `https://github.com/acme/aurora/actions/runs/${overrides.id}`,
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-01T10:04:00.000Z',
    ...overrides,
  };
  return item;
}

const RUNS = [
  run({ id: 3, status: 'in_progress', conclusion: null, workflowName: 'Nightly' }),
  run({ id: 1 }),
];

function runner(overrides: Partial<GithubRunner> & { name: string }): GithubRunner {
  return {
    scope: { kind: 'repo', name: 'acme/aurora' },
    os: 'Linux',
    arch: 'X64',
    state: 'idle',
    labels: ['self-hosted', 'Linux', 'X64'],
    customLabels: [],
    ...overrides,
  };
}

const busy = runner({
  name: 'gpu-box-1',
  state: 'busy',
  currentJob: {
    repo: 'acme/aurora',
    runId: 3,
    jobName: 'train',
    workflowName: 'Nightly',
    htmlUrl: 'https://github.com/acme/aurora/actions/runs/3/job/9',
  },
});
const idleA = runner({ name: 'build-00', customLabels: ['gpu', 'cuda'] });
const idleB = runner({ name: 'build-01' });
const offline = runner({ name: 'old-mac', state: 'offline', os: 'macOS', arch: 'ARM64' });
const seen = runner({
  name: 'smart-1',
  state: 'seen',
  scope: { kind: 'org', name: 'SmartClouds' },
  lastSeenAt: ago(5 * MINUTE + 10_000),
});

function waitingJob(overrides: Partial<GithubRunnerWaitingJob> = {}): GithubRunnerWaitingJob {
  return {
    repo: 'acme/aurora',
    runId: 3,
    jobName: 'train',
    workflowName: 'Nightly',
    htmlUrl: 'https://github.com/acme/aurora/actions/runs/3',
    labels: ['self-hosted', 'gpu'],
    queuedAt: ago(2 * MINUTE),
    liveStatusKnown: true,
    ...overrides,
  };
}

type OkResult = Extract<GithubRunnersResult, { ok: true }>;

function ok(overrides: Partial<OkResult> = {}): OkResult {
  return { ok: true, runners: [], waiting: [], hiddenOrgs: [], ...overrides };
}

/** Listed out of order on purpose, so the panel's own sort is what gets tested. */
const full = ok({ runners: [offline, idleB, seen, busy, idleA] });

function renderPanel(answer: unknown, runs: GithubActionsHistoryItem[] = RUNS) {
  const onFocusRun = vi.fn();
  const onGrantAccess = vi.fn();
  const view = renderWithProviders(
    <RunnersPanel runs={runs} onFocusRun={onFocusRun} onGrantAccess={onGrantAccess} />,
    { bridge: { 'pipelines.runners': typeof answer === 'function' ? answer : async () => answer } },
  );
  return { ...view, onFocusRun, onGrantAccess };
}

function panel(): HTMLElement {
  return screen.getByRole('region', { name: 'Self-hosted runners' });
}

function queryPanel(): HTMLElement | null {
  return screen.queryByRole('region', { name: 'Self-hosted runners' });
}

/** The tile for one runner, found by its name. */
function tile(name: string): HTMLElement {
  const item = within(panel())
    .getAllByRole('listitem')
    .find((li) => li.textContent?.includes(name));
  if (!item) throw new Error(`No tile for "${name}"`);
  return item;
}

type View = Pick<ReturnType<typeof renderPanel>, 'bridge' | 'queryClient'>;

async function settled(view: View): Promise<void> {
  await waitFor(() => expect(view.bridge.$fn('pipelines.runners')).toHaveBeenCalled());
  await waitFor(() => expect(view.queryClient.isFetching()).toBe(0));
}

/**
 * Renders the panel and waits for this test's answer to be on screen. Until then the panel may
 * still be showing the copy an earlier test saved, so finding a name is not enough.
 */
async function renderLoaded(answer: unknown, runs?: GithubActionsHistoryItem[]) {
  const view = renderPanel(answer, runs);
  await settled(view);
  // React Query hands the result to its observers on the next tick.
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
  return view;
}

describe('RunnersPanel before anything has loaded', () => {
  it('stays out of the way while the very first lookup runs', async () => {
    // Most people have no self-hosted runners, so a placeholder that then vanishes would only
    // shove the run list down and back up. Later visits start from the saved answer instead.
    const view = renderPanel(() => new Promise(() => undefined));
    await waitFor(() => expect(view.bridge.$fn('pipelines.runners')).toHaveBeenCalled());

    expect(queryPanel()).toBeNull();
    expect(document.querySelectorAll('.shimmer')).toHaveLength(0);
  });

  it('renders nothing when the runner lookup throws', async () => {
    const view = renderPanel(async () => {
      throw new Error('main process went away');
    });
    await settled(view);

    expect(queryPanel()).toBeNull();
  });

  it('renders nothing when the lookup failed and nothing was saved', async () => {
    const view = renderPanel({ ok: false, error: 'HTTP 403' });
    await settled(view);

    expect(queryPanel()).toBeNull();
  });

  it('renders nothing when there are no runners, no waiting jobs and no hidden orgs', async () => {
    const view = renderPanel(ok());
    await settled(view);

    expect(queryPanel()).toBeNull();
  });

  it('asks about the runs on the page, saying which ones are still going', async () => {
    const view = renderPanel(ok());
    await settled(view);

    expect(view.bridge.$fn('pipelines.runners')).toHaveBeenCalledWith({
      runs: [
        { repo: 'acme/aurora', runId: 3, workflowName: 'Nightly', completed: false },
        { repo: 'acme/aurora', runId: 1, workflowName: 'CI', completed: true },
      ],
    });
  });
});

describe('RunnersPanel tiles', () => {
  it('sums up the runners in the header', async () => {
    await renderLoaded(full);

    const region = panel();
    // Idle, not "online": busy runners are online too, and three of them must not read "0 online".
    expect(within(region).getByText('2 idle')).toBeInTheDocument();
    expect(within(region).getByText('1 busy')).toBeInTheDocument();
    expect(within(region).getByText('1 offline')).toBeInTheDocument();
    expect(within(region).getByText('1 seen')).toBeInTheDocument();
  });

  it('leaves out every count that is zero', async () => {
    await renderLoaded(ok({ runners: [idleA, offline] }));

    expect(within(panel()).getByText('1 idle')).toBeInTheDocument();
    expect(within(panel()).getByText('1 offline')).toBeInTheDocument();
    expect(within(panel()).queryByText(/busy$/)).toBeNull();
    expect(within(panel()).queryByText(/seen$/)).toBeNull();
  });

  it('shows only the seen count when GitHub hides every live status', async () => {
    await renderLoaded(ok({ runners: [seen] }));

    expect(within(panel()).getByText('1 seen')).toBeInTheDocument();
    expect(within(panel()).queryByText(/^0 /)).toBeNull();
  });

  it('puts busy runners first, then idle, seen and offline, by name within each', async () => {
    await renderLoaded(full);

    const names = ['gpu-box-1', 'build-00', 'build-01', 'smart-1', 'old-mac'];
    const order = within(panel())
      .getAllByRole('listitem')
      .map((li) => names.find((name) => li.textContent?.includes(name)));
    expect(order).toEqual(names);
  });

  it('labels every status dot for screen readers', async () => {
    await renderLoaded(full);

    expect(within(tile('gpu-box-1')).getByRole('img', { name: 'Busy' })).toBeInTheDocument();
    expect(within(tile('build-00')).getByRole('img', { name: 'Idle' })).toBeInTheDocument();
    expect(within(tile('old-mac')).getByRole('img', { name: 'Offline' })).toBeInTheDocument();
    expect(
      within(tile('smart-1')).getByRole('img', { name: 'Live status unknown' }),
    ).toBeInTheDocument();
  });

  it('shows the platform and where each runner is registered', async () => {
    await renderLoaded(full);

    expect(within(tile('build-01')).getByText('Linux · X64')).toBeInTheDocument();
    expect(within(tile('build-01')).getByText('acme/aurora')).toBeInTheDocument();
    expect(within(tile('old-mac')).getByText('macOS · ARM64')).toBeInTheDocument();
    expect(within(tile('smart-1')).getByText('SmartClouds')).toBeInTheDocument();
  });

  it('says what each runner is doing', async () => {
    await renderLoaded(
      ok({ runners: [busy, runner({ name: 'busy-quiet', state: 'busy' }), idleB, offline, seen] }),
    );

    expect(within(tile('busy-quiet')).getByText('Busy')).toBeInTheDocument();
    expect(within(tile('build-01')).getByText('Idle')).toBeInTheDocument();
    expect(within(tile('old-mac')).getByText('Offline')).toBeInTheDocument();
    expect(within(tile('smart-1')).getByText('Last job 5m ago')).toBeInTheDocument();
  });

  it('jumps to the run a busy runner is working on', async () => {
    const { user, onFocusRun } = await renderLoaded(full);

    await user.click(within(tile('gpu-box-1')).getByRole('button', { name: 'Nightly · train' }));

    expect(onFocusRun).toHaveBeenCalledWith({
      runId: 3,
      repo: 'acme/aurora',
      htmlUrl: 'https://github.com/acme/aurora/actions/runs/3/job/9',
    });
  });

  it('explains why a seen runner has no live status', async () => {
    const { user } = await renderLoaded(full);

    await user.hover(within(tile('smart-1')).getByText('Last job 5m ago'));

    expect(
      (await screen.findAllByText('Live status needs org admin access to SmartClouds.')).length,
    ).toBeGreaterThan(0);
  });

  it('lets a keyboard user reach that explanation too', async () => {
    const { user } = await renderLoaded(ok({ runners: [seen] }));
    const status = within(tile('smart-1')).getByText('Last job 5m ago');

    for (let step = 0; step < 10 && document.activeElement !== status; step += 1) {
      await user.tab();
    }

    expect(status).toHaveFocus();
    expect(
      (await screen.findAllByText('Live status needs org admin access to SmartClouds.')).length,
    ).toBeGreaterThan(0);
  });

  it('shows the labels someone added by hand', async () => {
    await renderLoaded(full);

    expect(within(tile('build-00')).getByText('gpu')).toBeInTheDocument();
    expect(within(tile('build-00')).getByText('cuda')).toBeInTheDocument();
    expect(within(tile('build-01')).queryByText('gpu')).toBeNull();
  });

  it('shows the full name in a tooltip when it does not fit', async () => {
    // jsdom has no layout, so every element reports 0 for both unless told otherwise.
    const scrollWidth = vi.spyOn(Element.prototype, 'scrollWidth', 'get').mockReturnValue(300);
    const clientWidth = vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(100);
    try {
      const long = runner({ name: 'a-very-long-runner-name-that-will-not-fit-1' });
      const { user } = await renderLoaded(ok({ runners: [long] }));

      await user.hover(screen.getByText(long.name));

      expect(await screen.findByRole('tooltip')).toHaveTextContent(long.name);
    } finally {
      scrollWidth.mockRestore();
      clientWidth.mockRestore();
    }
  });

  it('keeps quiet about a name that fits', async () => {
    const { user } = await renderLoaded(full);

    await user.hover(screen.getByText('build-01'));
    await act(() => new Promise((resolve) => setTimeout(resolve, 400)));

    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('never uses the native title attribute', async () => {
    await renderLoaded(
      ok({
        runners: full.runners,
        waiting: [waitingJob()],
        hiddenOrgs: ['SmartClouds'],
      }),
    );
    expect(screen.getByText('gpu-box-1')).toBeInTheDocument();

    expect(document.querySelectorAll('[title]')).toHaveLength(0);
  });
});

describe('RunnersPanel waiting jobs', () => {
  function alert(): HTMLElement {
    return within(panel()).getByRole('button', { name: /waiting/ });
  }

  it('says when jobs are waiting and no online runner matches', async () => {
    renderPanel(ok({ waiting: [waitingJob(), waitingJob({ runId: 4 })] }));
    await screen.findByRole('region', { name: 'Self-hosted runners' });

    await waitFor(() =>
      expect(alert()).toHaveTextContent(
        '2 jobs are waiting for a runner labeled self-hosted, gpu. No online runner matches.',
      ),
    );
  });

  it('uses the singular for one job', async () => {
    renderPanel(ok({ waiting: [waitingJob()] }));

    await waitFor(() =>
      expect(alert()).toHaveTextContent(
        '1 job is waiting for a runner labeled self-hosted, gpu. No online runner matches.',
      ),
    );
  });

  it('says how long a job has waited when the runner list is hidden', async () => {
    renderPanel(
      ok({
        waiting: [
          waitingJob({
            labels: ['self-hosted', 'linux', 'x64'],
            liveStatusKnown: false,
            queuedAt: ago(7 * MINUTE + 5_000),
          }),
        ],
      }),
    );

    await waitFor(() =>
      expect(alert()).toHaveTextContent(
        '1 job has been waiting 7 min for a runner labeled self-hosted, linux, x64. The runner may be offline.',
      ),
    );
  });

  it('counts from the oldest job when several are waiting on a hidden runner list', async () => {
    renderPanel(
      ok({
        waiting: [
          waitingJob({ liveStatusKnown: false, queuedAt: ago(3 * MINUTE) }),
          waitingJob({ runId: 4, liveStatusKnown: false, queuedAt: ago(12 * MINUTE + 5_000) }),
        ],
      }),
    );

    await waitFor(() =>
      expect(alert()).toHaveTextContent(
        '2 jobs have been waiting 12 min for a runner labeled self-hosted, gpu. The runner may be offline.',
      ),
    );
  });

  it('jumps to the job that has waited longest', async () => {
    const oldest = waitingJob({
      runId: 7,
      repo: 'acme/borealis',
      htmlUrl: 'https://github.com/acme/borealis/actions/runs/7',
      queuedAt: ago(9 * MINUTE),
    });
    const { user, onFocusRun } = await renderLoaded(ok({ waiting: [waitingJob(), oldest] }));

    await user.click(alert());

    expect(onFocusRun).toHaveBeenCalledWith({
      runId: 7,
      repo: 'acme/borealis',
      htmlUrl: 'https://github.com/acme/borealis/actions/runs/7',
    });
  });
});

describe('RunnersPanel collapsing and overflow', () => {
  it('collapses to the header and remembers it', async () => {
    const { user, unmount } = await renderLoaded(
      ok({ runners: full.runners, waiting: [waitingJob()] }),
    );

    const toggle = screen.getByRole('button', { name: 'Hide runners' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(document.getElementById(toggle.getAttribute('aria-controls') ?? '')).toBeTruthy();

    await user.click(toggle);

    expect(screen.queryByText('gpu-box-1')).toBeNull();
    expect(screen.getByRole('button', { name: 'Show runners' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    // The body is gone, so there is nothing for the button to point at.
    expect(screen.getByRole('button', { name: 'Show runners' })).not.toHaveAttribute(
      'aria-controls',
    );
    // The counts and a waiting job stay readable in the header.
    expect(within(panel()).getByText('1 busy')).toBeInTheDocument();
    expect(within(panel()).getByText('1 waiting')).toBeInTheDocument();
    expect(localStorage.getItem('runova:runners-panel-collapsed')).toBe('true');

    unmount();
    await renderLoaded(full);
    expect(screen.getByRole('button', { name: 'Show runners' })).toBeInTheDocument();
    expect(screen.queryByText('gpu-box-1')).toBeNull();
  });

  it('shows the first eight runners and the rest on request', async () => {
    const many = Array.from({ length: 10 }, (_, index) =>
      runner({ name: `runner-${String(index).padStart(2, '0')}` }),
    );
    const { user } = await renderLoaded(ok({ runners: many }));

    expect(within(panel()).getAllByRole('listitem')).toHaveLength(8);

    await user.click(screen.getByRole('button', { name: 'Show all 10' }));
    expect(within(panel()).getAllByRole('listitem')).toHaveLength(10);

    await user.click(screen.getByRole('button', { name: 'Show fewer' }));
    expect(within(panel()).getAllByRole('listitem')).toHaveLength(8);
  });

  it('has no overflow toggle with eight runners or fewer', async () => {
    await renderLoaded(full);

    expect(screen.queryByRole('button', { name: /Show all/ })).toBeNull();
  });
});

describe('RunnersPanel hidden orgs', () => {
  const hint = 'Live status for SmartClouds runners needs org admin access.';

  it('offers to grant org admin access', async () => {
    const { user, onGrantAccess } = await renderLoaded(
      ok({ runners: [seen], hiddenOrgs: ['SmartClouds'] }),
    );

    expect(screen.getByText(hint)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Grant access' }));

    expect(onGrantAccess).toHaveBeenCalledWith('SmartClouds');
  });

  it('explains what granting access does', async () => {
    const { user } = await renderLoaded(ok({ runners: [seen], hiddenOrgs: ['SmartClouds'] }));

    await user.hover(screen.getByRole('button', { name: 'Grant access' }));

    expect(
      (
        await screen.findAllByText(
          'Opens a terminal with gh auth refresh -s admin:org. You also need to be an admin of the org.',
        )
      ).length,
    ).toBeGreaterThan(0);
  });

  it('hides a dismissed hint for good', async () => {
    const { user, unmount } = await renderLoaded(
      ok({ runners: [seen], hiddenOrgs: ['SmartClouds'] }),
    );

    await user.click(screen.getByRole('button', { name: 'Dismiss the SmartClouds hint' }));

    expect(screen.queryByText(hint)).toBeNull();
    expect(JSON.parse(localStorage.getItem('runova:runners-dismissed-orgs') ?? '[]')).toEqual([
      'SmartClouds',
    ]);

    unmount();
    await renderLoaded(ok({ runners: [seen], hiddenOrgs: ['SmartClouds'] }));
    expect(screen.getByText('smart-1')).toBeInTheDocument();
    expect(screen.queryByText(hint)).toBeNull();
  });

  it('shows a panel for a hint alone, and nothing once it is dismissed', async () => {
    const { user } = await renderLoaded(ok({ hiddenOrgs: ['SmartClouds'] }));
    expect(screen.getByText(hint)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Dismiss the SmartClouds hint' }));

    expect(queryPanel()).toBeNull();
  });

  it('checks again once access was granted, and drops the hint when GitHub agrees', async () => {
    let answer = ok({ runners: [seen], hiddenOrgs: ['SmartClouds'] });
    const view = await renderLoaded(() => Promise.resolve(answer));
    const calls = view.bridge.$fn('pipelines.runners');

    await view.user.click(screen.getByRole('button', { name: 'Grant access' }));
    expect(view.onGrantAccess).toHaveBeenCalledWith('SmartClouds');
    expect(screen.queryByRole('button', { name: 'Grant access' })).toBeNull();
    const before = calls.mock.calls.length;

    answer = ok({ runners: [{ ...seen, state: 'idle' }] });
    await view.user.click(screen.getByRole('button', { name: 'Check again' }));

    await waitFor(() => expect(screen.queryByText(hint)).toBeNull());
    expect(calls).toHaveBeenCalledTimes(before + 1);
    expect(calls.mock.lastCall?.[0]).toMatchObject({ fresh: true });

    // Only that one lookup skips the main process's memory of refusals.
    await act(() => view.queryClient.refetchQueries());
    expect(calls).toHaveBeenCalledTimes(before + 2);
    expect(calls.mock.lastCall?.[0]).not.toHaveProperty('fresh');
  });

  it('copes with storage that throws', async () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    try {
      const { user } = await renderLoaded(ok({ runners: [seen], hiddenOrgs: ['SmartClouds'] }));
      expect(screen.getByText(hint)).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Dismiss the SmartClouds hint' }));
      await user.click(screen.getByRole('button', { name: 'Hide runners' }));

      expect(screen.queryByText(hint)).toBeNull();
      expect(screen.getByRole('button', { name: 'Show runners' })).toBeInTheDocument();
    } finally {
      getItem.mockRestore();
      setItem.mockRestore();
    }
  });
});

describe('RunnersPanel refreshing', () => {
  /** Lets a test swap the run list the panel gets, the way a page refresh would. */
  function Harness({
    first,
    next,
  }: {
    first: GithubActionsHistoryItem[];
    next: GithubActionsHistoryItem[];
  }): React.JSX.Element {
    const [runs, setRuns] = useState(first);
    return (
      <>
        <button type="button" onClick={() => setRuns(next)}>
          Next runs
        </button>
        <RunnersPanel runs={runs} onFocusRun={() => undefined} onGrantAccess={() => undefined} />
      </>
    );
  }

  it('asks again when a run starts or finishes, keeping the tiles on screen meanwhile', async () => {
    let release: (value: GithubRunnersResult) => void = () => undefined;
    let calls = 0;
    const view = renderWithProviders(
      <Harness first={RUNS} next={[run({ id: 5, status: 'queued', conclusion: null }), ...RUNS]} />,
      {
        bridge: {
          'pipelines.runners': () => {
            calls += 1;
            if (calls === 1) return Promise.resolve(full);
            return new Promise<GithubRunnersResult>((resolve) => {
              release = resolve;
            });
          },
        },
      },
    );
    await screen.findByText('gpu-box-1');

    await view.user.click(screen.getByRole('button', { name: 'Next runs' }));

    await waitFor(() => expect(calls).toBe(2));
    expect(view.bridge.$fn('pipelines.runners')).toHaveBeenLastCalledWith({
      runs: [
        { repo: 'acme/aurora', runId: 5, workflowName: 'CI', completed: false },
        { repo: 'acme/aurora', runId: 3, workflowName: 'Nightly', completed: false },
        { repo: 'acme/aurora', runId: 1, workflowName: 'CI', completed: true },
      ],
    });
    // No skeleton flash while the new answer is on its way.
    expect(screen.getByText('gpu-box-1')).toBeInTheDocument();
    expect(panel().querySelectorAll('.shimmer')).toHaveLength(0);

    await act(async () => release(ok({ runners: [idleB] })));
    await waitFor(() => expect(screen.queryByText('gpu-box-1')).toBeNull());
    expect(screen.getByText('build-01')).toBeInTheDocument();
  });

  it('does not ask again when only finished runs change', async () => {
    const view = renderWithProviders(<Harness first={RUNS} next={[...RUNS, run({ id: 9 })]} />, {
      bridge: { 'pipelines.runners': async () => full },
    });
    await screen.findByText('gpu-box-1');

    await view.user.click(screen.getByRole('button', { name: 'Next runs' }));

    expect(view.bridge.$fn('pipelines.runners')).toHaveBeenCalledTimes(1);
  });

  it('keeps the last runners on screen when a refresh fails', async () => {
    let fail = false;
    const view = renderWithProviders(
      <Harness
        first={RUNS}
        next={[run({ id: 6, status: 'in_progress', conclusion: null }), ...RUNS]}
      />,
      {
        bridge: {
          'pipelines.runners': async () => (fail ? { ok: false, error: 'HTTP 502' } : full),
        },
      },
    );
    await screen.findByText('gpu-box-1');

    fail = true;
    await view.user.click(screen.getByRole('button', { name: 'Next runs' }));

    await waitFor(() => expect(view.bridge.$fn('pipelines.runners')).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(view.queryClient.isFetching()).toBe(0));
    expect(screen.getByText('gpu-box-1')).toBeInTheDocument();
  });

  /** Loads `first`, then swaps in a running run so the panel asks again and gets `second`. */
  async function refreshOnce(first: () => Promise<unknown>, second: () => Promise<unknown>) {
    let calls = 0;
    const view = renderWithProviders(
      <Harness
        first={RUNS}
        next={[run({ id: 8, status: 'in_progress', conclusion: null }), ...RUNS]}
      />,
      {
        bridge: {
          'pipelines.runners': () => {
            calls += 1;
            return calls === 1 ? first() : second();
          },
        },
      },
    );
    await settled(view);
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(toast.error).not.toHaveBeenCalled();

    await view.user.click(screen.getByRole('button', { name: 'Next runs' }));
    await waitFor(() => expect(calls).toBe(2));
    await waitFor(() => expect(view.queryClient.isFetching()).toBe(0));
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    return view;
  }

  it('does not toast a failed refresh when the panel had nothing to show', async () => {
    await refreshOnce(
      async () => ok(),
      async () => ({ ok: false, error: 'HTTP 502' }),
    );

    expect(toast.error).not.toHaveBeenCalled();
    expect(queryPanel()).toBeNull();
  });

  it('does not toast a rejected lookup when the panel had nothing to show', async () => {
    await refreshOnce(
      async () => ok(),
      () =>
        Promise.reject(new Error("Error invoking remote method 'pipelines:runners': Error: boom")),
    );

    expect(toast.error).not.toHaveBeenCalled();
    expect(queryPanel()).toBeNull();
  });

  it('still toasts a failed refresh when runners are on screen', async () => {
    await refreshOnce(
      async () => full,
      async () => ({ ok: false, error: 'HTTP 502' }),
    );

    expect(toast.error).toHaveBeenCalledWith(
      'Could not refresh runners',
      expect.objectContaining({ description: 'HTTP 502 Showing the last data that loaded.' }),
    );
    expect(screen.getByText('gpu-box-1')).toBeInTheDocument();
  });
});
