import type { GitChangeEntry, Project } from '@runova/core';
import type { GitDiffSide } from '@shared/apiTypes';
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from '@/components/ui/context-menu';
import { projectFilePath, repoFileAbsolutePath } from '@/lib/git';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { copyPaths, revealInOs, revealInTree } from './explorer/actions';
import { revealLabel } from './explorer/keys';

function Item({
  label,
  onSelect,
  disabled,
  tone,
}: {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  tone?: 'default' | 'danger';
}): React.JSX.Element {
  return (
    <ContextMenuItem onSelect={onSelect} disabled={disabled} tone={tone}>
      <span className="truncate">{label}</span>
    </ContextMenuItem>
  );
}

/** The right-click menu of a changed file: open it as a file, find it on disk, copy its path. */
export function GitFileMenu({
  project,
  projectPrefix,
  entry,
  side,
  onOpen,
  onOpenFile,
  onStage,
  onUnstage,
  onDiscard,
  onResolveWithAi,
  aiResolving,
}: {
  project: Project;
  projectPrefix: string;
  entry: GitChangeEntry;
  side: GitDiffSide;
  onOpen: () => void;
  onOpenFile: () => void;
  onStage?: () => void;
  onUnstage?: () => void;
  onDiscard?: () => void;
  onResolveWithAi?: () => void;
  aiResolving?: boolean;
}): React.JSX.Element {
  const deleted = entry.status === 'D';
  const absolute = repoFileAbsolutePath(project.folderPath, projectPrefix, entry.path);
  // The explorer and the reveal call only reach files inside the project folder.
  const inProject = projectFilePath(project.folderPath, projectPrefix, entry.path);

  function revealInPanel(path: string): void {
    useWorkspaceStore.getState().revealPanelSection('explorer');
    revealInTree(project, path);
  }

  return (
    <ContextMenuContent className="min-w-[14rem]">
      <Item label="Open Changes" onSelect={onOpen} />
      <Item label="Open File" disabled={deleted} onSelect={onOpenFile} />
      <Item
        label="Open With Default App"
        disabled={deleted}
        onSelect={() => void window.runova.shell.openPath(absolute)}
      />
      <ContextMenuSeparator />
      <Item
        label={revealLabel()}
        disabled={deleted || !inProject}
        onSelect={() => inProject && revealInOs(project, inProject)}
      />
      <Item
        label="Reveal in Explorer View"
        disabled={deleted || !inProject}
        onSelect={() => inProject && revealInPanel(inProject)}
      />
      <ContextMenuSeparator />
      <Item label="Copy Path" onSelect={() => copyPaths(project, [absolute], false)} />
      <Item
        label="Copy Relative Path"
        onSelect={() =>
          inProject
            ? copyPaths(project, [inProject], true)
            : copyPaths(project, [entry.path], false)
        }
      />
      {onStage || onUnstage || onDiscard || onResolveWithAi ? <ContextMenuSeparator /> : null}
      {onResolveWithAi ? (
        <Item
          label={aiResolving ? 'Stop Resolving with AI' : 'Resolve with AI'}
          onSelect={onResolveWithAi}
        />
      ) : null}
      {onStage ? (
        <Item label={side === 'conflict' ? 'Mark as Resolved' : 'Stage'} onSelect={onStage} />
      ) : null}
      {onUnstage ? <Item label="Unstage" onSelect={onUnstage} /> : null}
      {onDiscard ? (
        <Item
          label={side === 'untracked' ? 'Delete File' : 'Discard Changes'}
          tone="danger"
          onSelect={onDiscard}
        />
      ) : null}
    </ContextMenuContent>
  );
}
