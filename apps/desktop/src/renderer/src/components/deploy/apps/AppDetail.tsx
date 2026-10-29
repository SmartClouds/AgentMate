import { coreErrorMessage } from '@shared/coreErrors';
import type {
  JobInfo,
  StackAction,
  StackDetails,
  StackRevisionInfo,
  StackServiceInfo,
} from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { motion, useReducedMotion } from 'framer-motion';
import { useCallback, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  ChevronRight,
  Docker,
  FileCode,
  FileText,
  Globe,
  History,
  Pause,
  Play,
  Plus,
  Power,
  Rocket,
  RotateCw,
  Route,
  TerminalSquare,
  Trash2,
} from '@/components/icons';
import {
  Chip,
  FOOTER_HAIRLINE,
  GLASS_CARD,
  LoadFailure,
  SECTION_HEADING,
  SECTION_WELL,
  TileHeader,
} from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { SimpleTooltip } from '@/components/ui/tooltip';
import {
  bindingAddress,
  describeBinding,
  REVISION_TEXT,
  REVISION_TONE,
  STATUS_TEXT,
  STATUS_TONE,
} from '@/lib/deploy/apps/format';
import { domainsForPort, proxyBlockReason, publishedPort } from '@/lib/deploy/apps/routes';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { confirmDialog } from '@/stores/confirmStore';
import { useFinishedOnce, useFollowedJob } from '@/stores/deployFollowedJobStore';
import { JobLogDialog } from '../overview/JobLogDialog';
import { RegistryPlanCard } from '../registries/RegistryPlanCard';
import { dateTime } from '../security/format';
import { useNginxStatus, useSites } from '../sites/hooks';
import {
  type StackToolsRequest,
  StackToolsSheet,
  stackContainers,
} from '../stackTools/StackToolsSheet';
import { OPERATOR_ONLY } from './AppsList';
import { DeployTimeline } from './DeployTimeline';
import type { AppsAccess } from './hooks';
import { stackIsBusy, useStack } from './hooks';
import { type ProxyRoute, ProxyRouteDialog } from './ProxyRouteDialog';
import { StatusPill } from './StatusPill';

/**
 * One app: how it is doing, its services and containers, every revision with its deploy
 * timeline and a rollback, the files it runs, and what each role may do with it.
 */

const ADMIN_ONLY = 'Deleting an app with its data needs the Admin role or higher.';
const CONSOLE_ADMIN_ONLY = 'Consoles need the Admin role or higher.';

const ACTIONS: ReadonlyArray<{
  action: StackAction;
  label: string;
  icon: typeof Play;
  done: string;
}> = [
  { action: 'start', label: 'Start', icon: Play, done: 'Started' },
  { action: 'stop', label: 'Stop', icon: Pause, done: 'Stopped' },
  { action: 'restart', label: 'Restart', icon: RotateCw, done: 'Restarted' },
  { action: 'down', label: 'Take down', icon: Power, done: 'Took down' },
];

/** One stop on the route map: a soft well with an inset ring rather than a border. */
const ROUTE_STOP =
  'rounded-lg bg-foreground/[0.03] px-2 py-1 ring-1 ring-inset ring-foreground/[0.08]';

const CONTAINER_STATE: Record<string, string> = {
  created: 'Created',
  running: 'Running',
  paused: 'Paused',
  restarting: 'Restarting',
  removing: 'Removing',
  exited: 'Exited',
  dead: 'Dead',
  unknown: 'Unknown',
};

function DetailSkeleton(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2" aria-busy="true">
      <div className={cn(GLASS_CARD, 'space-y-3 p-4')}>
        <Skeleton className="h-6 w-72 max-w-full" />
        <div className="flex gap-1.5">
          <Skeleton className="h-7 w-28 rounded-full" />
          <Skeleton className="h-7 w-20 rounded-full" />
          <Skeleton className="h-7 w-20 rounded-full" />
        </div>
      </div>
      <div className={cn(GLASS_CARD, 'p-4')}>
        <Skeleton className="h-40 w-full rounded-xl" />
      </div>
      <div className={cn(GLASS_CARD, 'p-4')}>
        <Skeleton className="h-24 w-full rounded-xl" />
      </div>
    </div>
  );
}

