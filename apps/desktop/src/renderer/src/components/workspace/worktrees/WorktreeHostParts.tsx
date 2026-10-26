import { type Project, parseScopeId } from '@runova/core';
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useShallow } from 'zustand/react/shallow';
import { ArrowLeft, Trash2, TriangleAlert } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useWorktrees } from '@/hooks/useWorktrees';
import type { WorkspaceProject } from '@/lib/workspace/scope';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { useWorktreeDialogStore } from '@/stores/worktreeDialogStore';
import { CreateWorktreeDialog } from './CreateWorktreeDialog';
import { RemoveWorktreeDialog } from './RemoveWorktreeDialog';

/**
 * Closes the workspaces of a project's worktrees once git no longer lists them (removed from a
 * terminal, or pruned). Only a list that actually arrived counts: a list still loading, or one
 * that failed, says nothing about what exists, and closing on it would end live shells.
 */
export function WorktreeWorkspaceGuard({ projectId }: { projectId: string }): null {
  const navigate = useNavigate();
  const query = useWorktrees(projectId);
  const { data, isFetching, dataUpdatedAt } = query;

  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the list's fetch time on purpose
  useEffect(() => {
    if (!data || isFetching) return;
    const known = new Set(data.map((w) => w.id));
    const state = useWorkspaceStore.getState();
    for (const key of Object.keys(state.workspaces)) {
      const scope = parseScopeId(key);
      if (scope.projectId !== projectId || !scope.worktreeId || known.has(scope.worktreeId))
        continue;
      const wasActive = useWorkspaceStore.getState().activeProjectId === key;
      state.closeWorkspace(key);
      if (wasActive) navigate(`/workspace/${projectId}`, { replace: true });
    }
  }, [dataUpdatedAt, isFetching]);

  return null;
}

/** One guard per project that has a worktree workspace open. */
export function WorktreeWorkspaceGuards(): React.JSX.Element {
  const projectIds = useWorkspaceStore(
    useShallow((s) => [
      ...new Set(
        Object.keys(s.workspaces)
          .map(parseScopeId)
          .filter((scope) => scope.worktreeId)
          .map((scope) => scope.projectId),
      ),
    ]),
  );
  return (
    <>
      {projectIds.map((id) => (
        <WorktreeWorkspaceGuard key={id} projectId={id} />
      ))}
    </>
  );
}

/** Where a worktree's panes would be, when its folder was deleted outside Runova. */
export function WorktreeMissingNotice({
  project,
}: {
  project: WorkspaceProject;
}): React.JSX.Element {
  const navigate = useNavigate();
  const openRemove = useWorktreeDialogStore((s) => s.openRemove);
  const worktree = project.worktree;
  return (
    <div className="flex h-full w-full items-center justify-center p-6">
      <div className="glass w-full max-w-md rounded-2xl p-6 text-center">
        <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-2xl bg-warning/12 text-warning">
          <TriangleAlert className="h-5 w-5" />
        </div>
        <h2 className="mt-4 text-base font-semibold">This worktree’s folder is gone</h2>
        <p className="mt-1.5 break-all font-mono text-[11px] text-muted-foreground">
          {project.folderPath}
        </p>
        <p className="mt-3 text-sm text-muted-foreground">
          It was deleted or moved outside Runova.
          {worktree?.branch ? ` Its branch ${worktree.branch} is still in the repository.` : ''}{' '}
          Remove it to tidy up git, or go back to {project.name}.
        </p>
        <div className="mt-5 flex justify-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5"
            onClick={() => navigate(`/workspace/${project.parentId}`)}
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to {project.name}
          </Button>
          {worktree ? (
            <Button
              variant="destructive"
              size="sm"
              className="gap-1.5"
              onClick={() => openRemove({ projectId: project.parentId, worktreeId: worktree.id })}
            >
              <Trash2 className="h-3.5 w-3.5" />
              Remove worktree
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** Stands in for the panes while a worktree's workspace waits for its folder to be known. */
export function WorkspaceLoading(): React.JSX.Element {
  return (
    <div className="flex h-full w-full flex-col gap-1.5" aria-label="Loading workspace">
      <Skeleton className="h-9 rounded-lg" />
      <Skeleton className="min-h-0 flex-1 rounded-xl" />
    </div>
  );
}

/** The worktree dialogs, opened from anywhere through the dialog store. */
export function WorktreeDialogsHost({ projects }: { projects: Project[] }): React.JSX.Element {
  const create = useWorktreeDialogStore((s) => s.create);
  const remove = useWorktreeDialogStore((s) => s.remove);
  const closeCreate = useWorktreeDialogStore((s) => s.closeCreate);
  const closeRemove = useWorktreeDialogStore((s) => s.closeRemove);
  const removeList = useWorktrees(remove?.projectId ?? null).data;
  const createProject = projects.find((p) => p.id === create?.projectId);
  const removeProject = projects.find((p) => p.id === remove?.projectId);
  const removeWorktree = removeList?.find((w) => w.id === remove?.worktreeId);

  return (
    <>
      {create && createProject ? (
        <CreateWorktreeDialog
          key={`${create.projectId}:${create.branch ?? ''}:${create.mode ?? ''}`}
          project={createProject}
          request={create}
          onClose={closeCreate}
        />
      ) : null}
      {remove && removeProject && removeWorktree ? (
        <RemoveWorktreeDialog
          key={`${remove.projectId}:${remove.worktreeId}`}
          project={removeProject}
          worktree={removeWorktree}
          onClose={closeRemove}
        />
      ) : null}
    </>
  );
}
