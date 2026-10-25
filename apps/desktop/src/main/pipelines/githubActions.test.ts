import type { Project } from '@agentmat/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Everything here talks to GitHub by spawning `gh`, so the process boundary is the only thing
 * stubbed: `execFile` is replaced and fed the JSON the real CLI prints. That keeps the argument
 * construction under test (a `--field` instead of a `--raw-field` would let a value starting with
 * "@" read a file off the user's disk) along with the payload mapping the UI depends on.
 */

interface ExecReply {
  stdout: string;
  stderr: string;
}

const proc = vi.hoisted(() => ({
  calls: [] as { file: string; args: string[] }[],
  reply: null as null | ((file: string, args: string[]) => Promise<ExecReply>),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  // Nothing under test uses the callback form, only `promisify(execFile)`.
  const execFile = (() => {
    throw new Error('callback execFile is not used by these modules');
  }) as unknown as typeof actual.execFile;
  Object.defineProperty(execFile, promisify.custom, {
    value: async (file: string, args: string[]): Promise<ExecReply> => {
      proc.calls.push({ file, args });
      if (!proc.reply) throw new Error(`no exec reply configured for ${file} ${args.join(' ')}`);
      return proc.reply(file, args);
    },
  });
  return { ...actual, execFile };
});

const storeState = vi.hoisted(() => ({
  projects: [] as unknown[],
  writes: [] as unknown[][],
}));

vi.mock('../store', () => ({
  store: {
    getProjects: async () => storeState.projects,
    setProjects: async (next: unknown[]) => {
      storeState.projects = next;
      storeState.writes.push(next);
    },
  },
}));

/** An error shaped the way a failed `execFile` is, since `ghErrorMessage` reads `stderr` first. */
function execError(stderr: string): Error {
  const error = new Error('Command failed') as Error & { stderr: string };
  error.stderr = stderr;
  return error;
}

interface Scenario {
  ghAvailable: boolean;
  /** stdout of `git remote get-url origin`, or null to make the lookup fail. */
  gitRemote: string | null;
  /** `gh api <path>` payloads, keyed by the exact path argument. */
  api: Record<string, unknown>;
  /** `gh api <path>` raw stdout, for replies that are not JSON at all. */
  apiRaw: Record<string, string>;
  /** `gh api <path>` failures, keyed by path, winning over `api`. */
  apiErrors: Record<string, string>;
  /** Any other `gh` invocation, keyed by the joined argument list. */
  gh: Record<string, ExecReply>;
  /** Failures for other `gh` invocations, keyed by the joined argument list. */
  ghErrors: Record<string, string>;
}

let scenario: Scenario;
let actions: typeof import('./githubActions');

/** The path argument of a `gh api` call: `['api', '-H', accept, <path>, ...]`. */
function apiPath(args: string[]): string {
  return args[3];
}

async function reply(file: string, args: string[]): Promise<ExecReply> {
  if (file === 'git') {
    if (scenario.gitRemote == null) throw execError('fatal: No such remote origin');
    return { stdout: `${scenario.gitRemote}\n`, stderr: '' };
  }
  if (file !== 'gh') throw execError(`unexpected command ${file}`);
  if (args[0] === '--version') {
    if (!scenario.ghAvailable) throw execError('gh: command not found');
    return { stdout: 'gh version 2.62.0\n', stderr: '' };
  }
  if (args[0] === 'api') {
    const path = apiPath(args);
    const failure = scenario.apiErrors[path];
    if (failure) throw execError(failure);
    if (path in scenario.apiRaw) return { stdout: scenario.apiRaw[path], stderr: '' };
    if (!(path in scenario.api)) throw execError(`HTTP 404: Not Found (${path})`);
    return { stdout: JSON.stringify(scenario.api[path]), stderr: '' };
  }
  const key = args.join(' ');
  const failure = scenario.ghErrors[key];
  if (failure) throw execError(failure);
  return scenario.gh[key] ?? { stdout: '', stderr: '' };
}

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'proj-1',
    name: 'Demo',
    folderPath: '/work/demo',
    description: '',
    tags: [],
    agentType: 'claude-code',
    notes: '',
    runCommands: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as unknown as Project;
}

/** A `workflow_runs` entry as the REST API prints it. */
function ghRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 5001,
    workflow_id: 100,
    name: 'CI',
    display_title: 'Fix the flake',
    run_number: 42,
    head_branch: 'main',
    status: 'completed',
    conclusion: 'success',
    html_url: 'https://github.com/acme/demo/actions/runs/5001',
    created_at: '2026-03-15T09:00:00.000Z',
    updated_at: '2026-03-15T09:10:00.000Z',
    check_suite_id: 9001,
    ...overrides,
  };
}

function ghWorkflow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 100,
    name: 'CI',
    path: '.github/workflows/ci.yml',
    state: 'active',
    html_url: 'https://github.com/acme/demo/actions/workflows/ci.yml',
    badge_url: 'https://github.com/acme/demo/workflows/CI/badge.svg',
    ...overrides,
  };
}

function workflowFile(source: string): Record<string, unknown> {
  return { content: Buffer.from(source, 'utf-8').toString('base64'), encoding: 'base64' };
}

const DISPATCHABLE_WORKFLOW = ['on:', '  workflow_dispatch:', 'jobs:', '  build: {}'].join('\n');

beforeEach(async () => {
  proc.calls.length = 0;
  storeState.projects = [];
  storeState.writes.length = 0;
  scenario = {
    ghAvailable: true,
    gitRemote: null,
    api: {},
    apiRaw: {},
    apiErrors: {},
    gh: {},
    ghErrors: {},
  };
  proc.reply = reply;
  // Every exported function caches (repo lookups, workflow lists, annotations), so each test
  // needs the module graph rebuilt or the previous test's answers would be reused.
  vi.resetModules();
  actions = await import('./githubActions');
});

afterEach(() => {
  vi.useRealTimers();
});

function ghCalls(): string[][] {
  return proc.calls.filter((call) => call.file === 'gh').map((call) => call.args);
}

