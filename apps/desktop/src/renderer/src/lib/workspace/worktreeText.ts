import type { WorktreeStatus } from '@runova/core';
import type { WorktreeMergeBlocker, WorktreeRemovePreflight } from '@shared/apiTypes';

/** The sentences the worktree UI shows, kept here so they read the same everywhere. */

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

export function mergeBlockerMessage(
  blocker: WorktreeMergeBlocker,
  branch: string,
  base: string,
): string {
  switch (blocker.kind) {
    case 'worktree-dirty':
      return `Commit or discard the ${plural(blocker.changes, 'change')} in this worktree first.`;
    case 'main-dirty':
      return `The main checkout has ${plural(blocker.changes, 'uncommitted change')}. Commit or stash them there first.`;
    case 'main-not-on-base':
      return blocker.current
        ? `The main checkout is on ${blocker.current}, not ${base}. Switch it to ${base} first.`
        : `The main checkout is not on a branch. Switch it to ${base} first.`;
    case 'nothing-to-merge':
      return `Nothing to merge: ${base} already has everything on ${branch}.`;
  }
}

export interface StatusBadge {
  kind: 'changes' | 'ahead' | 'behind';
  text: string;
}

/** Short badges for a worktree row: uncommitted changes, then commits ahead of and behind its base. */
export function statusSummary(status: WorktreeStatus): StatusBadge[] {
  const badges: StatusBadge[] = [];
  if (status.changes > 0) badges.push({ kind: 'changes', text: plural(status.changes, 'change') });
  if (status.ahead > 0) badges.push({ kind: 'ahead', text: `↑${status.ahead}` });
  if (status.behind > 0) badges.push({ kind: 'behind', text: `↓${status.behind}` });
  return badges;
}

export interface RemoveWarning {
  tone: 'danger' | 'warning' | 'info';
  text: string;
}

/** What removing a worktree would cost, the worst first, for the Remove dialog. */
export function removeWarnings(
  preflight: WorktreeRemovePreflight,
  open: { terminals: number; working: number },
): RemoveWarning[] {
  const warnings: RemoveWarning[] = [];
  if (preflight.missing) {
    warnings.push({
      tone: 'info',
      text: 'Its folder is already gone, so this only tidies up git.',
    });
  }
  if (preflight.changes > 0) {
    warnings.push({
      tone: 'danger',
      text: `${plural(preflight.changes, 'uncommitted change')} will be lost.`,
    });
  }
  if (!preflight.merged && preflight.ahead > 0) {
    const commits = plural(preflight.ahead, 'commit');
    const base = preflight.baseBranch ?? 'its base';
    const verb = preflight.ahead === 1 ? 'is' : 'are';
    warnings.push(
      preflight.unpushed === 0
        ? { tone: 'info', text: `${commits} ${verb} not merged into ${base}, but they are pushed.` }
        : { tone: 'warning', text: `${commits} ${verb} not merged into ${base} or pushed.` },
    );
  }
  if (open.terminals > 0) {
    const still =
      open.working > 0
        ? ` (${plural(open.working, 'agent')} ${open.working === 1 ? 'is' : 'are'} still working)`
        : '';
    warnings.push({
      tone: 'info',
      text: `${plural(open.terminals, 'terminal')} will be stopped${still}.`,
    });
  }
  return warnings;
}
