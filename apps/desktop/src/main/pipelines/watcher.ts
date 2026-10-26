import { randomUUID } from 'node:crypto';
import type { AppNotification, AppSettings, Project } from '@runova/core';
import type { GithubWorkflowRunInfo } from '../../shared/apiTypes';
import { IPC } from '../../shared/ipcChannels';
import type { PetPipelineMessage, PetPipelineRunRef } from '../../shared/pet';
import { broadcastToWindows } from '../ipc/send';
import { petDisplayName } from '../pet/names';
import { petManager } from '../pet/petWindow';
import { type PipelineWatchState, store } from '../store';
import {
  fetchProjectPipelineStatus,
  githubRepoForFolder,
  listRepoRunsByWorkflow,
  listRepoWorkflows,
} from './githubActions';

const TICK_MS = 45_000;
const MAX_NOTIFICATIONS = 200;

let timer: NodeJS.Timeout | null = null;
let ticking = false;
/**
 * Set when a check is asked for while a tick is already running. Two projects tagged at the
 * same time each ask for one, and the second read the repos before the tag landed, so
 * dropping it would leave that project's new run unseen until the next interval.
 */
let tickAgain = false;

function watchKey(projectId: string, workflowId: number): string {
  return `${projectId}:${workflowId}`;
}

function broadcastNotificationsChanged(): void {
  broadcastToWindows(IPC.appNotifications.onChanged);
}

function petSpeech(kind: 'pass' | 'fail', projectName: string, workflowName: string): string {
  if (kind === 'fail') return `${workflowName} on ${projectName} just failed.`;
  return `${workflowName} on ${projectName} passed.`;
}

function isFailedConclusion(conclusion: GithubWorkflowRunInfo['conclusion']): boolean {
  return conclusion === 'failure' || conclusion === 'timed_out';
}

async function appendRunNotification(input: {
  project: Project;
  workflowName: string;
  run: GithubWorkflowRunInfo;
  passed: boolean;
}): Promise<void> {
  const items = await store.getAppNotifications();
  if (items.some((item) => item.htmlUrl === input.run.htmlUrl)) return;
  const notification: AppNotification = {
    id: randomUUID(),
    kind: input.passed ? 'pipeline-success' : 'pipeline-failure',
    title: `${input.workflowName} ${input.passed ? 'passed' : 'failed'}`,
    body: `${input.project.name} · ${input.run.headBranch || 'unknown branch'} · run #${input.run.runNumber}`,
    projectId: input.project.id,
    projectName: input.project.name,
    htmlUrl: input.run.htmlUrl,
    createdAt: new Date().toISOString(),
    // A green run is good news to look back on, not something to clear, so it
    // stays out of the unread badge.
    read: input.passed,
  };
  items.unshift(notification);
  await store.setAppNotifications(items.slice(0, MAX_NOTIFICATIONS));
  broadcastNotificationsChanged();
}

/**
 * What the pet's bubble opens when clicked. Without a ref the bubble is not a link, which is how
 * "don't open it on click" reaches the pet: no "Click to open" hint and the click just waves the
 * bubble away. A missing setting counts as the Pipelines page, the way it always behaved.
 */
function clickTarget(
  settings: AppSettings,
  project: Project,
  run?: PetPipelineRunRef,
): PetPipelineRunRef | undefined {
  if (!run || settings.pipelineFailureOpen === 'none') return undefined;
  return settings.pipelineFailureOpen === 'workspace'
    ? { ...run, workspaceProjectId: project.id }
    : run;
}

function maybeSpeak(
  settings: AppSettings,
  kind: 'pass' | 'fail',
  project: Project,
  workflowName: string,
  run?: PetPipelineRunRef,
): void {
  if (!settings.desktopPetEnabled) return;
  if (kind === 'fail' && !settings.desktopPetPipelineOnFail) return;
  if (kind === 'pass' && !settings.desktopPetPipelineOnPass) return;

  const payload: PetPipelineMessage = {
    kind,
    petName: petDisplayName(
      settings.desktopPetCharacterId,
      settings.desktopPetCustoms ?? [],
      settings.desktopPetName,
    ),
    text: petSpeech(kind, project.name, workflowName),
    projectName: project.name,
    workflowName,
    run: clickTarget(settings, project, run),
  };
  petManager.sendPipelineMessage(payload);
}

