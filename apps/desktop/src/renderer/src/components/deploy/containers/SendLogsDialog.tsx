import { buildContainerLogsPrompt, type Project } from '@runova/core';
import { coreErrorMessage } from '@shared/coreErrors';
import type {
  ContainerEnvVariable,
  ContainerSummary,
} from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { FolderKanban } from '@/components/icons';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { FixWithAiDialog } from '@/components/workspace/FixWithAiDialog';
import { portsText } from '@/lib/deploy/containers/list';
import { linkKey, matchProject } from '@/lib/deploy/containers/projects';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { useDeployContainerLinksStore } from '@/stores/deployContainerLinksStore';

/**
 * "Send to the project CLI" (E06 T9): the end of a container's log and what the container is,
 * redacted, as a prompt for the project's coding CLI. The project comes from the container's
 * compose project when a project of that name is on this computer; otherwise the user picks one
 * once and it is remembered. No environment value is ever put in the prompt.
 */

const TAIL = 200;

export function SendLogsDialog({
  serverId,
  serverName,
  container,
  revealed,
  onClose,
}: {
  serverId: string;
  serverName: string;
  container: ContainerSummary | null;
  /** Values an Admin revealed in this session, to look for in the log as well. */
  revealed?: ContainerEnvVariable[] | null;
  onClose: () => void;
}): React.JSX.Element | null {
  const links = useDeployContainerLinksStore((state) => state.links);
  const link = useDeployContainerLinksStore((state) => state.link);
  const [picked, setPicked] = useState<string | null>(null);
  const open = container !== null;
  const key = container ? linkKey(serverId, container.composeProject, container.name) : '';

  const projects = useQuery({
    queryKey: queryKeys.projects,
    queryFn: () => window.runova.projects.list(),
    enabled: open,
  });
  const details = useQuery({
    queryKey: queryKeys.deployContainer(serverId, container?.id ?? ''),
    queryFn: () => window.runova.deployDocker.inspect(serverId, container?.id ?? ''),
    enabled: open,
    retry: false,
  });
  const tail = useQuery({
    queryKey: [...queryKeys.deployContainer(serverId, container?.id ?? ''), 'tail', TAIL],
    queryFn: () =>
      window.runova.deployDocker.logTail({
        serverId,
        containerId: container?.id ?? '',
        tail: TAIL,
      }),
    enabled: open,
    retry: false,
    staleTime: 0,
  });

  if (!container) return null;

  const project = matchProject(projects.data ?? [], {
    composeProject: container.composeProject,
    linkedProjectId: picked ?? links[key] ?? null,
  });

  if (!project) {
    return (
      <ProjectPicker
        open={open}
        loading={projects.isPending}
        projects={projects.data ?? []}
        container={container}
        onCancel={onClose}
        onPick={(chosen) => {
          link(key, chosen.id);
          setPicked(chosen.id);
        }}
      />
    );
  }

  const failure = details.error ?? tail.error;
  const prompt =
    details.data && tail.data
      ? buildContainerLogsPrompt({
          serverName,
          container: {
            name: container.name,
            image: container.image,
            imageId: container.imageId,
            state: container.state,
            status: container.status,
            health: container.health,
            composeProject: container.composeProject,
            composeService: container.composeService,
            restartCount: details.data.restartCount,
            exitCode: details.data.exitCode,
            oomKilled: details.data.oomKilled,
            command: details.data.command,
            entrypoint: details.data.entrypoint,
            ports: portsText(container.ports),
            error: details.data.error,
          },
          envKeys: details.data.envKeys,
          env: revealed ?? undefined,
          lines: tail.data,
        })
      : null;

  return (
    <FixWithAiDialog
      project={project}
      open={open}
      onOpenChange={(next) => !next && onClose()}
      title={`Send ${container.name}'s log to ${project.name}`}
      description="The end of the log and what the container is, with secrets taken out. Check it, then run it in the project's CLI."
      jobKey={`container-logs:${serverId}:${container.id}`}
      source={{
        prompt,
        loadingLabel: 'Reading the end of the log…',
        error: failure ? coreErrorMessage(failure) : null,
        retry: () => {
          void details.refetch();
          void tail.refetch();
        },
      }}
    />
  );
}

function ProjectPicker({
  open,
  loading,
  projects,
  container,
  onCancel,
  onPick,
}: {
  open: boolean;
  loading: boolean;
  projects: readonly Project[];
  container: ContainerSummary;
  onCancel: () => void;
  onPick: (project: Project) => void;
}): React.JSX.Element {
  const [choice, setChoice] = useState<string | null>(null);
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Which project runs {container.name}?</DialogTitle>
          <DialogDescription>
            {container.composeProject
              ? `No project here is called ${container.composeProject}. Pick the one this container comes from; the app remembers it.`
              : 'Pick the project this container comes from; the app remembers it.'}
          </DialogDescription>
        </DialogHeader>
        {loading ? (
          <div className="space-y-2" aria-busy="true">
            {Array.from({ length: 3 }, (_, i) => (
              <span key={i} className="shimmer block h-10 rounded-lg" />
            ))}
          </div>
        ) : projects.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            There are no projects on this computer yet. Add the project's folder first.
          </p>
        ) : (
          <div
            role="radiogroup"
            aria-label="Projects"
            className="max-h-72 space-y-1 overflow-y-auto"
          >
            {projects.map((project) => (
              <button
                key={project.id}
                type="button"
                role="radio"
                aria-checked={choice === project.id}
                onClick={() => setChoice(project.id)}
                className={cn(
                  // The main menu's row: a tinted pill and the glowing bar on the chosen one.
                  'relative flex w-full cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  choice === project.id
                    ? 'bg-primary/12 text-primary'
                    : 'hover:bg-foreground/[0.06]',
                )}
              >
                {choice === project.id && (
                  <span
                    aria-hidden
                    className="absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-full bg-primary shadow-[0_0_8px_hsl(var(--primary)/0.7)]"
                  />
                )}
                <FolderKanban
                  className={cn(
                    'h-3.5 w-3.5 shrink-0',
                    choice === project.id ? 'text-primary' : 'text-muted-foreground',
                  )}
                />
                <span className="min-w-0">
                  <span
                    className={cn(
                      'block truncate',
                      choice === project.id ? 'font-medium text-primary' : 'text-foreground',
                    )}
                  >
                    {project.name}
                  </span>
                  <span className="block truncate font-mono text-[11px] text-muted-foreground">
                    {project.folderPath}
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}
        <DialogFooter>
          <Button variant="soft" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            disabled={!choice}
            onClick={() => {
              const chosen = projects.find((project) => project.id === choice);
              if (chosen) onPick(chosen);
            }}
          >
            Use this project
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
