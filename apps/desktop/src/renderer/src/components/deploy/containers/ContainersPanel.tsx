import { coreErrorMessage } from '@shared/coreErrors';
import type {
  ContainerEnvVariable,
  ContainerSummary,
  JobInfo,
} from '@shared/deploy/protocol/generated/AgentMate.ServerCore.Contracts';
import type { DeployContainerAction } from '@shared/deployDockerTypes';
import type { DeployServer } from '@shared/deployTypes';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Docker } from '@/components/icons';
import { EmptyState, GLASS_CARD, LoadFailure } from '@/components/pageKit';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { allContainers } from '@/lib/deploy/containers/list';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { confirmDialog } from '@/stores/confirmStore';
import { useDeployConnection } from '../overview/hooks';
import { JobLogDialog } from '../overview/JobLogDialog';
import { useProofStepUp } from '../overview/useProofStepUp';
import { hasRole } from '../security/format';
import { StackToolsSheet } from '../stackTools/StackToolsSheet';
import { ContainerDrawer, type DrawerTab } from './ContainerDrawer';
import { type ContainerActions, ContainerList } from './ContainerList';
import { DockerInstallCard } from './DockerInstallCard';
import { useContainerStats, useDockerEvents } from './hooks';
import { type RemoveChoice, RemoveContainerDialog } from './RemoveContainerDialog';
import { DiskUsageTab, ImagesTab, NetworksTab, VolumesTab } from './ResourcesTabs';
import { SendLogsDialog } from './SendLogsDialog';

/**
 * A server's Containers section (E06 T8): Docker itself (and its install when it is missing),
 * every container grouped by compose project with live figures, a panel per container, and
 * Docker's images, volumes, networks and disk use. What a role may not do is not offered; the
 * core checks every call again. While the connection is being tried again, the lists stay on
 * screen, dimmed, and are read again once it is back.
 */

type ResourceTab = 'containers' | 'images' | 'volumes' | 'networks' | 'disk';

const DONE: Record<DeployContainerAction, string> = {
  start: 'Started',
  stop: 'Stopped',
  restart: 'Restarted',
  pause: 'Paused',
  unpause: 'Resumed',
  kill: 'Killed',
};

/** The resource switch drawn as the page kit's pill tabs, kept on Radix for its arrow keys. */
const RESOURCE_TAB =
  'h-7 rounded-full border-b-0 px-3 text-xs text-muted-foreground hover:bg-foreground/[0.06] focus-visible:ring-ring/60 data-[state=active]:bg-primary/12 data-[state=active]:text-primary data-[state=active]:hover:bg-primary/12';

const RESOURCE_TABS: ReadonlyArray<{ value: ResourceTab; label: string }> = [
  { value: 'containers', label: 'Containers' },
  { value: 'images', label: 'Images' },
  { value: 'volumes', label: 'Volumes' },
  { value: 'networks', label: 'Networks' },
  { value: 'disk', label: 'Disk use' },
];

function PanelSkeleton(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2" aria-busy="true">
      <div className={cn(GLASS_CARD, 'flex items-center gap-2 px-2.5 py-2')}>
        <Skeleton className="h-8 w-64 max-w-full rounded-full" />
      </div>
      <ListSkeleton />
    </div>
  );
}

function ListSkeleton(): React.JSX.Element {
  return (
    <div className={cn(GLASS_CARD, 'space-y-2 p-3')} aria-busy="true">
      {Array.from({ length: 5 }, (_, i) => (
        <Skeleton key={i} className="h-11 w-full rounded-lg" />
      ))}
    </div>
  );
}

