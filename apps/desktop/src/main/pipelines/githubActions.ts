import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Project, ProjectGithubAction } from '@runova/core';
import { normalizeProjectGithubActions } from '@runova/core';
import type {
  GithubActionsActivity,
  GithubActionsDayCount,
  GithubActionsHistoryItem,
  GithubActionsRunErrorInput,
  GithubActionsRunErrorResult,
  GithubJobLogInput,
  GithubJobLogResult,
  GithubLogLine,
  GithubLogLineKind,
  GithubPipelineActionResult,
  GithubRunAnnotation,
  GithubRunAnnotationLevel,
  GithubRunAnnotationsInput,
  GithubRunAnnotationsResult,
  GithubRunCancelRequest,
  GithubRunDetailsInput,
  GithubRunDetailsResult,
  GithubRunJob,
  GithubStepLog,
  GithubWorkflowDispatchRequest,
  GithubWorkflowInfo,
  GithubWorkflowRefsResult,
  GithubWorkflowRunInfo,
  PipelineConclusion,
  PipelineRunStatus,
  ProjectPipelineStatus,
} from '../../shared/apiTypes';
import {
  ghApi,
  ghApiAllowEmpty,
  ghErrorMessage,
  isGhCliAvailable,
  parseGithubRemote,
  runGh,
} from '../git/githubCli';
import { store } from '../store';
import { parseWorkflowDispatch, type WorkflowDispatchSpec } from './workflowDispatch';

const execFileAsync = promisify(execFile);

interface GhWorkflow {
  id: number;
  name: string;
  path: string;
  state: string;
  html_url: string;
  badge_url: string;
}

interface GhRun {
  id: number;
  workflow_id: number;
  name: string;
  display_title?: string;
  run_number: number;
  head_branch: string | null;
  status: string;
  conclusion: string | null;
  html_url: string;
  created_at: string;
  updated_at: string;
  check_suite_id?: number;
  event?: string;
  actor?: { login?: string } | null;
  head_sha?: string;
  run_attempt?: number;
}

const REPO_LOOKUP_TTL_MS = 10 * 60_000;
const repoLookupCache = new Map<
  string,
  { github: { owner: string; repo: string } | null; at: number }
>();

/**
 * The GitHub repo a project folder pushes to, or null when it has no GitHub origin.
 * Cached because the watcher asks for every project on every tick and an origin remote
 * almost never changes.
 */
export async function githubRepoForFolder(
  folderPath: string,
): Promise<{ owner: string; repo: string } | null> {
  const cached = repoLookupCache.get(folderPath);
  if (cached && Date.now() - cached.at < REPO_LOOKUP_TTL_MS) return cached.github;

  let github: { owner: string; repo: string } | null = null;
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', folderPath, 'remote', 'get-url', 'origin'],
      { timeout: 8000, windowsHide: true },
    );
    github = parseGithubRemote(stdout.trim());
  } catch {
    github = null;
  }
  repoLookupCache.set(folderPath, { github, at: Date.now() });
  return github;
}

function toRunStatus(value: string): PipelineRunStatus {
  switch (value) {
    case 'queued':
    case 'in_progress':
    case 'completed':
    case 'waiting':
    case 'requested':
    case 'pending':
      return value;
    default:
      return 'unknown';
  }
}

function toConclusion(value: string | null): PipelineConclusion {
  switch (value) {
    case 'success':
    case 'failure':
    case 'cancelled':
    case 'skipped':
    case 'timed_out':
    case 'action_required':
    case 'neutral':
    case 'stale':
      return value;
    default:
      return null;
  }
}

function toWorkflow(item: GhWorkflow): GithubWorkflowInfo {
  return {
    id: item.id,
    name: item.name,
    path: item.path,
    state: item.state,
    htmlUrl: item.html_url,
    badgeUrl: item.badge_url,
    dispatchable: true,
    dispatchInputs: [],
  };
}

export function toWorkflowRun(item: GhRun): GithubWorkflowRunInfo {
  return {
    id: item.id,
    workflowId: item.workflow_id,
    name: item.name,
    displayTitle: item.display_title?.trim() || item.name,
    runNumber: item.run_number,
    headBranch: item.head_branch ?? '',
    status: toRunStatus(item.status),
    conclusion: toConclusion(item.conclusion),
    htmlUrl: item.html_url,
    createdAt: item.created_at,
    updatedAt: item.updated_at,
    // Left out entirely when GitHub did not send them, so the UI can tell "unknown" from a value.
    ...(item.event ? { event: item.event } : {}),
    ...(item.actor?.login ? { actor: item.actor.login } : {}),
    ...(item.head_sha ? { headSha: item.head_sha } : {}),
    ...(item.run_attempt ? { runAttempt: item.run_attempt } : {}),
  };
}

