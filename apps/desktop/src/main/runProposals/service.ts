import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Project, ProjectRunCommand } from '@runova/core';
import { configuredRunCommands, normalizeProjectRunCommands } from '@runova/core';
import type {
  RunProposal,
  RunProposalDecision,
  RunProposalDecisionResult,
  RunProposalResult,
  RunProposalsChanged,
  RunSetupSession,
} from '../../shared/apiTypes';
import { IPC } from '../../shared/ipcChannels';
import { broadcastToWindows } from '../ipc/send';
import { store } from '../store';
import { bridgeScriptSource } from './bridgeScript';
import {
  disableRunProposals,
  enableRunProposals,
  isRunProposalsEnabled,
  RUN_COMMANDS_SCRIPT_NAME,
  RUN_COMMANDS_SERVER_NAME,
} from './mcpConfig';
import { validateRunProposal } from './validate';

/** More than this waiting for one project is a loop, not a plan, so the agent is told to stop. */
const MAX_WAITING_PER_PROJECT = 10;

/** How long a run setup started from Runova may keep suggesting. */
const GUIDED_MS = 2 * 60 * 60 * 1000;

const SAFE_PROJECT_ID = /^[A-Za-z0-9_-]+$/;

/** The tools the bridge offers. Allowed by name when the agent is launched from Runova. */
const RUN_COMMANDS_TOOLS = ['list_run_commands', 'propose_run_command'] as const;

/** Projects with a run setup under way, and when that permission ends. Memory only, like the rest. */
const guidedUntil = new Map<string, number>();

/**
 * Suggestions waiting for the user. Kept in memory on purpose: one nobody answered is dropped when
 * Runova quits, so a stale suggestion never comes back on its own.
 */
const pending = new Map<string, RunProposal>();

export interface RunCommandsResponse {
  status: number;
  payload: Record<string, unknown>;
}

export function listPendingRunProposals(): RunProposal[] {
  return [...pending.values()];
}

function announce(): void {
  const changed: RunProposalsChanged = { pending: listPendingRunProposals() };
  broadcastToWindows(IPC.runProposals.onChanged, changed);
}

async function findProject(projectId: string): Promise<Project | undefined> {
  const projects = await store.getProjects();
  return projects.find((project) => project.id === projectId);
}

function failure(status: number, error: string): RunCommandsResponse {
  return { status, payload: { ok: false, error } };
}

/**
 * Starts a run setup from Runova: the agent is launched with an MCP config of its own, kept
 * outside the project folder, so the project needs no `.mcp.json` entry. The tools are named here
 * so the launcher can allow them without a prompt. The user still approves every suggestion.
 */
export async function startGuidedRunSession(
  projectId: string,
  options: { directory: string; portFile: string },
): Promise<RunSetupSession> {
  const project = await findProject(projectId);
  if (!project) return { ok: false, error: 'Runova does not know this project.' };
  // The id becomes a folder name, so anything that could leave the sessions folder is refused.
  if (!SAFE_PROJECT_ID.test(project.id)) {
    return { ok: false, error: 'This project cannot start a run setup.' };
  }
  const folder = join(options.directory, project.id);
  const script = join(folder, RUN_COMMANDS_SCRIPT_NAME);
  const mcpConfigPath = join(folder, 'mcp.json');
  try {
    await mkdir(folder, { recursive: true });
    await writeFile(
      script,
      bridgeScriptSource({ portFile: options.portFile, projectId: project.id }),
      'utf-8',
    );
    await writeFile(
      mcpConfigPath,
      JSON.stringify(
        { mcpServers: { [RUN_COMMANDS_SERVER_NAME]: { command: 'node', args: [script] } } },
        null,
        2,
      ),
      'utf-8',
    );
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Could not prepare the run setup.',
    };
  }
  guidedUntil.set(project.id, Date.now() + GUIDED_MS);
  return {
    ok: true,
    mcpConfigPath,
    allowedTools: RUN_COMMANDS_TOOLS.map((tool) => `mcp__${RUN_COMMANDS_SERVER_NAME}__${tool}`),
  };
}

/** A project may suggest while its switch is on, or for a while after a setup started from here. */
async function mayPropose(project: Project): Promise<boolean> {
  if ((guidedUntil.get(project.id) ?? 0) > Date.now()) return true;
  return isRunProposalsEnabled(project.folderPath);
}

export async function getRunProposalsEnabled(projectId: string): Promise<boolean> {
  const project = await findProject(projectId);
  return project ? isRunProposalsEnabled(project.folderPath) : false;
}

