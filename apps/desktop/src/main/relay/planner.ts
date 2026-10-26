import {
  buildCatchUpRequest,
  buildDecomposeRequest,
  buildReviseRequest,
  diffProposal,
  type EffortLevel,
  nextTaskId,
  parsePlanProposal,
  runArgsFor,
} from '@runova/core';
import type {
  RelayCatchUpInput,
  RelayDecomposeInput,
  RelayPlannerInput,
  RelayPlannerResult,
  RelayReviseInput,
} from '../../shared/relayTypes';
import { cancelHeadlessPrompt, runHeadlessCliPrompt } from '../cli/headlessPrompt';
import { findProjectScope } from '../worktrees/resolve';
import { relaySettings } from './store';
import { readBoardFiles, relayFolder } from './taskFiles';

/**
 * Planning with AI (E26): a headless run of the user's CLI inside the project, so it can read the
 * code and the docs, asked to answer with a JSON proposal. It gets no write flags, and nothing is
 * written until the user applies the proposal.
 */

/** Reading a repository and its docs before answering can take a while on a high effort. */
export const PLANNER_TIMEOUT_MS = 10 * 60_000;
/** Catching up reads the whole project and its history, not just the docs. */
export const CATCH_UP_TIMEOUT_MS = 20 * 60_000;

async function context(projectId: string) {
  const project = await findProjectScope(projectId);
  if (!project) throw new Error('That project no longer exists.');
  const settings = await relaySettings(projectId);
  const folder = relayFolder(project.folderPath, settings.docsFolder);
  const board = await readBoardFiles(folder);
  return { project, settings, folder, board };
}

async function plan(
  input: RelayPlannerInput,
  prompt: string,
  board: Awaited<ReturnType<typeof readBoardFiles>>,
  cwd: string,
  timeoutMs = PLANNER_TIMEOUT_MS,
): Promise<RelayPlannerResult> {
  const cliId = input.cliId ?? null;
  // The planner picker sends the run profile's model id, the same as Build Prompt's run choice.
  const runArgs = runArgsFor(cliId, input.model, (input.effort ?? null) as EffortLevel | null);
  const result = await runHeadlessCliPrompt(prompt, cwd, {
    requestId: input.requestId,
    preferredCliId: cliId,
    strictCli: Boolean(cliId),
    runArgs,
    timeoutMs,
  });
  if (!result.ok) {
    return {
      ok: false,
      error: result.error ?? 'The planner did not answer.',
      cancelled: result.cancelled,
    };
  }
  const parsed = parsePlanProposal(result.text);
  if (!parsed.ok) {
    return { ok: false, error: `${result.cliName ?? 'The CLI'} answered, but ${parsed.error}` };
  }
  return {
    ok: true,
    proposal: parsed.proposal,
    entries: diffProposal(board.files, parsed.proposal),
    cliName: result.cliName,
  };
}

function boardTasks(board: Awaited<ReturnType<typeof readBoardFiles>>) {
  return board.files.map((file) => ({
    id: file.task.id,
    title: file.task.title,
    status: file.task.status,
    depends: file.task.depends,
    estimate: file.task.estimate,
  }));
}

/** Breaks a request into context-sized tasks that continue the board's numbering. */
export async function decomposeRequest(input: RelayDecomposeInput): Promise<RelayPlannerResult> {
  const { project, settings, board } = await context(input.projectId);
  const prompt = buildDecomposeRequest({
    projectName: project.name,
    request: input.request,
    docsFolder: settings.docsFolder,
    budget: input.budget ?? settings.options.defaultBudget,
    firstId: nextTaskId(board.files.map((file) => file.task.id)),
    existing: board.files.map((file) => ({
      id: file.task.id,
      title: file.task.title,
      status: file.task.status,
    })),
  });
  return plan(input, prompt, board, project.folderPath);
}

/** Compares the board with the docs and proposes what should change. */
export async function reviseBoard(input: RelayReviseInput): Promise<RelayPlannerResult> {
  const { project, settings, board } = await context(input.projectId);
  const prompt = buildReviseRequest({
    projectName: project.name,
    docsFolder: settings.docsFolder,
    budget: input.budget ?? settings.options.defaultBudget,
    firstId: nextTaskId(board.files.map((file) => file.task.id)),
    tasks: boardTasks(board),
    note: input.note,
  });
  return plan(input, prompt, board, project.folderPath);
}

/** Works out where a project already under way stands and plans what is left. */
export async function catchUpBoard(input: RelayCatchUpInput): Promise<RelayPlannerResult> {
  const { project, settings, board } = await context(input.projectId);
  const prompt = buildCatchUpRequest({
    projectName: project.name,
    docsFolder: settings.docsFolder,
    budget: input.budget ?? settings.options.defaultBudget,
    firstId: nextTaskId(board.files.map((file) => file.task.id)),
    tasks: boardTasks(board),
    recordDone: input.recordDone,
    note: input.note,
  });
  return plan(input, prompt, board, project.folderPath, CATCH_UP_TIMEOUT_MS);
}

export function cancelPlanner(requestId: string): void {
  cancelHeadlessPrompt(requestId);
}