const ACTIVITY_DAYS = 14;
const MAX_REPOS = 12;
const RUNS_PER_REPO = 50;
const HISTORY_CAP = 250;

function localIsoDate(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function emptyActivityDays(): GithubActionsDayCount[] {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days: GithubActionsDayCount[] = [];
  for (let offset = ACTIVITY_DAYS - 1; offset >= 0; offset -= 1) {
    const day = new Date(today);
    day.setDate(today.getDate() - offset);
    days.push({ date: localIsoDate(day), passed: 0, failed: 0 });
  }
  return days;
}

function emptyActivity(
  partial: Pick<GithubActionsActivity, 'ok' | 'cliAvailable' | 'authenticated'> & {
    error?: string;
  },
): GithubActionsActivity {
  return {
    ...partial,
    days: emptyActivityDays(),
    runs: [],
    weekPassed: 0,
    weekFailed: 0,
    runningCount: 0,
    repoCount: 0,
  };
}

export interface ProjectGithubRepo {
  owner: string;
  repo: string;
  projectId: string;
  projectName: string;
}

/**
 * The GitHub repos behind Runova projects, each listed once under the first project that
 * uses it, and at most `MAX_REPOS` of them.
 */
export async function listProjectGithubRepos(): Promise<ProjectGithubRepo[]> {
  const projects = await store.getProjects();
  const repos: ProjectGithubRepo[] = [];
  const seen = new Set<string>();
  for (const project of projects) {
    const github = await githubRepoForFolder(project.folderPath);
    if (!github) continue;
    const key = `${github.owner}/${github.repo}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    repos.push({
      owner: github.owner,
      repo: github.repo,
      projectId: project.id,
      projectName: project.name,
    });
    if (repos.length >= MAX_REPOS) break;
  }
  return repos;
}

/** Recent Actions runs across Runova projects, for the dashboard chart and the Pipelines page. */
export async function fetchDashboardActionsActivity(): Promise<GithubActionsActivity> {
  if (!(await isGhCliAvailable())) {
    return emptyActivity({
      ok: false,
      cliAvailable: false,
      authenticated: false,
      error: 'Install the GitHub CLI and sign in to see GitHub Actions.',
    });
  }

  const repos = await listProjectGithubRepos();
  if (repos.length === 0) {
    return emptyActivity({ ok: true, cliAvailable: true, authenticated: true });
  }

  try {
    const batches = await Promise.all(
      repos.map(async (item) => {
        const payload = await ghApi<{ workflow_runs?: GhRun[] }>(
          `repos/${item.owner}/${item.repo}/actions/runs?per_page=${RUNS_PER_REPO}`,
        );
        return (payload.workflow_runs ?? []).map((run) => ({ run, item }));
      }),
    );

    const days = emptyActivityDays();
    const byDate = new Map(days.map((day) => [day.date, day]));
    const weekStart = days[Math.max(0, days.length - 7)]?.date ?? days[0]?.date;
    let weekPassed = 0;
    let weekFailed = 0;
    let runningCount = 0;
    const history: GithubActionsHistoryItem[] = [];

    for (const { run, item } of batches.flat()) {
      const mapped = toWorkflowRun(run);
      const repo = `${item.owner}/${item.repo}`;
      history.push({
        id: mapped.id,
        projectId: item.projectId,
        projectName: item.projectName,
        repo,
        workflowName: mapped.name,
        displayTitle: mapped.displayTitle,
        runNumber: mapped.runNumber,
        headBranch: mapped.headBranch,
        status: mapped.status,
        conclusion: mapped.conclusion,
        htmlUrl: mapped.htmlUrl,
        createdAt: mapped.createdAt,
        updatedAt: mapped.updatedAt,
        checkSuiteId: run.check_suite_id,
      });

      if (mapped.status !== 'completed') {
        runningCount += 1;
        continue;
      }

      const dayKey = localIsoDate(new Date(mapped.updatedAt));
      const bucket = byDate.get(dayKey);
      const failed = mapped.conclusion === 'failure' || mapped.conclusion === 'timed_out';
      const passed = mapped.conclusion === 'success';
      if (bucket) {
        if (passed) bucket.passed += 1;
        else if (failed) bucket.failed += 1;
      }
      if (weekStart && dayKey >= weekStart) {
        if (passed) weekPassed += 1;
        else if (failed) weekFailed += 1;
      }
    }

    history.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));

    return {
      ok: true,
      cliAvailable: true,
      authenticated: true,
      days,
      runs: history.slice(0, HISTORY_CAP),
      weekPassed,
      weekFailed,
      runningCount,
      repoCount: repos.length,
    };
  } catch (error) {
    const message = ghErrorMessage(error);
    const unauthenticated = /401|403|HTTP 401|Bad credentials|not logged in|auth/i.test(message);
    return emptyActivity({
      ok: false,
      cliAvailable: true,
      authenticated: !unauthenticated,
      error: unauthenticated
        ? 'Not signed in to the GitHub CLI. Run "gh auth login" first.'
        : message,
    });
  }
}

export async function listWorkflowRuns(
  owner: string,
  repo: string,
  workflowId: number,
  perPage = 5,
): Promise<GithubWorkflowRunInfo[]> {
  const payload = await ghApi<{ workflow_runs?: GhRun[] }>(
    `repos/${owner}/${repo}/actions/workflows/${workflowId}/runs?per_page=${perPage}`,
  );
  return (payload.workflow_runs ?? []).map(toWorkflowRun);
}

const WORKFLOW_LIST_TTL_MS = 5 * 60_000;
const workflowListCache = new Map<string, { workflows: GithubWorkflowInfo[]; at: number }>();

/**
 * Every workflow the repo has, minus deleted ones. The watcher asks for this on each
 * tick, so the answer is cached: workflow files change far less often than runs do.
 */
export async function listRepoWorkflows(
  owner: string,
  repo: string,
): Promise<GithubWorkflowInfo[]> {
  const key = `${owner}/${repo}`;
  const cached = workflowListCache.get(key);
  if (cached && Date.now() - cached.at < WORKFLOW_LIST_TTL_MS) return cached.workflows;

  const payload = await ghApi<{ workflows?: GhWorkflow[] }>(
    `repos/${owner}/${repo}/actions/workflows?per_page=100`,
  );
  const workflows = (payload.workflows ?? [])
    .filter((item) => item.state !== 'deleted')
    .map(toWorkflow);
  workflowListCache.set(key, { workflows, at: Date.now() });
  return workflows;
}

/** The repo's latest runs in one call, grouped by workflow, newest first within each group. */
export async function listRepoRunsByWorkflow(
  owner: string,
  repo: string,
  perPage = 50,
): Promise<Map<number, GithubWorkflowRunInfo[]>> {
  const payload = await ghApi<{ workflow_runs?: GhRun[] }>(
    `repos/${owner}/${repo}/actions/runs?per_page=${perPage}`,
  );
  const byWorkflow = new Map<number, GithubWorkflowRunInfo[]>();
  for (const run of payload.workflow_runs ?? []) {
    const mapped = toWorkflowRun(run);
    const list = byWorkflow.get(mapped.workflowId);
    if (list) list.push(mapped);
    else byWorkflow.set(mapped.workflowId, [mapped]);
  }
  return byWorkflow;
}

export async function fetchProjectPipelineStatus(project: Project): Promise<ProjectPipelineStatus> {
  const empty: ProjectPipelineStatus = {
    projectId: project.id,
    cliAvailable: false,
    authenticated: false,
    github: null,
    workflows: [],
    runsByWorkflowId: {},
  };

  const github = await githubRepoForFolder(project.folderPath);
  if (!github) {
    return { ...empty, error: 'This repository is not connected to GitHub.' };
  }

  if (!(await isGhCliAvailable())) {
    return {
      ...empty,
      github,
      error: 'Install the GitHub CLI and sign in to watch Actions on this repo.',
    };
  }

  try {
    const [workflowPayload, runPayload] = await Promise.all([
      ghApi<{ workflows?: GhWorkflow[] }>(
        `repos/${github.owner}/${github.repo}/actions/workflows?per_page=100`,
      ),
      ghApi<{ workflow_runs?: GhRun[] }>(
        `repos/${github.owner}/${github.repo}/actions/runs?per_page=40`,
      ),
    ]);

    const workflows = (workflowPayload.workflows ?? [])
      .filter((item) => item.state !== 'deleted')
      .map(toWorkflow);
    await annotateDispatchSupport(github.owner, github.repo, workflows);

    const runsByWorkflowId: Record<number, GithubWorkflowRunInfo | null> = {};
    for (const workflow of workflows) runsByWorkflowId[workflow.id] = null;
    for (const run of runPayload.workflow_runs ?? []) {
      if (runsByWorkflowId[run.workflow_id] == null) {
        runsByWorkflowId[run.workflow_id] = toWorkflowRun(run);
      }
    }

    return {
      projectId: project.id,
      cliAvailable: true,
      authenticated: true,
      github,
      workflows,
      runsByWorkflowId,
    };
  } catch (error) {
    const message = ghErrorMessage(error);
    const unauthenticated = /401|403|HTTP 401|Bad credentials|not logged in|auth/i.test(message);
    return {
      ...empty,
      cliAvailable: true,
      authenticated: !unauthenticated,
      github,
      error: unauthenticated
        ? 'Not signed in to the GitHub CLI. Run "gh auth login" first.'
        : message,
    };
  }
}

interface GhJobStep {
  name: string;
  conclusion: string | null;
  number?: number;
  status?: string;
  started_at?: string | null;
  completed_at?: string | null;
}

interface GhJob {
  id: number;
  name: string;
  conclusion: string | null;
  steps?: GhJobStep[];
  status?: string;
  started_at?: string | null;
  completed_at?: string | null;
  html_url?: string | null;
  runner_name?: string | null;
}

interface GhAnnotation {
  path: string;
  start_line: number;
  end_line?: number;
  annotation_level: string;
  message: string;
  title?: string;
}

interface GhCheckRun {
  id: number;
  name: string;
  output?: { annotations_count?: number };
}

const ERROR_CACHE_MS = 10 * 60_000;
const LOG_CHAR_CAP = 12_000;
const errorCache = new Map<string, { text: string; at: number }>();

function isFailedConclusion(value: string | null | undefined): boolean {
  return value === 'failure' || value === 'timed_out';
}

function parseOwnerRepo(repo: string): { owner: string; repo: string } | null {
  const parts = repo.trim().split('/');
  if (parts.length !== 2) return null;
  const [owner, name] = parts;
  if (!owner || !name || owner.includes('..') || name.includes('..')) return null;
  return { owner, repo: name };
}

function stripAnsi(value: string): string {
  return value.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '');
}

function truncateEnd(value: string, maxChars: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `...\n${trimmed.slice(-maxChars).trim()}`;
}

function annotationsNeedLogs(text: string): boolean {
  if (!text) return true;
  return (
    text.length < 600 &&
    /process completed with exit code|the process '.+' failed with exit code/i.test(text)
  );
}

function formatAnnotations(items: GhAnnotation[]): string {
  const preferred = items.filter((item) => item.annotation_level === 'failure');
  const list = preferred.length > 0 ? preferred : items;
  return list
    .map((item) => {
      const location = item.path
        ? item.start_line
          ? `${item.path}:${item.start_line}`
          : item.path
        : '';
      const title = item.title?.trim();
      const message = item.message?.trim() ?? '';
      return [location, title && title !== message ? title : '', message]
        .filter(Boolean)
        .join('\n');
    })
    .filter(Boolean)
    .join('\n\n');
}

async function failedLogs(owner: string, repo: string, runId: number): Promise<string> {
  const { stdout, stderr } = await runGh(
    ['run', 'view', String(runId), '--repo', `${owner}/${repo}`, '--log-failed'],
    { timeout: 30000, maxBuffer: 8 * 1024 * 1024, readOnly: true },
  );
  const text = stripAnsi((stdout || stderr || '').trim());
  if (!text) return '';
  return truncateEnd(text, LOG_CHAR_CAP);
}

/** Failed-job annotations and logs for one Actions run, ready to copy. */
export async function fetchRunFailureText(
  input: GithubActionsRunErrorInput,
): Promise<GithubActionsRunErrorResult> {
  const parsed = parseOwnerRepo(input.repo);
  const runId = Number(input.runId);
  if (!parsed || !Number.isInteger(runId) || runId <= 0) {
    return { ok: false, error: 'That workflow run could not be identified.' };
  }

  const cacheKey = `${parsed.owner}/${parsed.repo}#${runId}`;
  const cached = errorCache.get(cacheKey);
  if (cached && Date.now() - cached.at < ERROR_CACHE_MS) {
    return { ok: true, text: cached.text };
  }

  if (!(await isGhCliAvailable())) {
    return { ok: false, error: 'Install the GitHub CLI and sign in to copy this error.' };
  }

  try {
    const header = [
      `${input.displayTitle || input.workflowName || 'Workflow'} failed`,
      [
        `${parsed.owner}/${parsed.repo}`,
        input.runNumber != null ? `#${input.runNumber}` : '',
        input.headBranch,
      ]
        .filter(Boolean)
        .join(' · '),
    ]
      .filter(Boolean)
      .join('\n');

    const jobPayload = await ghApi<{ jobs?: GhJob[] }>(
      `repos/${parsed.owner}/${parsed.repo}/actions/runs/${runId}/jobs?per_page=100`,
    );
    const jobs = jobPayload.jobs ?? [];
    const failedJobs = jobs.filter(
      (job) =>
        isFailedConclusion(job.conclusion) ||
        (job.steps ?? []).some((step) => isFailedConclusion(step.conclusion)),
    );

    const jobLines = (failedJobs.length > 0 ? failedJobs : jobs).flatMap((job) => {
      const failedSteps = (job.steps ?? []).filter((step) => isFailedConclusion(step.conclusion));
      if (failedSteps.length === 0) {
        return [`Job: ${job.name}${job.conclusion ? ` (${job.conclusion})` : ''}`];
      }
      return [
        `Job: ${job.name}`,
        ...failedSteps.map((step) => `  Step: ${step.name} (${step.conclusion})`),
      ];
    });

    const annotationLists = await Promise.all(
      failedJobs.map(async (job) => {
        try {
          const payload = await ghApi<GhAnnotation[] | { annotations?: GhAnnotation[] }>(
            `repos/${parsed.owner}/${parsed.repo}/check-runs/${job.id}/annotations`,
          );
          return Array.isArray(payload) ? payload : (payload.annotations ?? []);
        } catch {
          return [] as GhAnnotation[];
        }
      }),
    );
    const annotations = formatAnnotations(annotationLists.flat());

    let logs = '';
    if (annotationsNeedLogs(annotations)) {
      try {
        logs = await failedLogs(parsed.owner, parsed.repo, runId);
      } catch (error) {
        const message = ghErrorMessage(error);
        if (!jobLines.length && !annotations) {
          return { ok: false, error: message };
        }
      }
    }

    const text = [header, jobLines.join('\n'), annotations, logs]
      .filter(Boolean)
      .join('\n\n')
      .trim();
    if (!text) {
      return { ok: false, error: 'No error details were available for this run.' };
    }

    errorCache.set(cacheKey, { text, at: Date.now() });
    return { ok: true, text };
  } catch (error) {
    return { ok: false, error: ghErrorMessage(error) };
  }
}

/**
 * A finished run's jobs rarely change, but a re-run reuses the run id, so the answer is only kept
 * for a while instead of for good like annotations.
 */
const DETAILS_CACHE_MS = 10 * 60_000;
const DETAILS_CACHE_CAP = 200;
const detailsCache = new Map<
  string,
  { result: GithubRunDetailsResult & { ok: true }; at: number }
>();

function toJob(job: GhJob): GithubRunJob {
  return {
    id: job.id,
    name: job.name,
    status: toRunStatus(job.status ?? ''),
    conclusion: toConclusion(job.conclusion),
    startedAt: job.started_at ?? null,
    completedAt: job.completed_at ?? null,
    htmlUrl: job.html_url ?? null,
    runnerName: job.runner_name ?? null,
    steps: (job.steps ?? []).map((step, index) => ({
      number: step.number ?? index + 1,
      name: step.name,
      status: toRunStatus(step.status ?? ''),
      conclusion: toConclusion(step.conclusion),
      startedAt: step.started_at ?? null,
      completedAt: step.completed_at ?? null,
    })),
  };
}

/** The jobs of one Actions run with each step's status and timing, for the Pipelines details. */
export async function fetchRunDetails(
  input: GithubRunDetailsInput,
): Promise<GithubRunDetailsResult> {
  const parsed = parseOwnerRepo(input.repo);
  const runId = Number(input.runId);
  if (!parsed || !Number.isInteger(runId) || runId <= 0) {
    return { ok: false, error: 'That workflow run could not be identified.' };
  }

  const cacheKey = `${parsed.owner}/${parsed.repo}#${runId}`;
  const cached = detailsCache.get(cacheKey);
  if (cached && Date.now() - cached.at < DETAILS_CACHE_MS) return cached.result;

  // No `gh --version` probe first: it is its own unqueued process with a short timeout, so among
  // the calls fired by clicking through pipelines it timed out on a busy machine and reported a
  // working gh as missing. The status call that lists the pipelines already knows gh is there, and
  // a gh that cannot be started shows up as ENOENT from the call itself.
  try {
    const payload = await ghApi<{ jobs?: GhJob[] }>(
      `repos/${parsed.owner}/${parsed.repo}/actions/runs/${runId}/jobs?per_page=100`,
    );
    const result = { ok: true as const, jobs: (payload.jobs ?? []).map(toJob) };

    // A run that is still going, or has no jobs yet, must be looked at again next time.
    const finished =
      result.jobs.length > 0 && result.jobs.every((job) => job.status === 'completed');
    if (finished) {
      if (detailsCache.size >= DETAILS_CACHE_CAP) {
        const oldest = detailsCache.keys().next().value;
        if (oldest !== undefined) detailsCache.delete(oldest);
      }
      detailsCache.set(cacheKey, { result, at: Date.now() });
    }
    return result;
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') {
      return { ok: false, error: 'Install the GitHub CLI and sign in to see this run.' };
    }
    return { ok: false, error: ghErrorMessage(error) };
  }
}

const LOG_TIMESTAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d+)?Z ?/;
const LOG_COMMANDS: [prefix: string, kind: GithubLogLineKind][] = [
  ['##[error]', 'error'],
  ['##[warning]', 'warning'],
  ['##[notice]', 'notice'],
  ['##[group]', 'group'],
  ['##[section]', 'group'],
  ['##[debug]', 'plain'],
  ['[command]', 'command'],
];

