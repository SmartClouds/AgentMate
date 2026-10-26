import type { Project } from '@runova/core';
import { useQuery } from '@tanstack/react-query';
import { DockerContainerRow } from '@/components/docker/DockerContainerRow';
import { RemoveContainerDialog } from '@/components/docker/RemoveContainerDialog';
import { useDockerContainerActions } from '@/components/docker/useDockerContainerActions';
import { Docker, StopCircle } from '@/components/icons';
import { SectionEmptyState } from '@/components/projects/ProjectDetailChrome';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { queryKeys } from '@/lib/queryKeys';

function DockerTabSkeleton(): React.JSX.Element {
  return (
    <div className="space-y-2">
      {Array.from({ length: 2 }, (_, i) => (
        <Skeleton key={i} className="h-20 w-full rounded-lg" />
      ))}
    </div>
  );
}

export function DockerTab({ project }: { project: Project }): React.JSX.Element {
  const queryKey = queryKeys.dockerListForProject(project.id);
  const availabilityQuery = useQuery({
    queryKey: queryKeys.dockerAvailability,
    queryFn: () => window.runova.docker.availability(),
    meta: { silentLoading: true },
  });
  const available = availabilityQuery.data;
  const listQuery = useQuery({
    queryKey,
    queryFn: () => window.runova.docker.listForProject(project.folderPath),
    enabled: available === true,
    refetchInterval: available === true ? 4000 : false,
    meta: { silentLoading: true },
  });
  const actions = useDockerContainerActions(queryKey);

  if (availabilityQuery.isLoading) return <DockerTabSkeleton />;

  if (available === false) {
    return (
      <SectionEmptyState
        icon={Docker}
        title="Docker isn't available"
        description="Install Docker and make sure it's on PATH to manage this project's containers here."
      />
    );
  }

  if (listQuery.isLoading) return <DockerTabSkeleton />;

  const containers = listQuery.data ?? [];

  if (containers.length === 0) {
    return (
      <SectionEmptyState
        icon={Docker}
        title="No containers for this project"
        description="Only containers started with docker compose from this exact folder show up here. Run docker compose up -d in the project's folder to see them, or manage every container from the Docker page in the sidebar."
      />
    );
  }

  const runningContainers = containers.filter((c) => c.state === 'running');

  return (
    <div className="space-y-2">
      {runningContainers.length > 1 && (
        <div className="flex justify-end">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 gap-1 px-2 text-muted-foreground hover:text-foreground"
            onClick={() => actions.stopMany(runningContainers)}
          >
            <StopCircle className="h-3 w-3" />
            Stop all
          </Button>
        </div>
      )}
      {containers.map((container) => (
        <DockerContainerRow
          key={container.id}
          container={container}
          pending={actions.pendingIds.has(container.id)}
          onStart={() => actions.start(container.id)}
          onStop={() => actions.stop(container)}
          onRestart={() => actions.restart(container.id)}
          onRemove={() => actions.openRemoveDialog(container)}
        />
      ))}
      <RemoveContainerDialog
        containerName={actions.removeTarget?.name ?? null}
        open={actions.removeTarget !== null}
        removing={actions.removing}
        onOpenChange={(open) => {
          if (!open) actions.closeRemoveDialog();
        }}
        onConfirm={actions.confirmRemove}
      />
    </div>
  );
}
