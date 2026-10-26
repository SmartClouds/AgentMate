import { coreErrorMessage } from '@shared/coreErrors';
import type {
  ContainerDetails,
  ContainerEnvVariable,
  ContainerSummary,
} from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  FolderOpen,
  Globe,
  HardDrive,
  NetworkIcon,
  Pause,
  Play,
  RefreshCw,
  StopCircle,
  Wand2,
} from '@/components/icons';
import { Chip, EmptyState, SECTION_HEADING, SECTION_WELL } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { isPublic, portText } from '@/lib/deploy/containers/list';
import { cpuText, type StatsHistory } from '@/lib/deploy/containers/stats';
import { formatBytes } from '@/lib/format';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import type { ProofStepUp } from '../overview/useProofStepUp';
import { ago } from '../security/format';
import { serverFilesHref } from '../serverFiles/params';
import { ContainerConsoleTab } from './ContainerConsoleTab';
import { ContainerInspectTab } from './ContainerInspectTab';
import { ActionMenu, type ContainerActions } from './ContainerList';
import { ContainerLogsTab } from './ContainerLogsTab';
import { ContainerStatsTab } from './ContainerStatsTab';
import { StateChip } from './StateChip';

/**
 * One container up close (E06 T8), in a panel from the right: what it is, its live figures, its
 * log, what the engine knows about it (names of variables, values for Admins), its mounts and
 * ports, and a console for Admins. The lifecycle buttons follow the signed-in role.
 */

export type DrawerTab = 'overview' | 'stats' | 'logs' | 'inspect' | 'mounts' | 'ports' | 'console';

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 space-y-1">
      <dt className={SECTION_HEADING}>{label}</dt>
      <dd className="break-words text-sm text-foreground">{children}</dd>
    </div>
  );
}

function args(list: readonly string[]): string {
  return list.map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg)).join(' ');
}

function OverviewTab({
  container,
  details,
  history,
}: {
  container: ContainerSummary;
  details: ContainerDetails;
  history: StatsHistory;
}): React.JSX.Element {
  const latest = history.get(container.id)?.at(-1);
  const now = Date.now();
  return (
    <dl className={cn(SECTION_WELL, 'grid gap-x-6 gap-y-4 p-4 sm:grid-cols-2')}>
      <Fact label="Image">
        <span className="font-mono text-xs">{container.image}</span>
      </Fact>
      <Fact label="Status">{container.status || 'No status'}</Fact>
      {container.composeProject && (
        <Fact label="Compose">
          {container.composeProject}
          {container.composeService ? `, service ${container.composeService}` : ''}
        </Fact>
      )}
      <Fact label="Restart policy">
        {details.restartPolicy || 'no'}, restarted {details.restartCount} time
        {details.restartCount === 1 ? '' : 's'}
      </Fact>
      {details.startedAtUnixMs !== undefined && (
        <Fact label={container.state === 'running' ? 'Up since' : 'Last started'}>
          {ago(details.startedAtUnixMs, now)}
        </Fact>
      )}
      {container.state !== 'running' && details.exitCode !== undefined && (
        <Fact label="Exit code">
          {details.exitCode}
          {details.oomKilled ? ', killed for running out of memory' : ''}
        </Fact>
      )}
      {details.error && <Fact label="Engine error">{details.error}</Fact>}
      {latest && container.state === 'running' && (
        <Fact label="Right now">
          {cpuText(latest.cpuPercent)} processor, {formatBytes(latest.memoryUsedBytes)} memory,{' '}
          {latest.pids} processes
        </Fact>
      )}
      <Fact label="Limits">
        {details.cpuLimit ? `${details.cpuLimit} cores` : 'Any processor'},{' '}
        {details.memoryLimitBytes ? formatBytes(details.memoryLimitBytes) : 'any memory'}
      </Fact>
      {details.command.length > 0 && (
        <Fact label="Command">
          <span className="font-mono text-xs">{args(details.command)}</span>
        </Fact>
      )}
      {details.entrypoint.length > 0 && (
        <Fact label="Entrypoint">
          <span className="font-mono text-xs">{args(details.entrypoint)}</span>
        </Fact>
      )}
      {details.user && <Fact label="User">{details.user}</Fact>}
      {details.workingDirectory && (
        <Fact label="Working folder">
          <span className="font-mono text-xs">{details.workingDirectory}</span>
        </Fact>
      )}
      {details.networks.length > 0 && (
        <Fact label="Networks">
          {details.networks
            .map(
              (network) =>
                `${network.network}${network.ipAddress ? ` (${network.ipAddress})` : ''}`,
            )
            .join(', ')}
        </Fact>
      )}
      <Fact label="Runs with">
        {[
          details.privileged ? 'Privileged' : 'Not privileged',
          details.tty ? 'a terminal' : 'no terminal',
        ].join(', ')}
      </Fact>
    </dl>
  );
}

