import { orderTasks } from '@runova/core';
import type { RelayBoard, RelayHandoffSummary, RelayTaskDetail } from '../../shared/relayTypes';
import { findProjectScope } from '../worktrees/resolve';
import { getRelayRuntime } from './runtime';
import { legRecords, relaySettings } from './store';
import { readBoardFiles, readHandoff, relayFolder } from './taskFiles';

/** The Next step as a card shows it: one paragraph at most. */
const NEXT_MAX = 280;

/** A project, or a worktree's workspace (its scope id), with the folder its sessions run in. */
export async function projectFor(projectId: string) {
  const project = await findProjectScope(projectId);
  if (!project) throw new Error('That project no longer exists.');
  return project;
}

/** The project's relay folder, from its settings. */
export async function projectRelayFolder(projectId: string) {
  const [project, settings] = await Promise.all([projectFor(projectId), relaySettings(projectId)]);
  return { project, settings, folder: relayFolder(project.folderPath, settings.docsFolder) };
}

/** Everything the board shows for a project, read fresh from its files. */
export async function buildRelayBoard(projectId: string): Promise<RelayBoard> {
  const { settings, folder } = await projectRelayFolder(projectId);
  const [files, legs] = await Promise.all([readBoardFiles(folder), legRecords(projectId)]);
  const order = orderTasks(files.files.map((file) => file.task));
  const tasks = await Promise.all(
    files.files.map(async ({ task }) => {
      const read = await readHandoff(folder, task.id);
      const handoff: RelayHandoffSummary | null = read
        ? {
            outcome: read.handoff.outcome,
            tests: read.handoff.tests,
            leg: read.handoff.leg,
            updated: read.handoff.updated,
            missingSections: read.handoff.missingSections,
            next: read.handoff.sections.next.slice(0, NEXT_MAX),
          }
        : null;
      const { body: _body, ...card } = task;
      const own = legs.filter((leg) => leg.taskId === task.id);
      return {
        ...card,
        handoff,
        legCount: own.length,
        legPeaks: own.flatMap((leg) =>
          leg.peakContextTokens !== null && leg.peakContextTokens > 0
            ? [leg.peakContextTokens]
            : [],
        ),
      };
    }),
  );
  return {
    projectId,
    docsFolder: folder.docsFolder,
    exists: files.exists,
    guidePresent: files.guidePresent,
    tasks,
    order: [...order.ordered, ...order.cycles.flat(), ...order.stuck],
    cycles: order.cycles,
    missing: order.missing,
    issues: files.issues,
    settings,
    active: getRelayRuntime()?.active(projectId) ?? null,
  };
}

export async function relayTaskDetail(
  projectId: string,
  taskId: string,
): Promise<RelayTaskDetail | null> {
  const { folder } = await projectRelayFolder(projectId);
  const files = await readBoardFiles(folder);
  const file = files.files.find((entry) => entry.task.id === taskId);
  if (!file) return null;
  const read = await readHandoff(folder, taskId);
  return {
    task: file.task,
    handoff: read?.handoff ?? null,
    handoffText: read?.text ?? null,
    legs: await legRecords(projectId, taskId),
  };
}
