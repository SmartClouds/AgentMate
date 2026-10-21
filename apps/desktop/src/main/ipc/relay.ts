import {
  buildLegPrompt,
  RELAY_TASK_STATUSES,
  type RelayProposal,
  relayCapabilities,
} from '@agentmat/core';
import { ipcMain } from 'electron';
import { z } from 'zod';
import { IPC } from '../../shared/ipcChannels';
import type {
  RelayApplyResult,
  RelayBoard,
  RelayMcpProposal,
  RelayPlannerResult,
  RelayProjectSettings,
  RelayRunView,
  RelaySingleRun,
  RelayStartResult,
  RelayTaskDetail,
} from '../../shared/relayTypes';
import { buildRelayBoard, projectRelayFolder, relayTaskDetail } from '../relay/board';
import { cancelPlanner, catchUpBoard, decomposeRequest, reviseBoard } from '../relay/planner';
import { getRelayRuntime } from '../relay/runtime';
import { legRecords, saveRelaySettings, settingsPatchSchema } from '../relay/store';
import {
  applyProposalFiles,
  ensureGuide,
  ensureHandoffTemplate,
  readBoardFiles,
  relayFolder,
  reorderTaskFiles,
  setTaskStatusFile,
} from '../relay/taskFiles';
import { relayWatcher } from '../relay/wiring';
import { broadcastToWindows } from './send';

/**
 * Relay (E26). Only ids and plain data come in, each checked here; main reads the files, builds
 * every prompt and command, and runs the sessions.
 */

const id = z.string().min(1).max(128);
const taskId = z.string().regex(/^T\d{3,}$/);
const requestId = z.string().min(1).max(128);
const status = z.enum(RELAY_TASK_STATUSES);
const trigger = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('now') }),
  z.object({ kind: z.literal('at'), at: z.number().int().nonnegative() }),
  z.object({ kind: z.literal('after-task'), projectId: id, taskId }),
  z.object({
    kind: z.literal('after-session'),
    sessionId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    label: z.string().max(120).optional(),
  }),
]);
const startSchema = z
  .object({
    projectId: id,
    only: z.array(taskId).max(500).optional(),
    from: taskId.optional(),
    trigger,
    options: settingsPatchSchema.shape.options,
    defaults: settingsPatchSchema.shape.defaults,
  })
  .strict();
const plannerFields = {
  requestId,
  projectId: id,
  cliId: z.string().max(64).nullish(),
  model: z.string().max(200).nullish(),
  effort: z.string().max(40).nullish(),
  budget: z.number().int().min(10_000).max(10_000_000).optional(),
};
const decomposeSchema = z.object({ ...plannerFields, request: z.string().min(1).max(100_000) });
const reviseSchema = z.object({ ...plannerFields, note: z.string().max(20_000).optional() });
const catchUpSchema = z.object({
  ...plannerFields,
  recordDone: z.boolean(),
  note: z.string().max(20_000).optional(),
});
/** A proposal is checked again in core when it is applied; this only bounds its size. */
const proposalSchema = z
  .object({
    summary: z.string().max(10_000),
    add: z.array(z.record(z.string(), z.unknown())).max(200),
    change: z.array(z.record(z.string(), z.unknown())).max(200),
    split: z.array(z.record(z.string(), z.unknown())).max(100),
    remove: z.array(z.record(z.string(), z.unknown())).max(200),
  })
  .passthrough();
const reconcileSchema = z
  .array(z.object({ legId: z.string().max(256), tabId: z.string().max(128) }))
  .max(500);

function runtime() {
  const live = getRelayRuntime();
  if (!live) throw new Error('Relay is still starting. Try again in a moment.');
  return live;
}

function changed(projectId: string, reason: 'files' | 'settings'): void {
  broadcastToWindows(IPC.relay.onChanged, { projectId, reason });
}

/** A task run by hand in a new session: the files in place, the status set, the prompt built. */
async function prepareRun(projectId: string, task: string): Promise<RelaySingleRun> {
  const { settings, folder } = await projectRelayFolder(projectId);
  const file = (await readBoardFiles(folder)).files.find((entry) => entry.task.id === task);
  if (!file) throw new Error(`There is no task ${task}.`);
  await ensureGuide(folder);
  await ensureHandoffTemplate(folder, { id: task, title: file.task.title });
  await setTaskStatusFile(folder, task, 'in-progress');
  changed(projectId, 'files');
  const { planFirst: wantsPlan, ...override } = settings.overrides[task] ?? {};
  // A hand-started run is not sized: it starts on the chosen model and effort, or the CLI's own.
  const choice = { ...settings.defaults, ...override, autoSize: false };
  const planFirst =
    (wantsPlan ?? settings.options.planFirst) && relayCapabilities(choice.cliId).planMode;
  const legNo = (await legRecords(projectId, task)).length + 1;
  return {
    prompt: buildLegPrompt({
      task: { id: task, title: file.task.title, file: file.file },
      docsFolder: folder.docsFolder,
      legNo,
      continuation: legNo > 1,
      budget: file.task.budget ?? settings.options.defaultBudget,
      dependsOn: file.task.depends,
      commitPerTask: settings.options.commitPerTask,
      mcp: false,
      planFirst,
    }),
    choice,
    planFirst,
    legNo,
  };
}

