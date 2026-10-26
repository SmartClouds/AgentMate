import type { Project, WorktreeInfo } from '@runova/core';
import type { CreateWorktreeInput, CreateWorktreeResult } from '@shared/apiTypes';
import { asWorkspaceProject, type WorkspaceProject } from './scope';

/**
 * Making a worktree ready to work in, step by step, so the New worktree dialog can show each
 * one as it happens. Only creating the worktree itself can fail the whole thing: a file that
 * would not copy or an agent that did not start is reported on its step, and the worktree,
 * which is fine, still opens.
 */

export type CreateStepId = 'create' | 'copy' | 'open' | 'setup' | 'agent';
export type CreateStepStatus = 'pending' | 'running' | 'done' | 'error';

export interface CreateStep {
  id: CreateStepId;
  label: string;
  status: CreateStepStatus;
  detail?: string;
}

export interface CreateWorktreePlan {
  /** The project the worktree belongs to (its main checkout). */
  project: Project;
  input: CreateWorktreeInput;
  /** Local files, relative to the repository, to copy across. */
  copyFiles: string[];
  /** Empty runs nothing. */
  setupCommand: string;
  agent: { cliId: string; name: string; prompt: string } | null;
}

export interface CreateWorktreeDeps {
  create: (input: CreateWorktreeInput) => Promise<CreateWorktreeResult>;
  copyFiles: (projectId: string, worktreeId: string, files: string[]) => Promise<string[]>;
  /** Shows the new worktree's workspace. */
  open: (scopeId: string) => void;
  /** Starts the setup command in a tab; returns the tab id. */
  setup: (project: WorkspaceProject, command: string) => string;
  /** Starts the agent, with the task as its prompt when there is one; null when it could not. */
  launchAgent: (project: WorkspaceProject, cliId: string, prompt: string) => string | null;
}

export type CreateWorktreeOutcome =
  | { ok: true; scopeId: string; worktree: WorktreeInfo }
  | { ok: false; error: string };

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

export function plannedSteps(plan: CreateWorktreePlan): CreateStep[] {
  const steps: CreateStep[] = [{ id: 'create', label: 'Creating the worktree', status: 'pending' }];
  if (plan.copyFiles.length > 0) {
    steps.push({
      id: 'copy',
      label: `Copying ${plural(plan.copyFiles.length, 'local file')}`,
      status: 'pending',
    });
  }
  steps.push({ id: 'open', label: 'Opening its workspace', status: 'pending' });
  if (plan.setupCommand.trim())
    steps.push({ id: 'setup', label: 'Running setup', status: 'pending' });
  if (plan.agent) {
    steps.push({ id: 'agent', label: `Starting ${plan.agent.name}`, status: 'pending' });
  }
  return steps;
}

function errorText(error: unknown): string {
  return (error as Error | null)?.message || 'Something went wrong.';
}

export async function runCreateWorktree(
  plan: CreateWorktreePlan,
  onChange: (steps: CreateStep[]) => void,
  deps: CreateWorktreeDeps,
): Promise<CreateWorktreeOutcome> {
  let steps = plannedSteps(plan);
  const set = (id: CreateStepId, status: CreateStepStatus, detail?: string): void => {
    steps = steps.map((step) => (step.id === id ? { ...step, status, detail } : step));
    onChange(steps);
  };
  const has = (id: CreateStepId): boolean => steps.some((step) => step.id === id);

  set('create', 'running');
  let created: CreateWorktreeResult;
  try {
    created = await deps.create(plan.input);
  } catch (error) {
    created = { ok: false, error: errorText(error) };
  }
  if (!created.ok) {
    set('create', 'error', created.error);
    return { ok: false, error: created.error };
  }
  const { worktree } = created;
  set('create', 'done');

  if (has('copy')) {
    set('copy', 'running');
    try {
      const copied = await deps.copyFiles(plan.project.id, worktree.id, plan.copyFiles);
      set('copy', 'done', copied.length === 0 ? 'Already there, nothing copied' : undefined);
    } catch (error) {
      set('copy', 'error', errorText(error));
    }
  }

  const workspace = asWorkspaceProject(plan.project, worktree);
  set('open', 'running');
  deps.open(workspace.id);
  set('open', 'done');

  if (has('setup')) {
    set('setup', 'running');
    try {
      deps.setup(workspace, plan.setupCommand.trim());
      set('setup', 'done', 'Running in its own tab');
    } catch (error) {
      set('setup', 'error', errorText(error));
    }
  }

  if (plan.agent && has('agent')) {
    set('agent', 'running');
    const tabId = deps.launchAgent(workspace, plan.agent.cliId, plan.agent.prompt);
    if (tabId) set('agent', 'done');
    else set('agent', 'error', `${plan.agent.name} could not be started`);
  }

  return { ok: true, scopeId: workspace.id, worktree };
}
