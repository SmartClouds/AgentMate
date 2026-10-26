import type { GitChangeEntry, Project } from '@runova/core';
import type { GitDiffSide } from '@shared/apiTypes';
import { FileCode, Minus, Plus, Sparkles, Spinner, Trash2, Undo } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { changeStatusMeta, splitGitPath } from '@/lib/git';
import { cn } from '@/lib/utils';
import { GitFileMenu } from './GitFileMenu';
import { StatusLetter } from './StatusLetter';

export interface GitFileRowProps {
  project: Project;
  /** Where the project sits inside the repository, for turning repo paths into disk paths. */
  projectPrefix: string;
  entry: GitChangeEntry;
  side: GitDiffSide;
  selected: boolean;
  focusable: boolean;
  onFocusRow: () => void;
  onOpen: (pin: boolean) => void;
  onStage?: () => void;
  onUnstage?: () => void;
  onDiscard?: () => void;
  onResolve?: (pick: 'ours' | 'theirs') => void;
  /** Starts an AI CLI on the conflict markers, or stops the one already on them. */
  onResolveWithAi?: () => void;
  aiResolving?: boolean;
  onOpenFile: () => void;
}

function RowAction({
  label,
  onClick,
  children,
  tone = 'default',
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  tone?: 'default' | 'danger';
}): React.JSX.Element {
  return (
    <SimpleTooltip label={label} delayDuration={400}>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={label}
        tabIndex={-1}
        onClick={(event) => {
          event.stopPropagation();
          onClick();
        }}
        onDoubleClick={(event) => event.stopPropagation()}
        // A touch smaller than the panel's icon buttons, so a row of them fits a 28px row.
        className={cn(
          'h-5 w-5 [&_svg]:size-2.5',
          tone === 'danger' && 'hover:bg-destructive/10 hover:text-destructive',
        )}
      >
        {children}
      </Button>
    </SimpleTooltip>
  );
}

/** Moves focus to the next or previous row in the panel, wrapping at neither end. */
function focusSibling(current: HTMLElement, step: 1 | -1): void {
  const rows = Array.from(
    current.closest('[data-git-panel]')?.querySelectorAll<HTMLElement>('[data-git-row]') ?? [],
  );
  const next = rows[rows.indexOf(current) + step];
  next?.focus();
}