/** Whole seconds, since that is all the precision GitHub gives a step's start and end. */
function toSecond(iso: string | null): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

/** The first line of a step: `run` and `uses` steps open a "Run ..." group, post steps say so. */
function isStepHeader(text: string): boolean {
  return text.startsWith('##[group]Run ') || text === 'Post job cleanup.';
}

function toLogLine(text: string): GithubLogLine | null {
  if (text.startsWith('##[endgroup]')) return null;
  for (const [prefix, kind] of LOG_COMMANDS) {
    if (text.startsWith(prefix)) return { text: text.slice(prefix.length), kind };
  }
  return { text, kind: 'plain' };
}

/**
 * Cuts a job's log into its steps. GitHub only serves the log of a whole job, and its lines carry
 * nothing but a timestamp, so each line goes to the step that was running at that time. Step
 * times are whole seconds, which leaves quick steps sharing a second; there the "Run ..." header a
 * step opens with marks where one ends and the next begins.
 */
export function splitJobLog(raw: string, steps: GithubJobLogInput['steps']): GithubStepLog[] {
  const logs: GithubStepLog[] = steps.map((step) => ({
    number: step.number,
    lines: [],
    errors: 0,
    warnings: 0,
  }));
  const ran = steps.flatMap((step, index) => {
    const start = toSecond(step.startedAt);
    if (start === null || step.conclusion === 'skipped') return [];
    return [{ log: logs[index], start, end: toSecond(step.completedAt) ?? Infinity }];
  });
  if (ran.length === 0) return logs;

  let cursor = 0;
  const rows = stripAnsi(raw.replace(/^﻿/, '')).split(/\r?\n/);
  if (rows.at(-1) === '') rows.pop();
  for (const row of rows) {
    const stamp = LOG_TIMESTAMP.exec(row);
    const text = stamp ? row.slice(stamp[0].length) : row;
    if (stamp) {
      const second = Math.floor(Date.parse(`${stamp[1]}Z`) / 1000);
      const header = isStepHeader(text);
      while (cursor + 1 < ran.length) {
        const current = ran[cursor];
        if (second < ran[cursor + 1].start) break;
        if (second > current.end) {
          cursor += 1;
          continue;
        }
        // A header opens exactly one step, and only after the current one has printed something,
        // so it never moves past the step it belongs to.
        if (header && current.log.lines.length > 0) cursor += 1;
        break;
      }
    }
    const line = toLogLine(text);
    if (!line) continue;
    const log = ran[cursor].log;
    log.lines.push(line);
    if (line.kind === 'error') log.errors += 1;
    if (line.kind === 'warning') log.warnings += 1;
  }
  return logs;
}