describe('toWorkflowRun', () => {
  it('maps the REST payload onto the shape the UI renders', () => {
    expect(
      actions.toWorkflowRun({
        id: 7,
        workflow_id: 100,
        name: 'CI',
        display_title: 'Fix the flake',
        run_number: 42,
        head_branch: 'feature/x',
        status: 'completed',
        conclusion: 'failure',
        html_url: 'https://example.invalid/7',
        created_at: '2026-03-15T09:00:00.000Z',
        updated_at: '2026-03-15T09:10:00.000Z',
        event: 'push',
        actor: { login: 'octo' },
        head_sha: 'abc1234def5678',
        run_attempt: 2,
      }),
    ).toEqual({
      id: 7,
      workflowId: 100,
      name: 'CI',
      displayTitle: 'Fix the flake',
      runNumber: 42,
      headBranch: 'feature/x',
      status: 'completed',
      conclusion: 'failure',
      htmlUrl: 'https://example.invalid/7',
      createdAt: '2026-03-15T09:00:00.000Z',
      updatedAt: '2026-03-15T09:10:00.000Z',
      event: 'push',
      actor: 'octo',
      headSha: 'abc1234def5678',
      runAttempt: 2,
    });
  });

  it('leaves out the run facts GitHub did not send, instead of inventing them', () => {
    const run = actions.toWorkflowRun({
      ...ghRun({ actor: null }),
    } as unknown as Parameters<typeof actions.toWorkflowRun>[0]);
    expect(run.event).toBeUndefined();
    expect(run.actor).toBeUndefined();
    expect(run.headSha).toBeUndefined();
    expect(run.runAttempt).toBeUndefined();
  });

  it.each([
    ['queued', 'queued'],
    ['in_progress', 'in_progress'],
    ['completed', 'completed'],
    ['waiting', 'waiting'],
    ['requested', 'requested'],
    ['pending', 'pending'],
    ['some_new_github_state', 'unknown'],
  ])('maps status %s to %s', (status, expected) => {
    // A status GitHub adds later must not leak through as a raw string the UI cannot style.
    const run = actions.toWorkflowRun({ ...ghRun({ status }) } as unknown as Parameters<
      typeof actions.toWorkflowRun
    >[0]);
    expect(run.status).toBe(expected);
  });

  it.each([
    ['success', 'success'],
    ['failure', 'failure'],
    ['cancelled', 'cancelled'],
    ['skipped', 'skipped'],
    ['timed_out', 'timed_out'],
    ['action_required', 'action_required'],
    ['neutral', 'neutral'],
    ['stale', 'stale'],
  ])('keeps the %s conclusion', (conclusion, expected) => {
    const run = actions.toWorkflowRun({ ...ghRun({ conclusion }) } as unknown as Parameters<
      typeof actions.toWorkflowRun
    >[0]);
    expect(run.conclusion).toBe(expected);
  });

  it('turns a null or unrecognized conclusion into null', () => {
    const running = actions.toWorkflowRun({
      ...ghRun({ conclusion: null }),
    } as unknown as Parameters<typeof actions.toWorkflowRun>[0]);
    const odd = actions.toWorkflowRun({
      ...ghRun({ conclusion: 'brand_new' }),
    } as unknown as Parameters<typeof actions.toWorkflowRun>[0]);
    expect(running.conclusion).toBeNull();
    expect(odd.conclusion).toBeNull();
  });

  it('falls back to the workflow name when the display title is blank', () => {
    const run = actions.toWorkflowRun({
      ...ghRun({ display_title: '   ' }),
    } as unknown as Parameters<typeof actions.toWorkflowRun>[0]);
    expect(run.displayTitle).toBe('CI');
  });

  it('turns a null head branch into an empty string', () => {
    const run = actions.toWorkflowRun({ ...ghRun({ head_branch: null }) } as unknown as Parameters<
      typeof actions.toWorkflowRun
    >[0]);
    expect(run.headBranch).toBe('');
  });
});

describe('githubRepoForFolder', () => {
  it('reads the owner and repo out of the origin remote', async () => {
    scenario.gitRemote = 'git@github.com:acme/demo.git';

    await expect(actions.githubRepoForFolder('/work/demo')).resolves.toEqual({
      owner: 'acme',
      repo: 'demo',
    });
    expect(proc.calls[0]).toEqual({
      file: 'git',
      args: ['-C', '/work/demo', 'remote', 'get-url', 'origin'],
    });
  });

  it('returns null when the folder has no origin remote', async () => {
    scenario.gitRemote = null;
    await expect(actions.githubRepoForFolder('/work/demo')).resolves.toBeNull();
  });

  it('returns null for a remote that is not on GitHub', async () => {
    scenario.gitRemote = 'git@gitlab.com:acme/demo.git';
    await expect(actions.githubRepoForFolder('/work/demo')).resolves.toBeNull();
  });

  it('caches the answer, since the watcher asks for every project on every tick', async () => {
    scenario.gitRemote = 'https://github.com/acme/demo';

    await actions.githubRepoForFolder('/work/demo');
    await actions.githubRepoForFolder('/work/demo');

    expect(proc.calls.filter((call) => call.file === 'git')).toHaveLength(1);
  });
});

describe('listRepoWorkflows', () => {
  it('drops deleted workflows and maps the rest', async () => {
    scenario.api['repos/acme/demo/actions/workflows?per_page=100'] = {
      workflows: [
        ghWorkflow(),
        ghWorkflow({ id: 101, name: 'Old', path: '.github/workflows/old.yml', state: 'deleted' }),
      ],
    };

    const workflows = await actions.listRepoWorkflows('acme', 'demo');

    // A deleted workflow still comes back from the API but can never run again.
    expect(workflows).toHaveLength(1);
    expect(workflows[0]).toEqual({
      id: 100,
      name: 'CI',
      path: '.github/workflows/ci.yml',
      state: 'active',
      htmlUrl: 'https://github.com/acme/demo/actions/workflows/ci.yml',
      badgeUrl: 'https://github.com/acme/demo/workflows/CI/badge.svg',
      dispatchable: true,
      dispatchInputs: [],
    });
  });

  it('caches per repo, so a watcher tick costs one call however often it asks', async () => {
    scenario.api['repos/acme/demo/actions/workflows?per_page=100'] = { workflows: [ghWorkflow()] };
    scenario.api['repos/acme/other/actions/workflows?per_page=100'] = { workflows: [] };

    await actions.listRepoWorkflows('acme', 'demo');
    await actions.listRepoWorkflows('acme', 'demo');
    await actions.listRepoWorkflows('acme', 'other');

    expect(ghCalls().filter((args) => args[0] === 'api')).toHaveLength(2);
  });

  it('tolerates a payload with no workflows key', async () => {
    scenario.api['repos/acme/demo/actions/workflows?per_page=100'] = {};
    await expect(actions.listRepoWorkflows('acme', 'demo')).resolves.toEqual([]);
  });
});

describe('listWorkflowRuns', () => {
  it('asks for one workflow with the page size it was given', async () => {
    scenario.api['repos/acme/demo/actions/workflows/100/runs?per_page=3'] = {
      workflow_runs: [ghRun()],
    };

    const runs = await actions.listWorkflowRuns('acme', 'demo', 100, 3);

    expect(runs.map((run) => run.id)).toEqual([5001]);
  });

  it('defaults to five runs', async () => {
    scenario.api['repos/acme/demo/actions/workflows/100/runs?per_page=5'] = { workflow_runs: [] };
    await expect(actions.listWorkflowRuns('acme', 'demo', 100)).resolves.toEqual([]);
  });
});

