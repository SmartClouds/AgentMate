import type { Project, WorktreeInfo } from '@runova/core';
import { ipcErrorMessage } from '@/components/projects/environments/ipcError';
import { asWorkspaceProject } from './scope';
import { mergeBlockerMessage } from './worktreeText';

/**
 * Finishing a worktree: merging its branch back into its base. Both sides are checked first and
 * each thing in the way gets a sentence that says how to clear it. A conflict never lands in the
 * main checkout; the fix offered is to bring the base into the worktree and resolve it there.
 */

interface NotifyOptions {
  description?: string;
  action?: { label: string; onClick: () => void };
}

type Notify = (title: string, options?: NotifyOptions) => void;

export interface MergeFlowDeps {
  confirm: (options: {
    title: string;
    description: string;
    confirmLabel: string;
  }) => Promise<boolean>;
  notify: { success: Notify; error: Notify; warning: Notify; info: Notify };
  openRemove: (projectId: string, worktreeId: string) => void;
  openWorkspace: (scopeId: string) => void;
  /** Shows the changes (and so the conflicts) of the workspace on screen. */
  revealChanges: () => void;
}

export type MergeOutcome = 'merged' | 'blocked' | 'cancelled' | 'conflict' | 'failed';

function names(worktree: WorktreeInfo): { branch: string; base: string } {
  return { branch: worktree.branch ?? 'this worktree', base: worktree.baseBranch ?? 'its base' };
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

export async function mergeWorktreeFlow(
  project: Project,
  worktree: WorktreeInfo,
  deps: MergeFlowDeps,
): Promise<MergeOutcome> {
  const { branch, base } = names(worktree);
  try {
    const check = await window.runova.worktrees.mergePreflight(project.id, worktree.id);
    if (!check.ok) {
      deps.notify.error('Not ready to merge', {
        description: mergeBlockerMessage(check.blocker, branch, base),
      });
      return 'blocked';
    }

    const confirmed = await deps.confirm({
      title: `Merge ${branch} into ${base}?`,
      description: `The merge happens in the main checkout at ${project.folderPath}. Nothing is pushed.`,
      confirmLabel: 'Merge',
    });
    if (!confirmed) return 'cancelled';

    const result = await window.runova.worktrees.merge(project.id, worktree.id);
    if (result.ok) {
      deps.notify.success(`Merged ${branch} into ${base}`, {
        description: result.message,
        action: {
          label: 'Remove worktree',
          onClick: () => deps.openRemove(project.id, worktree.id),
        },
      });
      return 'merged';
    }

    deps.notify.warning(`${branch} and ${base} conflict`, {
      description: `${plural(result.conflicts.length, 'file')} would conflict: ${result.conflicts.join(', ')}. Nothing was changed. Bring ${base} into this worktree and resolve them there.`,
      action: {
        label: `Merge ${base} in here`,
        onClick: () => void mergeBaseInFlow(project, worktree, deps),
      },
    });
    return 'conflict';
  } catch (error) {
    deps.notify.error('Merge failed', { description: ipcErrorMessage(error, 'Git refused.') });
    return 'failed';
  }
}

/** Merges the base into the worktree's branch, leaving any conflict there to resolve. */
export async function mergeBaseInFlow(
  project: Project,
  worktree: WorktreeInfo,
  deps: MergeFlowDeps,
): Promise<'merged' | 'conflict' | 'failed'> {
  const { branch, base } = names(worktree);
  try {
    const result = await window.runova.worktrees.mergeBaseIn(project.id, worktree.id);
    if (result.ok) {
      deps.notify.success(`Merged ${base} into ${branch}`, { description: result.message });
      return 'merged';
    }
    deps.openWorkspace(asWorkspaceProject(project, worktree).id);
    deps.revealChanges();
    deps.notify.info(`Resolve ${plural(result.conflicts.length, 'conflict')} in ${branch}`, {
      description:
        'They are listed under Conflicts. Commit once they are resolved, then merge again.',
    });
    return 'conflict';
  } catch (error) {
    deps.notify.error('Merge failed', { description: ipcErrorMessage(error, 'Git refused.') });
    return 'failed';
  }
}