/** A finished job's log never changes, but logs are big, so only a few are kept. */
const JOB_LOG_CACHE_CAP = 20;
const jobLogCache = new Map<string, string>();

/** One job's log, split by step, for the step logs in the Pipelines details. */
export async function fetchJobLog(input: GithubJobLogInput): Promise<GithubJobLogResult> {
  const parsed = parseOwnerRepo(input.repo);
  const jobId = Number(input.jobId);
  if (!parsed || !Number.isInteger(jobId) || jobId <= 0) {
    return { ok: false, error: 'That job could not be identified.' };
  }
  const steps = Array.isArray(input.steps) ? input.steps : [];

  const cacheKey = `${parsed.owner}/${parsed.repo}#job${jobId}`;
  let raw = jobLogCache.get(cacheKey);
  if (raw === undefined) {
    try {
      // Not `ghApi`: the log is plain text, which gh fetches by following GitHub's redirect.
      const { stdout } = await runGh(
        [
          'api',
          '-H',
          'Accept: application/vnd.github+json',
          `repos/${parsed.owner}/${parsed.repo}/actions/jobs/${jobId}/logs`,
        ],
        { timeout: 60_000, maxBuffer: 64 * 1024 * 1024, readOnly: true },
      );
      raw = stdout;
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') {
        return { ok: false, error: 'Install the GitHub CLI and sign in to see this log.' };
      }
      return { ok: false, error: ghErrorMessage(error) };
    }
    if (jobLogCache.size >= JOB_LOG_CACHE_CAP) {
      const oldest = jobLogCache.keys().next().value;
      if (oldest !== undefined) jobLogCache.delete(oldest);
    }
    jobLogCache.set(cacheKey, raw);
  }
  return { ok: true, steps: splitJobLog(raw, steps) };
}

