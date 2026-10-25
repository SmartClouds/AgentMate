import {
  configuredRunCommands,
  parseRunInputs,
  projectRunCommandTitle,
  runCommandSummary,
} from '@agentmat/core';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Cpu, FolderOpen, Keyboard, Pencil, Play, Run, Tag, Wand2 } from '@/components/icons';
import { CreateRunWithAiDialog } from '@/components/projects/CreateRunWithAiDialog';
import { useProjectRun } from '@/components/projects/useProjectRun';
import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { useWorkspaceProject } from '@/hooks/useWorktrees';
import { RUN_PROJECT_EVENT } from '@/lib/workspace/commands';
import { ProjectVersionDialogs } from '@/pages/ProjectDetailPage';
import { useRunningClisStore } from '@/stores/runningClisStore';
import { useShortcutLabel } from '@/stores/shortcutStore';
import { useVersionDialogStore } from '@/stores/versionDialogStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { PauseProjectRunsButton } from './PauseProjectRunsButton';
import { WorkspaceDeployButton } from './WorkspaceDeployButton';
import { WorkspaceScopeSwitcher } from './worktrees/WorkspaceScopeSwitcher';

/**
 * Run and Tag a version for the project open in the Workspace, beside the header's other
 * buttons. Run uses the general terminal, the same as the project page's Run button.
 * Right-clicking Run lists the project's commands and links to where they're edited.
 *
 * A project linked to a WordPress site gets Deploy in place of Tag a version: deploying to the
 * site is what moves it forward, and tagging is still on the project page's Git tab.
 *
 * In a worktree's workspace, Run starts in the worktree's folder, while tagging a version,
 * deploying and the project page belong to the project itself (its main checkout).
 */
