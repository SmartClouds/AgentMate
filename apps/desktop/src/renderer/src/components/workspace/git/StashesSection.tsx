import type { Project } from '@runova/core';
import type { GitStashEntry, WorkspaceGitState } from '@shared/apiTypes';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Archive, Copy, Trash2, Undo } from '@/components/icons';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { confirmDialog } from '@/stores/confirmStore';
import { type GitActions, useGitActions } from './useWorkspaceGit';

/** A project's `git stash list`, newest first. Quiet until the Stashes section is opened. */
export function useStashes(projectId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.gitStashList(projectId),
    queryFn: () => window.runova.git.stashList(projectId),
    enabled,
    meta: { silentLoading: true },
    placeholderData: (previous) => previous,
  });
}

/**
 * The stash overflow menu for the Changes header, shaped like VS Code's: stash everything
 * (untracked files included), or stash everything but keep the staged changes in place.
 */
export function StashMenu({
  project,
  state,
  actions,
}: {
  project: Project;
  state: WorkspaceGitState;
  actions: GitActions;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const stashes = useStashes(project.id, true).data ?? [];
  const total =
    state.staged.length + state.unstaged.length + state.untracked.length + state.conflicts.length;
  const blocked = state.conflicts.length > 0 || state.operation !== null;
  const canStash = total > 0 && !blocked && !busy;

  async function stash(mode: 'all' | 'keep-staged'): Promise<void> {
    if (!canStash) return;
    setBusy(true);
    try {
      await actions.stash(mode);
    } finally {
      setBusy(false);
    }
  }

  // Busy covers the pop too. Otherwise a second pop started before the list refreshes reuses
  // the same ref, and once the first pop has dropped it, that ref points at the next stash.
  async function popLatest(): Promise<void> {
    const latest = stashes[0]?.ref;
    if (!latest || busy) return;
    setBusy(true);
    try {
      await actions.stashRestore('pop', latest);
      void queryClient.invalidateQueries({ queryKey: queryKeys.gitWorkspaceState(project.id) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <DropdownMenu modal={false}>
      <SimpleTooltip label="Stash changes…">
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Stash changes…"
            className="data-[state=open]:bg-foreground/[0.06]"
          >
            <Archive className="h-2.5 w-2.5" />
          </Button>
        </DropdownMenuTrigger>
      </SimpleTooltip>
      <DropdownMenuContent align="end" collisionPadding={8} className="w-[19rem]">
        <DropdownMenuItem
          disabled={!canStash}
          onSelect={() => void stash('all')}
          className="group items-start py-2"
        >
          <span className="mt-px flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-foreground/[0.05] text-muted-foreground transition-colors group-focus:bg-foreground/[0.08] group-focus:text-foreground">
            <Archive className="h-3.5 w-3.5" />
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-[13px] font-medium leading-5">
              Stash All (--include-untracked)
            </span>
            <span className="text-[11px] leading-snug text-muted-foreground">
              {blocked
                ? 'Resolve the conflicts first'
                : total === 0
                  ? 'There are no changes to stash'
                  : 'Stash every change, untracked files included'}
            </span>
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!canStash || state.staged.length === 0}
          onSelect={() => void stash('keep-staged')}
          className="group items-start py-2"
        >
          <span className="mt-px flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-foreground/[0.05] text-muted-foreground transition-colors group-focus:bg-foreground/[0.08] group-focus:text-foreground">
            <Archive className="h-3.5 w-3.5" />
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-[13px] font-medium leading-5">
              Stash All and Keep Staged (--keep-index)
            </span>
            <span className="text-[11px] leading-snug text-muted-foreground">
              {state.staged.length === 0
                ? 'Stage something first, or use Stash All'
                : 'Stash everything but leave the staged changes in place'}
            </span>
          </span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={stashes.length === 0 || blocked || busy}
          onSelect={() => void popLatest()}
        >
          <Undo className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-[13px] font-medium leading-5">Pop Latest Stash</span>
            <span className="truncate text-[11px] leading-snug text-muted-foreground">
              {stashes.length === 0 ? 'Nothing stashed' : (stashes[0]?.message ?? stashes[0]?.ref)}
            </span>
          </span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function StashRow({
  project,
  stash,
  actions,
  busy,
  onBusyChange,
}: {
  project: Project;
  stash: GitStashEntry;
  actions: GitActions;
  busy: string | null;
  onBusyChange: (ref: string | null) => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const running = busy === stash.ref;

  async function run(fn: () => Promise<void>): Promise<void> {
    if (busy) return;
    onBusyChange(stash.ref);
    try {
      await fn();
      void queryClient.invalidateQueries({
        queryKey: queryKeys.gitWorkspaceState(project.id),
      });
    } finally {
      onBusyChange(null);
    }
  }

  return (
    <div className="group/stash mx-1.5 flex w-[calc(100%-0.75rem)] items-center gap-1 rounded-lg px-2 py-1.5 transition-colors hover:bg-foreground/[0.06]">
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-foreground/[0.05] text-muted-foreground">
        <Archive className="h-2.5 w-2.5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12px] font-medium">{stash.message}</span>
        <span className="block font-mono text-[10px] text-muted-foreground">{stash.ref}</span>
      </span>
      <span
        className={cn(
          'flex shrink-0 items-center gap-0.5',
          !running && 'opacity-0 transition-opacity group-hover/stash:opacity-100',
        )}
      >
        <SimpleTooltip label={`Pop ${stash.ref}: restore it and drop the stash`}>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={`Pop ${stash.ref}`}
            disabled={busy !== null}
            onClick={() => void run(() => actions.stashRestore('pop', stash.ref))}
          >
            <Undo className="h-2.5 w-2.5" />
          </Button>
        </SimpleTooltip>
        <SimpleTooltip label={`Apply ${stash.ref}: restore it but keep the stash`}>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={`Apply ${stash.ref}`}
            disabled={busy !== null}
            onClick={() => void run(() => actions.stashRestore('apply', stash.ref))}
          >
            <Copy className="h-2.5 w-2.5" />
          </Button>
        </SimpleTooltip>
        <SimpleTooltip label={`Drop ${stash.ref} without restoring it`}>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={`Drop ${stash.ref}`}
            disabled={busy !== null}
            onClick={() =>
              void (async () => {
                const ok = await confirmDialog({
                  title: `Drop ${stash.ref}?`,
                  description: stash.message,
                  confirmLabel: 'Drop stash',
                  variant: 'destructive',
                });
                if (ok) void run(() => actions.stashDrop(stash.ref));
              })()
            }
          >
            <Trash2 className="h-2.5 w-2.5" />
          </Button>
        </SimpleTooltip>
      </span>
    </div>
  );
}

/** Every stash, newest first, with pop/apply/drop. Only fetched while the section is open. */
export function StashesSection({ project }: { project: Project }): React.JSX.Element {
  const actions = useGitActions(project.id);
  const stashes = useStashes(project.id, true);
  const [busy, setBusy] = useState<string | null>(null);

  if (stashes.isPending) {
    return (
      <div className="space-y-1 px-2 py-1.5">
        {Array.from({ length: 3 }, (_, i) => (
          <Skeleton key={i} className="h-10 rounded-lg" style={{ width: `${96 - i * 8}%` }} />
        ))}
      </div>
    );
  }
  if (stashes.isError) {
    return (
      <div className="p-3 text-xs text-muted-foreground">
        Could not read the stashes.{' '}
        <button
          type="button"
          className="cursor-pointer underline underline-offset-2"
          onClick={() => void stashes.refetch()}
        >
          Try again
        </button>
      </div>
    );
  }
  const entries = stashes.data ?? [];
  if (entries.length === 0) {
    return (
      <p className="p-3 text-xs text-muted-foreground">
        No stashes. Stashed changes show up here so they can be popped back.
      </p>
    );
  }
  return (
    <div className="min-h-0 flex-1 space-y-px overflow-y-auto py-1">
      {entries.map((stash) => (
        <StashRow
          key={stash.ref}
          project={project}
          stash={stash}
          actions={actions}
          busy={busy}
          onBusyChange={setBusy}
        />
      ))}
    </div>
  );
}