/** A finished run's annotations never change, so they are kept until the cache fills up. */
const ANNOTATION_CACHE_CAP = 500;
/** Per job. GitHub's own run page does not show more than this either. */
const ANNOTATIONS_PER_JOB = 50;
const annotationCache = new Map<string, GithubRunAnnotationsResult & { ok: true }>();

const ANNOTATION_LEVEL_ORDER: Record<GithubRunAnnotationLevel, number> = {
  failure: 0,
  warning: 1,
  notice: 2,
};

function toAnnotationLevel(value: string): GithubRunAnnotationLevel {
  if (value === 'failure' || value === 'warning') return value;
  return 'notice';
}

/** Every annotation the run's jobs left, for the Pipelines page to list and colour the run by. */
export async function fetchRunAnnotations(
  input: GithubRunAnnotationsInput,
): Promise<GithubRunAnnotationsResult> {
  const parsed = parseOwnerRepo(input.repo);
  const runId = Number(input.runId);
  if (!parsed || !Number.isInteger(runId) || runId <= 0) {
    return { ok: false, error: 'That workflow run could not be identified.' };
  }

  const cacheKey = `${parsed.owner}/${parsed.repo}#${runId}`;
  const cached = annotationCache.get(cacheKey);
  if (cached) return cached;

  if (!(await isGhCliAvailable())) {
    return { ok: false, error: 'Install the GitHub CLI and sign in to see annotations.' };
  }

  try {
    let checkSuiteId = Number(input.checkSuiteId);
    if (!Number.isInteger(checkSuiteId) || checkSuiteId <= 0) {
      const run = await ghApi<GhRun>(`repos/${parsed.owner}/${parsed.repo}/actions/runs/${runId}`);
      checkSuiteId = Number(run.check_suite_id);
    }
    if (!Number.isInteger(checkSuiteId) || checkSuiteId <= 0) {
      return { ok: false, error: 'GitHub did not say which checks belong to this run.' };
    }

    // Each job is a check run, and the listing already says how many annotations each one has,
    // so only jobs that actually left something cost a second call.
    const suite = await ghApi<{ check_runs?: GhCheckRun[] }>(
      `repos/${parsed.owner}/${parsed.repo}/check-suites/${checkSuiteId}/check-runs?per_page=100`,
    );
    const withAnnotations = (suite.check_runs ?? []).filter(
      (checkRun) => (checkRun.output?.annotations_count ?? 0) > 0,
    );

    const lists = await Promise.all(
      withAnnotations.map(async (checkRun) => {
        const payload = await ghApi<GhAnnotation[]>(
          `repos/${parsed.owner}/${parsed.repo}/check-runs/${checkRun.id}/annotations?per_page=${ANNOTATIONS_PER_JOB}`,
        );
        return (Array.isArray(payload) ? payload : []).map(
          (item): GithubRunAnnotation => ({
            level: toAnnotationLevel(item.annotation_level),
            jobName: checkRun.name,
            path: item.path ?? '',
            startLine: item.start_line || null,
            endLine: item.end_line || null,
            title: item.title?.trim() ?? '',
            message: item.message?.trim() ?? '',
          }),
        );
      }),
    );

    const annotations = lists
      .flat()
      .sort((a, b) => ANNOTATION_LEVEL_ORDER[a.level] - ANNOTATION_LEVEL_ORDER[b.level]);
    const counts: Record<GithubRunAnnotationLevel, number> = { failure: 0, warning: 0, notice: 0 };
    for (const item of annotations) counts[item.level] += 1;

    const result = { ok: true as const, annotations, counts };
    if (annotationCache.size >= ANNOTATION_CACHE_CAP) {
      const oldest = annotationCache.keys().next().value;
      if (oldest !== undefined) annotationCache.delete(oldest);
    }
    annotationCache.set(cacheKey, result);
    return result;
  } catch (error) {
    return { ok: false, error: ghErrorMessage(error) };
  }
}