export function WorkspaceHeaderActions(): React.JSX.Element | null {
  const navigate = useNavigate();
  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId);
  const { requestRun, runCommand, runPicker } = useProjectRun();
  const [createAiOpen, setCreateAiOpen] = useState(false);
  const tagDialogProjectId = useVersionDialogStore((s) => s.openProjectId);
  const openVersionDialog = useVersionDialogStore((s) => s.open);
  const closeVersionDialog = useVersionDialogStore((s) => s.close);
  const runningClisOpen = useRunningClisStore((s) => s.open);
  const setRunningClisOpen = useRunningClisStore((s) => s.setOpen);
  const { project } = useWorkspaceProject(activeProjectId);
  const runShortcut = useShortcutLabel('workspace.run');
  const parentId = project?.parentId ?? null;
  const tagOpen = parentId !== null && tagDialogProjectId === parentId;
  const wordpress = project?.wordpress;

  // The button and the run shortcut share this. The ref keeps the listener on the latest project
  // without resubscribing every render, since requestRun is a new function each time.
  const runHandler = useRef<() => void>(() => undefined);
  runHandler.current = () => {
    if (!project || !parentId || !activeProjectId) return;
    // Nothing to run yet, so Run turns into the way to get one: the AI helper opens right here.
    requestRun(project, { onEmpty: () => setCreateAiOpen(true) });
  };
  useEffect(() => {
    const onRun = (): void => runHandler.current();
    window.addEventListener(RUN_PROJECT_EVENT, onRun);
    return () => window.removeEventListener(RUN_PROJECT_EVENT, onRun);
  }, []);

  if (!project || !parentId || !activeProjectId) return null;

  const commands = configuredRunCommands(project);
  const runLabel =
    commands.length === 1
      ? `Run ${project.name} (${runCommandSummary(commands[0]?.command ?? '')})`
      : commands.length > 1
        ? `Run ${project.name}: pick a command`
        : `Set a run command for ${project.name}`;

  function editRunCommands(): void {
    if (parentId) navigate(`/projects/${parentId}?edit=run`);
  }

  return (
    <>
      <WorkspaceScopeSwitcher scopeId={activeProjectId} />
      <ContextMenu>
        <SimpleTooltip label={runShortcut ? `${runLabel} (${runShortcut})` : runLabel}>
          <ContextMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label={runLabel}
              onClick={() => runHandler.current()}
            >
              <Run className="h-4 w-4" />
            </Button>
          </ContextMenuTrigger>
        </SimpleTooltip>
        <ContextMenuContent className="max-w-[20rem]">
          {commands.length > 0 ? (
            <>
              <ContextMenuLabel>Run in {project.name}</ContextMenuLabel>
              {commands.map((entry) => {
                const title = projectRunCommandTitle(entry);
                const showCommand = entry.label.trim().length > 0;
                const asksForInput = parseRunInputs(entry.command).length > 0;
                return (
                  <ContextMenuItem key={entry.id} onSelect={() => runCommand(project, entry)}>
                    <Play className="h-3.5 w-3.5 shrink-0 text-primary" />
                    <span className="min-w-0 flex-1 truncate">{title}</span>
                    {asksForInput ? (
                      <>
                        <Keyboard aria-hidden className="h-3 w-3 shrink-0 text-primary" />
                        <span className="sr-only">Asks for input</span>
                      </>
                    ) : null}
                    {showCommand ? (
                      <span className="ml-auto max-w-[9rem] truncate pl-4 font-mono text-[11px] text-muted-foreground">
                        {runCommandSummary(entry.command)}
                      </span>
                    ) : null}
                  </ContextMenuItem>
                );
              })}
              <ContextMenuSeparator />
            </>
          ) : (
            <>
              <ContextMenuLabel>No run commands yet</ContextMenuLabel>
              <ContextMenuItem onSelect={() => setCreateAiOpen(true)}>
                <Wand2 className="h-3.5 w-3.5 shrink-0 text-primary" />
                Create with AI
              </ContextMenuItem>
            </>
          )}
          <ContextMenuItem onSelect={editRunCommands}>
            <Pencil className="h-3.5 w-3.5 shrink-0" />
            {commands.length > 0 ? 'Edit run commands' : 'Add a run command'}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <PauseProjectRunsButton
        scopeId={activeProjectId}
        projectId={project.id}
        projectName={project.name}
      />
      {wordpress ? (
        <WorkspaceDeployButton
          key={`deploy:${parentId}`}
          projectId={parentId}
          projectName={project.name}
          siteId={wordpress.siteId}
          inWorktree={project.worktree !== null}
        />
      ) : (
        <SimpleTooltip label={`Tag a version of ${project.name}`}>
          <Button
            variant={tagOpen ? 'soft' : 'ghost'}
            size="icon"
            aria-label="Tag a version"
            onClick={() => openVersionDialog(parentId)}
          >
            <Tag className="h-4 w-4" />
          </Button>
        </SimpleTooltip>
      )}
      <SimpleTooltip label={`Open ${project.name}'s project details`}>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Project details"
          onClick={() => navigate(`/projects/${parentId}`)}
        >
          <FolderOpen className="h-4 w-4" />
        </Button>
      </SimpleTooltip>
      <SimpleTooltip label="Running CLIs: CPU and memory for every terminal">
        <Button
          variant={runningClisOpen ? 'soft' : 'ghost'}
          size="icon"
          aria-label="Running CLIs"
          onClick={() => setRunningClisOpen(true)}
        >
          <Cpu className="h-4 w-4" />
        </Button>
      </SimpleTooltip>
      {runPicker}
      <CreateRunWithAiDialog
        open={createAiOpen}
        onOpenChange={setCreateAiOpen}
        project={project}
        onWriteMyself={editRunCommands}
      />
      {/* Keyed by project so each one gets its own form, suggestion and tag run. One shared
          instance let a project's pending answer or finished tag land in the next project. */}
      {/* Mounted for WordPress projects too, with no button: a tag started from the project's Git
          tab ends in a "version files updated" toast and notification, and their Review comes
          back here to open it. */}
      <ProjectVersionDialogs
        key={parentId}
        projectId={parentId}
        open={tagOpen}
        onOpenChange={(next) => (next ? openVersionDialog(parentId) : closeVersionDialog(parentId))}
      />
    </>
  );
}
