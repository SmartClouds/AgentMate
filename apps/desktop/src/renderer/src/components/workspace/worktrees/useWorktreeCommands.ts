import type { Project, WorktreeInfo } from '@runova/core';
import { useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { queryKeys } from '@/lib/queryKeys';
import { launchAgentTab, launchShellTab, projectCliId } from '@/lib/workspace/launch';
import { asWorkspaceProject } from '@/lib/workspace/scope';
import {
  type MergeFlowDeps,
  mergeBaseInFlow,
  mergeWorktreeFlow,
} from '@/lib/workspace/worktreeActions';
import { confirmDialog } from '@/stores/confirmStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { type CreateWorktreeRequest, useWorktreeDialogStore } from '@/stores/worktreeDialogStore';
import { revealInOs } from '../git/explorer/actions';

export interface WorktreeCommands {
  open: (project: Project, worktree: WorktreeInfo) => void;
  openMain: (projectId: string) => void;
  create: (request: CreateWorktreeRequest) => void;
  remove: (project: Project, worktree: WorktreeInfo) => void;
  merge: (project: Project, worktree: WorktreeInfo) => void;
  mergeBaseIn: (project: Project, worktree: WorktreeInfo) => void;
  pullRequest: (project: Project, worktree: WorktreeInfo) => void;
  newAgent: (project: Project, worktree: WorktreeInfo) => void;
  newShell: (project: Project, worktree: WorktreeInfo) => void;
  reveal: (project: Project, worktree: WorktreeInfo) => void;
  copyPath: (worktree: WorktreeInfo) => void;
  prune: (projectId: string) => void;
}

/** What every worktree menu, row and tile can do, in one place so they all behave the same. */
export function useWorktreeCommands(): WorktreeCommands {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  return useMemo(() => {
    const dialogs = useWorktreeDialogStore.getState();
    const go = (project: Project, worktree: WorktreeInfo | null): void => {
      navigate(`/workspace/${asWorkspaceProject(project, worktree).id}`);
    };
    const deps: MergeFlowDeps = {
      confirm: (options) => confirmDialog(options),
      notify: {
        success: (title, options) => toast.success(title, options),
        error: (title, options) => toast.error(title, options),
        warning: (title, options) => toast.warning(title, options),
        info: (title, options) => toast.info(title, options),
      },
      openRemove: (projectId, worktreeId) => dialogs.openRemove({ projectId, worktreeId }),
      openWorkspace: (scopeId) => navigate(`/workspace/${scopeId}`),
      revealChanges: () => useWorkspaceStore.getState().revealPanelSection('changes'),
    };
    const refresh = (projectId: string): void => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.worktrees(projectId) });
    };

    return {
      open: (project, worktree) => go(project, worktree),
      openMain: (projectId) => navigate(`/workspace/${projectId}`),
      create: (request) => dialogs.openCreate(request),
      remove: (project, worktree) =>
        dialogs.openRemove({ projectId: project.id, worktreeId: worktree.id }),
      merge: (project, worktree) =>
        void mergeWorktreeFlow(project, worktree, deps).then(() => refresh(project.id)),
      mergeBaseIn: (project, worktree) =>
        void mergeBaseInFlow(project, worktree, deps).then(() => refresh(project.id)),
      pullRequest: (project, worktree) => {
        go(project, worktree);
        useWorkspaceStore.getState().revealPanelSection('pullRequest');
      },
      newAgent: (project, worktree) => {
        const cliId = projectCliId(project);
        if (!cliId) {
          toast.info('Pick a default agent in Settings first');
          return;
        }
        go(project, worktree);
        launchAgentTab(asWorkspaceProject(project, worktree), cliId);
      },
      newShell: (project, worktree) => {
        go(project, worktree);
        launchShellTab(asWorkspaceProject(project, worktree));
      },
      reveal: (project, worktree) =>
        revealInOs(asWorkspaceProject(project, worktree), worktree.path),
      copyPath: (worktree) =>
        void navigator.clipboard.writeText(worktree.path).then(
          () => toast.success('Path copied'),
          () => toast.error('Could not copy the path'),
        ),
      prune: (projectId) =>
        void window.runova.worktrees.prune(projectId).then((result) => {
          refresh(projectId);
          if (result.ok) toast.success(result.message);
          else toast.error('Could not clean up', { description: result.message });
        }),
    };
  }, [navigate, queryClient]);
}