export async function setProjectMutedActions(
  projectId: string,
  actions: ProjectGithubAction[],
): Promise<Project> {
  const projects = await store.getProjects();
  const index = projects.findIndex((item) => item.id === projectId);
  if (index === -1) throw new Error(`Project ${projectId} not found`);
  const updated: Project = {
    ...projects[index],
    githubActionsMuted: normalizeProjectGithubActions(actions),
    updatedAt: new Date().toISOString(),
  };
  projects[index] = updated;
  await store.setProjects(projects);
  return updated;
}

const DISPATCH_SPEC_TTL_MS = 10 * 60_000;
/** How many workflow files one status refresh will read to look for a `workflow_dispatch` trigger. */
const DISPATCH_SPEC_LOOKUP_CAP = 30;
const dispatchSpecCache = new Map<string, { spec: WorkflowDispatchSpec; at: number }>();

async function readWorkflowFile(owner: string, repo: string, path: string): Promise<string> {
  const payload = await ghApi<{ content?: string; encoding?: string }>(
    `repos/${owner}/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}`,
  );
  if (!payload.content) return '';
  return Buffer.from(payload.content, payload.encoding === 'base64' ? 'base64' : 'utf8').toString(
    'utf8',
  );
}

/** The `workflow_dispatch` trigger of one workflow, cached because the file rarely changes. */
async function workflowDispatchSpec(
  owner: string,
  repo: string,
  path: string,
): Promise<WorkflowDispatchSpec> {
  const key = `${owner}/${repo}:${path}`;
  const cached = dispatchSpecCache.get(key);
  if (cached && Date.now() - cached.at < DISPATCH_SPEC_TTL_MS) return cached.spec;

  const source = await readWorkflowFile(owner, repo, path);
  if (!source) return { dispatchable: true, inputs: [] };
  const spec = parseWorkflowDispatch(source);
  dispatchSpecCache.set(key, { spec, at: Date.now() });
  return spec;
}

