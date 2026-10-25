import os from 'node:os';
import type {
  GithubRunner,
  GithubRunnerJob,
  GithubRunnerState,
  GithubRunnersInput,
  GithubRunnersResult,
  GithubRunnersRunRef,
  GithubRunnerWaitingJob,
} from '../../shared/apiTypes';
import { ghApi, ghErrorMessage, isGhCliAvailable } from '../git/githubCli';
import { listProjectGithubRepos } from './githubActions';

interface GhRunnerLabel {
  name: string;
  type?: string;
}

interface GhRunner {
  id: number;
  name: string;
  os?: string;
  status: string;
  busy: boolean;
  labels?: GhRunnerLabel[];
}

interface GhRunnerJob {
  id: number;
  name: string;
  status: string;
  labels?: string[];
  runner_name: string | null;
  html_url: string;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

/** A job together with the run it belongs to, since the job payload has no workflow name. */
interface RunJob {
  job: GhRunnerJob;
  run: GithubRunnersRunRef;
}

/**
 * A runner list GitHub refused (403 when not an admin, 404 for a user account's org list) is
 * remembered this long, so it is not asked for again on every poll.
 */
const DENIED_LIST_TTL_MS = 10 * 60_000;
const MAX_ACTIVE_RUNS = 15;
const FINISHED_RUNS_PER_REPO = 10;
/** A finished run's jobs never change, so they are kept until the cache fills up. */
const FINISHED_JOBS_CACHE_CAP = 500;
/**
 * Without a readable runner list (a hidden org, or a repo the user is not an admin of), a queued
 * job may just be waiting its turn on a runner we cannot see, so it is only reported once it has
 * waited this long.
 */
const HIDDEN_ORG_GRACE_MS = 5 * 60_000;

const OS_LABELS: Record<string, string> = { linux: 'Linux', windows: 'Windows', macos: 'macOS' };
const ARCH_LABELS: Record<string, string> = { x64: 'X64', arm64: 'ARM64', arm: 'ARM' };
const STATE_ORDER: Record<GithubRunnerState, number> = { busy: 0, idle: 1, seen: 2, offline: 3 };

const deniedLists = new Map<string, { status: number; at: number }>();
const finishedRunJobs = new Map<string, GhRunnerJob[]>();

function sameName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function ownerOf(repo: string): string {
  return repo.split('/')[0] ?? '';
}

function isSelfHosted(job: GhRunnerJob): boolean {
  return (job.labels ?? []).some((label) => sameName(label, 'self-hosted'));
}

function httpStatus(message: string): number | null {
  const match = message.match(/\bHTTP (\d{3})\b/);
  return match ? Number(match[1]) : null;
}

/**
 * A runner list, or the 403 or 404 GitHub refused it with. Any other failure throws, and so
 * does a rate limit, which GitHub also answers with 403 but which says nothing about access.
 */
async function readRunnerList(path: string): Promise<GhRunner[] | { denied: number }> {
  const denied = deniedLists.get(path);
  if (denied && Date.now() - denied.at < DENIED_LIST_TTL_MS) return { denied: denied.status };
  try {
    const payload = await ghApi<{ runners?: GhRunner[] }>(path);
    return payload.runners ?? [];
  } catch (error) {
    const message = ghErrorMessage(error);
    if (/rate limit/i.test(message)) throw error;
    const status = httpStatus(message);
    if (status !== 403 && status !== 404) throw error;
    deniedLists.set(path, { status, at: Date.now() });
    return { denied: status };
  }
}

function toLiveRunner(item: GhRunner, scope: GithubRunner['scope']): GithubRunner {
  const labels = item.labels ?? [];
  const arch = labels
    .filter((label) => label.type !== 'custom')
    .map((label) => ARCH_LABELS[label.name.toLowerCase()])
    .find(Boolean);
  return {
    name: item.name,
    id: item.id,
    scope,
    os: item.os ?? '',
    ...(arch ? { arch } : {}),
    state: item.busy ? 'busy' : item.status === 'online' ? 'idle' : 'offline',
    labels: labels.map((label) => label.name),
    customLabels: labels.filter((label) => label.type === 'custom').map((label) => label.name),
  };
}

/** Whether a runner registered at `scope` could pick up jobs from `repo`. */
function servesRepo(scope: GithubRunner['scope'], repo: string): boolean {
  return scope.kind === 'repo' ? sameName(scope.name, repo) : sameName(scope.name, ownerOf(repo));
}

function isRunRef(run: GithubRunnersRunRef): boolean {
  const parts = String(run?.repo ?? '').split('/');
  return parts.length === 2 && parts.every(Boolean) && Number.isInteger(run.runId) && run.runId > 0;
}

/** Active runs first in line, then the newest finished runs of each repo, in input order. */
function runsToRead(runs: GithubRunnersRunRef[]): GithubRunnersRunRef[] {
  let active = 0;
  const finishedPerRepo = new Map<string, number>();
  return runs.filter((run) => {
    if (!isRunRef(run)) return false;
    if (!run.completed) {
      active += 1;
      return active <= MAX_ACTIVE_RUNS;
    }
    const key = run.repo.toLowerCase();
    const count = finishedPerRepo.get(key) ?? 0;
    if (count >= FINISHED_RUNS_PER_REPO) return false;
    finishedPerRepo.set(key, count + 1);
    return true;
  });
}

/** The run's jobs, or none when they could not be read. A finished run is read only once. */
async function readRunJobs(run: GithubRunnersRunRef): Promise<GhRunnerJob[]> {
  const key = `${run.repo}#${run.runId}`;
  if (run.completed) {
    const cached = finishedRunJobs.get(key);
    if (cached) return cached;
  } else {
    // A re-run puts a finished run back in the queue, and its old jobs no longer apply.
    finishedRunJobs.delete(key);
  }

  try {
    const payload = await ghApi<{ jobs?: GhRunnerJob[] }>(
      `repos/${run.repo}/actions/runs/${run.runId}/jobs?per_page=100`,
    );
    const jobs = payload.jobs ?? [];
    if (run.completed) {
      if (finishedRunJobs.size >= FINISHED_JOBS_CACHE_CAP) {
        const oldest = finishedRunJobs.keys().next().value;
        if (oldest !== undefined) finishedRunJobs.delete(oldest);
      }
      finishedRunJobs.set(key, jobs);
    }
    return jobs;
  } catch {
    return [];
  }
}

function toRunnerJob({ job, run }: RunJob): GithubRunnerJob {
  return {
    repo: run.repo,
    runId: run.runId,
    jobName: job.name,
    workflowName: run.workflowName,
    htmlUrl: job.html_url,
  };
}

/** A runner only known from the jobs it ran, built up one job at a time. */
interface SeenRunner {
  name: string;
  scope: GithubRunner['scope'];
  labels: string[];
  currentJob?: GithubRunnerJob;
  lastSeenAt?: string;
}

function toSeenRunner(item: SeenRunner): GithubRunner {
  const lower = item.labels.map((label) => label.toLowerCase());
  const os = lower.map((label) => OS_LABELS[label]).find(Boolean) ?? '';
  const arch = lower.map((label) => ARCH_LABELS[label]).find(Boolean);
  const customLabels = item.labels.filter((label) => {
    const key = label.toLowerCase();
    return key !== 'self-hosted' && !OS_LABELS[key] && !ARCH_LABELS[key];
  });
  return {
    name: item.name,
    scope: item.scope,
    os,
    ...(arch ? { arch } : {}),
    state: item.currentJob ? 'busy' : 'seen',
    labels: item.labels,
    customLabels,
    ...(item.currentJob ? { currentJob: item.currentJob } : {}),
    ...(item.lastSeenAt ? { lastSeenAt: item.lastSeenAt } : {}),
  };
}

/** Self-hosted runners behind the projects' repos, and jobs stuck waiting for one. */
export async function fetchRunnerStatus(input: GithubRunnersInput): Promise<GithubRunnersResult> {
  if (!(await isGhCliAvailable())) {
    return { ok: false, error: 'Install the GitHub CLI and sign in to see self-hosted runners.' };
  }

  // A refresh the user asked for may follow granting a scope, so old refusals no longer count.
  if (input.fresh) deniedLists.clear();

  const repos = await listProjectGithubRepos();
  const owners: string[] = [];
  for (const item of repos) {
    if (!owners.some((owner) => sameName(owner, item.owner))) owners.push(item.owner);
  }

  let orgLists: Awaited<ReturnType<typeof readRunnerList>>[];
  let repoLists: Awaited<ReturnType<typeof readRunnerList>>[];
  try {
    [orgLists, repoLists] = await Promise.all([
      Promise.all(
        owners.map((owner) => readRunnerList(`orgs/${owner}/actions/runners?per_page=100`)),
      ),
      Promise.all(
        repos.map((item) =>
          readRunnerList(`repos/${item.owner}/${item.repo}/actions/runners?per_page=100`),
        ),
      ),
    ]);
  } catch (error) {
    // The caller keeps showing its last good answer, which beats a list missing half its runners.
    return { ok: false, error: ghErrorMessage(error) };
  }

  const hiddenOrgs: string[] = [];
  /** Repos and owners whose runner list GitHub let us read. */
  const readable = new Set<string>();
  const live: GithubRunner[] = [];
  // Runner ids are numbered per repo or org, so only scope plus name identifies a runner.
  const listed = new Set<string>();
  function addLive(item: GhRunner, scope: GithubRunner['scope']): void {
    const key = `${scope.kind}:${scope.name}:${item.name}`.toLowerCase();
    if (listed.has(key)) return;
    listed.add(key);
    live.push(toLiveRunner(item, scope));
  }
  orgLists.forEach((list, index) => {
    const owner = owners[index];
    if (!Array.isArray(list)) {
      // A 404 means the owner is a user account, which has no org runners at all.
      if (list.denied === 403) hiddenOrgs.push(owner);
      return;
    }
    readable.add(owner.toLowerCase());
    for (const item of list) addLive(item, { kind: 'org', name: owner });
  });
  repoLists.forEach((list, index) => {
    if (!Array.isArray(list)) return;
    const name = `${repos[index].owner}/${repos[index].repo}`;
    readable.add(name.toLowerCase());
    for (const item of list) addLive(item, { kind: 'repo', name });
  });

  const isHidden = (repo: string): boolean =>
    hiddenOrgs.some((owner) => sameName(owner, ownerOf(repo)));
  /**
   * Whether a runner list we could read covers every runner that might serve `repo`. A hidden
   * org, or a repo the user is not an admin of, leaves some of them out of sight.
   */
  const liveStatusKnown = (repo: string): boolean =>
    !isHidden(repo) &&
    (readable.has(repo.toLowerCase()) || readable.has(ownerOf(repo).toLowerCase()));

  // A finished run's jobs only matter for spotting runners we cannot list, so they are skipped
  // wherever the lists already tell the whole story. That is why the lists are read first.
  const runs = runsToRead(input.runs ?? []).filter(
    (run) => !run.completed || !liveStatusKnown(run.repo),
  );
  const allJobs = (
    await Promise.all(
      runs.map(async (run) => (await readRunJobs(run)).map((job): RunJob => ({ job, run }))),
    )
  ).flat();
  // Seen runners and waiting jobs only make sense for jobs that asked for a self-hosted runner,
  // or a GitHub-hosted "GitHub Actions 12" would turn up as one of ours.
  const jobs = allJobs.filter(({ job }) => isSelfHosted(job));
  const liveFor = (repo: string): GithubRunner[] =>
    live.filter((runner) => servesRepo(runner.scope, repo));

  // A live runner is self-hosted by definition, so any job running on it counts, even one that
  // asked for a custom label like `gpu` without the literal self-hosted one.
  for (const runner of live) {
    if (runner.state !== 'busy') continue;
    const running = allJobs.find(
      ({ job, run }) =>
        job.status === 'in_progress' &&
        job.runner_name != null &&
        sameName(job.runner_name, runner.name) &&
        servesRepo(runner.scope, run.repo),
    );
    if (running) runner.currentJob = toRunnerJob(running);
  }

  const seen = new Map<string, SeenRunner>();
  for (const entry of jobs) {
    const name = entry.job.runner_name;
    if (!name) continue;
    const { repo } = entry.run;
    // A name missing from a list we could read is a runner that was removed, or an ephemeral
    // one that got a fresh name for this job, so it is not reported.
    if (liveStatusKnown(repo)) continue;
    if (liveFor(repo).some((runner) => sameName(runner.name, name))) continue;

    const scope: GithubRunner['scope'] = isHidden(repo)
      ? { kind: 'org', name: ownerOf(repo) }
      : { kind: 'repo', name: repo };
    const key = `${scope.kind}:${scope.name}:${name}`.toLowerCase();
    let runner = seen.get(key);
    if (!runner) {
      runner = { name, scope, labels: [] };
      seen.set(key, runner);
    }
    // Jobs can ask the same runner for different labels, so the runner gets all of them.
    for (const label of entry.job.labels ?? []) {
      if (!runner.labels.some((known) => sameName(known, label))) runner.labels.push(label);
    }
    const at = entry.job.completed_at ?? entry.job.started_at;
    if (at && (!runner.lastSeenAt || Date.parse(at) > Date.parse(runner.lastSeenAt))) {
      runner.lastSeenAt = at;
    }
    if (entry.job.status === 'in_progress' && !runner.currentJob) {
      runner.currentJob = toRunnerJob(entry);
    }
  }

  const now = Date.now();
  const waiting: GithubRunnerWaitingJob[] = [];
  for (const entry of jobs) {
    const { job, run } = entry;
    if (job.status !== 'queued') continue;
    const wanted = (job.labels ?? []).map((label) => label.toLowerCase());
    const canTake = liveFor(run.repo).some(
      (runner) =>
        runner.state !== 'offline' &&
        wanted.every((label) => runner.labels.some((have) => sameName(have, label))),
    );
    if (canTake) continue;

    // Only a runner list we could read can prove that nothing online matches.
    const known = liveStatusKnown(run.repo);
    if (!known) {
      // A runner we can only see through its jobs is clearly alive while it keeps finishing
      // them, so the queued job is just waiting its turn. The grace period starts from the
      // later of the job being queued and that runner last doing any work.
      let since = Date.parse(job.created_at);
      for (const runner of seen.values()) {
        if (!servesRepo(runner.scope, run.repo)) continue;
        if (!wanted.every((label) => runner.labels.some((have) => sameName(have, label)))) continue;
        const active = runner.currentJob ? now : Date.parse(runner.lastSeenAt ?? '');
        if (Number.isFinite(active) && active > since) since = active;
      }
      if (now - since <= HIDDEN_ORG_GRACE_MS) continue;
    }
    waiting.push({
      repo: run.repo,
      runId: run.runId,
      jobName: job.name,
      workflowName: run.workflowName,
      htmlUrl: job.html_url,
      labels: job.labels ?? [],
      queuedAt: job.created_at,
      liveStatusKnown: known,
    });
  }
  waiting.sort((a, b) => Date.parse(a.queuedAt) - Date.parse(b.queuedAt));

  const here = thisHostName();
  const runners = [...live, ...[...seen.values()].map(toSeenRunner)]
    .map((runner) =>
      runner.name.toLowerCase() === here ? { ...runner, onThisComputer: true } : runner,
    )
    .sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.name.localeCompare(b.name));
  return { ok: true, runners, waiting, hiddenOrgs };
}

/** This computer's short host name, lower case: `config.sh` names a runner after it by default. */
function thisHostName(): string {
  return os.hostname().split('.')[0].toLowerCase();
}
