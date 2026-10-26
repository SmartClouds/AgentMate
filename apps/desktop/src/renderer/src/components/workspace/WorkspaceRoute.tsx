import { parseScopeId } from '@runova/core';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useWorkspaceProject } from '@/hooks/useWorktrees';
import { queryKeys } from '@/lib/queryKeys';
import { usePageHeader } from '@/stores/pageHeaderStore';
import { useVersionDialogStore } from '@/stores/versionDialogStore';
import { isSourceControlSection, useWorkspaceStore } from '@/stores/workspaceStore';

/**
 * The route element for `/workspace` and `/workspace/:projectId`. The page itself is the
 * always-mounted WorkspaceHost; this only keeps the store in step with the URL.
 */
export default function WorkspaceRoute(): null {
  const { projectId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const openProject = useWorkspaceStore((s) => s.openProject);
  const activateTab = useWorkspaceStore((s) => s.activateTab);
  const revealPanelSection = useWorkspaceStore((s) => s.revealPanelSection);
  // The id in the URL is a project's, or a worktree's scope id (`<project>~<worktree>`).
  const { project, projects, isPending } = useWorkspaceProject(projectId ?? null);
  const queryClient = useQueryClient();

  // A link to a project the cached list has not seen yet (just created): fetch it.
  const parentId = projectId ? parseScopeId(projectId).projectId : null;
  const unknown = Boolean(parentId && !isPending && !projects.some((p) => p.id === parentId));
  useEffect(() => {
    if (unknown) void queryClient.invalidateQueries({ queryKey: queryKeys.projects });
  }, [unknown, queryClient]);

  const branch = project?.worktree?.branch;
  usePageHeader(
    'Workspace',
    project
      ? [
          project.name,
          project.worktree ? `worktree ${branch ?? 'detached'}` : null,
          project.folderPath,
        ]
          .filter(Boolean)
          .join(' · ')
      : undefined,
  );

  useEffect(() => {
    if (projectId) {
      openProject(projectId);
      return;
    }
    const last = useWorkspaceStore.getState().activeProjectId;
    if (last) navigate(`/workspace/${last}`, { replace: true });
  }, [projectId, openProject, navigate]);

  // `?session=<id>` comes from a notification click: bring that tab forward.
  const session = searchParams.get('session');
  useEffect(() => {
    if (!projectId || !session) return;
    activateTab(projectId, session);
    const next = new URLSearchParams(searchParams);
    next.delete('session');
    setSearchParams(next, { replace: true });
  }, [projectId, session, searchParams, setSearchParams, activateTab]);

  // `?panel=pipelines` comes from a pipeline failure alert: unfold that section of the Git panel.
  // Only Source control sections are accepted, so a hand-edited link cannot reach anything else.
  const panel = searchParams.get('panel');
  useEffect(() => {
    if (!projectId || !panel) return;
    if (isSourceControlSection(panel)) revealPanelSection(panel);
    const next = new URLSearchParams(searchParams);
    next.delete('panel');
    setSearchParams(next, { replace: true });
  }, [projectId, panel, searchParams, setSearchParams, revealPanelSection]);

  // `?tag=1` comes from a "version files updated" notification: reopen that flow.
  const openTagDialog = searchParams.get('tag');
  useEffect(() => {
    if (!projectId || !openTagDialog) return;
    useVersionDialogStore.getState().open(projectId);
    const next = new URLSearchParams(searchParams);
    next.delete('tag');
    setSearchParams(next, { replace: true });
  }, [projectId, openTagDialog, searchParams, setSearchParams]);

  return null;
}