function processWatchedWorkflow(
  project: Project,
  workflowId: number,
  workflowName: string,
  owner: string,
  repo: string,
  runs: GithubWorkflowRunInfo[],
  watch: PipelineWatchState,
): { changed: boolean; announce: (() => Promise<void>) | null } {
  const key = watchKey(project.id, workflowId);
  const completed = runs.filter((run) => run.status === 'completed');
  const lastSeen = watch.lastCompletedRunId[key];

  if (lastSeen == null) {
    // First time this workflow is seen. Remember where it stands so the next tick
    // only reports what happens from here on.
    const newest = completed[0];
    watch.lastCompletedRunId[key] = newest?.id ?? 0;
    return { changed: true, announce: null };
  }

  const fresh = completed.filter((run) => run.id > lastSeen).sort((a, b) => a.id - b.id);
  if (fresh.length === 0) return { changed: false, announce: null };

  watch.lastCompletedRunId[key] = fresh[fresh.length - 1].id;
  return {
    changed: true,
    announce: async () => {
      const settings = await store.getSettings();
      for (const run of fresh) {
        const name = workflowName || run.name;
        if (isFailedConclusion(run.conclusion)) {
          // Missing counts as on, so a profile from before the setting existed keeps its notices.
          if (settings.pipelineFailureNotify !== false) {
            await appendRunNotification({ project, workflowName: name, run, passed: false });
          }
          // The ref rides along so clicking the bubble opens this run on the
          // Pipelines page instead of just raising the window.
          maybeSpeak(settings, 'fail', project, name, { runId: run.id, repo: `${owner}/${repo}` });
        } else if (run.conclusion === 'success') {
          await appendRunNotification({ project, workflowName: name, run, passed: true });
          maybeSpeak(settings, 'pass', project, name);
        }
      }
    },
  };
}

/** The workflows of a project that still report, i.e. everything the user has not switched off. */
async function watchedWorkflows(
  project: Project,
  owner: string,
  repo: string,
): Promise<{ workflowId: number; name: string }[]> {
  const muted = new Set((project.githubActionsMuted ?? []).map((item) => item.workflowId));
  const workflows = await listRepoWorkflows(owner, repo);
  return workflows
    .filter((workflow) => !muted.has(workflow.id))
    .map((workflow) => ({ workflowId: workflow.id, name: workflow.name }));
}

/**
 * Drops what the watcher remembers about these workflows, so the next tick reads their
 * current state instead of replaying it. Called when a workflow is switched off: while it
 * is off nothing advances the mark, and switching it back on should not announce every run
 * that happened in between.
 */
export async function forgetWatchedWorkflows(
  projectId: string,
  workflowIds: number[],
): Promise<void> {
  if (workflowIds.length === 0) return;
  const watch = await store.getPipelineWatch();
  for (const workflowId of workflowIds) {
    delete watch.lastCompletedRunId[watchKey(projectId, workflowId)];
  }
  await store.setPipelineWatch(watch);
}

async function tick(): Promise<void> {
  if (ticking) {
    tickAgain = true;
    return;
  }
  ticking = true;
  try {
    do {
      tickAgain = false;
      await tickOnce();
    } while (tickAgain);
  } finally {
    ticking = false;
  }
}

async function tickOnce(): Promise<void> {
  const projects = await store.getProjects();
  const watch = await store.getPipelineWatch();
  const announcements: (() => Promise<void>)[] = [];
  // Two projects can sit in the same repo, and a repo only needs reading once a tick.
  const runsByRepo = new Map<string, Map<number, GithubWorkflowRunInfo[]>>();
  let dirty = false;
  for (const project of projects) {
    if (project.archived) continue;
    const github = await githubRepoForFolder(project.folderPath);
    if (!github) continue;
    try {
      const watched = await watchedWorkflows(project, github.owner, github.repo);
      if (watched.length === 0) continue;
      // One call covers the whole repo, however many workflows it has.
      const repoKey = `${github.owner}/${github.repo}`.toLowerCase();
      let runsByWorkflow = runsByRepo.get(repoKey);
      if (!runsByWorkflow) {
        runsByWorkflow = await listRepoRunsByWorkflow(github.owner, github.repo);
        runsByRepo.set(repoKey, runsByWorkflow);
      }
      for (const workflow of watched) {
        const result = processWatchedWorkflow(
          project,
          workflow.workflowId,
          workflow.name,
          github.owner,
          github.repo,
          runsByWorkflow.get(workflow.workflowId) ?? [],
          watch,
        );
        if (result.changed) dirty = true;
        if (result.announce) announcements.push(result.announce);
      }
    } catch {
      // Offline, rate limited, or the repo is gone. The next tick retries.
    }
  }
  // Saving before announcing means a crash here costs a notification rather than
  // repeating every one of them on the next launch.
  if (dirty) await store.setPipelineWatch(watch);
  for (const announce of announcements) await announce();
}

export function startPipelineWatcher(): void {
  if (timer) return;
  timer = setInterval(() => {
    void tick();
  }, TICK_MS);
  void tick();
}

export function stopPipelineWatcher(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

export function schedulePipelineCheck(projectId?: string): void {
  void (async () => {
    if (projectId) {
      const projects = await store.getProjects();
      if (!projects.some((item) => item.id === projectId)) return;
    }
    await tick();
  })();
}

/** Used by the Git tab so connecting a workflow immediately shows current status. */
export async function refreshProjectPipelineStatus(projectId: string) {
  const projects = await store.getProjects();
  const project = projects.find((item) => item.id === projectId);
  if (!project) throw new Error(`Project ${projectId} not found`);
  return fetchProjectPipelineStatus(project);
}
