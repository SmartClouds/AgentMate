import {
  diffProposal,
  formatTokenCount,
  handoffRelPath,
  isHandoffFresh,
  isRelayTaskId,
  parsePlanProposal,
  RELAY_OUTCOMES,
  RELAY_TEST_RESULTS,
  taskRelPath,
} from '@runova/core';
import { z } from 'zod';
import type { RelayDriver } from '../service';
import { readBoardFiles, readHandoff, relayFolder } from '../taskFiles';
import { RELAY_MCP_TOOLS } from './bridgeScript';

/**
 * Answers the Relay MCP tools (POST /relay). The bridge names only its session; which project,
 * task and leg that is comes from the driver, so an agent can never reach another project.
 */

const requestSchema = z.object({
  sessionId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  tool: z.enum(RELAY_MCP_TOOLS),
  args: z.record(z.string(), z.unknown()).default({}),
});

const finishSchema = z.object({
  outcome: z.enum(RELAY_OUTCOMES),
  tests: z.enum(RELAY_TEST_RESULTS),
  summary: z.string().max(2000).optional(),
});

type Answer = {
  status: number;
  payload: { ok: boolean; text?: string; data?: unknown; error?: string };
};

const ok = (text: string): Answer => ({ status: 200, payload: { ok: true, text } });
const data = (value: unknown): Answer => ({ status: 200, payload: { ok: true, data: value } });
const refuse = (error: string, status = 200): Answer => ({ status, payload: { ok: false, error } });

export interface RelayMcpContext {
  driver: RelayDriver;
  projectFolder: (projectId: string) => Promise<{ folderPath: string; name: string } | null>;
}

export async function handleRelayMcp(
  context: RelayMcpContext,
  body: Record<string, unknown>,
): Promise<Answer> {
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) return refuse('The request was not understood.', 400);
  const { sessionId, tool, args } = parsed.data;
  const found = context.driver.legForSession(sessionId);
  if (!found) return refuse('This session is not running a Relay task right now.');
  const { relay, leg } = found;
  const project = await context.projectFolder(relay.projectId);
  if (!project) return refuse('The project is gone.');
  const folder = relayFolder(project.folderPath, relay.docsFolder);
  const handoffPath = handoffRelPath(folder.docsFolder, leg.taskId);

  switch (tool) {
    case 'current_leg': {
      const board = await readBoardFiles(folder);
      const task = board.files.find((file) => file.task.id === leg.taskId);
      return data({
        taskId: leg.taskId,
        title: task?.task.title ?? leg.taskId,
        taskFile: task ? taskRelPath(folder.docsFolder, task.file) : null,
        session: leg.legNo,
        continuation: leg.continuation,
        budgetTokens: leg.budget,
        handoff: handoffPath,
        dependsOn: (task?.task.depends ?? []).map((id) => ({
          id,
          handoff: handoffRelPath(folder.docsFolder, id),
        })),
        planFirst: leg.planFirst,
        commitWhenDone: relay.options.commitPerTask,
      });
    }
    case 'context_status': {
      if (leg.contextTokens === null) {
        return ok(
          `Runova cannot measure this session's context. The budget is ${formatTokenCount(leg.budget)} tokens; hand off with outcome: continue if you think you are near it.`,
        );
      }
      const percent = Math.round((leg.contextTokens / leg.budget) * 100);
      const guard = Math.round(relay.options.guardShare * 100);
      return ok(
        `About ${formatTokenCount(leg.contextTokens)} of ${formatTokenCount(leg.budget)} tokens used (${percent}%). Hand off at ${guard}%.`,
      );
    }
    case 'finish_leg': {
      const finish = finishSchema.safeParse(args);
      if (!finish.success)
        return refuse(
          'Give outcome (done, continue or blocked) and tests (passed, failed or not-run).',
        );
      const read = await readHandoff(folder, leg.taskId);
      if (!read || !isHandoffFresh(read.meta, leg.handoffMtimeAtStart)) {
        return refuse(`Write ${handoffPath} first, then call finish_leg again.`);
      }
      const problems: string[] = [];
      if (read.handoff.missingSections.length > 0) {
        problems.push(`fill in these sections: ${read.handoff.missingSections.join(', ')}`);
      }
      if (read.handoff.outcome !== finish.data.outcome) {
        problems.push(
          `set outcome: ${finish.data.outcome} in its front matter (it says ${read.handoff.outcome ?? 'nothing'})`,
        );
      }
      if (read.handoff.tests !== finish.data.tests) {
        problems.push(`set tests: ${finish.data.tests} in its front matter`);
      }
      if (problems.length > 0)
        return refuse(`In ${handoffPath}, ${problems.join('; ')}. Then call finish_leg again.`);
      await context.driver.reportLeg(sessionId, read.meta);
      return ok('Recorded. Stop now; Runova takes it from here.');
    }
    case 'list_tasks': {
      const board = await readBoardFiles(folder);
      return data(
        board.files.map(({ task }) => ({
          id: task.id,
          title: task.title,
          status: task.status,
          epic: task.epic,
          depends: task.depends,
        })),
      );
    }
    case 'get_task': {
      const id = typeof args.id === 'string' ? args.id.trim().toUpperCase() : '';
      if (!isRelayTaskId(id)) return refuse('Give a task id like T004.');
      const board = await readBoardFiles(folder);
      const file = board.files.find((entry) => entry.task.id === id);
      if (!file) return refuse(`There is no task ${id}.`);
      const handoff = await readHandoff(folder, id);
      return ok(`${file.content}\n\n--- handoff ---\n\n${handoff?.text ?? '(none yet)'}`);
    }
    case 'propose_tasks': {
      const parsedProposal = parsePlanProposal(JSON.stringify(args.proposal ?? null));
      if (!parsedProposal.ok) return refuse(parsedProposal.error);
      const board = await readBoardFiles(folder);
      const added = context.driver.addProposal(
        relay.projectId,
        project.name,
        leg.taskId,
        parsedProposal.proposal,
        diffProposal(board.files, parsedProposal.proposal),
      );
      if (typeof added === 'string') return refuse(added);
      return ok(
        'Sent to the user for review in Runova. Carry on with your task; do not wait for it.',
      );
    }
  }
}
