import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GithubRunnersRunRef } from '../../shared/apiTypes';

/**
 * Same approach as githubActions.test.ts: only the process boundary is stubbed, so `execFile`
 * gets the JSON the real `gh` would print and the real `ghApi`/`runGh` run on top of it.
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

const storeState = vi.hoisted(() => ({ projects: [] as unknown[] }));

vi.mock('../store', () => ({
  store: {
    getProjects: async () => storeState.projects,
    setProjects: async (next: unknown[]) => {
      storeState.projects = next;
    },
  },
}));

function execError(stderr: string): Error {
  const error = new Error('Command failed') as Error & { stderr: string };
  error.stderr = stderr;
  return error;
}

interface Scenario {
  ghAvailable: boolean;
  /** Origin remote per project folder. */
  remotes: Record<string, string>;
  api: Record<string, unknown>;
  apiErrors: Record<string, string>;
}

let scenario: Scenario;
let runners: typeof import('./githubRunners');

async function reply(file: string, args: string[]): Promise<ExecReply> {
  if (file === 'git') {
    const remote = scenario.remotes[args[1]];
    if (!remote) throw execError('fatal: No such remote origin');
    return { stdout: `${remote}\n`, stderr: '' };
  }
  if (file !== 'gh') throw execError(`unexpected command ${file}`);
  if (args[0] === '--version') {
    if (!scenario.ghAvailable) throw execError('gh: command not found');
    return { stdout: 'gh version 2.62.0\n', stderr: '' };
  }
  if (args[0] === 'api') {
    const path = args[3];
    const failure = scenario.apiErrors[path];
    if (failure) throw execError(failure);
    if (!(path in scenario.api)) throw execError(`HTTP 404: Not Found (${path})`);
    return { stdout: JSON.stringify(scenario.api[path]), stderr: '' };
  }
  throw execError(`unexpected gh call ${args.join(' ')}`);
}

const NOW = new Date('2026-03-15T12:00:00.000Z');
/** An ISO timestamp `minutes` before NOW. */
const ago = (minutes: number): string => new Date(NOW.getTime() - minutes * 60_000).toISOString();

const ORG_FORBIDDEN =
  'gh: You must be an org admin or have the runners and runner groups fine-grained permission. (HTTP 403)\n' +
  'gh: This API operation needs the "admin:org" scope. To request it, run:  gh auth refresh -h github.com -s admin:org';
const NOT_FOUND = 'gh: Not Found (HTTP 404)';

const repoRunnersPath = (repo: string): string => `repos/${repo}/actions/runners?per_page=100`;
const orgRunnersPath = (org: string): string => `orgs/${org}/actions/runners?per_page=100`;
const jobsPath = (repo: string, runId: number): string =>
  `repos/${repo}/actions/runs/${runId}/jobs?per_page=100`;

/** One project per repo, each in its own folder. */
function useRepos(...repos: string[]): void {
  storeState.projects = repos.map((repo, index) => ({
    id: `proj-${index}`,
    name: repo,
    folderPath: `/work/${index}`,
  }));
  for (const [index, repo] of repos.entries()) {
    scenario.remotes[`/work/${index}`] = `https://github.com/${repo}.git`;
  }
}

function label(name: string, type: 'read-only' | 'custom' = 'read-only') {
  return { id: name.length, name, type };
}

/** A runner as the runners API prints it. */
function ghRunner(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    name: 'build-1',
    os: 'Linux',
    status: 'online',
    busy: false,
    labels: [label('self-hosted'), label('Linux'), label('X64')],
    ...overrides,
  };
}

function runnerList(...items: Record<string, unknown>[]): Record<string, unknown> {
  return { total_count: items.length, runners: items };
}

/** A job as the run jobs API prints it, on a self-hosted runner by default. */
function ghJob(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 900,
    run_id: 77,
    name: 'build',
    status: 'completed',
    conclusion: 'success',
    labels: ['self-hosted', 'linux', 'x64'],
    runner_name: 'SmartAgent',
    runner_group_name: 'default',
    html_url: 'https://github.com/acme/api/actions/runs/77/job/900',
    created_at: ago(30),
    started_at: ago(29),
    completed_at: ago(20),
    ...overrides,
  };
}

function run(
  repo: string,
  runId: number,
  completed: boolean,
  workflowName = 'CI',
): GithubRunnersRunRef {
  return { repo, runId, workflowName, completed };
}

function apiCalls(): string[] {
  return proc.calls
    .filter((call) => call.file === 'gh' && call.args[0] === 'api')
    .map((call) => call.args[3]);
}

