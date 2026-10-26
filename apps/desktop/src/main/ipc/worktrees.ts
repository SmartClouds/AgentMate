import { cleanBranchSuggestion, type WorktreeInfo } from '@runova/core';
import { dialog, ipcMain } from 'electron';
import type {
  CreateWorktreeInput,
  CreateWorktreeResult,
  GitOpResult,
  RemoveWorktreeInput,
  SuggestGitTextResult,
  WorktreeDefaults,
  WorktreeMergePreflight,
  WorktreeMergeResult,
  WorktreeRemovePreflight,
} from '../../shared/apiTypes';
import { IPC } from '../../shared/ipcChannels';
import { cancelHeadlessPrompt, runHeadlessCliPrompt } from '../cli/headlessPrompt';
import { store } from '../store';
import {
  copyIntoWorktree,
  createWorktree,
  listProjectWorktrees,
  mergeBaseIntoProjectWorktree,
  mergeWorktree,
  previewCopy,
  pruneProjectWorktrees,
  removePreflight,
  removeProjectWorktree,
  suggestWorktreePath,
  worktreeDefaults,
  worktreeMergePreflight,
} from '../worktrees/service';

function errorMessage(error: unknown): string {
  return (error as Error | null)?.message?.trim() || 'Something went wrong.';
}

export function registerWorktreeHandlers(): void {
  ipcMain.handle(
    IPC.worktrees.list,
    (_event, projectId: string): Promise<WorktreeInfo[]> => listProjectWorktrees(projectId),
  );

  ipcMain.handle(
    IPC.worktrees.defaults,
    (_event, projectId: string): Promise<WorktreeDefaults> => worktreeDefaults(projectId),
  );

  ipcMain.handle(
    IPC.worktrees.suggestPath,
    (_event, projectId: string, branch: string): Promise<string> =>
      suggestWorktreePath(projectId, branch),
  );

  ipcMain.handle(
    IPC.worktrees.create,
    async (_event, input: CreateWorktreeInput): Promise<CreateWorktreeResult> => {
      try {
        return { ok: true, worktree: await createWorktree(input) };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  );

  ipcMain.handle(
    IPC.worktrees.previewCopy,
    (_event, projectId: string, globs: string[] | null): Promise<string[]> =>
      previewCopy(projectId, globs),
  );

  ipcMain.handle(
    IPC.worktrees.copyFiles,
    (_event, projectId: string, worktreeId: string, files: string[]): Promise<string[]> =>
      copyIntoWorktree(projectId, worktreeId, files),
  );

  ipcMain.handle(
    IPC.worktrees.removePreflight,
    (_event, projectId: string, worktreeId: string): Promise<WorktreeRemovePreflight> =>
      removePreflight(projectId, worktreeId),
  );

  ipcMain.handle(
    IPC.worktrees.remove,
    async (_event, input: RemoveWorktreeInput): Promise<GitOpResult> => {
      try {
        return { ok: true, message: await removeProjectWorktree(input) };
      } catch (error) {
        return { ok: false, message: errorMessage(error) };
      }
    },
  );

  ipcMain.handle(
    IPC.worktrees.mergePreflight,
    (_event, projectId: string, worktreeId: string): Promise<WorktreeMergePreflight> =>
      worktreeMergePreflight(projectId, worktreeId),
  );

  ipcMain.handle(
    IPC.worktrees.merge,
    (_event, projectId: string, worktreeId: string): Promise<WorktreeMergeResult> =>
      mergeWorktree(projectId, worktreeId),
  );

  ipcMain.handle(
    IPC.worktrees.mergeBaseIn,
    (_event, projectId: string, worktreeId: string): Promise<WorktreeMergeResult> =>
      mergeBaseIntoProjectWorktree(projectId, worktreeId),
  );

  ipcMain.handle(IPC.worktrees.prune, async (_event, projectId: string): Promise<GitOpResult> => {
    try {
      await pruneProjectWorktrees(projectId);
      return { ok: true, message: 'Cleared worktrees whose folders are gone.' };
    } catch (error) {
      return { ok: false, message: errorMessage(error) };
    }
  });

  ipcMain.handle(
    IPC.worktrees.suggestBranch,
    async (
      _event,
      projectId: string,
      task: string,
      requestId?: string,
    ): Promise<SuggestGitTextResult> => {
      const project = (await store.getProjects()).find((p) => p.id === projectId);
      if (!project) return { ok: false, error: 'That project no longer exists.' };
      const result = await runHeadlessCliPrompt(
        'Generate a single short git branch name (kebab-case with a type prefix, e.g. ' +
          '"feat/add-login" or "fix/null-check", max 60 characters, no spaces, no quotes, no ' +
          'markdown) for the task below. Do not read or edit any files. ' +
          `Reply with ONLY the branch name and nothing else.\n\nTask:\n${task.slice(0, 4000)}`,
        project.folderPath,
        { requestId, preferredCliId: project.cliId },
      );
      if (!result.ok) {
        return {
          ok: false,
          error: result.error,
          cliName: result.cliName,
          cancelled: result.cancelled,
        };
      }
      const text = cleanBranchSuggestion(result.text);
      return text
        ? { ok: true, text, cliName: result.cliName }
        : { ok: false, error: 'The answer was not a usable branch name.', cliName: result.cliName };
    },
  );

  ipcMain.handle(IPC.worktrees.cancelSuggestBranch, (_event, requestId: string): boolean =>
    cancelHeadlessPrompt(requestId),
  );

  ipcMain.handle(
    IPC.worktrees.pickLocation,
    async (_event, defaultPath: string | null): Promise<string | null> => {
      const result = await dialog.showOpenDialog({
        properties: ['openDirectory', 'createDirectory'],
        defaultPath: defaultPath ?? undefined,
      });
      if (result.canceled || result.filePaths.length === 0) return null;
      return result.filePaths[0] ?? null;
    },
  );
}