/**
 * Answers one request from a project's bridge. The HTTP layer has already checked the token, so
 * this only decides what the project may do. Nothing here saves a command: a suggestion waits.
 */
export async function handleRunCommandsRequest(body: unknown): Promise<RunCommandsResponse> {
  const request = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const projectId = typeof request.projectId === 'string' ? request.projectId : '';
  const project = projectId ? await findProject(projectId) : undefined;
  if (!project) return failure(404, 'Runova does not know this project.');
  if (!(await mayPropose(project))) {
    return failure(
      403,
      'Run suggestions are off for this project. Turn them on in its MCP section.',
    );
  }
  if (request.action === 'list') {
    const commands = configuredRunCommands(project).map(({ label, command }) => ({
      label,
      command,
    }));
    return { status: 200, payload: { ok: true, commands } };
  }
  if (request.action === 'propose') return proposeRunCommand(project, request);
  return failure(400, 'Unknown action.');
}

async function proposeRunCommand(
  project: Project,
  request: Record<string, unknown>,
): Promise<RunCommandsResponse> {
  const checked = validateRunProposal(
    { label: request.label, command: request.command },
    project.runCommands,
  );
  if (!checked.ok) return failure(400, checked.error);

  const waiting = listPendingRunProposals().filter((item) => item.projectId === project.id);
  if (waiting.some((item) => item.command === checked.command)) {
    return failure(409, 'Runova is already waiting for your approval of that command.');
  }
  if (waiting.length >= MAX_WAITING_PER_PROJECT) {
    return failure(429, 'Too many suggestions are waiting. Review them in Runova first.');
  }

  const proposal: RunProposal = {
    id: randomUUID(),
    projectId: project.id,
    projectName: project.name,
    label: checked.label,
    command: checked.command,
    proposedAt: new Date().toISOString(),
  };
  pending.set(proposal.id, proposal);
  announce();

  const named = proposal.label ? `"${proposal.label}"` : 'the command';
  return {
    status: 200,
    payload: {
      ok: true,
      id: proposal.id,
      message: `Suggested ${named} for ${project.name}. It waits for the user to approve it in Runova. Nothing runs until they approve it and press Run.`,
    },
  };
}

/** Adds an approved suggestion to its project. Returns the reason it could not be added, if any. */
async function addRunCommand(
  proposal: RunProposal,
): Promise<{ runCommand: ProjectRunCommand } | { error: string }> {
  const projects = await store.getProjects();
  const index = projects.findIndex((project) => project.id === proposal.projectId);
  if (index === -1) return { error: 'That project no longer exists.' };
  const project = projects[index];
  // Checked again: the project may have gained the same command since the suggestion was made.
  const checked = validateRunProposal(
    { label: proposal.label, command: proposal.command },
    project.runCommands,
  );
  if (!checked.ok) return { error: checked.error };
  const runCommand: ProjectRunCommand = {
    id: randomUUID(),
    label: checked.label,
    command: checked.command,
  };
  projects[index] = {
    ...project,
    runCommands: normalizeProjectRunCommands({
      runCommands: [...project.runCommands, runCommand],
    }),
    updatedAt: new Date().toISOString(),
  };
  await store.setProjects(projects);
  return { runCommand };
}

export async function decideRunProposal(
  id: string,
  decision: RunProposalDecision,
): Promise<RunProposalDecisionResult> {
  const proposal = pending.get(id);
  if (!proposal) return { ok: false, error: 'That suggestion is no longer waiting.' };
  pending.delete(id);
  const added = decision === 'add' ? await addRunCommand(proposal) : null;
  announce();
  if (added && 'error' in added) return { ok: false, error: added.error };
  return added
    ? { ok: true, projectId: proposal.projectId, runCommand: added.runCommand }
    : { ok: true, projectId: proposal.projectId };
}

/**
 * Switches the feature on or off for one project. Switching off also drops that project's waiting
 * suggestions, so nothing can be approved after the user has turned the feature off.
 */
export async function setRunProposalsEnabled(
  projectId: string,
  enabled: boolean,
  portFile: string,
): Promise<RunProposalResult> {
  const project = await findProject(projectId);
  if (!project) return { ok: false, error: 'Runova does not know this project.' };
  try {
    if (enabled) {
      await enableRunProposals(project.folderPath, bridgeScriptSource({ portFile, projectId }));
    } else {
      await disableRunProposals(project.folderPath);
      for (const item of listPendingRunProposals()) {
        if (item.projectId === projectId) pending.delete(item.id);
      }
      announce();
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : 'Could not change run suggestions for this project.',
    };
  }
}
