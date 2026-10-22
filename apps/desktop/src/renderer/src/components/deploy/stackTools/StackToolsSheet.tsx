import type {
  ContainerList,
  ContainerSummary,
  StackServiceInfo,
} from '@shared/deploy/protocol/generated/AgentMate.ServerCore.Contracts';
import { useMemo, useState } from 'react';
import { Lock, TerminalSquare } from '@/components/icons';
import { EmptyState } from '@/components/pageKit';
import { Combobox } from '@/components/ui/combobox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ContainerConsoleTab } from '../containers/ContainerConsoleTab';
import { LogViewer } from '../logs/LogViewer';
import { useAskAboutLog } from '../logs/useAskAboutLog';

/**
 * One compose app's logs and consoles, the way a hosting panel shows them: every service's log
 * together (or one container's), followed live, and a console or a command in any of its running
 * containers for Admins. Apps, the App Store and the container list open it.
 */

export type StackToolsTab = 'logs' | 'console';

export interface StackToolsRequest {
  tab: StackToolsTab;
  /** The container to start on; the whole app when left out. */
  containerId?: string;
}

/** Every container of an app, each named by the service it runs. */
export function stackContainers(services: readonly StackServiceInfo[]): ContainerSummary[] {
  return services.flatMap((service) =>
    service.containers.map((container) => ({
      ...container,
      composeService: container.composeService ?? service.name,
    })),
  );
}

export function StackToolsSheet({
  serverId,
  project,
  containers,
  canAdmin,
  request,
  onClose,
}: {
  serverId: string;
  /** The compose project, which is the app's name. */
  project: string;
  containers: readonly ContainerSummary[];
  canAdmin: boolean;
  request: StackToolsRequest | null;
  onClose: () => void;
}): React.JSX.Element {
  const running = containers.filter((container) => container.state === 'running').length;
  return (
    <Dialog open={request !== null} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        className="left-auto right-0 top-0 flex h-full max-h-none w-[min(60rem,100vw)] max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none rounded-l-xl p-0 data-[state=closed]:zoom-out-100 data-[state=open]:zoom-in-100"
        aria-describedby={undefined}
      >
        {request && (
          <>
            <DialogHeader className="space-y-1 px-5 py-4 pr-12">
              <DialogTitle className="truncate font-mono text-base">{project}</DialogTitle>
              <DialogDescription className="text-xs">
                {containers.length === 1
                  ? `1 container, ${running === 1 ? 'running' : 'not running'}`
                  : `${running} of ${containers.length} containers running`}
              </DialogDescription>
            </DialogHeader>
            <StackTools
              // A new request starts over on what it asked for.
              key={`${request.tab}-${request.containerId ?? ''}`}
              serverId={serverId}
              project={project}
              containers={containers}
              canAdmin={canAdmin}
              request={request}
            />
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function StackTools({
  serverId,
  project,
  containers,
  canAdmin,
  request,
}: {
  serverId: string;
  project: string;
  containers: readonly ContainerSummary[];
  canAdmin: boolean;
  request: StackToolsRequest;
}): React.JSX.Element {
  const [tab, setTab] = useState<StackToolsTab>(request.tab);
  const askAi = useAskAboutLog(serverId);
  // The log viewer reads its sources from a container list; this app is its only group, and
  // every container given is one of its own.
  const list = useMemo<ContainerList>(
    () => ({
      groups: [
        {
          project,
          containers: containers.map((container) => ({ ...container, composeProject: project })),
        },
      ],
    }),
    [project, containers],
  );

  return (
    <Tabs
      value={tab}
      onValueChange={(next) => setTab(next as StackToolsTab)}
      className="flex min-h-0 flex-1 flex-col"
    >
      <TabsList
        className="h-9 border-none bg-transparent"
        containerClassName="border-b-0 px-3 shadow-[inset_0_-1px_0_hsl(var(--foreground)/0.08),inset_0_1px_0_hsl(var(--foreground)/0.08)]"
      >
        <TabsTrigger value="logs">Logs</TabsTrigger>
        <TabsTrigger value="console">Console</TabsTrigger>
      </TabsList>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-4">
        <TabsContent
          value="logs"
          className="mt-0 flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden"
        >
          <LogViewer
            serverId={serverId}
            containers={list}
            sites={undefined}
            scope="stack"
            initial={
              request.containerId && request.tab === 'logs'
                ? `container:${request.containerId}`
                : `stack:${project}`
            }
            onAskAi={askAi}
          />
        </TabsContent>
        <TabsContent
          value="console"
          className="mt-0 flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden"
        >
          <StackConsole
            serverId={serverId}
            containers={containers}
            canAdmin={canAdmin}
            initial={request.containerId}
          />
        </TabsContent>
      </div>
    </Tabs>
  );
}

function StackConsole({
  serverId,
  containers,
  canAdmin,
  initial,
}: {
  serverId: string;
  containers: readonly ContainerSummary[];
  canAdmin: boolean;
  initial?: string;
}): React.JSX.Element {
  const running = containers.filter((container) => container.state === 'running');
  const [chosen, setChosen] = useState(
    running.find((container) => container.id === initial)?.id ?? running[0]?.id ?? '',
  );
  const container = running.find((item) => item.id === chosen) ?? running[0];

  if (!canAdmin) {
    return (
      <EmptyState
        size="sm"
        icon={Lock}
        title="Consoles are for Admins"
        description="A shell in a container can read and change everything in it."
      />
    );
  }
  if (!container) {
    return (
      <EmptyState
        size="sm"
        icon={TerminalSquare}
        title="Nothing is running"
        description="Start the app to open a console in one of its containers."
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {running.length > 1 && (
        <Combobox
          className="h-8 w-72 text-xs"
          value={container.id}
          onChange={setChosen}
          options={running.map((item) => ({
            value: item.id,
            label: item.composeService ? `${item.composeService} (${item.name})` : item.name,
            keywords: [item.name],
          }))}
          ariaLabel="Container"
        />
      )}
      <ContainerConsoleTab
        key={container.id}
        serverId={serverId}
        container={container}
        canOpen={canAdmin}
      />
    </div>
  );
}
