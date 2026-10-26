import { isSameOrInside, type Project } from '@runova/core';
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from '@/components/ui/context-menu';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { copyPaths, projectRoot, revealInOs, revealInTree } from './git/explorer/actions';
import { revealLabel } from './git/explorer/keys';

/** The right-click menu of an open file's tab: find the file on disk or in the tree, copy its path. */
export function FileTabMenu({
  project,
  path,
  onClose,
}: {
  project: Project;
  /** Absolute path on disk. */
  path: string;
  onClose: () => void;
}): React.JSX.Element {
  // The reveal call and the explorer only reach files inside the project folder.
  const inProject = isSameOrInside(path, projectRoot(project));

  return (
    <ContextMenuContent className="min-w-[14rem]">
      <ContextMenuItem disabled={!inProject} onSelect={() => revealInOs(project, path)}>
        {revealLabel()}
      </ContextMenuItem>
      <ContextMenuItem
        disabled={!inProject}
        onSelect={() => {
          useWorkspaceStore.getState().revealPanelSection('explorer');
          revealInTree(project, path);
        }}
      >
        Reveal in Explorer View
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => copyPaths(project, [path], false)}>
        Copy Path
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => copyPaths(project, [path], true)}>
        Copy Relative Path
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem tone="danger" onSelect={onClose}>
        Close
      </ContextMenuItem>
    </ContextMenuContent>
  );
}