describe('listRepoRunsByWorkflow', () => {
  it('groups the repo runs by workflow id, newest first within each group', async () => {
    scenario.api['repos/acme/demo/actions/runs?per_page=50'] = {
      workflow_runs: [
        ghRun({ id: 3, workflow_id: 100 }),
        ghRun({ id: 2, workflow_id: 200, name: 'Deploy' }),
        ghRun({ id: 1, workflow_id: 100 }),
      ],
    };

    const grouped = await actions.listRepoRunsByWorkflow('acme', 'demo');

    // The API already returns newest first, and the watcher relies on that order.
    expect([...grouped.keys()]).toEqual([100, 200]);
    expect(grouped.get(100)?.map((run) => run.id)).toEqual([3, 1]);
    expect(grouped.get(200)?.map((run) => run.id)).toEqual([2]);
  });

  it('asks for the page size it was given', async () => {
    scenario.api['repos/acme/demo/actions/runs?per_page=10'] = { workflow_runs: [] };
    await expect(actions.listRepoRunsByWorkflow('acme', 'demo', 10)).resolves.toEqual(new Map());
  });
});

describe('fetchProjectPipelineStatus', () => {
  function seedRepo(): void {
    scenario.gitRemote = 'https://github.com/acme/demo.git';
    scenario.api['repos/acme/demo/actions/workflows?per_page=100'] = {
      workflows: [ghWorkflow(), ghWorkflow({ id: 200, name: 'Deploy', path: 'deploy.yml' })],
    };
    scenario.api['repos/acme/demo/actions/runs?per_page=40'] = {
      workflow_runs: [
        ghRun({ id: 9, workflow_id: 100, updated_at: '2026-03-15T10:00:00.000Z' }),
        ghRun({ id: 8, workflow_id: 100, updated_at: '2026-03-15T09:00:00.000Z' }),
      ],
    };
    scenario.api['repos/acme/demo/contents/.github/workflows/ci.yml'] =
      workflowFile(DISPATCHABLE_WORKFLOW);
    scenario.api['repos/acme/demo/contents/deploy.yml'] = workflowFile('on: push\n');
  }

  it('reports the workflows and the latest run of each', async () => {
    seedRepo();

    const status = await actions.fetchProjectPipelineStatus(project());

    expect(status.cliAvailable).toBe(true);
    expect(status.authenticated).toBe(true);
    expect(status.github).toEqual({ owner: 'acme', repo: 'demo' });
    expect(status.workflows.map((item) => item.id)).toEqual([100, 200]);
    // Only the newest run per workflow, because that is what the row shows.
    expect(status.runsByWorkflowId[100]?.id).toBe(9);
    expect(status.runsByWorkflowId[200]).toBeNull();
    expect(status.error).toBeUndefined();
  });

  it('marks a workflow without a workflow_dispatch trigger as not dispatchable', async () => {
    seedRepo();

    const status = await actions.fetchProjectPipelineStatus(project());

    // The Run button has to disappear for a workflow GitHub would refuse to start.
    expect(status.workflows[0].dispatchable).toBe(true);
    expect(status.workflows[1].dispatchable).toBe(false);
  });

  it('stays optimistically dispatchable when the workflow file cannot be read', async () => {
    seedRepo();
    scenario.apiErrors['repos/acme/demo/contents/.github/workflows/ci.yml'] = 'HTTP 404: Not Found';

    const status = await actions.fetchProjectPipelineStatus(project());

    // Losing the Run button over a transient API hiccup would be worse than a failed dispatch.
    expect(status.workflows[0].dispatchable).toBe(true);
  });

  it('explains that the project has no GitHub remote', async () => {
    scenario.gitRemote = null;

    const status = await actions.fetchProjectPipelineStatus(project());

    expect(status.error).toBe('This repository is not connected to GitHub.');
    expect(status.github).toBeNull();
    expect(ghCalls()).toEqual([]);
  });

  it('explains that the GitHub CLI is missing', async () => {
    scenario.gitRemote = 'https://github.com/acme/demo';
    scenario.ghAvailable = false;

    const status = await actions.fetchProjectPipelineStatus(project());

    expect(status.error).toMatch(/Install the GitHub CLI/);
    expect(status.github).toEqual({ owner: 'acme', repo: 'demo' });
    expect(status.cliAvailable).toBe(false);
  });

  it('reports a sign-in problem separately from a plain failure', async () => {
    scenario.gitRemote = 'https://github.com/acme/demo';
    scenario.apiErrors['repos/acme/demo/actions/workflows?per_page=100'] =
      'HTTP 401: Bad credentials';

    const status = await actions.fetchProjectPipelineStatus(project());

    expect(status.authenticated).toBe(false);
    expect(status.error).toBe('Not signed in to the GitHub CLI. Run "gh auth login" first.');
  });

  it('passes a non-auth failure through as it is', async () => {
    scenario.gitRemote = 'https://github.com/acme/demo';
    scenario.apiErrors['repos/acme/demo/actions/workflows?per_page=100'] =
      'HTTP 404: Not Found (repos/acme/demo)';

    const status = await actions.fetchProjectPipelineStatus(project());

    expect(status.authenticated).toBe(true);
    expect(status.error).toBe('HTTP 404: Not Found (repos/acme/demo)');
  });
});

describe('listProjectGithubRepos', () => {
  it('lists each GitHub repo once, labelled with the first project that uses it', async () => {
    storeState.projects = [
      project({ id: 'a', name: 'A', folderPath: '/work/a' }),
      project({ id: 'b', name: 'B', folderPath: '/work/b' }),
    ];
    scenario.gitRemote = 'https://github.com/ACME/Demo.git';

    await expect(actions.listProjectGithubRepos()).resolves.toEqual([
      { owner: 'ACME', repo: 'Demo', projectId: 'a', projectName: 'A' },
    ]);
  });

  it('skips projects without a GitHub remote', async () => {
    storeState.projects = [project()];
    scenario.gitRemote = null;

    await expect(actions.listProjectGithubRepos()).resolves.toEqual([]);
  });
});