export function registerRelayHandlers(): void {
  ipcMain.handle(
    IPC.relay.board,
    (_event, projectId: unknown): Promise<RelayBoard> => buildRelayBoard(id.parse(projectId)),
  );

  ipcMain.handle(
    IPC.relay.task,
    (_event, projectId: unknown, task: unknown): Promise<RelayTaskDetail | null> =>
      relayTaskDetail(id.parse(projectId), taskId.parse(task)),
  );

  ipcMain.handle(
    IPC.relay.setStatus,
    async (_event, projectId: unknown, task: unknown, next: unknown): Promise<void> => {
      const project = id.parse(projectId);
      const { folder } = await projectRelayFolder(project);
      if (!(await setTaskStatusFile(folder, taskId.parse(task), status.parse(next)))) {
        throw new Error('That task is not on the board any more.');
      }
      changed(project, 'files');
    },
  );

  ipcMain.handle(
    IPC.relay.reorder,
    async (_event, projectId: unknown, taskIds: unknown): Promise<void> => {
      const project = id.parse(projectId);
      const { folder } = await projectRelayFolder(project);
      await reorderTaskFiles(folder, z.array(taskId).max(500).parse(taskIds));
      changed(project, 'files');
    },
  );

  ipcMain.handle(
    IPC.relay.ensureGuide,
    async (_event, projectId: unknown, docsFolder: unknown): Promise<void> => {
      const project = id.parse(projectId);
      const { project: found, folder } = await projectRelayFolder(project);
      const target =
        typeof docsFolder === 'string' ? relayFolder(found.folderPath, docsFolder) : folder;
      await ensureGuide(target);
      changed(project, 'files');
    },
  );

  ipcMain.handle(
    IPC.relay.saveSettings,
    async (_event, projectId: unknown, patch: unknown): Promise<RelayProjectSettings> => {
      const project = id.parse(projectId);
      const saved = await saveRelaySettings(project, settingsPatchSchema.parse(patch));
      changed(project, 'settings');
      return saved;
    },
  );

  ipcMain.handle(
    IPC.relay.prepareRun,
    (_event, projectId: unknown, task: unknown): Promise<RelaySingleRun> =>
      prepareRun(id.parse(projectId), taskId.parse(task)),
  );

  ipcMain.handle(
    IPC.relay.start,
    (_event, input: unknown): Promise<RelayStartResult> =>
      runtime().start(startSchema.parse(input)),
  );
  ipcMain.handle(IPC.relay.pause, (_event, relayId: unknown) => runtime().pause(id.parse(relayId)));
  ipcMain.handle(IPC.relay.resume, (_event, relayId: unknown) =>
    runtime().resume(id.parse(relayId)),
  );
  ipcMain.handle(IPC.relay.cancel, (_event, relayId: unknown) =>
    runtime().cancel(id.parse(relayId)),
  );
  ipcMain.handle(IPC.relay.markDone, (_event, relayId: unknown, task: unknown) =>
    runtime().markDone(id.parse(relayId), taskId.parse(task)),
  );
  ipcMain.handle(
    IPC.relay.runs,
    (_event, projectId: unknown): RelayRunView[] =>
      getRelayRuntime()?.runs(id.parse(projectId)) ?? [],
  );

  ipcMain.handle(IPC.relay.watch, (_event, projectId: unknown): void => {
    relayWatcher()?.watch(id.parse(projectId));
  });
  ipcMain.handle(IPC.relay.unwatch, (_event, projectId: unknown): void => {
    relayWatcher()?.unwatch(id.parse(projectId));
  });

  ipcMain.handle(
    IPC.relay.decompose,
    (_event, input: unknown): Promise<RelayPlannerResult> =>
      decomposeRequest(decomposeSchema.parse(input)),
  );
  ipcMain.handle(
    IPC.relay.revise,
    (_event, input: unknown): Promise<RelayPlannerResult> => reviseBoard(reviseSchema.parse(input)),
  );
  ipcMain.handle(
    IPC.relay.catchUp,
    (_event, input: unknown): Promise<RelayPlannerResult> =>
      catchUpBoard(catchUpSchema.parse(input)),
  );
  ipcMain.handle(IPC.relay.cancelPlanner, (_event, request: unknown): void => {
    cancelPlanner(requestId.parse(request));
  });

  ipcMain.handle(
    IPC.relay.applyProposal,
    async (_event, projectId: unknown, proposal: unknown): Promise<RelayApplyResult> => {
      const project = id.parse(projectId);
      const { folder } = await projectRelayFolder(project);
      const result = await applyProposalFiles(
        folder,
        proposalSchema.parse(proposal) as unknown as RelayProposal,
      );
      changed(project, 'files');
      return result;
    },
  );

  ipcMain.handle(
    IPC.relay.decideProposal,
    (_event, proposalId: unknown, accept: unknown): Promise<RelayApplyResult | null> =>
      runtime().decideProposal(id.parse(proposalId), z.boolean().parse(accept)),
  );
  ipcMain.handle(
    IPC.relay.pendingProposals,
    (): RelayMcpProposal[] => getRelayRuntime()?.pendingProposals() ?? [],
  );
  ipcMain.handle(IPC.relay.reconcile, (_event, tabs: unknown) =>
    runtime().reconcile(reconcileSchema.parse(tabs)),
  );
}
