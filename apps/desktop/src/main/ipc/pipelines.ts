import type { ProjectGithubAction } from '@runova/core';
import { normalizeProjectGithubActions } from '@runova/core';
import { ipcMain } from 'electron';
import type {
  GithubActionsActivity,
  GithubActionsRunErrorInput,
  GithubActionsRunErrorResult,
  GithubJobLogInput,
  GithubJobLogResult,
  GithubPipelineActionResult,
  GithubRunAnnotationsInput,
  GithubRunAnnotationsResult,
  GithubRunCancelRequest,
  GithubRunDetailsInput,
  GithubRunDetailsResult,
  GithubRunnersInput,
  GithubRunnersResult,
  GithubWorkflowDispatchRequest,
  GithubWorkflowRefsResult,
  ProjectPipelineStatus,
  RunnerMachineLink,
  RunnerMachineStatsResult,
} from '../../shared/apiTypes';
import { IPC } from '../../shared/ipcChannels';
import {
  cancelWorkflowRun,
  dispatchWorkflow,
  fetchDashboardActionsActivity,
  fetchJobLog,
  fetchRunAnnotations,
  fetchRunDetails,
  fetchRunFailureText,
  fetchWorkflowRefs,
  setProjectMutedActions,
} from '../pipelines/githubActions';
import { fetchRunnerStatus } from '../pipelines/githubRunners';
import { readRunnerMachineStats } from '../pipelines/runnerMachineStats';
import {
  forgetWatchedWorkflows,
  refreshProjectPipelineStatus,
  schedulePipelineCheck,
} from '../pipelines/watcher';

export function registerPipelineHandlers(): void {
  ipcMain.handle(
    IPC.pipelines.status,
    async (_event, projectId: string): Promise<ProjectPipelineStatus> => {
      return refreshProjectPipelineStatus(String(projectId));
    },
  );

  ipcMain.handle(
    IPC.pipelines.setMuted,
    async (
      _event,
      projectId: string,
      actions: ProjectGithubAction[],
    ): Promise<ProjectPipelineStatus> => {
      const id = String(projectId);
      const next = normalizeProjectGithubActions(actions);
      await setProjectMutedActions(id, next);
      // A workflow that is off stops advancing its mark, so clear it now. Turning the
      // workflow back on then reports from that moment instead of replaying the gap.
      await forgetWatchedWorkflows(
        id,
        next.map((item) => item.workflowId),
      );
      schedulePipelineCheck(id);
      return refreshProjectPipelineStatus(id);
    },
  );

  ipcMain.handle(IPC.pipelines.dashboardActivity, (): Promise<GithubActionsActivity> => {
    return fetchDashboardActionsActivity();
  });

  ipcMain.handle(
    IPC.pipelines.runError,
    (_event, input: GithubActionsRunErrorInput): Promise<GithubActionsRunErrorResult> => {
      return fetchRunFailureText(input);
    },
  );

  ipcMain.handle(
    IPC.pipelines.runAnnotations,
    (_event, input: GithubRunAnnotationsInput): Promise<GithubRunAnnotationsResult> => {
      return fetchRunAnnotations(input);
    },
  );

  ipcMain.handle(
    IPC.pipelines.runDetails,
    (_event, input: GithubRunDetailsInput): Promise<GithubRunDetailsResult> => {
      return fetchRunDetails(input);
    },
  );

  ipcMain.handle(
    IPC.pipelines.jobLog,
    (_event, input: GithubJobLogInput): Promise<GithubJobLogResult> => {
      return fetchJobLog(input);
    },
  );

  ipcMain.handle(IPC.pipelines.refs, (_event, repo: string): Promise<GithubWorkflowRefsResult> => {
    return fetchWorkflowRefs(String(repo));
  });

  ipcMain.handle(
    IPC.pipelines.dispatch,
    async (_event, input: GithubWorkflowDispatchRequest): Promise<GithubPipelineActionResult> => {
      const result = await dispatchWorkflow(input);
      // The run takes a moment to appear on GitHub, so nudge the watcher rather than
      // waiting for its next tick.
      if (result.ok) schedulePipelineCheck();
      return result;
    },
  );

  ipcMain.handle(
    IPC.pipelines.cancelRun,
    async (_event, input: GithubRunCancelRequest): Promise<GithubPipelineActionResult> => {
      const result = await cancelWorkflowRun(input);
      if (result.ok) schedulePipelineCheck();
      return result;
    },
  );

  ipcMain.handle(
    IPC.pipelines.runners,
    (_event, input: GithubRunnersInput): Promise<GithubRunnersResult> => {
      return fetchRunnerStatus({
        runs: Array.isArray(input?.runs) ? input.runs : [],
        fresh: input?.fresh === true,
      });
    },
  );

  ipcMain.handle(
    IPC.pipelines.runnerMachineStats,
    async (_event, link: RunnerMachineLink): Promise<RunnerMachineStatsResult> => {
      if (link?.kind === 'local') return readRunnerMachineStats({ kind: 'local' });
      if (link?.kind === 'ssh' && typeof link.serverId === 'string' && link.serverId !== '') {
        return readRunnerMachineStats({ kind: 'ssh', serverId: link.serverId });
      }
      return { ok: false, reason: 'missing', error: 'No machine is linked to this runner.' };
    },
  );
}
