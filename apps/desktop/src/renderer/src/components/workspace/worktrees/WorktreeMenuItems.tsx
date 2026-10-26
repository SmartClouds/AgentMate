import type { Project, WorktreeInfo } from '@runova/core';
import type { ComponentType, ReactNode } from 'react';
import {
  Copy,
  FolderOpen,
  GitMerge,
  GitPullRequest,
  Robot,
  TerminalSquare,
  Trash2,
  Workspace,
} from '@/components/icons';
import type { WorktreeCommands } from './useWorktreeCommands';

interface ItemProps {
  onSelect?: (event: Event) => void;
  disabled?: boolean;
  className?: string;
  tone?: 'default' | 'danger';
  children?: ReactNode;
}

/**
 * The actions for one worktree, for either a context menu or a dropdown: pass that menu's own
 * item and separator. The destructive one sits last, after a separator, so it is never the item
 * a stray click lands on.
 */
export function WorktreeMenuItems({
  project,
  worktree,
  commands,
  Item,
  Separator,
  showOpen = true,
}: {
  project: Project;
  worktree: WorktreeInfo;
  commands: WorktreeCommands;
  Item: ComponentType<ItemProps>;
  Separator: ComponentType;
  showOpen?: boolean;
}): React.JSX.Element {
  const hasBranch = Boolean(worktree.branch);
  return (
    <>
      {showOpen ? (
        <Item onSelect={() => commands.open(project, worktree)} disabled={worktree.missing}>
          <Workspace className="h-3.5 w-3.5" />
          Open workspace
        </Item>
      ) : null}
      <Item onSelect={() => commands.newAgent(project, worktree)} disabled={worktree.missing}>
        <Robot className="h-3.5 w-3.5" />
        New agent here
      </Item>
      <Item onSelect={() => commands.newShell(project, worktree)} disabled={worktree.missing}>
        <TerminalSquare className="h-3.5 w-3.5" />
        New terminal here
      </Item>
      <Separator />
      <Item
        onSelect={() => commands.merge(project, worktree)}
        disabled={worktree.missing || !hasBranch}
      >
        <GitMerge className="h-3.5 w-3.5" />
        Merge into {worktree.baseBranch ?? 'base'}
      </Item>
      <Item
        onSelect={() => commands.pullRequest(project, worktree)}
        disabled={worktree.missing || !hasBranch}
      >
        <GitPullRequest className="h-3.5 w-3.5" />
        Create pull request
      </Item>
      <Separator />
      <Item onSelect={() => commands.reveal(project, worktree)} disabled={worktree.missing}>
        <FolderOpen className="h-3.5 w-3.5" />
        Reveal in folder
      </Item>
      <Item onSelect={() => commands.copyPath(worktree)}>
        <Copy className="h-3.5 w-3.5" />
        Copy path
      </Item>
      <Separator />
      <Item onSelect={() => commands.remove(project, worktree)} tone="danger">
        <Trash2 className="h-3.5 w-3.5" />
        Remove worktree…
      </Item>
    </>
  );
}