describe('fetchDashboardActionsActivity', () => {
  /** Local-time constructors on both sides, so the day buckets do not depend on the test box. */
  const NOW = new Date(2026, 2, 15, 12, 0, 0);
  const at = (dayOffset: number, hour = 10): string =>
    new Date(2026, 2, 15 + dayOffset, hour, 0, 0).toISOString();
  const localDay = (dayOffset: number): string => {
    const day = new Date(2026, 2, 15 + dayOffset);
    const month = String(day.getMonth() + 1).padStart(2, '0');
    return `${day.getFullYear()}-${month}-${String(day.getDate()).padStart(2, '0')}`;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  it('asks the user to install the CLI when it is not there', async () => {
    scenario.ghAvailable = false;

    const activity = await actions.fetchDashboardActionsActivity();

    expect(activity).toMatchObject({ ok: false, cliAvailable: false, authenticated: false });
    expect(activity.error).toMatch(/Install the GitHub CLI/);
    // Fourteen empty days, so the chart still renders its axis.
    expect(activity.days).toHaveLength(14);
    expect(activity.runs).toEqual([]);
  });

  it('succeeds with nothing to show when no project has a GitHub remote', async () => {
    storeState.projects = [project()];
    scenario.gitRemote = null;

    const activity = await actions.fetchDashboardActionsActivity();

    expect(activity).toMatchObject({ ok: true, cliAvailable: true, repoCount: 0 });
    expect(activity.runs).toEqual([]);
  });

  it('counts passes and failures per day and tallies the week', async () => {
    storeState.projects = [project()];
    scenario.gitRemote = 'https://github.com/acme/demo';
    scenario.api['repos/acme/demo/actions/runs?per_page=50'] = {
      workflow_runs: [
        ghRun({ id: 1, conclusion: 'success', updated_at: at(0) }),
        ghRun({ id: 2, conclusion: 'failure', updated_at: at(0) }),
        ghRun({ id: 3, conclusion: 'timed_out', updated_at: at(-1) }),
        // Cancelled is neither a pass nor a failure, so it must not move either bar.
        ghRun({ id: 4, conclusion: 'cancelled', updated_at: at(-1) }),
        // Ten days back is inside the chart but outside the seven day tally.
        ghRun({ id: 5, conclusion: 'success', updated_at: at(-10) }),
        ghRun({ id: 6, status: 'in_progress', conclusion: null, updated_at: at(0) }),
      ],
    };

    const activity = await actions.fetchDashboardActionsActivity();

    const byDate = new Map(activity.days.map((day) => [day.date, day]));
    expect(byDate.get(localDay(0))).toEqual({ date: localDay(0), passed: 1, failed: 1 });
    expect(byDate.get(localDay(-1))).toEqual({ date: localDay(-1), passed: 0, failed: 1 });
    expect(byDate.get(localDay(-10))).toEqual({ date: localDay(-10), passed: 1, failed: 0 });
    expect(activity.weekPassed).toBe(1);
    expect(activity.weekFailed).toBe(2);
    expect(activity.runningCount).toBe(1);
    expect(activity.repoCount).toBe(1);
  });

  it('labels every run with the project it belongs to and sorts newest first', async () => {
    storeState.projects = [project()];
    scenario.gitRemote = 'https://github.com/acme/demo';
    scenario.api['repos/acme/demo/actions/runs?per_page=50'] = {
      workflow_runs: [ghRun({ id: 1, updated_at: at(-2) }), ghRun({ id: 2, updated_at: at(0) })],
    };

    const activity = await actions.fetchDashboardActionsActivity();

    expect(activity.runs.map((run) => run.id)).toEqual([2, 1]);
    expect(activity.runs[0]).toMatchObject({
      projectId: 'proj-1',
      projectName: 'Demo',
      repo: 'acme/demo',
      workflowName: 'CI',
      checkSuiteId: 9001,
    });
  });

  it('reads a repo shared by two projects only once', async () => {
    storeState.projects = [
      project({ id: 'a', name: 'A', folderPath: '/work/a' }),
      project({ id: 'b', name: 'B', folderPath: '/work/b' }),
    ];
    scenario.gitRemote = 'https://github.com/ACME/Demo.git';
    scenario.api['repos/ACME/Demo/actions/runs?per_page=50'] = { workflow_runs: [] };

    const activity = await actions.fetchDashboardActionsActivity();

    // Two projects in one clone would otherwise double every count on the chart.
    expect(activity.repoCount).toBe(1);
    expect(ghCalls().filter((args) => args[0] === 'api')).toHaveLength(1);
  });

  it('reports a sign-in problem rather than a raw API error', async () => {
    storeState.projects = [project()];
    scenario.gitRemote = 'https://github.com/acme/demo';
    scenario.apiErrors['repos/acme/demo/actions/runs?per_page=50'] = 'HTTP 401: Bad credentials';

    const activity = await actions.fetchDashboardActionsActivity();

    expect(activity).toMatchObject({ ok: false, cliAvailable: true, authenticated: false });
    expect(activity.error).toMatch(/gh auth login/);
  });
});

describe('dispatchWorkflow', () => {
  beforeEach(() => {
    scenario.gh['workflow run 100 --repo acme/demo --ref main'] = { stdout: '', stderr: '' };
  });

  it('builds the gh command from the repo, workflow and ref', async () => {
    await expect(
      actions.dispatchWorkflow({ repo: 'acme/demo', workflowId: 100, ref: 'main', inputs: {} }),
    ).resolves.toEqual({ ok: true });

    expect(ghCalls()).toContainEqual([
      'workflow',
      'run',
      '100',
      '--repo',
      'acme/demo',
      '--ref',
      'main',
    ]);
  });

  it('passes inputs as raw fields so a leading "@" is not read as a file path', async () => {
    scenario.gh[
      'workflow run 100 --repo acme/demo --ref main --raw-field environment=prod --raw-field note=@/etc/passwd'
    ] = { stdout: '', stderr: '' };

    await actions.dispatchWorkflow({
      repo: 'acme/demo',
      workflowId: 100,
      ref: 'main',
      inputs: { environment: 'prod', note: '@/etc/passwd' },
    });

    const args = ghCalls().find((call) => call[0] === 'workflow') ?? [];
    expect(args).toContain('--raw-field');
    expect(args).not.toContain('--field');
    expect(args.slice(7)).toEqual([
      '--raw-field',
      'environment=prod',
      '--raw-field',
      'note=@/etc/passwd',
    ]);
  });

  it('drops blank inputs so the workflow default applies', async () => {
    await actions.dispatchWorkflow({
      repo: 'acme/demo',
      workflowId: 100,
      ref: 'main',
      inputs: { environment: '', note: '  ' },
    });

    const args = ghCalls().find((call) => call[0] === 'workflow') ?? [];
    expect(args).toContain('--raw-field');
    expect(args).toContain('note=  ');
    expect(args.join(' ')).not.toContain('environment=');
  });

  it('trims the ref and refuses a blank one', async () => {
    await expect(
      actions.dispatchWorkflow({ repo: 'acme/demo', workflowId: 100, ref: '   ', inputs: {} }),
    ).resolves.toEqual({ ok: false, error: 'Pick a branch or tag to run this workflow from.' });
    expect(ghCalls()).toEqual([]);
  });

  it.each([
    ['demo', 100],
    ['acme/demo/extra', 100],
    ['acme/../demo', 100],
    ['acme/demo', 0],
    ['acme/demo', -1],
    ['acme/demo', 1.5],
  ])('refuses repo %s with workflow %s', async (repo, workflowId) => {
    await expect(
      actions.dispatchWorkflow({ repo, workflowId, ref: 'main', inputs: {} }),
    ).resolves.toEqual({ ok: false, error: 'That workflow could not be identified.' });
    expect(ghCalls()).toEqual([]);
  });

  it('needs the CLI to be installed', async () => {
    scenario.ghAvailable = false;

    const result = await actions.dispatchWorkflow({
      repo: 'acme/demo',
      workflowId: 100,
      ref: 'main',
      inputs: {},
    });

    expect(result).toEqual({
      ok: false,
      error: 'Install the GitHub CLI and sign in to start workflows.',
    });
  });

  it('returns gh stderr when the dispatch is rejected', async () => {
    scenario.ghErrors['workflow run 100 --repo acme/demo --ref main'] =
      'could not create workflow dispatch event: HTTP 422: Required input "environment" not provided';

    const result = await actions.dispatchWorkflow({
      repo: 'acme/demo',
      workflowId: 100,
      ref: 'main',
      inputs: {},
    });

    expect(result).toEqual({
      ok: false,
      error:
        'could not create workflow dispatch event: HTTP 422: Required input "environment" not provided',
    });
  });
});

describe('cancelWorkflowRun', () => {
  it('posts to the cancel endpoint', async () => {
    scenario.api['repos/acme/demo/actions/runs/5001/cancel'] = {};

    await expect(actions.cancelWorkflowRun({ repo: 'acme/demo', runId: 5001 })).resolves.toEqual({
      ok: true,
    });
    expect(ghCalls()).toContainEqual([
      'api',
      '-H',
      'Accept: application/vnd.github+json',
      'repos/acme/demo/actions/runs/5001/cancel',
      '--method',
      'POST',
    ]);
  });

  it('accepts an empty body, which is what GitHub answers a cancel with', async () => {
    // The cancel endpoint replies 202 with nothing in it, which is success and not bad JSON.
    scenario.apiRaw['repos/acme/demo/actions/runs/5001/cancel'] = '  \n';

    await expect(actions.cancelWorkflowRun({ repo: 'acme/demo', runId: 5001 })).resolves.toEqual({
      ok: true,
    });
  });

  it('explains a 409 in plain words', async () => {
    scenario.apiErrors['repos/acme/demo/actions/runs/5001/cancel'] =
      'HTTP 409: Cannot cancel a workflow run that is completed';

    await expect(actions.cancelWorkflowRun({ repo: 'acme/demo', runId: 5001 })).resolves.toEqual({
      ok: false,
      error: 'That run already finished, so there was nothing to stop.',
    });
  });

  it('passes any other failure through', async () => {
    scenario.apiErrors['repos/acme/demo/actions/runs/5001/cancel'] = 'HTTP 403: Forbidden';

    await expect(actions.cancelWorkflowRun({ repo: 'acme/demo', runId: 5001 })).resolves.toEqual({
      ok: false,
      error: 'HTTP 403: Forbidden',
    });
  });

  it('refuses an unidentifiable run', async () => {
    await expect(actions.cancelWorkflowRun({ repo: 'acme', runId: 5001 })).resolves.toEqual({
      ok: false,
      error: 'That workflow run could not be identified.',
    });
    await expect(actions.cancelWorkflowRun({ repo: 'acme/demo', runId: 0 })).resolves.toEqual({
      ok: false,
      error: 'That workflow run could not be identified.',
    });
  });

  it('needs the CLI to be installed', async () => {
    scenario.ghAvailable = false;
    const result = await actions.cancelWorkflowRun({ repo: 'acme/demo', runId: 5001 });
    expect(result).toEqual({
      ok: false,
      error: 'Install the GitHub CLI and sign in to stop workflow runs.',
    });
  });
});

describe('fetchWorkflowRefs', () => {
  it('lists the default branch, branches and tags', async () => {
    scenario.api['repos/acme/demo'] = { default_branch: 'main' };
    scenario.api['repos/acme/demo/branches?per_page=100'] = [{ name: 'main' }, { name: 'dev' }];
    scenario.api['repos/acme/demo/tags?per_page=50'] = [{ name: 'v1.0.0' }];

    await expect(actions.fetchWorkflowRefs('acme/demo')).resolves.toEqual({
      ok: true,
      defaultBranch: 'main',
      branches: ['main', 'dev'],
      tags: ['v1.0.0'],
    });
  });

  it('still answers when the tag listing fails', async () => {
    scenario.api['repos/acme/demo'] = { default_branch: 'main' };
    scenario.api['repos/acme/demo/branches?per_page=100'] = [{ name: 'main' }];
    scenario.apiErrors['repos/acme/demo/tags?per_page=50'] = 'HTTP 404: Not Found';

    // Tags are optional, so a repo with none must not lose its branch list.
    await expect(actions.fetchWorkflowRefs('acme/demo')).resolves.toEqual({
      ok: true,
      defaultBranch: 'main',
      branches: ['main'],
      tags: [],
    });
  });

  it('falls back to the first branch when the repo reports no default', async () => {
    scenario.api['repos/acme/demo'] = {};
    scenario.api['repos/acme/demo/branches?per_page=100'] = [{ name: 'trunk' }];
    scenario.api['repos/acme/demo/tags?per_page=50'] = [];

    const refs = await actions.fetchWorkflowRefs('acme/demo');
    expect(refs).toMatchObject({ ok: true, defaultBranch: 'trunk' });
  });

  it('refuses a repo it cannot identify', async () => {
    await expect(actions.fetchWorkflowRefs('nope')).resolves.toEqual({
      ok: false,
      error: 'That repository could not be identified.',
    });
  });

  it('reports a failure from the branch listing', async () => {
    scenario.api['repos/acme/demo'] = { default_branch: 'main' };
    scenario.apiErrors['repos/acme/demo/branches?per_page=100'] = 'HTTP 403: Forbidden';

    await expect(actions.fetchWorkflowRefs('acme/demo')).resolves.toEqual({
      ok: false,
      error: 'HTTP 403: Forbidden',
    });
  });
});

describe('fetchRunFailureText', () => {
  const input = {
    repo: 'acme/demo',
    runId: 5001,
    workflowName: 'CI',
    displayTitle: 'Fix the flake',
    runNumber: 42,
    headBranch: 'main',
  };
  const logsKey = 'run view 5001 --repo acme/demo --log-failed';

  it('puts the header, failed steps and annotations together', async () => {
    scenario.api['repos/acme/demo/actions/runs/5001/jobs?per_page=100'] = {
      jobs: [
        { id: 1, name: 'build', conclusion: 'success', steps: [] },
        {
          id: 2,
          name: 'test',
          conclusion: 'failure',
          steps: [
            { name: 'Checkout', conclusion: 'success' },
            { name: 'Run vitest', conclusion: 'failure' },
          ],
        },
      ],
    };
    scenario.api['repos/acme/demo/check-runs/2/annotations'] = [
      {
        path: 'src/app.ts',
        start_line: 12,
        annotation_level: 'failure',
        title: 'Assertion failed',
        message: 'expected 1 to be 2',
      },
      {
        path: 'src/other.ts',
        start_line: 3,
        annotation_level: 'warning',
        message: 'unused import',
      },
    ];

    const result = await actions.fetchRunFailureText(input);

    expect(result.ok).toBe(true);
    const text = result.ok ? result.text : '';
    expect(text).toContain('Fix the flake failed');
    expect(text).toContain('acme/demo · #42 · main');
    expect(text).toContain('Job: test');
    expect(text).toContain('  Step: Run vitest (failure)');
    // Only the failure-level annotations, since a warning is noise next to the real error.
    expect(text).toContain('src/app.ts:12');
    expect(text).toContain('expected 1 to be 2');
    expect(text).not.toContain('unused import');
    // Annotations were enough, so the expensive log download is skipped.
    expect(ghCalls().some((args) => args[0] === 'run')).toBe(false);
  });

  it('falls back to the failed logs when the annotation says nothing useful', async () => {
    scenario.api['repos/acme/demo/actions/runs/5001/jobs?per_page=100'] = {
      jobs: [{ id: 2, name: 'test', conclusion: 'failure', steps: [] }],
    };
    scenario.api['repos/acme/demo/check-runs/2/annotations'] = [
      {
        path: '',
        start_line: 0,
        annotation_level: 'failure',
        message: 'Process completed with exit code 1.',
      },
    ];
    scenario.gh[logsKey] = {
      stdout: `test\tRun vitest\t${String.fromCharCode(27)}[31mFAIL src/app.test.ts${String.fromCharCode(27)}[0m`,
      stderr: '',
    };

    const result = await actions.fetchRunFailureText(input);
    const text = result.ok ? result.text : '';

    expect(text).toContain('FAIL src/app.test.ts');
    // ANSI colour codes would show up as garbage once pasted somewhere.
    expect(text).not.toContain(String.fromCharCode(27));
  });

  it('downloads the logs when there are no annotations at all', async () => {
    scenario.api['repos/acme/demo/actions/runs/5001/jobs?per_page=100'] = {
      jobs: [{ id: 2, name: 'test', conclusion: 'failure', steps: [] }],
    };
    scenario.api['repos/acme/demo/check-runs/2/annotations'] = [];
    scenario.gh[logsKey] = { stdout: 'boom', stderr: '' };

    const result = await actions.fetchRunFailureText(input);

    expect(result.ok).toBe(true);
    expect(ghCalls()).toContainEqual([
      'run',
      'view',
      '5001',
      '--repo',
      'acme/demo',
      '--log-failed',
    ]);
  });

  it('keeps the tail of a very long log', async () => {
    scenario.api['repos/acme/demo/actions/runs/5001/jobs?per_page=100'] = {
      jobs: [{ id: 2, name: 'test', conclusion: 'failure', steps: [] }],
    };
    scenario.api['repos/acme/demo/check-runs/2/annotations'] = [];
    scenario.gh[logsKey] = { stdout: `${'noise\n'.repeat(4000)}THE REAL ERROR`, stderr: '' };

    const result = await actions.fetchRunFailureText(input);
    const text = result.ok ? result.text : '';

    // The end of a CI log is where the failure is, so the head is what gets dropped.
    expect(text).toContain('THE REAL ERROR');
    expect(text).toContain('...\n');
    expect(text.length).toBeLessThan(13_000);
  });

  it('lists every job when none of them is marked failed', async () => {
    scenario.api['repos/acme/demo/actions/runs/5001/jobs?per_page=100'] = {
      jobs: [{ id: 1, name: 'build', conclusion: 'cancelled', steps: [] }],
    };
    scenario.gh[logsKey] = { stdout: '', stderr: '' };

    const result = await actions.fetchRunFailureText(input);
    const text = result.ok ? result.text : '';

    expect(text).toContain('Job: build (cancelled)');
  });

  it('treats a failed step as a failed job even when the job says otherwise', async () => {
    scenario.api['repos/acme/demo/actions/runs/5001/jobs?per_page=100'] = {
      jobs: [
        {
          id: 3,
          name: 'flaky',
          conclusion: 'success',
          steps: [{ name: 'Retry', conclusion: 'timed_out' }],
        },
      ],
    };
    scenario.api['repos/acme/demo/check-runs/3/annotations'] = [];
    scenario.gh[logsKey] = { stdout: 'timed out', stderr: '' };

    const result = await actions.fetchRunFailureText(input);
    const text = result.ok ? result.text : '';

    expect(text).toContain('Job: flaky');
    expect(text).toContain('  Step: Retry (timed_out)');
  });

  it('accepts an annotations payload wrapped in an object', async () => {
    scenario.api['repos/acme/demo/actions/runs/5001/jobs?per_page=100'] = {
      jobs: [{ id: 2, name: 'test', conclusion: 'failure', steps: [] }],
    };
    scenario.api['repos/acme/demo/check-runs/2/annotations'] = {
      annotations: [
        {
          path: 'src/app.ts',
          start_line: 1,
          annotation_level: 'failure',
          message: 'a message long enough not to trigger the log fallback path at all',
        },
      ],
    };

    const result = await actions.fetchRunFailureText(input);
    expect(result.ok ? result.text : '').toContain('src/app.ts:1');
  });

  it('caches the text, so copying twice costs one set of calls', async () => {
    scenario.api['repos/acme/demo/actions/runs/5001/jobs?per_page=100'] = {
      jobs: [{ id: 2, name: 'test', conclusion: 'failure', steps: [] }],
    };
    scenario.api['repos/acme/demo/check-runs/2/annotations'] = [];
    scenario.gh[logsKey] = { stdout: 'boom', stderr: '' };

    await actions.fetchRunFailureText(input);
    const before = proc.calls.length;
    await actions.fetchRunFailureText(input);

    expect(proc.calls.length).toBe(before);
  });

  it('refuses a run it cannot identify', async () => {
    await expect(actions.fetchRunFailureText({ repo: 'acme', runId: 1 })).resolves.toEqual({
      ok: false,
      error: 'That workflow run could not be identified.',
    });
    await expect(
      actions.fetchRunFailureText({ repo: 'acme/demo', runId: Number.NaN }),
    ).resolves.toEqual({ ok: false, error: 'That workflow run could not be identified.' });
  });

  it('needs the CLI to be installed', async () => {
    scenario.ghAvailable = false;
    await expect(actions.fetchRunFailureText(input)).resolves.toEqual({
      ok: false,
      error: 'Install the GitHub CLI and sign in to copy this error.',
    });
  });

  it('still produces a usable header when the run has no jobs or logs', async () => {
    scenario.api['repos/acme/demo/actions/runs/5001/jobs?per_page=100'] = { jobs: [] };
    scenario.gh[logsKey] = { stdout: '', stderr: '' };

    const result = await actions.fetchRunFailureText({ repo: 'acme/demo', runId: 5001 });

    // The header alone is worth copying: it names the repo and the run.
    expect(result.ok).toBe(true);
    expect(result.ok ? result.text : '').toBe('Workflow failed\nacme/demo');
  });

  it('reports the job lookup failure', async () => {
    scenario.apiErrors['repos/acme/demo/actions/runs/5001/jobs?per_page=100'] =
      'HTTP 403: Forbidden';

    await expect(actions.fetchRunFailureText(input)).resolves.toEqual({
      ok: false,
      error: 'HTTP 403: Forbidden',
    });
  });
});

describe('fetchRunAnnotations', () => {
  function seedSuite(): void {
    scenario.api['repos/acme/demo/check-suites/9001/check-runs?per_page=100'] = {
      check_runs: [
        { id: 11, name: 'test', output: { annotations_count: 2 } },
        // A job that left nothing must not cost a second round trip.
        { id: 12, name: 'build', output: { annotations_count: 0 } },
        { id: 13, name: 'lint' },
      ],
    };
    scenario.api['repos/acme/demo/check-runs/11/annotations?per_page=50'] = [
      {
        path: 'src/b.ts',
        start_line: 5,
        end_line: 6,
        annotation_level: 'warning',
        title: 'Deprecated',
        message: 'use the new helper',
      },
      {
        path: 'src/a.ts',
        start_line: 1,
        annotation_level: 'failure',
        message: 'type error',
      },
      {
        path: 'src/c.ts',
        start_line: 0,
        annotation_level: 'something_else',
        message: 'just so you know',
      },
    ];
  }

  it('returns the annotations failures first, with counts per level', async () => {
    seedSuite();

    const result = await actions.fetchRunAnnotations({
      repo: 'acme/demo',
      runId: 5001,
      checkSuiteId: 9001,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The Pipelines page colours the run by the worst level, so the order matters.
    expect(result.annotations.map((item) => item.level)).toEqual(['failure', 'warning', 'notice']);
    expect(result.counts).toEqual({ failure: 1, warning: 1, notice: 1 });
    expect(result.annotations[0]).toEqual({
      level: 'failure',
      jobName: 'test',
      path: 'src/a.ts',
      startLine: 1,
      endLine: null,
      title: '',
      message: 'type error',
    });
    expect(result.annotations[1].endLine).toBe(6);
    // A line number of 0 means "no line", not line zero.
    expect(result.annotations[2].startLine).toBeNull();
  });

  it('looks up the check suite id when the caller does not have one', async () => {
    seedSuite();
    scenario.api['repos/acme/demo/actions/runs/5001'] = ghRun();

    const result = await actions.fetchRunAnnotations({ repo: 'acme/demo', runId: 5001 });

    expect(result.ok).toBe(true);
    expect(ghCalls().map((args) => args[3])).toContain('repos/acme/demo/actions/runs/5001');
  });

  it('explains when GitHub has no check suite for the run', async () => {
    scenario.api['repos/acme/demo/actions/runs/5001'] = ghRun({ check_suite_id: undefined });

    await expect(actions.fetchRunAnnotations({ repo: 'acme/demo', runId: 5001 })).resolves.toEqual({
      ok: false,
      error: 'GitHub did not say which checks belong to this run.',
    });
  });

  it('caches a run, because a finished run never grows new annotations', async () => {
    seedSuite();

    await actions.fetchRunAnnotations({ repo: 'acme/demo', runId: 5001, checkSuiteId: 9001 });
    const before = proc.calls.length;
    await actions.fetchRunAnnotations({ repo: 'acme/demo', runId: 5001, checkSuiteId: 9001 });

    expect(proc.calls.length).toBe(before);
  });

  it('returns nothing when no job left an annotation', async () => {
    scenario.api['repos/acme/demo/check-suites/9001/check-runs?per_page=100'] = {
      check_runs: [{ id: 12, name: 'build', output: { annotations_count: 0 } }],
    };

    await expect(
      actions.fetchRunAnnotations({ repo: 'acme/demo', runId: 5001, checkSuiteId: 9001 }),
    ).resolves.toEqual({
      ok: true,
      annotations: [],
      counts: { failure: 0, warning: 0, notice: 0 },
    });
  });

  it('refuses a run it cannot identify', async () => {
    await expect(actions.fetchRunAnnotations({ repo: 'acme', runId: 1 })).resolves.toEqual({
      ok: false,
      error: 'That workflow run could not be identified.',
    });
  });

  it('needs the CLI to be installed', async () => {
    scenario.ghAvailable = false;
    await expect(
      actions.fetchRunAnnotations({ repo: 'acme/demo', runId: 5001, checkSuiteId: 9001 }),
    ).resolves.toEqual({
      ok: false,
      error: 'Install the GitHub CLI and sign in to see annotations.',
    });
  });

  it('reports a failure from the check suite listing', async () => {
    scenario.apiErrors['repos/acme/demo/check-suites/9001/check-runs?per_page=100'] =
      'HTTP 403: Forbidden';

    await expect(
      actions.fetchRunAnnotations({ repo: 'acme/demo', runId: 5001, checkSuiteId: 9001 }),
    ).resolves.toEqual({ ok: false, error: 'HTTP 403: Forbidden' });
  });
});

describe('fetchRunDetails', () => {
  const JOBS_PATH = 'repos/acme/demo/actions/runs/5001/jobs?per_page=100';

  /** A job as the REST API prints it. */
  function ghJob(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 11,
      name: 'test',
      status: 'completed',
      conclusion: 'success',
      started_at: '2026-03-15T09:00:05Z',
      completed_at: '2026-03-15T09:04:35Z',
      html_url: 'https://github.com/acme/demo/actions/runs/5001/job/11',
      runner_name: 'GitHub Actions 3',
      steps: [
        {
          number: 1,
          name: 'Set up job',
          status: 'completed',
          conclusion: 'success',
          started_at: '2026-03-15T09:00:05Z',
          completed_at: '2026-03-15T09:00:07Z',
        },
        {
          number: 2,
          name: 'Run tests',
          status: 'completed',
          conclusion: 'failure',
          started_at: '2026-03-15T09:00:07Z',
          completed_at: '2026-03-15T09:04:30Z',
        },
      ],
      ...overrides,
    };
  }

  it('maps the jobs and their steps with timings, status and conclusion', async () => {
    scenario.api[JOBS_PATH] = { jobs: [ghJob()] };

    const result = await actions.fetchRunDetails({ repo: 'acme/demo', runId: 5001 });

    expect(result).toEqual({
      ok: true,
      jobs: [
        {
          id: 11,
          name: 'test',
          status: 'completed',
          conclusion: 'success',
          startedAt: '2026-03-15T09:00:05Z',
          completedAt: '2026-03-15T09:04:35Z',
          htmlUrl: 'https://github.com/acme/demo/actions/runs/5001/job/11',
          runnerName: 'GitHub Actions 3',
          steps: [
            {
              number: 1,
              name: 'Set up job',
              status: 'completed',
              conclusion: 'success',
              startedAt: '2026-03-15T09:00:05Z',
              completedAt: '2026-03-15T09:00:07Z',
            },
            {
              number: 2,
              name: 'Run tests',
              status: 'completed',
              conclusion: 'failure',
              startedAt: '2026-03-15T09:00:07Z',
              completedAt: '2026-03-15T09:04:30Z',
            },
          ],
        },
      ],
    });
  });

  it('keeps a job that has not started as nulls, not as made-up times', async () => {
    scenario.api[JOBS_PATH] = {
      jobs: [
        ghJob({
          status: 'queued',
          conclusion: null,
          started_at: null,
          completed_at: null,
          runner_name: null,
          steps: [],
        }),
      ],
    };

    const result = await actions.fetchRunDetails({ repo: 'acme/demo', runId: 5001 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.jobs[0]).toMatchObject({
      status: 'queued',
      conclusion: null,
      startedAt: null,
      completedAt: null,
      runnerName: null,
      steps: [],
    });
  });

  it('treats a missing steps list as no steps and a status GitHub adds later as unknown', async () => {
    scenario.api[JOBS_PATH] = {
      jobs: [ghJob({ status: 'some_new_state', conclusion: 'brand_new', steps: undefined })],
    };

    const result = await actions.fetchRunDetails({ repo: 'acme/demo', runId: 5001 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.jobs[0]).toMatchObject({ status: 'unknown', conclusion: null, steps: [] });
  });

  it('returns an empty list for a run that has no jobs yet', async () => {
    scenario.api[JOBS_PATH] = { jobs: [] };

    await expect(actions.fetchRunDetails({ repo: 'acme/demo', runId: 5001 })).resolves.toEqual({
      ok: true,
      jobs: [],
    });
  });

  it('refuses a run it cannot identify', async () => {
    await expect(actions.fetchRunDetails({ repo: 'acme', runId: 1 })).resolves.toEqual({
      ok: false,
      error: 'That workflow run could not be identified.',
    });
    await expect(actions.fetchRunDetails({ repo: 'acme/demo', runId: 0 })).resolves.toEqual({
      ok: false,
      error: 'That workflow run could not be identified.',
    });
    expect(ghCalls()).toEqual([]);
  });

  it('says to install the CLI when gh cannot be started at all', async () => {
    proc.reply = async () => {
      const error = new Error('spawn gh ENOENT') as Error & { code: string };
      error.code = 'ENOENT';
      throw error;
    };
    await expect(actions.fetchRunDetails({ repo: 'acme/demo', runId: 5001 })).resolves.toEqual({
      ok: false,
      error: 'Install the GitHub CLI and sign in to see this run.',
    });
  });

  it('does not depend on a version probe, which can time out when gh is busy', async () => {
    // Clicking through pipelines fires several gh calls at once. A bare `gh --version` among them
    // used to time out on a loaded machine and turn a working gh into "Install the GitHub CLI".
    scenario.ghAvailable = false;
    scenario.api[JOBS_PATH] = { jobs: [ghJob()] };

    const result = await actions.fetchRunDetails({ repo: 'acme/demo', runId: 5001 });

    expect(result.ok).toBe(true);
    expect(ghCalls().some((args) => args[0] === '--version')).toBe(false);
  });

  it('reports a GitHub failure instead of throwing', async () => {
    scenario.apiErrors[JOBS_PATH] = 'HTTP 403: Forbidden';

    await expect(actions.fetchRunDetails({ repo: 'acme/demo', runId: 5001 })).resolves.toEqual({
      ok: false,
      error: 'HTTP 403: Forbidden',
    });
  });

  it('serves a finished run from memory for a while, since its steps no longer change', async () => {
    scenario.api[JOBS_PATH] = { jobs: [ghJob()] };

    await actions.fetchRunDetails({ repo: 'acme/demo', runId: 5001 });
    const before = proc.calls.length;
    await actions.fetchRunDetails({ repo: 'acme/demo', runId: 5001 });

    expect(proc.calls.length).toBe(before);
  });

  it('asks GitHub again once the remembered answer is old, in case the run was re-run', async () => {
    vi.useFakeTimers();
    scenario.api[JOBS_PATH] = { jobs: [ghJob()] };

    await actions.fetchRunDetails({ repo: 'acme/demo', runId: 5001 });
    const before = proc.calls.length;
    vi.advanceTimersByTime(11 * 60_000);
    await actions.fetchRunDetails({ repo: 'acme/demo', runId: 5001 });

    expect(proc.calls.length).toBeGreaterThan(before);
  });

  it('never remembers a run that is still going, so each look sees the newest step', async () => {
    scenario.api[JOBS_PATH] = { jobs: [ghJob({ status: 'in_progress', conclusion: null })] };

    await actions.fetchRunDetails({ repo: 'acme/demo', runId: 5001 });
    const before = proc.calls.length;
    await actions.fetchRunDetails({ repo: 'acme/demo', runId: 5001 });

    expect(proc.calls.length).toBeGreaterThan(before);
  });

  it('never remembers a run with no jobs yet', async () => {
    scenario.api[JOBS_PATH] = { jobs: [] };

    await actions.fetchRunDetails({ repo: 'acme/demo', runId: 5001 });
    const before = proc.calls.length;
    await actions.fetchRunDetails({ repo: 'acme/demo', runId: 5001 });

    expect(proc.calls.length).toBeGreaterThan(before);
  });
});

describe('setProjectMutedActions', () => {
  it('stores the muted workflows and stamps the project as updated', async () => {
    storeState.projects = [project()];

    const updated = await actions.setProjectMutedActions('proj-1', [
      { workflowId: 100, path: '.github/workflows/ci.yml', name: 'CI' },
    ]);

    expect(updated.githubActionsMuted).toEqual([
      { workflowId: 100, path: '.github/workflows/ci.yml', name: 'CI' },
    ]);
    expect(updated.updatedAt).not.toBe('2026-01-01T00:00:00.000Z');
    expect(storeState.writes).toHaveLength(1);
  });

  it('drops entries that are not a usable workflow reference', async () => {
    storeState.projects = [project()];

    const updated = await actions.setProjectMutedActions('proj-1', [
      { workflowId: 100, path: 'ci.yml', name: 'CI' },
      // Duplicates and blanks would make the mute list grow without bound.
      { workflowId: 100, path: 'ci.yml', name: 'CI' },
      { workflowId: 0, path: 'bad.yml', name: 'Bad' },
      { workflowId: 101, path: '', name: 'Empty' },
    ]);

    expect(updated.githubActionsMuted).toEqual([{ workflowId: 100, path: 'ci.yml', name: 'CI' }]);
  });

  it('throws for a project that is not there', async () => {
    storeState.projects = [];
    await expect(actions.setProjectMutedActions('ghost', [])).rejects.toThrow(
      'Project ghost not found',
    );
  });
});
