import { randomUUID } from 'node:crypto';
import {
  AGENT_TYPE_CLI_ID,
  type AppNotification,
  launchPickArgs,
  launchPickLabel,
} from '@runova/core';
import type { AutoFixSession } from '../../../shared/ciAutoFixTypes';
import { IPC } from '../../../shared/ipcChannels';
import { agentStatus } from '../../agents/statusTracker';
import { appNotificationInbox } from '../../deploy/watcher';
import { broadcastToWindows } from '../../ipc/send';
import { showOsNotification } from '../../notifications/osNotification';
import { store } from '../../store';
import { findProjectScope } from '../../worktrees/resolve';
import { fetchRunFailureText, fetchWorkflowRun, listWorkflowRuns } from '../githubActions';
import { schedulePipelineCheck } from '../watcher';
import { setAutoFixClaimer } from './claims';
import { commitAutoFix, preflightAutoFix } from './git';
import { launchAutoFixAgent } from './launch';
import { pickWaitedRun } from './runs';
import { type AutoFixService, createAutoFixService } from './service';

const inbox = appNotificationInbox({
  list: () => store.getAppNotifications(),
  save: (items) => store.setAppNotifications(items),
  changed: () => broadcastToWindows(IPC.appNotifications.onChanged),
});

/** The run a notice about this session opens: the one it follows, or the last one it fixed. */
function runRoute(session: AutoFixSession): string {
  const runId = session.runId ?? session.attempts[session.attempts.length - 1]?.runId;
  return runId ? `/pipelines?run=${runId}&repo=${encodeURIComponent(session.repo)}` : '/pipelines';
}

function notice(
  session: AutoFixSession,
  kind: 'fixed' | 'attention' | 'gave-up',
): { title: string; body: string; route: string } {
  const where = `${session.projectName} · ${session.branch}`;
  if (kind === 'fixed') {
    const count = session.attempts.length;
    return {
      title: `${session.workflowName} fixed`,
      body: `${where} · passing after ${count} ${count === 1 ? 'fix' : 'fixes'}`,
      route: runRoute(session),
    };
  }
  const tab = session.attempts[session.attempts.length - 1]?.tabId;
  const inTab = session.blocker === 'needs-input' || session.blocker === 'agent-lost';
  return {
    title:
      kind === 'attention'
        ? `Auto-fix needs you on ${session.workflowName}`
        : `Auto-fix gave up on ${session.workflowName}`,
    body: `${where} · ${session.message ?? ''}`.trim(),
    // A question from the agent is answered in its tab, everything else on the run.
    route:
      inTab && tab
        ? `/workspace/${session.projectId}?session=${encodeURIComponent(tab)}`
        : runRoute(session),
  };
}

function notify(session: AutoFixSession, kind: 'fixed' | 'attention' | 'gave-up'): void {
  const text = notice(session, kind);
  const notification: AppNotification = {
    id: `autofix:${session.id}:${kind}:${Date.now().toString(36)}`,
    kind: `pipeline-autofix-${kind}`,
    title: text.title,
    body: text.body,
    projectId: session.projectId,
    projectName: session.projectName,
    htmlUrl: null,
    route: text.route,
    createdAt: new Date().toISOString(),
    read: false,
  };
  void inbox.add(notification).catch(() => undefined);
  showOsNotification({ title: text.title, body: text.body, route: text.route });
}

let service: AutoFixService | null = null;

function create(): AutoFixService {
  return createAutoFixService({
    now: () => Date.now(),
    newId: () => randomUUID(),
    load: () => store.getAutoFixSessions(),
    save: (sessions) => store.setAutoFixSessions(sessions),
    project: async (projectId) => {
      const project = await findProjectScope(projectId);
      return project
        ? {
            id: project.id,
            name: project.name,
            folderPath: project.folderPath,
            cliId: project.cliId ?? null,
            fallbackCliId: AGENT_TYPE_CLI_ID[project.agentType] ?? null,
          }
        : null;
    },
    defaults: async (project) => {
      const settings = await store.getSettings();
      const chosen = settings.ciAutoFixCliId ?? null;
      // The same order a workspace tab uses (see projectCliId in the renderer), after Settings.
      const cliId = chosen ?? project.cliId ?? settings.defaultCliId ?? project.fallbackCliId;
      // The model and effort in Settings were picked for the CLI picked there.
      const pick =
        chosen && cliId === chosen
          ? {
              model: settings.ciAutoFixModel ?? undefined,
              effort: settings.ciAutoFixEffort ?? undefined,
            }
          : {};
      return {
        cliId,
        runArgs: cliId ? launchPickArgs(cliId, pick) : [],
        runLabel: (cliId && launchPickLabel(cliId, pick)) || null,
        maxAttempts: settings.ciAutoFixMaxAttempts ?? 3,
      };
    },
    getRun: async (repo, runId) => {
      const run = await fetchWorkflowRun(repo, runId);
      return {
        status: run.status,
        conclusion: run.conclusion,
        headSha: run.headSha ?? null,
        runNumber: run.runNumber,
        displayTitle: run.displayTitle,
      };
    },
    findRun: async (repo, workflowId, branch, wait) => {
      const [owner, name] = repo.split('/');
      return pickWaitedRun(await listWorkflowRuns(owner, name, workflowId, 20), branch, wait);
    },
    failureText: fetchRunFailureText,
    preflight: preflightAutoFix,
    commit: commitAutoFix,
    launch: launchAutoFixAgent,
    agentStatus: {
      subscribe: (listener) => agentStatus.subscribe(listener),
      status: (id) => agentStatus.status(id),
      unpin: (id) => agentStatus.unpin(id),
    },
    emitTab: (event) => broadcastToWindows(IPC.ciAutoFix.onTab, event),
    emitChanged: (sessions) => broadcastToWindows(IPC.ciAutoFix.onChanged, sessions),
    notify,
    pushed: (projectId) => schedulePipelineCheck(projectId),
  });
}

/** The one auto-fix service of the app, created on first use. */
export function ciAutoFixService(): AutoFixService {
  service ??= create();
  return service;
}

/** Reads the saved sessions back and carries on with the ones still in progress. */
export async function startCiAutoFix(): Promise<void> {
  const current = ciAutoFixService();
  setAutoFixClaimer((projectId, runId) => current.claims(projectId, runId));
  await current.start();
}

export function stopCiAutoFix(): void {
  service?.dispose();
  setAutoFixClaimer(null);
}
