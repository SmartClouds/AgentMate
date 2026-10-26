import { baseName, getCliDefinition, type Project, splitExtension } from '@runova/core';
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from '@/components/ui/context-menu';
import { patchExplorer, useExplorerStore } from '@/stores/explorerStore';
import {
  addToGitignore,
  agentChatTarget,
  collapseAll,
  copyPaths,
  copyToClipboard,
  deleteEntries,
  openInTerminal,
  openToSide,
  pasteInto,
  projectRoot,
  revealInOs,
  sendPathsToAgent,
  startCreate,
  targetFolder,
} from './actions';
import { type ExplorerCommand, explorerShortcutLabel, revealLabel } from './keys';

/** What was right-clicked: a row, or the empty space below the rows (the project root). */
export interface ExplorerMenuTarget {
  path: string | null;
  isDirectory: boolean;
}

function Item({
  label,
  command,
  onSelect,
  disabled,
  tone,
}: {
  label: string;
  command?: ExplorerCommand;
  onSelect: () => void;
  disabled?: boolean;
  tone?: 'default' | 'danger';
}): React.JSX.Element {
  return (
    <ContextMenuItem onSelect={onSelect} disabled={disabled} tone={tone}>
      <span className="truncate">{label}</span>
      {command ? <ContextMenuShortcut>{explorerShortcutLabel(command)}</ContextMenuShortcut> : null}
    </ContextMenuItem>
  );
}

export function ExplorerMenu({
  project,
  target,
  isRepo,
}: {
  project: Project;
  target: ExplorerMenuTarget;
  isRepo: boolean;
}): React.JSX.Element {
  const selected = useExplorerStore((s) => s.projects[project.id]?.selected);
  const root = projectRoot(project);
  const path = target.path;
  const isRoot = path === null || path === root;
  const paths =
    path && selected?.includes(path) && selected.length > 1 ? selected : path ? [path] : [root];
  const multi = paths.length > 1;
  const folder = targetFolder(project, path, target.isDirectory);
  const extension = path && !target.isDirectory ? splitExtension(baseName(path)).ext : '';

  // Radix restores focus to the tree after an item runs; the rename box has to open after that.
  const later = (fn: () => void) => () => {
    setTimeout(fn, 0);
  };

  const agent = agentChatTarget(project);
  const agentLabel = agent ? getCliDefinition(agent.cliId)?.label : undefined;
  const addToChatLabel = !agentLabel
    ? 'Add to Agent Chat'
    : agent?.running
      ? `Add to ${agentLabel}`
      : `Add to New ${agentLabel} Tab`;

  const rename = later(() => {
    if (!path || isRoot) return;
    patchExplorer(project.id, {
      editing: { kind: 'rename', path, isDirectory: target.isDirectory },
    });
  });

  return (
    <ContextMenuContent
      className="min-w-[15rem]"
      onCloseAutoFocus={(event) => event.preventDefault()}
    >
      {!isRoot ? (
        <>
          <Item
            label={addToChatLabel}
            command="addToChat"
            onSelect={later(() => sendPathsToAgent(project, paths))}
          />
          <ContextMenuSeparator />
        </>
      ) : null}

      {!multi && (target.isDirectory || isRoot) ? (
        <>
          <Item label="New File…" onSelect={later(() => startCreate(project, 'newFile', folder))} />
          <Item
            label="New Folder…"
            onSelect={later(() => startCreate(project, 'newFolder', folder))}
          />
          <ContextMenuSeparator />
        </>
      ) : null}

      {!multi && path && !target.isDirectory ? (
        <>
          <Item label="Open to the Side" onSelect={() => openToSide(project, path)} />
          <Item
            label="Open With Default App"
            onSelect={() => void window.runova.shell.openPath(path)}
          />
        </>
      ) : null}
      {!multi ? (
        <>
          <Item
            label={revealLabel()}
            command="reveal"
            onSelect={() => revealInOs(project, path ?? root)}
          />
          <Item
            label="Open in Integrated Terminal"
            onSelect={() => openInTerminal(project, path ?? root, target.isDirectory || isRoot)}
          />
          <ContextMenuSeparator />
        </>
      ) : null}

      {!isRoot ? (
        <>
          <Item label="Cut" command="cut" onSelect={() => copyToClipboard(project, paths, 'cut')} />
          <Item
            label="Copy"
            command="copy"
            onSelect={() => copyToClipboard(project, paths, 'copy')}
          />
        </>
      ) : null}
      {!multi ? (
        <Item label="Paste" command="paste" onSelect={() => void pasteInto(project, folder)} />
      ) : null}
      <ContextMenuSeparator />

      <Item
        label="Copy Path"
        command="copyPath"
        onSelect={() => copyPaths(project, paths, false)}
      />
      <Item
        label="Copy Relative Path"
        command="copyRelativePath"
        onSelect={() => copyPaths(project, paths, true)}
      />

      {isRepo && !isRoot ? (
        <>
          <ContextMenuSeparator />
          {multi || target.isDirectory ? (
            <Item
              label="Add to .gitignore"
              onSelect={() => void addToGitignore(project, paths, 'path')}
            />
          ) : (
            <ContextMenuSub>
              <ContextMenuSubTrigger>Add to .gitignore</ContextMenuSubTrigger>
              <ContextMenuSubContent className="min-w-[11rem]">
                <Item
                  label="This file"
                  onSelect={() => void addToGitignore(project, paths, 'path')}
                />
                <Item
                  label={extension ? `All *${extension} files` : 'All files with this extension'}
                  disabled={!extension}
                  onSelect={() => void addToGitignore(project, paths, 'extension')}
                />
              </ContextMenuSubContent>
            </ContextMenuSub>
          )}
        </>
      ) : null}

      <ContextMenuSeparator />
      {isRoot ? (
        <Item label="Collapse Folders" onSelect={() => collapseAll(project.id)} />
      ) : (
        <>
          {!multi ? <Item label="Rename…" command="rename" onSelect={rename} /> : null}
          <Item
            label="Delete"
            command="delete"
            tone="danger"
            onSelect={later(() => void deleteEntries(project, paths, { permanent: false }))}
          />
        </>
      )}
    </ContextMenuContent>
  );
}