export function GitFileRow({
  project,
  projectPrefix,
  entry,
  side,
  selected,
  focusable,
  onFocusRow,
  onOpen,
  onStage,
  onUnstage,
  onDiscard,
  onResolve,
  onResolveWithAi,
  aiResolving = false,
  onOpenFile,
}: GitFileRowProps): React.JSX.Element {
  const { dir, name } = splitGitPath(entry.path);
  const meta = changeStatusMeta(entry.status);
  const deleted = entry.status === 'D';
  const hasCounts = !entry.binary && ((entry.additions ?? 0) > 0 || (entry.deletions ?? 0) > 0);
  const description = [
    entry.origPath ? `${entry.origPath} renamed to ${entry.path}` : entry.path,
    entry.conflict ? `${meta.label} (${entry.conflict})` : meta.label,
    entry.binary ? 'binary file' : null,
    aiResolving ? 'resolving with AI' : null,
  ]
    .filter(Boolean)
    .join(', ');

  // No hover tooltip on the row itself: the row is full of action buttons with their own,
  // and two stacked bubbles read as noise. Only the folder part, which truncates from the
  // left, gets one with the full path.
  return (
    <ContextMenu modal={false}>
      <ContextMenuTrigger asChild>
        <div
          role="option"
          aria-selected={selected}
          aria-label={description}
          tabIndex={focusable ? 0 : -1}
          data-git-row
          onFocus={onFocusRow}
          onClick={() => onOpen(false)}
          onDoubleClick={() => onOpen(true)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              focusSibling(event.currentTarget, event.key === 'ArrowDown' ? 1 : -1);
            } else if (event.key === 'Enter') {
              event.preventDefault();
              onOpen(true);
            } else if (event.key === ' ') {
              event.preventDefault();
              (onStage ?? onUnstage)?.();
            } else if (event.key === 'Delete' && onDiscard) {
              event.preventDefault();
              onDiscard();
            }
          }}
          className={cn(
            'group/row relative mx-1.5 flex h-7 cursor-pointer select-none items-center gap-2 rounded-lg pl-6 pr-1.5 text-[13px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/60',
            selected
              ? 'bg-primary/12 font-medium text-primary'
              : 'text-foreground/85 hover:bg-foreground/[0.06] hover:text-foreground',
            aiResolving && 'shimmer',
          )}
        >
          {selected ? (
            <span
              aria-hidden
              className="absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-full bg-primary shadow-[0_0_8px_hsl(var(--primary)/0.7)]"
            />
          ) : null}
          <span
            className={cn(
              'min-w-0 shrink truncate',
              deleted && 'text-muted-foreground line-through decoration-foreground/30',
            )}
          >
            {name}
          </span>
          {dir ? (
            <SimpleTooltip
              label={
                entry.origPath ? (
                  <>
                    <span className="block text-muted-foreground">{entry.origPath}</span>
                    <span className="block">{entry.path}</span>
                  </>
                ) : (
                  entry.path
                )
              }
              side="bottom"
              align="start"
              delayDuration={400}
              className="max-w-[min(32rem,90vw)] break-all font-mono text-[11px]"
            >
              <span
                className="min-w-0 flex-1 truncate text-left text-[11px] font-normal text-muted-foreground/80 [direction:rtl]"
                aria-hidden
              >
                <bdi>{dir.replace(/\/$/, '')}</bdi>
              </span>
            </SimpleTooltip>
          ) : (
            <span className="flex-1" />
          )}

          <span className="flex shrink-0 items-center gap-1.5 group-focus-within/row:hidden group-hover/row:hidden">
            {hasCounts ? (
              <span className="font-mono text-[10px] font-normal tabular-nums">
                {entry.additions ? <span className="text-success">+{entry.additions}</span> : null}
                {entry.additions && entry.deletions ? ' ' : null}
                {entry.deletions ? (
                  <span className="text-destructive">−{entry.deletions}</span>
                ) : null}
              </span>
            ) : null}
          </span>

          <span className="hidden shrink-0 items-center gap-0.5 group-focus-within/row:flex group-hover/row:flex">
            {onResolveWithAi && !aiResolving ? (
              <RowAction label="Resolve with AI" onClick={onResolveWithAi}>
                <Sparkles className="h-2.5 w-2.5" />
              </RowAction>
            ) : null}
            {/* Picking a side while the AI is still editing the file would race it. */}
            {onResolve && !aiResolving ? (
              <>
                <SimpleTooltip label="Keep your version" delayDuration={400}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    tabIndex={-1}
                    onClick={(event) => {
                      event.stopPropagation();
                      onResolve('ours');
                    }}
                    className="h-5 px-1.5 text-[10px] text-muted-foreground hover:bg-foreground/[0.06]"
                  >
                    Ours
                  </Button>
                </SimpleTooltip>
                <SimpleTooltip label="Keep the incoming version" delayDuration={400}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    tabIndex={-1}
                    onClick={(event) => {
                      event.stopPropagation();
                      onResolve('theirs');
                    }}
                    className="h-5 px-1.5 text-[10px] text-muted-foreground hover:bg-foreground/[0.06]"
                  >
                    Theirs
                  </Button>
                </SimpleTooltip>
              </>
            ) : null}
            {!deleted ? (
              <RowAction label="Open file" onClick={onOpenFile}>
                <FileCode className="h-2.5 w-2.5" />
              </RowAction>
            ) : null}
            {onDiscard ? (
              <RowAction
                label={side === 'untracked' ? 'Delete file' : 'Discard changes'}
                onClick={onDiscard}
                tone="danger"
              >
                {side === 'untracked' ? (
                  <Trash2 className="h-2.5 w-2.5" />
                ) : (
                  <Undo className="h-2.5 w-2.5" />
                )}
              </RowAction>
            ) : null}
            {onStage ? (
              <RowAction
                label={side === 'conflict' ? 'Mark as resolved' : 'Stage'}
                onClick={onStage}
              >
                <Plus className="h-2.5 w-2.5" />
              </RowAction>
            ) : null}
            {onUnstage ? (
              <RowAction label="Unstage" onClick={onUnstage}>
                <Minus className="h-2.5 w-2.5" />
              </RowAction>
            ) : null}
          </span>

          {/* Stays out of the hover group so the run shows, and can be stopped, at a glance. */}
          {aiResolving && onResolveWithAi ? (
            <RowAction label="Stop resolving with AI" onClick={onResolveWithAi}>
              <Spinner className="h-2.5 w-2.5 animate-spin text-primary motion-reduce:animate-none" />
            </RowAction>
          ) : null}

          <StatusLetter status={entry.status} />
        </div>
      </ContextMenuTrigger>
      <GitFileMenu
        project={project}
        projectPrefix={projectPrefix}
        entry={entry}
        side={side}
        onOpen={() => onOpen(true)}
        onOpenFile={onOpenFile}
        onStage={onStage}
        onUnstage={onUnstage}
        onDiscard={onDiscard}
        onResolveWithAi={onResolveWithAi}
        aiResolving={aiResolving}
      />
    </ContextMenu>
  );
}