const NO_CONTAINERS = 'Nothing runs yet. Deploy a revision first.';

function Gate({
  allowed,
  reason,
  children,
}: {
  allowed: boolean;
  reason: string;
  children: React.ReactElement;
}): React.JSX.Element {
  return (
    <SimpleTooltip label={allowed ? null : reason} wrapTrigger>
      {children}
    </SimpleTooltip>
  );
}

function ServicesCard({
  services,
  canAdmin,
  onTools,
}: {
  services: StackServiceInfo[];
  canAdmin: boolean;
  onTools: (request: StackToolsRequest) => void;
}): React.JSX.Element {
  return (
    <section className={cn(GLASS_CARD, 'space-y-3 p-4')}>
      <div className="space-y-1">
        <TileHeader icon={<Docker />} title="Services" />
        <p className="text-xs text-muted-foreground">
          Each service and the containers it runs right now.
        </p>
      </div>
      {services.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing runs yet. Deploy a revision first.</p>
      ) : (
        <ul aria-label="Services" className={cn(SECTION_WELL, 'settings-rows p-0')}>
          {services.map((service) => (
            <li key={service.name} aria-label={service.name} className="px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-sm font-medium text-foreground">
                  {service.name}
                </span>
                {service.image && (
                  <span className="truncate font-mono text-[11px] text-muted-foreground">
                    {service.image}
                  </span>
                )}
              </div>
              {service.ports.length > 0 && (
                <p className="mt-1 flex flex-wrap gap-x-3 font-mono text-[11px] text-muted-foreground">
                  {service.ports.map((port) => (
                    <span key={`${port.hostIp}-${port.published}-${port.target}-${port.protocol}`}>
                      {describeBinding(port)}
                    </span>
                  ))}
                </p>
              )}
              {service.containers.length === 0 ? (
                <p className="mt-2 text-xs text-muted-foreground">No containers.</p>
              ) : (
                <ul className="mt-2 space-y-1">
                  {service.containers.map((container) => (
                    <li
                      key={container.id}
                      className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
                    >
                      <StatusPill
                        tone={
                          container.state === 'running'
                            ? container.health === 'unhealthy'
                              ? 'warning'
                              : 'success'
                            : container.state === 'dead'
                              ? 'danger'
                              : 'muted'
                        }
                      >
                        {CONTAINER_STATE[container.state] ?? container.state}
                        {container.health !== 'none' ? `, ${container.health}` : ''}
                      </StatusPill>
                      <span className="font-mono text-foreground/90">{container.name}</span>
                      <span className="min-w-0 flex-1 truncate">{container.status}</span>
                      <SimpleTooltip label="Logs">
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label={`Logs of ${container.name}`}
                          onClick={() => onTools({ tab: 'logs', containerId: container.id })}
                        >
                          <FileText />
                        </Button>
                      </SimpleTooltip>
                      {container.state === 'running' && (
                        <SimpleTooltip
                          label={canAdmin ? 'Console' : CONSOLE_ADMIN_ONLY}
                          wrapTrigger={!canAdmin}
                        >
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            aria-label={`Console in ${container.name}`}
                            disabled={!canAdmin}
                            onClick={() => onTools({ tab: 'console', containerId: container.id })}
                          >
                            <TerminalSquare />
                          </Button>
                        </SimpleTooltip>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const ADD_DOMAIN_ADMIN_ONLY = 'Adding a domain needs the Admin role or higher.';
const NGINX_UNMANAGED = 'Set up nginx under Websites first, so it can serve a domain.';

function RouteMap({
  serverId,
  stackName,
  services,
  signedIn,
  canAdmin,
  onOpenWebsites,
}: {
  serverId: string;
  stackName: string;
  services: StackServiceInfo[];
  signedIn: boolean;
  canAdmin: boolean;
  onOpenWebsites?: () => void;
}): React.JSX.Element {
  const routes = services.flatMap((service) => service.ports.map((port) => ({ service, port })));
  const sites = useSites(serverId, signedIn && routes.length > 0);
  const nginx = useNginxStatus(serverId, signedIn && routes.length > 0);
  const [adding, setAdding] = useState<ProxyRoute | null>(null);
  return (
    <section className={cn(GLASS_CARD, 'space-y-3 p-4')}>
      <div className="space-y-1">
        <TileHeader icon={<Route />} title="Route map" />
        <p className="text-xs text-muted-foreground">
          Where each published port leads. Add a domain to put a port on the internet: nginx answers
          for it and forwards to the port on this server.
        </p>
      </div>
      {routes.length === 0 ? (
        <p className="text-sm text-muted-foreground">No service publishes a port.</p>
      ) : (
        <ul aria-label="Routes" className="space-y-2">
          {routes.map(({ service, port }) => {
            const name = `${service.name}:${port.target}`;
            const published = publishedPort(port);
            const domains =
              published !== null && sites.data ? domainsForPort(sites.data, published) : [];
            const blocked =
              proxyBlockReason(port) ??
              (!canAdmin ? ADD_DOMAIN_ADMIN_ONLY : null) ??
              (nginx.data && !nginx.data.managed ? NGINX_UNMANAGED : null);
            const label = domains.length > 0 ? 'Add another domain' : 'Add domain';
            return (
              <li
                key={`${service.name}-${port.hostIp}-${port.published}-${port.target}-${port.protocol}`}
                aria-label={`${name}/${port.protocol}`}
                className="flex flex-wrap items-center gap-2 text-xs"
              >
                {sites.isPending && signedIn ? (
                  <Skeleton className="h-6 w-28 rounded-lg" />
                ) : sites.isError || !signedIn ? (
                  <span className="rounded-lg px-2 py-1 text-muted-foreground ring-1 ring-inset ring-foreground/[0.1]">
                    Domain, via Websites
                  </span>
                ) : domains.length === 0 ? (
                  <span className="rounded-lg border border-dashed border-foreground/15 px-2 py-1 text-muted-foreground">
                    No domain
                  </span>
                ) : (
                  domains.map((domain) => (
                    <span
                      key={domain}
                      className={cn(
                        ROUTE_STOP,
                        'inline-flex min-w-0 items-center gap-1.5 font-mono text-foreground [overflow-wrap:anywhere]',
                      )}
                    >
                      <Globe className="h-3 w-3 shrink-0 text-primary" />
                      {domain}
                    </span>
                  ))
                )}
                <ArrowRight className="h-3 w-3 text-muted-foreground" />
                <span className={cn(ROUTE_STOP, 'font-mono text-foreground')}>
                  {bindingAddress(port) === 'This server only' ? '127.0.0.1' : (port.hostIp ?? '*')}
                  :{port.published ?? 'any'}
                </span>
                <ArrowRight className="h-3 w-3 text-muted-foreground" />
                <span className={cn(ROUTE_STOP, 'font-mono text-foreground')}>
                  {service.name}:{port.target}/{port.protocol}
                </span>
                <ArrowRight className="h-3 w-3 text-muted-foreground" />
                <span className="text-muted-foreground">
                  {service.containers.length === 1
                    ? '1 container'
                    : `${service.containers.length} containers`}
                </span>
                <span className="ml-auto">
                  <Gate allowed={blocked === null} reason={blocked ?? ''}>
                    <Button
                      size="sm"
                      variant="soft"
                      aria-label={`${label} for ${name}`}
                      disabled={blocked !== null || nginx.isPending || published === null}
                      onClick={() =>
                        published !== null &&
                        setAdding({
                          stack: stackName,
                          service: service.name,
                          target: port.target,
                          port: published,
                        })
                      }
                    >
                      <Plus className="h-3.5 w-3.5" /> {label}
                    </Button>
                  </Gate>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {adding && (
        <ProxyRouteDialog
          serverId={serverId}
          route={adding}
          open
          onClose={() => setAdding(null)}
          onOpenWebsites={onOpenWebsites}
        />
      )}
    </section>
  );
}

function FilesCard({
  serverId,
  stackId,
  revision,
}: {
  serverId: string;
  stackId: string;
  revision: number;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const files = useQuery({
    queryKey: queryKeys.deployAppFiles(serverId, stackId, revision),
    queryFn: () => window.runova.deployStacks.files({ serverId, stackId, revision }),
    enabled: open,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
  return (
    <section className={GLASS_CARD}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full cursor-pointer items-center gap-2 rounded-[inherit] p-4 text-left transition-colors hover:bg-foreground/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <FileCode className="h-4 w-4 shrink-0 text-primary" />
        <span className="min-w-0 flex-1 space-y-1">
          <span className="block text-sm font-semibold">Files of revision {revision}</span>
          <span className="block text-xs text-muted-foreground">
            The compose file as uploaded, the env keys and the loopback override. Env values stay on
            the server.
          </span>
        </span>
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
        )}
      </button>
      {open && (
        <div className="space-y-3 px-4 pb-4">
          {files.isPending ? (
            <Skeleton className="h-40 w-full rounded-xl" aria-busy="true" />
          ) : files.isError ? (
            <p role="alert" className="text-sm text-muted-foreground">
              The files did not load: {coreErrorMessage(files.error)}
            </p>
          ) : files.data ? (
            <>
              <pre
                aria-label="Compose file"
                className={cn(SECTION_WELL, 'max-h-80 overflow-auto font-mono text-xs')}
              >
                {files.data.compose}
              </pre>
              <div>
                <p className={SECTION_HEADING}>Env keys</p>
                {files.data.envKeys.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No .env for this revision.</p>
                ) : (
                  <ul aria-label="Env keys" className="mt-1.5 flex flex-wrap gap-1">
                    {files.data.envKeys.map((key) => (
                      <li key={key}>
                        <Chip className="font-mono">{key}</Chip>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              {files.data.override && (
                <pre
                  aria-label="Loopback override"
                  className={cn(SECTION_WELL, 'max-h-60 overflow-auto font-mono text-xs')}
                >
                  {files.data.override}
                </pre>
              )}
            </>
          ) : null}
        </div>
      )}
    </section>
  );
}

function RevisionsList({
  revisions,
  shown,
  latest,
  canOperate,
  onShow,
  onRollback,
}: {
  revisions: StackRevisionInfo[];
  shown: number | null;
  latest: number | null;
  canOperate: boolean;
  onShow: (revision: number) => void;
  onRollback: (revision: StackRevisionInfo) => void;
}): React.JSX.Element {
  const reduceMotion = useReducedMotion();
  return (
    <section className={cn(GLASS_CARD, 'space-y-3 p-4')}>
      <div className="space-y-1">
        <TileHeader icon={<History />} title="Revisions" />
        <p className="text-xs text-muted-foreground">
          Every upload is kept. Rolling back deploys an older revision again as a new one.
        </p>
      </div>
      {revisions.length === 0 ? (
        <p className="text-sm text-muted-foreground">No revisions yet.</p>
      ) : (
        <ul aria-label="Revisions" className="space-y-0.5">
          {revisions.map((revision) => {
            const canRollBack =
              revision.number !== latest &&
              (revision.state === 'superseded' || revision.state === 'live');
            return (
              <li
                key={revision.number}
                aria-label={`Revision ${revision.number}`}
                className={cn(
                  // `isolate` keeps the sliding pill behind the row's text.
                  'relative isolate flex flex-wrap items-center gap-2 rounded-lg py-1 pl-2.5 pr-1 transition-colors',
                  shown !== revision.number && 'hover:bg-foreground/[0.06]',
                )}
              >
                {shown === revision.number && (
                  <motion.span
                    aria-hidden
                    layoutId="app-revisions-active"
                    transition={
                      reduceMotion
                        ? { duration: 0 }
                        : { type: 'spring', stiffness: 420, damping: 32 }
                    }
                    className="absolute inset-0 -z-10 rounded-lg bg-primary/12"
                  >
                    <span className="absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-full bg-primary shadow-[0_0_8px_hsl(var(--primary)/0.7)]" />
                  </motion.span>
                )}
                <button
                  type="button"
                  onClick={() => onShow(revision.number)}
                  aria-current={shown === revision.number ? 'true' : undefined}
                  className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md py-0.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span
                    className={cn(
                      'font-mono text-sm',
                      shown === revision.number ? 'font-medium text-primary' : 'text-foreground',
                    )}
                  >
                    #{revision.number}
                  </span>
                  <StatusPill tone={REVISION_TONE[revision.state]}>
                    {REVISION_TEXT[revision.state]}
                  </StatusPill>
                  <span className="truncate text-xs text-muted-foreground">
                    {dateTime(revision.createdAtUnixMs)}
                    {revision.createdBy ? `, by ${revision.createdBy}` : ''}
                    {revision.rollbackOf !== undefined
                      ? `, rollback of ${revision.rollbackOf}`
                      : ''}
                  </span>
                </button>
                {canRollBack && (
                  <Gate allowed={canOperate} reason={OPERATOR_ONLY}>
                    <Button
                      size="sm"
                      variant="soft"
                      disabled={!canOperate}
                      onClick={() => onRollback(revision)}
                      aria-label={`Roll back to revision ${revision.number}`}
                    >
                      <History className="h-3.5 w-3.5" /> Roll back
                    </Button>
                  </Gate>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export function AppDetail({
  serverId,
  stackId,
  access,
  onBack,
  onDeployAgain,
  onDeleted,
  onOpenRegistries,
  onOpenWebsites,
}: {
  serverId: string;
  stackId: string;
  access: AppsAccess;
  onBack: () => void;
  onDeployAgain: (details: StackDetails) => void;
  onDeleted: () => void;
  /** The registry sign-ins for private images (E08). */
  onOpenRegistries?: () => void;
  /** The server's Websites section, where the sites behind the route map live. */
  onOpenWebsites?: () => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const [busyJob, setBusyJob] = useState<string | null>(null);
  const details = useStack(serverId, stackId, access.signedIn, busyJob !== null);
  const deleting = useRef(false);
  const [shownRevision, setShownRevision] = useState<number | null>(null);
  const [followJob, setFollowJob] = useState<string | null>(null);
  const [logJob, setLogJob] = useFollowedJob(serverId, `app:${stackId}:log`);
  const [working, setWorking] = useState<string | null>(null);
  const [tools, setTools] = useState<StackToolsRequest | null>(null);

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.deployApps(serverId) });
  }, [queryClient, serverId]);

  const data = details.data;
  const stack = data?.stack;
  const revisions = data?.revisions ?? [];
  const latest = revisions[0]?.number ?? null;
  const followed = followJob
    ? revisions.find((revision) => revision.jobId === followJob)
    : undefined;
  const shown =
    followed ??
    revisions.find((revision) => revision.number === shownRevision) ??
    revisions[0] ??
    null;
  const stackBusy = stackIsBusy(data);

  const settled = useCallback(() => {
    setBusyJob(null);
    refresh();
  }, [refresh]);
  const logFinished = useFinishedOnce(serverId, (job) => {
    settled();
    if (job.state === 'failed') {
      toast.error(`${job.title} failed${job.error ? `: ${job.error}` : '.'}`);
      deleting.current = false;
    } else if (job.state === 'succeeded' && deleting.current) {
      toast.success(`Deleted ${stack?.name ?? 'the app'}.`);
      setLogJob(null);
      onDeleted();
    }
  });

  async function run(
    label: string,
    work: () => Promise<JobInfo>,
    show: 'log' | 'timeline',
    removing = false,
  ) {
    setWorking(label);
    try {
      const job = await work();
      deleting.current = removing;
      setBusyJob(job.id);
      if (show === 'log') setLogJob(job);
      else {
        setFollowJob(job.id);
        setShownRevision(null);
      }
      refresh();
      return job;
    } catch (error) {
      toast.error(coreErrorMessage(error));
      return null;
    } finally {
      setWorking(null);
    }
  }

  async function rollback(revision: StackRevisionInfo): Promise<void> {
    if (!stack) return;
    const confirmed = await confirmDialog({
      title: `Roll ${stack.name} back to revision ${revision.number}?`,
      description: `Revision ${revision.number}'s files are copied into a new revision and deployed. What runs now is replaced once the new one is healthy.`,
      confirmLabel: 'Roll back',
    });
    if (!confirmed) return;
    await run(
      'rollback',
      () => window.runova.deployStacks.rollback({ serverId, stackId, revision: revision.number }),
      'timeline',
    );
  }

  async function action(item: (typeof ACTIONS)[number]): Promise<void> {
    if (!stack) return;
    if (item.action === 'down') {
      const confirmed = await confirmDialog({
        title: `Take ${stack.name} down?`,
        description:
          'Its containers and networks go. Volumes and every revision stay, so a deploy brings it back.',
        confirmLabel: 'Take down',
        variant: 'destructive',
      });
      if (!confirmed) return;
    }
    await run(
      item.action,
      () => window.runova.deployStacks.action({ serverId, stackId, action: item.action }),
      'log',
    );
  }

  async function remove(removeVolumes: boolean): Promise<void> {
    if (!stack) return;
    const confirmed = await confirmDialog({
      title: removeVolumes ? `Delete ${stack.name} and its data?` : `Delete ${stack.name}?`,
      description: removeVolumes
        ? 'Its containers, revisions and volumes all go. Whatever the app stored in its volumes is lost.'
        : 'Its containers and revisions go. Its volumes stay on the server, so a new app with the same name finds its data again.',
      warning: removeVolumes ? 'Deleted volumes cannot be brought back.' : undefined,
      confirmLabel: removeVolumes ? 'Delete with its data' : 'Delete the app',
      variant: 'destructive',
      typeToConfirm: removeVolumes ? stack.name : undefined,
    });
    if (!confirmed) return;
    await run(
      removeVolumes ? 'delete-volumes' : 'delete',
      () => window.runova.deployStacks.delete({ serverId, stackId, removeVolumes }),
      'log',
      true,
    );
  }

  if (details.isPending) return <DetailSkeleton />;

  if (!data || !stack) {
    return (
      <div className="flex flex-col gap-2">
        <div className={cn(GLASS_CARD, 'px-2.5 py-2')}>
          <Button size="sm" variant="soft" onClick={onBack}>
            <ArrowLeft className="h-3.5 w-3.5" /> All apps
          </Button>
        </div>
        <LoadFailure
          message={`The app did not load${details.error ? `: ${coreErrorMessage(details.error)}` : '.'}`}
          retry={() => void details.refetch()}
        />
      </div>
    );
  }

  const canRedeploy = Boolean(stack.source?.projectId && stack.source.composePath);
  const disabled = !access.canOperate || stackBusy || working !== null;
  const why = !access.canOperate
    ? OPERATOR_ONLY
    : stackBusy
      ? 'A job is working on this app. Wait for it to finish.'
      : '';
  const containers = stackContainers(data.services);
  const rollbackTarget =
    shown && shown.number !== latest && (shown.state === 'superseded' || shown.state === 'live')
      ? shown
      : null;

  return (
    <div className="flex flex-col gap-2">
      <div className={cn(GLASS_CARD, 'space-y-3 px-4 py-3')}>
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" variant="soft" onClick={onBack}>
            <ArrowLeft className="h-3.5 w-3.5" /> All apps
          </Button>
          <h3 className="font-mono text-base font-semibold text-foreground">{stack.name}</h3>
          <StatusPill tone={STATUS_TONE[stack.status]}>{STATUS_TEXT[stack.status]}</StatusPill>
          <span className="text-xs text-muted-foreground">
            {stack.liveRevision !== undefined
              ? `Revision ${stack.liveRevision} live`
              : 'Nothing live'}
            {stack.containers > 0
              ? `, ${stack.runningContainers} of ${stack.containers} containers running`
              : ''}
          </span>
        </div>
        {stack.source && (
          <p className="text-xs text-muted-foreground">
            From {stack.source.projectName ?? 'a project'}
            {stack.source.composePath ? `, ${stack.source.composePath}` : ''}
            {stack.source.environmentName
              ? `, with the ${stack.source.environmentName} environment`
              : ', without an environment'}
            .
          </p>
        )}
        <div
          role="toolbar"
          aria-label="App actions"
          className={cn('-mx-4 flex flex-wrap gap-1.5 px-4 pt-3', FOOTER_HAIRLINE)}
        >
          <Gate
            allowed={canRedeploy && !disabled}
            reason={why || 'This app has no project to deploy from on this computer.'}
          >
            <Button
              size="sm"
              disabled={disabled || !canRedeploy}
              onClick={() => onDeployAgain(data)}
            >
              <Rocket className="h-3.5 w-3.5" /> Deploy again
            </Button>
          </Gate>
          {ACTIONS.map((item) => {
            const Icon = item.icon;
            return (
              <Gate key={item.action} allowed={!disabled} reason={why}>
                <Button
                  size="sm"
                  variant="soft"
                  disabled={disabled}
                  onClick={() => void action(item)}
                >
                  <Icon className="h-3.5 w-3.5" /> {item.label}
                </Button>
              </Gate>
            );
          })}
          <Gate allowed={!disabled} reason={why}>
            <Button
              size="sm"
              variant="danger"
              disabled={disabled}
              onClick={() => void remove(false)}
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </Button>
          </Gate>
          <Gate
            allowed={access.canAdmin && !stackBusy && working === null}
            reason={access.canAdmin ? why : ADMIN_ONLY}
          >
            <Button
              size="sm"
              variant="danger"
              disabled={!access.canAdmin || stackBusy || working !== null}
              onClick={() => void remove(true)}
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete with its data
            </Button>
          </Gate>
          <span className="flex-1" aria-hidden />
          <Gate allowed={containers.length > 0} reason={NO_CONTAINERS}>
            <Button
              size="sm"
              variant="soft"
              disabled={containers.length === 0}
              onClick={() => setTools({ tab: 'logs' })}
            >
              <FileText className="h-3.5 w-3.5" /> Logs
            </Button>
          </Gate>
          <Gate
            allowed={access.canAdmin && containers.length > 0}
            reason={access.canAdmin ? NO_CONTAINERS : CONSOLE_ADMIN_ONLY}
          >
            <Button
              size="sm"
              variant="soft"
              disabled={!access.canAdmin || containers.length === 0}
              onClick={() => setTools({ tab: 'console' })}
            >
              <TerminalSquare className="h-3.5 w-3.5" /> Console
            </Button>
          </Gate>
        </div>
      </div>
      {shown && (
        <DeployTimeline
          key={`${shown.number}-${shown.jobId ?? 'none'}`}
          serverId={serverId}
          revision={shown}
          canOperate={access.canOperate}
          onSettled={settled}
          onRollback={
            rollbackTarget && access.canOperate ? () => void rollback(rollbackTarget) : undefined
          }
        />
      )}
      <div className="grid gap-2 xl:grid-cols-2">
        <ServicesCard services={data.services} canAdmin={access.canAdmin} onTools={setTools} />
        <RevisionsList
          revisions={revisions}
          shown={shown?.number ?? null}
          latest={latest}
          canOperate={access.canOperate}
          onShow={(number) => {
            setFollowJob(null);
            setShownRevision(number);
          }}
          onRollback={(revision) => void rollback(revision)}
        />
      </div>
      <RouteMap
        serverId={serverId}
        stackName={stack.name}
        services={data.services}
        signedIn={access.signedIn}
        canAdmin={access.canAdmin}
        onOpenWebsites={onOpenWebsites}
      />
      {latest !== null && (
        <RegistryPlanCard
          input={{ serverId, stackId, revision: latest }}
          stackId={stackId}
          onOpenRegistries={onOpenRegistries}
        />
      )}
      {shown && <FilesCard serverId={serverId} stackId={stackId} revision={shown.number} />}
      <StackToolsSheet
        serverId={serverId}
        project={stack.name}
        containers={containers}
        canAdmin={access.canAdmin}
        request={tools}
        onClose={() => setTools(null)}
      />
      <JobLogDialog
        serverId={serverId}
        job={logJob}
        canCancel={access.canOperate}
        onClose={() => {
          setLogJob(null);
          if (deleting.current) onDeleted();
        }}
        onFinished={logFinished}
      />
    </div>
  );
}