export function ContainersPanel({ server }: { server: DeployServer }): React.JSX.Element {
  const serverId = server.id;
  const queryClient = useQueryClient();
  const stepUp = useProofStepUp(server);
  const [tab, setTab] = useState<ResourceTab>('containers');
  const [openId, setOpenId] = useState<string | null>(null);
  const [drawerTab, setDrawerTab] = useState<DrawerTab>('overview');
  const [removing, setRemoving] = useState<ContainerSummary | null>(null);
  const [sending, setSending] = useState<{
    container: ContainerSummary;
    revealed: ContainerEnvVariable[] | null;
  } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [job, setJob] = useState<JobInfo | null>(null);
  const [stackLogs, setStackLogs] = useState<string | null>(null);

  const access = useQuery({
    queryKey: queryKeys.deployAccess(serverId),
    queryFn: () => window.agentmat.deploy.access(serverId),
    retry: false,
    staleTime: 30_000,
  });
  const signedIn = access.data?.state === 'signed-in';
  const roles = access.data?.user?.roles;
  const canOperate = hasRole(roles, 'operator');
  const canAdmin = hasRole(roles, 'admin');
  const connection = useDeployConnection(serverId, signedIn);
  const stale = connection?.state === 'reconnecting';

  const status = useQuery({
    queryKey: queryKeys.deployDockerStatus(serverId),
    queryFn: () => window.agentmat.deployDocker.status(serverId),
    enabled: signedIn,
    retry: false,
  });
  const ready = signedIn && status.data?.installed === true && status.data.running;
  const containers = useQuery({
    queryKey: queryKeys.deployContainers(serverId),
    queryFn: () => window.agentmat.deployDocker.listContainers(serverId),
    enabled: ready,
    retry: false,
  });
  const stats = useContainerStats(serverId, ready);
  useDockerEvents(serverId, ready);

  const all = useMemo(() => allContainers(containers.data), [containers.data]);
  const open = all.find((container) => container.id === openId) ?? null;

  const refreshContainers = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.deployContainers(serverId) });
  }, [queryClient, serverId]);

  const act = useCallback(
    async (container: ContainerSummary, action: DeployContainerAction) => {
      if (action === 'kill') {
        const confirmed = await confirmDialog({
          title: `Kill ${container.name}?`,
          description:
            'It stops at once, without the chance to finish what it is doing or save anything.',
          confirmLabel: 'Kill',
          variant: 'destructive',
        });
        if (!confirmed) return;
      }
      setBusyId(container.id);
      try {
        await window.agentmat.deployDocker.act({ serverId, containerId: container.id, action });
        toast.success(`${DONE[action]} ${container.name}.`);
      } catch (error) {
        toast.error(coreErrorMessage(error));
      } finally {
        setBusyId(null);
        refreshContainers();
        void queryClient.invalidateQueries({
          queryKey: queryKeys.deployContainer(serverId, container.id),
        });
      }
    },
    [serverId, refreshContainers, queryClient],
  );

  async function remove(choice: RemoveChoice): Promise<boolean> {
    if (!removing) return false;
    try {
      await window.agentmat.deployDocker.remove({
        serverId,
        containerId: removing.id,
        removeVolumes: choice.removeVolumes,
        force: choice.force,
      });
      toast.success(
        choice.removeVolumes
          ? `Removed ${removing.name} and its volumes.`
          : `Removed ${removing.name}.`,
      );
      if (openId === removing.id) setOpenId(null);
      setRemoving(null);
      refreshContainers();
      return true;
    } catch (error) {
      toast.error(coreErrorMessage(error));
      return false;
    }
  }

  const actions: ContainerActions = {
    open: (container) => {
      setDrawerTab('overview');
      setOpenId(container.id);
    },
    act: canOperate ? (container, action) => void act(container, action) : undefined,
    remove: canOperate ? (container) => setRemoving(container) : undefined,
    busyId,
    openStackLogs: setStackLogs,
  };

  const jobDialog = (
    <JobLogDialog
      serverId={serverId}
      job={job}
      canCancel={canOperate}
      onClose={() => setJob(null)}
      onFinished={(finished) => {
        void queryClient.invalidateQueries({ queryKey: queryKeys.deployDocker(serverId) });
        if (finished.state === 'succeeded') toast.success(`${finished.title}: done.`);
      }}
    />
  );

  if (access.isPending) return <PanelSkeleton />;
  if (!signedIn) {
    return (
      <EmptyState
        card
        size="sm"
        icon={Docker}
        title="Not signed in"
        description={`Sign in to ${server.nickname} on its Overview to see and manage its containers.`}
      />
    );
  }
  if (status.isPending) return <PanelSkeleton />;
  if (status.error) {
    return (
      <LoadFailure
        message={`Could not find out about Docker: ${coreErrorMessage(status.error)}`}
        retry={() => void status.refetch()}
      />
    );
  }
  if (!ready) {
    return (
      <>
        <DockerInstallCard
          serverId={serverId}
          serverName={server.nickname}
          status={status.data}
          canInstall={canAdmin}
          canRestart={canOperate}
          onStarted={setJob}
          onRestart={() =>
            void window.agentmat.deploySystem
              .restartService(serverId, 'docker')
              .then(setJob, (error: unknown) => toast.error(coreErrorMessage(error)))
          }
        />
        {jobDialog}
      </>
    );
  }

  const engine = status.data;
  return (
    // While the connection is tried again everything dims together, toolbar and lists alike.
    <div className={cn('transition-opacity', stale && 'opacity-60')}>
      <Tabs
        value={tab}
        onValueChange={(next) => setTab(next as ResourceTab)}
        className="flex flex-col gap-2"
      >
        <div className={cn(GLASS_CARD, 'flex flex-wrap items-center gap-2 px-2.5 py-2')}>
          <TabsList
            aria-label="Docker resources"
            className="mb-0 h-auto w-auto gap-0.5 p-0.5"
            containerClassName="search-pill min-w-0 max-w-full rounded-full border-b-0"
          >
            {RESOURCE_TABS.map((entry) => (
              <TabsTrigger key={entry.value} value={entry.value} className={RESOURCE_TAB}>
                {entry.label}
              </TabsTrigger>
            ))}
          </TabsList>
          <p
            className="ml-auto min-w-0 truncate text-xs text-muted-foreground"
            aria-label="Docker version"
          >
            Docker {engine.engineVersion ?? 'unknown version'}
            {engine.composeVersion ? `, Compose ${engine.composeVersion}` : ', no Compose'}
            {engine.cgroupVersion ? `, cgroup v${engine.cgroupVersion}` : ''}
            {engine.storageDriver ? `, ${engine.storageDriver}` : ''}
          </p>
        </div>
        <TabsContent value="containers" className="mt-0">
          {containers.isPending ? (
            <ListSkeleton />
          ) : containers.error ? (
            <LoadFailure
              message={`Could not list the containers: ${coreErrorMessage(containers.error)}`}
              retry={() => void containers.refetch()}
            />
          ) : (
            <ContainerList
              list={containers.data}
              history={stats.history}
              actions={actions}
              notice={
                stats.error ? (
                  <p role="status" className="text-xs text-warning">
                    Live figures are not coming in right now: {stats.error}
                  </p>
                ) : null
              }
            />
          )}
        </TabsContent>
        <TabsContent value="images" className="mt-0">
          <ImagesTab serverId={serverId} roles={{ canOperate, canAdmin }} onJob={setJob} />
        </TabsContent>
        <TabsContent value="volumes" className="mt-0">
          <VolumesTab serverId={serverId} roles={{ canOperate, canAdmin }} />
        </TabsContent>
        <TabsContent value="networks" className="mt-0">
          <NetworksTab serverId={serverId} roles={{ canOperate, canAdmin }} />
        </TabsContent>
        <TabsContent value="disk" className="mt-0">
          <DiskUsageTab
            serverId={serverId}
            serverName={server.nickname}
            roles={{ canOperate, canAdmin }}
          />
        </TabsContent>
      </Tabs>

      <ContainerDrawer
        serverId={serverId}
        container={open}
        tab={drawerTab}
        onTab={setDrawerTab}
        history={stats.history}
        statsReady={stats.ready}
        statsError={stats.error}
        actions={actions}
        canAdmin={canAdmin}
        stepUp={stepUp}
        onSendToCli={(container, revealed) => setSending({ container, revealed })}
        onClose={() => setOpenId(null)}
      />
      <StackToolsSheet
        serverId={serverId}
        project={stackLogs ?? ''}
        containers={all.filter((container) => container.composeProject === stackLogs)}
        canAdmin={canAdmin}
        request={stackLogs ? { tab: 'logs' } : null}
        onClose={() => setStackLogs(null)}
      />
      <RemoveContainerDialog
        container={removing}
        canRemoveVolumes={canAdmin}
        onCancel={() => setRemoving(null)}
        onRemove={remove}
      />
      <SendLogsDialog
        key={sending?.container.id ?? 'none'}
        serverId={serverId}
        serverName={server.nickname}
        container={sending?.container ?? null}
        revealed={sending?.revealed}
        onClose={() => setSending(null)}
      />
      {jobDialog}
      {stepUp.dialog}
    </div>
  );
}