beforeEach(async () => {
  proc.calls.length = 0;
  storeState.projects = [];
  scenario = { ghAvailable: true, remotes: {}, api: {}, apiErrors: {} };
  proc.reply = reply;
  // Only Date is faked: runGh's retry delays still use real timers.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  // The forbidden and jobs caches live at module level, so each test gets a fresh module.
  vi.resetModules();
  runners = await import('./githubRunners');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('fetchRunnerStatus', () => {
  it('asks for the GitHub CLI when it is not installed', async () => {
    scenario.ghAvailable = false;

    const result = await runners.fetchRunnerStatus({ runs: [] });

    expect(result).toEqual({
      ok: false,
      error: 'Install the GitHub CLI and sign in to see self-hosted runners.',
    });
  });

  describe('live runner lists', () => {
    it('reads one list per repo and one per distinct owner', async () => {
      useRepos('acme/api', 'acme/web', 'me/tool');
      scenario.api[repoRunnersPath('acme/api')] = runnerList();
      scenario.api[repoRunnersPath('acme/web')] = runnerList();
      scenario.api[repoRunnersPath('me/tool')] = runnerList();
      scenario.api[orgRunnersPath('acme')] = runnerList();
      scenario.apiErrors[orgRunnersPath('me')] = NOT_FOUND;

      const result = await runners.fetchRunnerStatus({ runs: [] });

      expect(result.ok).toBe(true);
      expect(apiCalls().sort()).toEqual(
        [
          repoRunnersPath('acme/api'),
          repoRunnersPath('acme/web'),
          repoRunnersPath('me/tool'),
          orgRunnersPath('acme'),
          orgRunnersPath('me'),
        ].sort(),
      );
    });

    it('skips a repo list it is not allowed to read', async () => {
      useRepos('acme/api');
      scenario.apiErrors[repoRunnersPath('acme/api')] =
        'gh: Must have admin rights to Repository. (HTTP 403)';
      scenario.api[orgRunnersPath('acme')] = runnerList(ghRunner({ name: 'org-box' }));

      const result = await runners.fetchRunnerStatus({ runs: [] });

      expect(result).toMatchObject({ ok: true, hiddenOrgs: [] });
      if (!result.ok) return;
      expect(result.runners.map((item) => item.name)).toEqual(['org-box']);
    });

    it('marks a runner named after this computer, the name config.sh suggests', async () => {
      const host = os.hostname().split('.')[0];
      useRepos('acme/api');
      scenario.api[repoRunnersPath('acme/api')] = runnerList(
        ghRunner({ id: 1, name: host.toUpperCase() }),
        ghRunner({ id: 2, name: `${host}-other` }),
      );
      scenario.apiErrors[orgRunnersPath('acme')] = NOT_FOUND;

      const result = await runners.fetchRunnerStatus({ runs: [] });

      if (!result.ok) throw new Error(result.error);
      expect(
        result.runners.map((item) => [item.name, item.onThisComputer ?? false]).sort(),
      ).toEqual(
        [
          [host.toUpperCase(), true],
          [`${host}-other`, false],
        ].sort(),
      );
    });

    it('also skips a repo list that answers 404', async () => {
      useRepos('acme/api');
      scenario.apiErrors[repoRunnersPath('acme/api')] = 'HTTP 404: Not Found';
      scenario.api[orgRunnersPath('acme')] = runnerList();

      const result = await runners.fetchRunnerStatus({ runs: [] });

      expect(result).toEqual({ ok: true, runners: [], waiting: [], hiddenOrgs: [] });
    });

    it('lists an org whose runners need admin:org as hidden', async () => {
      useRepos('acme/api');
      scenario.api[repoRunnersPath('acme/api')] = runnerList();
      scenario.apiErrors[orgRunnersPath('acme')] = ORG_FORBIDDEN;

      const result = await runners.fetchRunnerStatus({ runs: [] });

      expect(result).toEqual({ ok: true, runners: [], waiting: [], hiddenOrgs: ['acme'] });
    });

    it('says nothing about an owner that is a user account', async () => {
      useRepos('me/tool');
      scenario.api[repoRunnersPath('me/tool')] = runnerList();
      scenario.apiErrors[orgRunnersPath('me')] = NOT_FOUND;

      const result = await runners.fetchRunnerStatus({ runs: [] });

      expect(result).toEqual({ ok: true, runners: [], waiting: [], hiddenOrgs: [] });
    });

    it('does not ask again for a forbidden list within ten minutes', async () => {
      useRepos('acme/api');
      scenario.apiErrors[repoRunnersPath('acme/api')] = 'gh: Forbidden (HTTP 403)';
      scenario.apiErrors[orgRunnersPath('acme')] = ORG_FORBIDDEN;

      await runners.fetchRunnerStatus({ runs: [] });
      vi.setSystemTime(new Date(NOW.getTime() + 9 * 60_000));
      const second = await runners.fetchRunnerStatus({ runs: [] });

      // The cached answer still counts, so the org stays hidden without a call.
      expect(second).toMatchObject({ ok: true, hiddenOrgs: ['acme'] });
      expect(apiCalls().filter((path) => path.includes('/runners'))).toHaveLength(2);

      vi.setSystemTime(new Date(NOW.getTime() + 11 * 60_000));
      await runners.fetchRunnerStatus({ runs: [] });

      expect(apiCalls().filter((path) => path.includes('/runners'))).toHaveLength(4);
    });

    it('asks every list again on a fresh refresh, so a newly granted scope shows', async () => {
      useRepos('acme/api');
      scenario.api[repoRunnersPath('acme/api')] = runnerList();
      scenario.apiErrors[orgRunnersPath('acme')] = ORG_FORBIDDEN;
      await runners.fetchRunnerStatus({ runs: [] });

      // The user runs `gh auth refresh -s admin:org` and clicks Refresh.
      delete scenario.apiErrors[orgRunnersPath('acme')];
      scenario.api[orgRunnersPath('acme')] = runnerList(ghRunner({ name: 'org-box' }));
      const result = await runners.fetchRunnerStatus({ runs: [], fresh: true });

      if (!result.ok) throw new Error(result.error);
      expect(result.hiddenOrgs).toEqual([]);
      expect(result.runners.map((item) => item.name)).toEqual(['org-box']);
      expect(apiCalls().filter((path) => path === orgRunnersPath('acme'))).toHaveLength(2);
    });

    it.each([
      'gh: API rate limit exceeded for user ID 1. (HTTP 403)',
      'gh: You have exceeded a secondary rate limit. Please wait a few minutes before you try again. (HTTP 403)',
    ])('fails on a rate limit rather than treating it as a forbidden list: %s', async (message) => {
      useRepos('acme/api');
      scenario.api[repoRunnersPath('acme/api')] = runnerList();
      scenario.apiErrors[orgRunnersPath('acme')] = message;

      const limited = await runners.fetchRunnerStatus({ runs: [] });

      expect(limited).toEqual({ ok: false, error: message });

      // Nothing was cached, so the next poll asks again and sees the org's runners.
      delete scenario.apiErrors[orgRunnersPath('acme')];
      scenario.api[orgRunnersPath('acme')] = runnerList(ghRunner({ name: 'org-box' }));
      const next = await runners.fetchRunnerStatus({ runs: [] });

      expect(next).toMatchObject({ ok: true, hiddenOrgs: [] });
      expect(apiCalls().filter((path) => path === orgRunnersPath('acme'))).toHaveLength(2);
    });

    it('fails the whole result on a network error', async () => {
      useRepos('acme/api');
      scenario.apiErrors[repoRunnersPath('acme/api')] =
        'error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com';
      scenario.api[orgRunnersPath('acme')] = runnerList(ghRunner());

      const result = await runners.fetchRunnerStatus({ runs: [] });

      expect(result).toEqual({
        ok: false,
        error:
          'error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com',
      });
    });

    it('fails the whole result on a server error from the org list', async () => {
      useRepos('acme/api');
      scenario.api[repoRunnersPath('acme/api')] = runnerList();
      scenario.apiErrors[orgRunnersPath('acme')] = 'gh: Internal Server Error (HTTP 500)';

      const result = await runners.fetchRunnerStatus({ runs: [] });

      expect(result).toEqual({ ok: false, error: 'gh: Internal Server Error (HTTP 500)' });
    });

    it('fails on bad credentials rather than treating them as a forbidden list', async () => {
      useRepos('acme/api');
      scenario.apiErrors[repoRunnersPath('acme/api')] = 'gh: Bad credentials (HTTP 401)';
      scenario.api[orgRunnersPath('acme')] = runnerList();

      const result = await runners.fetchRunnerStatus({ runs: [] });

      expect(result.ok).toBe(false);
    });

    it('maps state, scope, labels and arch', async () => {
      useRepos('acme/api');
      scenario.api[repoRunnersPath('acme/api')] = runnerList(
        ghRunner({
          id: 11,
          name: 'repo-box',
          busy: true,
          labels: [label('self-hosted'), label('Linux'), label('ARM64'), label('gpu', 'custom')],
        }),
        ghRunner({ id: 12, name: 'repo-off', status: 'offline', os: 'Windows', labels: [] }),
      );
      scenario.api[orgRunnersPath('acme')] = runnerList(
        ghRunner({
          id: 21,
          name: 'org-box',
          os: 'macOS',
          labels: [label('self-hosted'), label('macOS'), label('X64'), label('xcode', 'custom')],
        }),
      );

      const result = await runners.fetchRunnerStatus({ runs: [] });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.runners).toEqual([
        {
          name: 'repo-box',
          id: 11,
          scope: { kind: 'repo', name: 'acme/api' },
          os: 'Linux',
          arch: 'ARM64',
          state: 'busy',
          labels: ['self-hosted', 'Linux', 'ARM64', 'gpu'],
          customLabels: ['gpu'],
        },
        {
          name: 'org-box',
          id: 21,
          scope: { kind: 'org', name: 'acme' },
          os: 'macOS',
          arch: 'X64',
          state: 'idle',
          labels: ['self-hosted', 'macOS', 'X64', 'xcode'],
          customLabels: ['xcode'],
        },
        {
          name: 'repo-off',
          id: 12,
          scope: { kind: 'repo', name: 'acme/api' },
          os: 'Windows',
          state: 'offline',
          labels: [],
          customLabels: [],
        },
      ]);
    });

    it('lists a runner once per scope and name', async () => {
      useRepos('acme/api');
      scenario.api[repoRunnersPath('acme/api')] = runnerList();
      scenario.api[orgRunnersPath('acme')] = runnerList(
        ghRunner({ id: 5, name: 'dup' }),
        ghRunner({ id: 5, name: 'DUP' }),
        ghRunner({ id: 6, name: 'other' }),
      );

      const result = await runners.fetchRunnerStatus({ runs: [] });

      if (!result.ok) throw new Error(result.error);
      expect(result.runners.map((item) => item.name)).toEqual(['dup', 'other']);
    });

    it('keeps a repo runner and an org runner that share an id', async () => {
      // Runner ids are numbered per repo or org, so the first runner of each is often id 1.
      useRepos('acme/api');
      scenario.api[repoRunnersPath('acme/api')] = runnerList(ghRunner({ id: 1, name: 'repo-box' }));
      scenario.api[orgRunnersPath('acme')] = runnerList(ghRunner({ id: 1, name: 'org-box' }));

      const result = await runners.fetchRunnerStatus({ runs: [] });

      if (!result.ok) throw new Error(result.error);
      expect(result.runners.map((item) => `${item.scope.kind}:${item.name}`)).toEqual([
        'org:org-box',
        'repo:repo-box',
      ]);
    });

    it('gives a busy runner the job it is running', async () => {
      useRepos('acme/api');
      scenario.api[repoRunnersPath('acme/api')] = runnerList(
        ghRunner({ name: 'SmartAgent', busy: true }),
      );
      scenario.api[orgRunnersPath('acme')] = runnerList();
      scenario.api[jobsPath('acme/api', 77)] = {
        jobs: [
          ghJob({ id: 1, name: 'lint', status: 'completed', runner_name: 'SmartAgent' }),
          ghJob({
            id: 2,
            name: 'deploy',
            status: 'in_progress',
            conclusion: null,
            completed_at: null,
            runner_name: 'smartagent',
            html_url: 'https://github.com/acme/api/actions/runs/77/job/2',
          }),
        ],
      };

      const result = await runners.fetchRunnerStatus({
        runs: [run('acme/api', 77, false, 'Deploy')],
      });

      if (!result.ok) throw new Error(result.error);
      expect(result.runners).toHaveLength(1);
      expect(result.runners[0].currentJob).toEqual({
        repo: 'acme/api',
        runId: 77,
        jobName: 'deploy',
        workflowName: 'Deploy',
        htmlUrl: 'https://github.com/acme/api/actions/runs/77/job/2',
      });
    });

    it('matches a busy runner to a job that never asked for the self-hosted label', async () => {
      // `runs-on: [gpu]` is enough to land on a self-hosted runner.
      useRepos('acme/api');
      scenario.api[repoRunnersPath('acme/api')] = runnerList(
        ghRunner({
          name: 'gpu-box',
          busy: true,
          labels: [label('self-hosted'), label('Linux'), label('gpu', 'custom')],
        }),
      );
      scenario.api[orgRunnersPath('acme')] = runnerList();
      scenario.api[jobsPath('acme/api', 77)] = {
        jobs: [
          ghJob({
            id: 5,
            name: 'train',
            status: 'in_progress',
            conclusion: null,
            completed_at: null,
            labels: ['gpu'],
            runner_name: 'GPU-box',
            html_url: 'https://github.com/acme/api/actions/runs/77/job/5',
          }),
        ],
      };

      const result = await runners.fetchRunnerStatus({
        runs: [run('acme/api', 77, false, 'Train')],
      });

      if (!result.ok) throw new Error(result.error);
      expect(result.runners).toHaveLength(1);
      expect(result.runners[0].currentJob).toEqual({
        repo: 'acme/api',
        runId: 77,
        jobName: 'train',
        workflowName: 'Train',
        htmlUrl: 'https://github.com/acme/api/actions/runs/77/job/5',
      });
    });
  });

  describe('runners seen through jobs', () => {
    it('reports a runner from finished jobs with its last job time and labels', async () => {
      useRepos('acme/api');
      scenario.apiErrors[repoRunnersPath('acme/api')] = 'gh: Forbidden (HTTP 403)';
      scenario.apiErrors[orgRunnersPath('acme')] = ORG_FORBIDDEN;
      scenario.api[jobsPath('acme/api', 70)] = {
        jobs: [
          ghJob({
            id: 1,
            labels: ['self-hosted', 'macOS', 'ARM64', 'xcode'],
            runner_name: 'Mac-Mini',
            completed_at: ago(40),
          }),
        ],
      };
      scenario.api[jobsPath('acme/api', 71)] = {
        jobs: [
          ghJob({
            id: 2,
            labels: ['self-hosted', 'macos', 'arm64', 'signing'],
            runner_name: 'Mac-Mini',
            completed_at: ago(10),
          }),
        ],
      };

      const result = await runners.fetchRunnerStatus({
        runs: [run('acme/api', 71, true), run('acme/api', 70, true)],
      });

      if (!result.ok) throw new Error(result.error);
      expect(result.runners).toEqual([
        {
          name: 'Mac-Mini',
          scope: { kind: 'org', name: 'acme' },
          os: 'macOS',
          arch: 'ARM64',
          state: 'seen',
          labels: ['self-hosted', 'macos', 'arm64', 'signing', 'xcode'],
          customLabels: ['signing', 'xcode'],
          lastSeenAt: ago(10),
        },
      ]);
    });

    it('scopes a seen runner to its repo when the owner has no org list', async () => {
      useRepos('me/tool');
      scenario.apiErrors[repoRunnersPath('me/tool')] = 'gh: Forbidden (HTTP 403)';
      scenario.apiErrors[orgRunnersPath('me')] = NOT_FOUND;
      scenario.api[jobsPath('me/tool', 5)] = {
        jobs: [ghJob({ labels: ['self-hosted', 'Windows', 'X64'], runner_name: 'win-box' })],
      };

      const result = await runners.fetchRunnerStatus({ runs: [run('me/tool', 5, true)] });

      if (!result.ok) throw new Error(result.error);
      expect(result.runners[0]).toMatchObject({
        name: 'win-box',
        scope: { kind: 'repo', name: 'me/tool' },
        os: 'Windows',
        arch: 'X64',
        state: 'seen',
        customLabels: [],
      });
    });

    it('marks a seen runner busy while one of its jobs runs', async () => {
      useRepos('acme/api');
      scenario.apiErrors[repoRunnersPath('acme/api')] = 'gh: Forbidden (HTTP 403)';
      scenario.apiErrors[orgRunnersPath('acme')] = ORG_FORBIDDEN;
      scenario.api[jobsPath('acme/api', 80)] = {
        jobs: [
          ghJob({
            id: 3,
            name: 'e2e',
            status: 'in_progress',
            conclusion: null,
            started_at: ago(2),
            completed_at: null,
            runner_name: 'SmartAgent',
            html_url: 'https://github.com/acme/api/actions/runs/80/job/3',
          }),
        ],
      };
      scenario.api[jobsPath('acme/api', 79)] = {
        jobs: [ghJob({ id: 4, runner_name: 'SmartAgent', completed_at: ago(20) })],
      };

      const result = await runners.fetchRunnerStatus({
        runs: [run('acme/api', 80, false, 'E2E'), run('acme/api', 79, true)],
      });

      if (!result.ok) throw new Error(result.error);
      expect(result.runners).toHaveLength(1);
      expect(result.runners[0]).toMatchObject({
        name: 'SmartAgent',
        state: 'busy',
        os: 'Linux',
        lastSeenAt: ago(2),
        currentJob: {
          repo: 'acme/api',
          runId: 80,
          jobName: 'e2e',
          workflowName: 'E2E',
          htmlUrl: 'https://github.com/acme/api/actions/runs/80/job/3',
        },
      });
    });

    it('reports no seen runner where the live list was readable', async () => {
      // A name missing from a list we could read belongs to a runner that was removed, or to
      // an ephemeral one (ARC registers a new name for every job).
      useRepos('acme/api');
      scenario.api[repoRunnersPath('acme/api')] = runnerList();
      scenario.api[orgRunnersPath('acme')] = runnerList(ghRunner({ name: 'org-box' }));
      scenario.api[jobsPath('acme/api', 80)] = {
        jobs: [
          ghJob({ id: 1, runner_name: 'arc-runner-x7k2p' }),
          ghJob({
            id: 2,
            status: 'in_progress',
            conclusion: null,
            completed_at: null,
            runner_name: 'arc-runner-q9m4z',
          }),
        ],
      };

      const result = await runners.fetchRunnerStatus({ runs: [run('acme/api', 80, false)] });

      if (!result.ok) throw new Error(result.error);
      expect(result.runners.map((item) => item.name)).toEqual(['org-box']);
    });

    it('does not repeat a runner the live list already has', async () => {
      // The org hides its runners, so jobs can still add seen runners, but not one the readable
      // repo list already shows.
      useRepos('acme/api');
      scenario.api[repoRunnersPath('acme/api')] = runnerList(ghRunner({ name: 'SmartAgent' }));
      scenario.apiErrors[orgRunnersPath('acme')] = ORG_FORBIDDEN;
      scenario.api[jobsPath('acme/api', 79)] = {
        jobs: [ghJob({ runner_name: 'smartagent' })],
      };

      const result = await runners.fetchRunnerStatus({ runs: [run('acme/api', 79, false)] });

      if (!result.ok) throw new Error(result.error);
      expect(result.runners.map((item) => [item.name, item.state])).toEqual([
        ['SmartAgent', 'idle'],
      ]);
    });

    it('ignores jobs that ran on GitHub-hosted runners', async () => {
      // A hidden org, so only the self-hosted filter keeps these out of the seen runners.
      useRepos('acme/api');
      scenario.api[repoRunnersPath('acme/api')] = runnerList();
      scenario.apiErrors[orgRunnersPath('acme')] = ORG_FORBIDDEN;
      scenario.api[jobsPath('acme/api', 79)] = {
        jobs: [
          ghJob({ id: 1, labels: ['ubuntu-latest'], runner_name: 'GitHub Actions 12' }),
          ghJob({
            id: 2,
            status: 'queued',
            conclusion: null,
            labels: ['windows-latest'],
            runner_name: null,
            created_at: ago(30),
          }),
        ],
      };

      const result = await runners.fetchRunnerStatus({ runs: [run('acme/api', 79, false)] });

      expect(result).toEqual({ ok: true, runners: [], waiting: [], hiddenOrgs: ['acme'] });
    });
  });

  describe('waiting jobs', () => {
    function queuedJob(overrides: Record<string, unknown> = {}): Record<string, unknown> {
      return ghJob({
        status: 'queued',
        conclusion: null,
        runner_name: null,
        runner_group_name: null,
        started_at: null,
        completed_at: null,
        created_at: ago(3),
        labels: ['self-hosted', 'Linux', 'gpu'],
        html_url: 'https://github.com/acme/api/actions/runs/90/job/7',
        ...overrides,
      });
    }

    function seedReadableAcme(): void {
      useRepos('acme/api', 'acme/web');
      scenario.api[repoRunnersPath('acme/web')] = runnerList();
      scenario.api[orgRunnersPath('acme')] = runnerList();
    }

    it('reports a queued job that no runner can take', async () => {
      seedReadableAcme();
      scenario.api[repoRunnersPath('acme/api')] = runnerList();
      scenario.api[jobsPath('acme/api', 90)] = { jobs: [queuedJob({ id: 7, name: 'train' })] };

      const result = await runners.fetchRunnerStatus({
        runs: [run('acme/api', 90, false, 'Train')],
      });

      if (!result.ok) throw new Error(result.error);
      expect(result.waiting).toEqual([
        {
          repo: 'acme/api',
          runId: 90,
          jobName: 'train',
          workflowName: 'Train',
          htmlUrl: 'https://github.com/acme/api/actions/runs/90/job/7',
          labels: ['self-hosted', 'Linux', 'gpu'],
          queuedAt: ago(3),
          liveStatusKnown: true,
        },
      ]);
    });

    it('stays quiet when an online runner has every label, whatever the case', async () => {
      seedReadableAcme();
      scenario.api[repoRunnersPath('acme/api')] = runnerList(
        ghRunner({
          busy: true,
          labels: [label('self-hosted'), label('linux'), label('X64'), label('GPU', 'custom')],
        }),
      );
      scenario.api[jobsPath('acme/api', 90)] = { jobs: [queuedJob()] };

      const result = await runners.fetchRunnerStatus({ runs: [run('acme/api', 90, false)] });

      if (!result.ok) throw new Error(result.error);
      expect(result.waiting).toEqual([]);
    });

    it('counts an org runner as able to take the job', async () => {
      seedReadableAcme();
      scenario.api[repoRunnersPath('acme/api')] = runnerList();
      scenario.api[orgRunnersPath('acme')] = runnerList(
        ghRunner({ labels: [label('self-hosted'), label('Linux'), label('gpu', 'custom')] }),
      );
      scenario.api[jobsPath('acme/api', 90)] = { jobs: [queuedJob()] };

      const result = await runners.fetchRunnerStatus({ runs: [run('acme/api', 90, false)] });

      if (!result.ok) throw new Error(result.error);
      expect(result.waiting).toEqual([]);
    });

    it('still reports the job when the matching runner is offline', async () => {
      seedReadableAcme();
      scenario.api[repoRunnersPath('acme/api')] = runnerList(
        ghRunner({
          status: 'offline',
          labels: [label('self-hosted'), label('Linux'), label('gpu', 'custom')],
        }),
      );
      scenario.api[jobsPath('acme/api', 90)] = { jobs: [queuedJob()] };

      const result = await runners.fetchRunnerStatus({ runs: [run('acme/api', 90, false)] });

      if (!result.ok) throw new Error(result.error);
      expect(result.waiting).toHaveLength(1);
    });

    it('still reports the job when the online runner lacks one label', async () => {
      seedReadableAcme();
      scenario.api[repoRunnersPath('acme/api')] = runnerList(ghRunner());
      scenario.api[jobsPath('acme/api', 90)] = { jobs: [queuedJob()] };

      const result = await runners.fetchRunnerStatus({ runs: [run('acme/api', 90, false)] });

      if (!result.ok) throw new Error(result.error);
      expect(result.waiting).toHaveLength(1);
    });

    it('ignores a matching runner that belongs to another repo', async () => {
      seedReadableAcme();
      scenario.api[repoRunnersPath('acme/api')] = runnerList();
      scenario.api[repoRunnersPath('acme/web')] = runnerList(
        ghRunner({ labels: [label('self-hosted'), label('Linux'), label('gpu', 'custom')] }),
      );
      scenario.api[jobsPath('acme/api', 90)] = { jobs: [queuedJob()] };

      const result = await runners.fetchRunnerStatus({ runs: [run('acme/api', 90, false)] });

      if (!result.ok) throw new Error(result.error);
      expect(result.waiting).toHaveLength(1);
    });

    it('only reports a job in a hidden org once it has waited five minutes', async () => {
      useRepos('acme/api');
      scenario.api[repoRunnersPath('acme/api')] = runnerList();
      scenario.apiErrors[orgRunnersPath('acme')] = ORG_FORBIDDEN;
      scenario.api[jobsPath('acme/api', 90)] = {
        jobs: [
          queuedJob({ id: 1, name: 'fresh', created_at: ago(4) }),
          queuedJob({ id: 2, name: 'stale', created_at: ago(6) }),
        ],
      };

      const result = await runners.fetchRunnerStatus({ runs: [run('acme/api', 90, false)] });

      if (!result.ok) throw new Error(result.error);
      expect(result.waiting.map((job) => [job.jobName, job.liveStatusKnown])).toEqual([
        ['stale', false],
      ]);
    });

    it('counts the grace period from the last time a matching seen runner did any work', async () => {
      // One runner chewing through a run's jobs one at a time: the queued ones are waiting
      // their turn, not stranded, as long as the runner keeps finishing jobs.
      useRepos('acme/api');
      scenario.api[repoRunnersPath('acme/api')] = runnerList();
      scenario.apiErrors[orgRunnersPath('acme')] = ORG_FORBIDDEN;
      scenario.api[jobsPath('acme/api', 90)] = {
        jobs: [
          ghJob({
            id: 1,
            name: 'lint',
            labels: ['self-hosted', 'Linux', 'gpu'],
            completed_at: ago(2),
          }),
          queuedJob({ id: 2, name: 'test', created_at: ago(10) }),
        ],
      };
      scenario.api[jobsPath('acme/api', 91)] = {
        jobs: [
          ghJob({
            id: 3,
            name: 'lint',
            labels: ['self-hosted', 'Linux', 'gpu'],
            completed_at: ago(8),
          }),
          queuedJob({ id: 4, name: 'stuck', created_at: ago(12) }),
        ],
      };

      const busyQueue = await runners.fetchRunnerStatus({ runs: [run('acme/api', 90, false)] });
      if (!busyQueue.ok) throw new Error(busyQueue.error);
      expect(busyQueue.waiting).toEqual([]);

      // Same labels, but the runner has not finished anything for eight minutes.
      const stalled = await runners.fetchRunnerStatus({ runs: [run('acme/api', 91, false)] });
      if (!stalled.ok) throw new Error(stalled.error);
      expect(stalled.waiting.map((job) => job.jobName)).toEqual(['stuck']);
    });

    it('treats a repo with no readable runner list like a hidden org', async () => {
      // A collaborator without admin rights on a user's repo can read neither list.
      useRepos('someone/tool');
      scenario.apiErrors[repoRunnersPath('someone/tool')] = 'gh: Must have admin rights (HTTP 403)';
      scenario.apiErrors[orgRunnersPath('someone')] = NOT_FOUND;
      scenario.api[jobsPath('someone/tool', 90)] = {
        jobs: [
          queuedJob({ id: 1, name: 'fresh', created_at: ago(4) }),
          queuedJob({ id: 2, name: 'stale', created_at: ago(6) }),
        ],
      };

      const result = await runners.fetchRunnerStatus({ runs: [run('someone/tool', 90, false)] });

      if (!result.ok) throw new Error(result.error);
      expect(result.hiddenOrgs).toEqual([]);
      expect(result.waiting.map((job) => [job.jobName, job.liveStatusKnown])).toEqual([
        ['stale', false],
      ]);
    });

    it('trusts a matching repo runner even when the org hides its own', async () => {
      useRepos('acme/api');
      scenario.api[repoRunnersPath('acme/api')] = runnerList(
        ghRunner({ labels: [label('self-hosted'), label('Linux'), label('gpu', 'custom')] }),
      );
      scenario.apiErrors[orgRunnersPath('acme')] = ORG_FORBIDDEN;
      scenario.api[jobsPath('acme/api', 90)] = { jobs: [queuedJob({ created_at: ago(30) })] };

      const result = await runners.fetchRunnerStatus({ runs: [run('acme/api', 90, false)] });

      if (!result.ok) throw new Error(result.error);
      expect(result.waiting).toEqual([]);
    });

    it('sorts the waiting jobs oldest first', async () => {
      seedReadableAcme();
      scenario.api[repoRunnersPath('acme/api')] = runnerList();
      scenario.api[jobsPath('acme/api', 91)] = {
        jobs: [queuedJob({ id: 1, name: 'newer', created_at: ago(2) })],
      };
      scenario.api[jobsPath('acme/api', 90)] = {
        jobs: [queuedJob({ id: 2, name: 'older', created_at: ago(9) })],
      };

      const result = await runners.fetchRunnerStatus({
        runs: [run('acme/api', 91, false), run('acme/api', 90, false)],
      });

      if (!result.ok) throw new Error(result.error);
      expect(result.waiting.map((job) => job.jobName)).toEqual(['older', 'newer']);
    });
  });

  describe('reading jobs', () => {
    /** A repo whose runner lists are both hidden, so its finished runs' jobs are worth reading. */
    function seedHiddenRepo(): void {
      useRepos('acme/api');
      scenario.apiErrors[repoRunnersPath('acme/api')] = 'gh: Forbidden (HTTP 403)';
      scenario.apiErrors[orgRunnersPath('acme')] = ORG_FORBIDDEN;
    }

    it('reads a finished run once and an active run on every call', async () => {
      seedHiddenRepo();
      scenario.api[jobsPath('acme/api', 1)] = { jobs: [ghJob()] };
      scenario.api[jobsPath('acme/api', 2)] = { jobs: [] };
      const input = { runs: [run('acme/api', 2, false), run('acme/api', 1, true)] };

      await runners.fetchRunnerStatus(input);
      const second = await runners.fetchRunnerStatus(input);

      const jobCalls = apiCalls().filter((path) => path.includes('/jobs'));
      expect(jobCalls.filter((path) => path === jobsPath('acme/api', 1))).toHaveLength(1);
      expect(jobCalls.filter((path) => path === jobsPath('acme/api', 2))).toHaveLength(2);
      // The cached jobs still feed the answer.
      if (!second.ok) throw new Error(second.error);
      expect(second.runners.map((item) => item.name)).toEqual(['SmartAgent']);
    });

    it('only reads finished runs of repos whose live status is unknown', async () => {
      // A finished run can only add seen runners, and a readable list rules those out.
      useRepos('acme/api', 'other/lib');
      scenario.api[repoRunnersPath('acme/api')] = runnerList();
      scenario.api[orgRunnersPath('acme')] = runnerList();
      scenario.apiErrors[repoRunnersPath('other/lib')] = 'gh: Forbidden (HTTP 403)';
      scenario.apiErrors[orgRunnersPath('other')] = ORG_FORBIDDEN;
      const runs = [
        run('acme/api', 3, false),
        run('acme/api', 2, true),
        run('acme/api', 1, true),
        run('other/lib', 9, true),
      ];
      for (const item of runs) scenario.api[jobsPath(item.repo, item.runId)] = { jobs: [] };

      const result = await runners.fetchRunnerStatus({ runs });

      if (!result.ok) throw new Error(result.error);
      expect(apiCalls().filter((path) => path.includes('/jobs'))).toEqual([
        jobsPath('acme/api', 3),
        jobsPath('other/lib', 9),
      ]);
    });

    it('caps active runs at 15 and finished runs at 10 per repo', async () => {
      // Hidden lists, so the finished runs are read too.
      useRepos('acme/api', 'acme/web');
      scenario.apiErrors[repoRunnersPath('acme/api')] = 'gh: Forbidden (HTTP 403)';
      scenario.apiErrors[repoRunnersPath('acme/web')] = 'gh: Forbidden (HTTP 403)';
      scenario.apiErrors[orgRunnersPath('acme')] = ORG_FORBIDDEN;
      const runs: GithubRunnersRunRef[] = [];
      for (let id = 1; id <= 20; id += 1) runs.push(run('acme/api', id, false));
      for (let id = 101; id <= 112; id += 1) runs.push(run('acme/api', id, true));
      for (let id = 201; id <= 203; id += 1) runs.push(run('acme/web', id, true));
      for (const item of runs) scenario.api[jobsPath(item.repo, item.runId)] = { jobs: [] };

      await runners.fetchRunnerStatus({ runs });

      const jobCalls = apiCalls().filter((path) => path.includes('/jobs'));
      const active = jobCalls.filter((path) => /\/runs\/\d{1,2}\//.test(path));
      expect(active).toHaveLength(15);
      // The input is newest first, so the first ten finished runs are the ones read.
      expect(jobCalls).toContain(jobsPath('acme/api', 110));
      expect(jobCalls).not.toContain(jobsPath('acme/api', 111));
      expect(jobCalls.filter((path) => /\/runs\/1\d\d\//.test(path))).toHaveLength(10);
      expect(jobCalls.filter((path) => /\/runs\/2\d\d\//.test(path))).toHaveLength(3);
    });

    it('skips a run whose jobs cannot be read and keeps the rest', async () => {
      seedHiddenRepo();
      scenario.apiErrors[jobsPath('acme/api', 1)] = 'gh: Internal Server Error (HTTP 500)';
      scenario.api[jobsPath('acme/api', 2)] = { jobs: [ghJob({ runner_name: 'box-2' })] };

      const result = await runners.fetchRunnerStatus({
        runs: [run('acme/api', 2, true), run('acme/api', 1, true)],
      });

      if (!result.ok) throw new Error(result.error);
      expect(result.runners.map((item) => item.name)).toEqual(['box-2']);

      // A failed read is not cached, so the next call tries that run again.
      await runners.fetchRunnerStatus({ runs: [run('acme/api', 1, true)] });
      expect(apiCalls().filter((path) => path === jobsPath('acme/api', 1))).toHaveLength(2);
    });
  });

  it('sorts runners busy, idle, seen, offline, then by name', async () => {
    // The seen runners come from a second org that hides its runners.
    useRepos('acme/api', 'other/lib');
    scenario.api[repoRunnersPath('acme/api')] = runnerList(
      ghRunner({ id: 1, name: 'zeta', status: 'offline' }),
      ghRunner({ id: 2, name: 'beta' }),
      ghRunner({ id: 3, name: 'alpha', status: 'offline' }),
      ghRunner({ id: 4, name: 'omega', busy: true }),
      ghRunner({ id: 5, name: 'Alpha2' }),
    );
    scenario.api[orgRunnersPath('acme')] = runnerList();
    scenario.apiErrors[repoRunnersPath('other/lib')] = 'gh: Forbidden (HTTP 403)';
    scenario.apiErrors[orgRunnersPath('other')] = ORG_FORBIDDEN;
    scenario.api[jobsPath('other/lib', 1)] = {
      jobs: [ghJob({ id: 1, runner_name: 'gamma' }), ghJob({ id: 2, runner_name: 'delta' })],
    };

    const result = await runners.fetchRunnerStatus({ runs: [run('other/lib', 1, true)] });

    if (!result.ok) throw new Error(result.error);
    expect(result.runners.map((item) => item.name)).toEqual([
      'omega',
      'Alpha2',
      'beta',
      'delta',
      'gamma',
      'alpha',
      'zeta',
    ]);
  });
});