/**
 * Fills in `dispatchable`/`dispatchInputs` on each workflow. Anything that could not be read stays
 * optimistically dispatchable rather than losing its Run button over a transient API hiccup.
 */
async function annotateDispatchSupport(
  owner: string,
  repo: string,
  workflows: GithubWorkflowInfo[],
): Promise<void> {
  await Promise.all(
    workflows.slice(0, DISPATCH_SPEC_LOOKUP_CAP).map(async (workflow) => {
      try {
        const spec = await workflowDispatchSpec(owner, repo, workflow.path);
        workflow.dispatchable = spec.dispatchable;
        workflow.dispatchInputs = spec.inputs;
      } catch {
        // Leave the optimistic default in place.
      }
    }),
  );
}

/** Branches and tags a manual run can be started from. */
export async function fetchWorkflowRefs(repo: string): Promise<GithubWorkflowRefsResult> {
  const parsed = parseOwnerRepo(repo);
  if (!parsed) return { ok: false, error: 'That repository could not be identified.' };
  if (!(await isGhCliAvailable())) {
    return { ok: false, error: 'Install the GitHub CLI and sign in to start workflows.' };
  }

  try {
    const [info, branches, tags] = await Promise.all([
      ghApi<{ default_branch?: string }>(`repos/${parsed.owner}/${parsed.repo}`),
      ghApi<{ name: string }[]>(`repos/${parsed.owner}/${parsed.repo}/branches?per_page=100`),
      ghApi<{ name: string }[]>(`repos/${parsed.owner}/${parsed.repo}/tags?per_page=50`).catch(
        () => [] as { name: string }[],
      ),
    ]);
    return {
      ok: true,
      defaultBranch: info.default_branch ?? branches[0]?.name ?? '',
      branches: branches.map((item) => item.name),
      tags: tags.map((item) => item.name),
    };
  } catch (error) {
    return { ok: false, error: ghErrorMessage(error) };
  }
}