function MountsTab({ details }: { details: ContainerDetails }): React.JSX.Element {
  if (details.mounts.length === 0) {
    return (
      <EmptyState size="sm" icon={HardDrive} title="Nothing is mounted into this container." />
    );
  }
  return (
    <div className={cn(SECTION_WELL, 'overflow-x-auto p-0')}>
      <table className="w-full text-left text-sm" aria-label="Mounts">
        <thead>
          <tr className={SECTION_HEADING}>
            <th className="px-3 py-2 font-semibold">Inside the container</th>
            <th className="px-3 py-2 font-semibold">From</th>
            <th className="px-3 py-2 font-semibold">Access</th>
          </tr>
        </thead>
        <tbody>
          {details.mounts.map((mount) => (
            <tr
              key={mount.destination}
              className="[&>td]:shadow-[inset_0_1px_0_hsl(var(--foreground)/0.08)]"
            >
              <td className="px-3 py-2 font-mono text-xs">{mount.destination}</td>
              <td className="px-3 py-2 text-xs">
                <span className="text-muted-foreground">{mount.type} </span>
                <span className="font-mono">{mount.name ?? mount.source ?? ''}</span>
              </td>
              <td className="px-3 py-2 text-xs">
                {mount.readWrite ? 'Read and write' : 'Read only'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PortsTab({ container }: { container: ContainerSummary }): React.JSX.Element {
  if (container.ports.length === 0) {
    return <EmptyState size="sm" icon={NetworkIcon} title="This container has no ports." />;
  }
  return (
    <ul className={cn(SECTION_WELL, 'settings-rows p-0')} aria-label="Ports">
      {container.ports.map((port) => {
        const open = isPublic(port);
        const text = portText(port);
        return (
          <li key={text} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
            <span className="font-mono text-xs">{text}</span>
            {port.hostPort === undefined ? (
              <span className="text-xs text-muted-foreground">
                Only other containers on its network reach it
              </span>
            ) : open ? (
              <Chip tone="warning">
                <Globe />
                <span>Public: anyone who can reach the server reaches it</span>
              </Chip>
            ) : (
              <span className="text-xs text-muted-foreground">Only this address on the server</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function ContainerDrawer({
  serverId,
  container,
  tab,
  onTab,
  history,
  statsReady,
  statsError,
  actions,
  canAdmin,
  stepUp,
  onSendToCli,
  onClose,
}: {
  serverId: string;
  container: ContainerSummary | null;
  tab: DrawerTab;
  onTab: (tab: DrawerTab) => void;
  history: StatsHistory;
  statsReady: boolean;
  statsError: string | null;
  actions: ContainerActions;
  canAdmin: boolean;
  stepUp: ProofStepUp;
  onSendToCli: (container: ContainerSummary, revealed: ContainerEnvVariable[] | null) => void;
  onClose: () => void;
}): React.JSX.Element {
  const navigate = useNavigate();
  const [revealed, setRevealed] = useState<ContainerEnvVariable[] | null>(null);
  const id = container?.id ?? '';
  const details = useQuery({
    queryKey: queryKeys.deployContainer(serverId, id),
    queryFn: () => window.runova.deployDocker.inspect(serverId, id),
    enabled: container !== null,
    retry: false,
  });

  // Revealed values belong to the container they were shown for, and go when it changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the container is the trigger
  useEffect(() => setRevealed(null), [id]);

  const running = container?.state === 'running';
  const quick = container && actions.act && (
    <div className="flex flex-wrap gap-1.5">
      {running ? (
        <>
          <Button
            size="sm"
            variant="soft"
            onClick={() => actions.act?.(container, 'restart')}
            disabled={actions.busyId === container.id}
          >
            <RefreshCw className="h-3.5 w-3.5" /> Restart
          </Button>
          <Button
            size="sm"
            variant="soft"
            onClick={() => actions.act?.(container, 'stop')}
            disabled={actions.busyId === container.id}
          >
            <StopCircle className="h-3.5 w-3.5" /> Stop
          </Button>
        </>
      ) : container.state === 'paused' ? (
        <Button
          size="sm"
          variant="soft"
          onClick={() => actions.act?.(container, 'unpause')}
          disabled={actions.busyId === container.id}
        >
          <Pause className="h-3.5 w-3.5" /> Resume
        </Button>
      ) : (
        <Button
          size="sm"
          variant="soft"
          onClick={() => actions.act?.(container, 'start')}
          disabled={actions.busyId === container.id}
        >
          <Play className="h-3.5 w-3.5" /> Start
        </Button>
      )}
    </div>
  );

  const needsDetails = (body: (details: ContainerDetails) => React.ReactNode) =>
    details.data ? (
      body(details.data)
    ) : details.error ? (
      <p role="alert" className="text-sm text-destructive">
        Could not read this container: {coreErrorMessage(details.error)}
      </p>
    ) : (
      <div className="grid gap-4 sm:grid-cols-2" aria-busy="true">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-10 rounded-lg" />
        ))}
      </div>
    );

  return (
    <Dialog open={container !== null} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        className="left-auto right-0 top-0 flex h-full max-h-none w-[min(60rem,100vw)] max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none rounded-l-xl p-0 data-[state=closed]:zoom-out-100 data-[state=open]:zoom-in-100"
        aria-describedby={undefined}
      >
        {container && (
          <>
            <DialogHeader className="space-y-2 px-5 py-4 pr-12">
              <div className="flex flex-wrap items-center gap-2">
                <DialogTitle className="truncate text-base">{container.name}</DialogTitle>
                <StateChip container={container} />
              </div>
              <DialogDescription className="truncate font-mono text-xs">
                {container.image}
              </DialogDescription>
              <div className="flex flex-wrap items-center gap-2">
                {quick}
                <Button size="sm" variant="soft" onClick={() => onSendToCli(container, revealed)}>
                  <Wand2 className="h-3.5 w-3.5" /> Send logs to the project CLI
                </Button>
                <SimpleTooltip
                  label={canAdmin ? undefined : 'Browsing files in a container is for Admins.'}
                  wrapTrigger
                >
                  <Button
                    size="sm"
                    variant="soft"
                    disabled={!canAdmin}
                    onClick={() =>
                      navigate(
                        serverFilesHref(serverId, { source: 'container', target: container.name }),
                      )
                    }
                  >
                    <FolderOpen className="h-3.5 w-3.5" /> Browse files
                  </Button>
                </SimpleTooltip>
                <ActionMenu container={container} actions={actions} align="start" />
              </div>
            </DialogHeader>
            <Tabs
              value={tab}
              onValueChange={(next) => onTab(next as DrawerTab)}
              className="flex min-h-0 flex-1 flex-col"
            >
              {/* The API Client's strip: hairlines above and below instead of a border. */}
              <TabsList
                className="h-9 border-none bg-transparent"
                containerClassName="border-b-0 px-3 shadow-[inset_0_-1px_0_hsl(var(--foreground)/0.08),inset_0_1px_0_hsl(var(--foreground)/0.08)]"
              >
                <TabsTrigger value="overview">Overview</TabsTrigger>
                <TabsTrigger value="stats">Stats</TabsTrigger>
                <TabsTrigger value="logs">Logs</TabsTrigger>
                <TabsTrigger value="inspect">Inspect</TabsTrigger>
                <TabsTrigger value="mounts">Mounts</TabsTrigger>
                <TabsTrigger value="ports">Ports</TabsTrigger>
                <TabsTrigger value="console">Console</TabsTrigger>
              </TabsList>
              <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-4">
                <TabsContent value="overview" className="mt-0">
                  {needsDetails((data) => (
                    <OverviewTab container={container} details={data} history={history} />
                  ))}
                </TabsContent>
                <TabsContent value="stats" className="mt-0">
                  <ContainerStatsTab
                    container={container}
                    history={history}
                    ready={statsReady}
                    error={statsError}
                  />
                </TabsContent>
                <TabsContent
                  value="logs"
                  className="mt-0 flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden"
                >
                  <ContainerLogsTab
                    serverId={serverId}
                    container={container}
                    onSendToCli={() => onSendToCli(container, revealed)}
                  />
                </TabsContent>
                <TabsContent value="inspect" className="mt-0">
                  {needsDetails((data) => (
                    <ContainerInspectTab
                      serverId={serverId}
                      details={data}
                      canReveal={canAdmin}
                      stepUp={stepUp}
                      revealed={revealed}
                      onRevealed={setRevealed}
                    />
                  ))}
                </TabsContent>
                <TabsContent value="mounts" className="mt-0">
                  {needsDetails((data) => (
                    <MountsTab details={data} />
                  ))}
                </TabsContent>
                <TabsContent value="ports" className="mt-0">
                  <PortsTab container={container} />
                </TabsContent>
                <TabsContent
                  value="console"
                  className="mt-0 flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden"
                >
                  <ContainerConsoleTab
                    serverId={serverId}
                    container={container}
                    canOpen={canAdmin}
                  />
                </TabsContent>
              </div>
            </Tabs>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
