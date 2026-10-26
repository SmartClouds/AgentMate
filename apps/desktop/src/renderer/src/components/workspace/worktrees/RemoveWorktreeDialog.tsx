import type { Project, WorktreeInfo } from '@runova/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { useShallow } from 'zustand/react/shallow';
import { CircleCheck, CircleInfo, Spinner, Trash2, TriangleAlert } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { queryKeys } from '@/lib/queryKeys';
import { useTerminalSessionStore } from '@/lib/terminal/terminalRuntime';
import { cn } from '@/lib/utils';
import { asWorkspaceProject, worktreeLabel } from '@/lib/workspace/scope';
import { type RemoveWarning, removeWarnings } from '@/lib/workspace/worktreeText';
import { useAgentStatusStore } from '@/stores/agentStatusStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';

/** Open shells in a workspace, and how many of them have an agent in the middle of something. */
export function useWorkspaceActivity(scopeId: string): { terminals: number; working: number } {
  const ended = useTerminalSessionStore((s) => s.ended);
  const tabIds = useWorkspaceStore(
    useShallow((s) =>
      Object.values(s.workspaces[scopeId]?.tabs ?? {})
        .filter((tab) => tab.kind === 'terminal')
        .map((tab) => tab.id),
    ),
  );
  const open = tabIds.filter((id) => !(id in ended));
  const working = useAgentStatusStore(
    (s) => open.filter((id) => s.statuses[id] === 'working').length,
  );
  return { terminals: open.length, working };
}

const TONE_STYLES: Record<RemoveWarning['tone'], string> = {
  danger: 'ring-1 ring-inset ring-destructive/30 bg-destructive/10 text-destructive',
  warning: 'ring-1 ring-inset ring-warning/30 bg-warning/10 text-warning',
  info: 'ring-1 ring-inset ring-foreground/[0.08] bg-foreground/[0.04] text-foreground',
};

function Warning({ warning }: { warning: RemoveWarning }): React.JSX.Element {
  const Icon = warning.tone === 'info' ? CircleInfo : TriangleAlert;
  return (
    <li
      className={cn(
        'flex items-start gap-2.5 rounded-xl px-3 py-2 text-sm',
        TONE_STYLES[warning.tone],
      )}
    >
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>{warning.text}</span>
    </li>
  );
}

/**
 * Remove worktree. Everything that would be lost is spelled out before anything happens, the
 * worst first, and the button says "Remove anyway" when uncommitted work is on the line. The
 * worktree's shells are stopped first, because Windows will not delete a folder a shell sits in.
 */
export function RemoveWorktreeDialog({
  project,
  worktree,
  onClose,
}: {
  project: Project;
  worktree: WorktreeInfo;
  onClose: () => void;
}): React.JSX.Element {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const scopeId = asWorkspaceProject(project, worktree).id;
  const label = worktreeLabel(worktree);
  const activity = useWorkspaceActivity(scopeId);

  const preflightQuery = useQuery({
    queryKey: [...queryKeys.worktrees(project.id), 'remove', worktree.id],
    queryFn: () => window.runova.worktrees.removePreflight(project.id, worktree.id),
    staleTime: 0,
  });
  const settingsQuery = useQuery({
    queryKey: queryKeys.settings,
    queryFn: () => window.runova.settings.get(),
  });

  const [deleteChoice, setDeleteChoice] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const preflight = preflightQuery.data;
  const warnings = preflight ? removeWarnings(preflight, activity) : [];
  // Commits that are on this branch and nowhere else go with it; that is never a default.
  const onlyHere = Boolean(
    preflight && !preflight.merged && preflight.ahead > 0 && preflight.unpushed !== 0,
  );
  const canDeleteBranch = Boolean(preflight?.branch) && !onlyHere;
  const deleteBranch =
    canDeleteBranch &&
    (deleteChoice ??
      (preflight?.merged || settingsQuery.data?.worktrees?.deleteBranchOnRemove === true));
  const force = (preflight?.changes ?? 0) > 0;

  async function remove(): Promise<void> {
    if (!preflight) return;
    setBusy(true);
    setError(null);
    const store = useWorkspaceStore.getState();
    const wasActive = store.activeProjectId === scopeId;
    store.closeWorkspace(scopeId);
    if (wasActive) navigate(`/workspace/${project.id}`);
    const result = await window.runova.worktrees.remove({
      projectId: project.id,
      worktreeId: worktree.id,
      force,
      deleteBranch,
    });
    void queryClient.invalidateQueries({ queryKey: queryKeys.worktrees(project.id) });
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    toast.success(result.message);
    onClose();
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="flex w-[min(30rem,calc(100vw-2rem))] max-w-none flex-col gap-0 p-0">
        <DialogHeader className="border-b border-border/70 px-5 py-4">
          <DialogTitle className="flex items-center gap-2 text-base">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-destructive/12 text-destructive">
              <Trash2 className="h-3.5 w-3.5" />
            </span>
            Remove the {label} worktree?
          </DialogTitle>
          <DialogDescription className="break-all font-mono text-[11px]">
            {worktree.path}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 px-5 py-4">
          {preflightQuery.isPending ? (
            <div className="space-y-2">
              <Skeleton className="h-9 rounded-lg" />
              <Skeleton className="h-9 rounded-lg" />
            </div>
          ) : preflightQuery.isError ? (
            <p className="text-sm text-destructive">Could not check this worktree. Try again.</p>
          ) : warnings.length === 0 ? (
            <p className="flex items-center gap-2 rounded-xl bg-success/10 px-3 py-2 text-sm text-success ring-1 ring-inset ring-success/30">
              <CircleCheck className="h-3.5 w-3.5" />
              Nothing is lost: the branch is merged and clean.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {warnings.map((warning) => (
                <Warning key={warning.text} warning={warning} />
              ))}
            </ul>
          )}

          {preflight?.branch ? (
            <label
              className={cn(
                'flex items-start gap-2.5 text-sm',
                canDeleteBranch ? 'cursor-pointer' : 'cursor-not-allowed opacity-70',
              )}
            >
              <Checkbox
                checked={deleteBranch}
                disabled={!canDeleteBranch || busy}
                onCheckedChange={(checked) => setDeleteChoice(checked === true)}
                aria-label={`Also delete branch ${preflight.branch}`}
                className="mt-0.5"
              />
              <span>
                <span className="block">
                  Also delete branch{' '}
                  <span className="font-mono text-[13px]">{preflight.branch}</span>
                </span>
                {onlyHere ? (
                  <span className="block text-xs text-muted-foreground">
                    Kept, since its {preflight.ahead} commit{preflight.ahead === 1 ? '' : 's'} exist
                    only on this branch. Delete it from Branches once you are sure.
                  </span>
                ) : null}
              </span>
            </label>
          ) : null}

          {error ? (
            <p
              role="alert"
              className="rounded-xl bg-destructive/10 px-3 py-2 text-sm text-destructive ring-1 ring-inset ring-destructive/30"
            >
              {error}
            </p>
          ) : null}
        </div>

        <DialogFooter className="flex-row items-center gap-2 border-t border-border/70 px-5 py-3 sm:justify-end">
          <Button variant="ghost" size="sm" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            size="sm"
            className="gap-1.5"
            disabled={!preflight || busy}
            onClick={() => void remove()}
          >
            {busy ? (
              <Spinner className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Trash2 className="h-3.5 w-3.5" />
            )}
            {error ? 'Try again' : force ? 'Remove anyway' : 'Remove worktree'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