/** Starts a `workflow_dispatch` run. */
export async function dispatchWorkflow(
  input: GithubWorkflowDispatchRequest,
): Promise<GithubPipelineActionResult> {
  const parsed = parseOwnerRepo(input.repo);
  const workflowId = Number(input.workflowId);
  if (!parsed || !Number.isInteger(workflowId) || workflowId <= 0) {
    return { ok: false, error: 'That workflow could not be identified.' };
  }
  const ref = String(input.ref ?? '').trim();
  if (!ref) return { ok: false, error: 'Pick a branch or tag to run this workflow from.' };
  if (!(await isGhCliAvailable())) {
    return { ok: false, error: 'Install the GitHub CLI and sign in to start workflows.' };
  }

  const args = [
    'workflow',
    'run',
    String(workflowId),
    '--repo',
    `${parsed.owner}/${parsed.repo}`,
    '--ref',
    ref,
  ];
  // `--raw-field` rather than `--field`: the latter reads a value starting with "@" as a file
  // path, and these values come straight from what the user typed. Blank optional inputs are
  // dropped so the workflow's own default applies.
  for (const [name, value] of Object.entries(input.inputs ?? {})) {
    if (!name || value == null || value === '') continue;
    args.push('--raw-field', `${name}=${value}`);
  }

  try {
    await runGh(args, { timeout: 30000 });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: ghErrorMessage(error) };
  }
}

/** Cancels a queued or in-progress run. */
export async function cancelWorkflowRun(
  input: GithubRunCancelRequest,
): Promise<GithubPipelineActionResult> {
  const parsed = parseOwnerRepo(input.repo);
  const runId = Number(input.runId);
  if (!parsed || !Number.isInteger(runId) || runId <= 0) {
    return { ok: false, error: 'That workflow run could not be identified.' };
  }
  if (!(await isGhCliAvailable())) {
    return { ok: false, error: 'Install the GitHub CLI and sign in to stop workflow runs.' };
  }

  try {
    await ghApiAllowEmpty(`repos/${parsed.owner}/${parsed.repo}/actions/runs/${runId}/cancel`, [
      '--method',
      'POST',
    ]);
    return { ok: true };
  } catch (error) {
    const message = ghErrorMessage(error);
    if (/409|Conflict/i.test(message)) {
      return { ok: false, error: 'That run already finished, so there was nothing to stop.' };
    }
    return { ok: false, error: message };
  }
}
