import {
  formatHealthInterval,
  type HealthDiagnosis,
  type HealthIncident,
  type HealthReport,
  type HealthServiceResult,
  type HealthState,
  type Project,
} from '@runova/core';
import type { HealthSecretReveal, HealthTargetSummary } from '@shared/healthTypes';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import {
  ChevronDown,
  Copy,
  EllipsisVertical,
  HeartPulse,
  Key,
  Pause,
  Pencil,
  Play,
  RefreshCw,
  Robot,
  Server,
  Sparkles,
  Spinner,
  Trash2,
  TriangleAlert,
  Wand2,
} from '@/components/icons';
import { Chip, EmptyState, Notice, SECTION_HEADING, SECTION_WELL } from '@/components/pageKit';
import { ipcErrorMessage } from '@/components/projects/environments/ipcError';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { confirmDialog } from '@/stores/confirmStore';
import { HealthFixDialog, healthFixPromptKey } from './HealthFixDialog';
import { HealthLatencyChart } from './HealthLatencyChart';
import { HealthSecretDialog } from './HealthSecretStep';
import { HealthStatusChip } from './HealthStatusChip';
import {
  formatAgo,
  formatClock,
  formatIn,
  formatLatency,
  formatObserved,
  formatSpan,
  formatUptime,
  HEALTH_STATE_META,
  healthBucket,
  SERVICE_STATUS_META,
  targetHost,
} from './healthView';
import { UptimeStrip } from './UptimeStrip';
import { useHealthActions, useHealthTarget } from './useHealth';

/**
 * One health target up close, in a panel from the right: its numbers, the last report's checks
 * and errors, the read-only AI diagnosis, the incidents and the raw (redacted) response, with
 * every action the target has. Text from the endpoint and the agent is shown as plain text,
 * never as markup.
 */

/** States where the endpoint may not exist yet, so building it is the likely next step. */
const NO_ENDPOINT_YET: ReadonlySet<HealthState> = new Set(['pending', 'unreachable', 'invalid']);

function copy(text: string, what: string): void {
  void navigator.clipboard.writeText(text).then(
    () => toast.success(`${what} copied`),
    () => toast.error(`Could not copy the ${what.toLowerCase()}`),
  );
}

function Section({
  title,
  icon,
  actions,
  children,
  label,
}: {
  title: string;
  icon?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  /** The region's accessible name, when it should differ from the title. */
  label?: string;
}): React.JSX.Element {
  const headingId = useId();
  return (
    <section
      aria-labelledby={label ? undefined : headingId}
      aria-label={label}
      className="space-y-2"
    >
      <div className="flex items-center justify-between gap-2">
        <h3
          id={headingId}
          className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.06em] text-muted-foreground [&_svg]:h-3.5 [&_svg]:w-3.5"
        >
          {icon}
          {title}
        </h3>
        {actions}
      </div>
      {children}
    </section>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 space-y-1">
      <dt className={SECTION_HEADING}>{label}</dt>
      <dd className="break-words text-sm font-medium tabular-nums text-foreground">{children}</dd>
    </div>
  );
}

function Disclosure({
  label,
  children,
  actions,
}: {
  label: string;
  children: React.ReactNode;
  actions?: React.ReactNode;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((value) => !value)}
          className="flex cursor-pointer items-center gap-1.5 rounded-md text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronDown className={cn('h-3 w-3 transition-transform', !open && '-rotate-90')} />
          {label}
        </button>
        {open && actions}
      </div>
      <div id={bodyId} hidden={!open}>
        {open && children}
      </div>
    </div>
  );
}

function ErrorPanel({ service }: { service: HealthServiceResult }): React.JSX.Element | null {
  const error = service.error;
  if (!error) return null;
  const tone = service.status === 'warn' ? 'warning' : 'destructive';
  return (
    <section
      aria-label={`${service.key} error`}
      className={cn(
        'space-y-2 rounded-xl px-3 py-2.5 ring-1 ring-inset',
        tone === 'warning'
          ? 'bg-warning/[0.07] ring-warning/25'
          : 'bg-destructive/[0.06] ring-destructive/25',
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <TriangleAlert
          className={cn(
            'h-3.5 w-3.5 shrink-0',
            tone === 'warning' ? 'text-warning' : 'text-destructive',
          )}
        />
        <span className="font-mono text-xs font-medium">{service.key}</span>
        {error.code && (
          <Chip tone={tone} className="font-mono">
            {error.code}
          </Chip>
        )}
        {error.since && (
          <span className="text-[11px] text-muted-foreground">
            since {formatClock(Date.parse(error.since))}
          </span>
        )}
      </div>
      <p className="whitespace-pre-wrap break-words text-sm text-foreground">{error.message}</p>
      {error.hint && (
        <p className="text-xs text-foreground/85">
          <span className="font-medium">Hint: </span>
          {error.hint}
        </p>
      )}
      {error.detail && (
        <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">
          {error.detail}
        </p>
      )}
      {error.stack && (
        <Disclosure
          label="Stack trace"
          actions={
            <Button
              size="xs"
              variant="ghost"
              onClick={() => copy(error.stack ?? '', 'Stack trace')}
            >
              <Copy />
              Copy stack trace
            </Button>
          }
        >
          <pre className="max-h-64 overflow-auto rounded-lg bg-foreground/[0.05] p-2.5 font-mono text-[11px] leading-relaxed text-foreground/90">
            {error.stack}
          </pre>
        </Disclosure>
      )}
    </section>
  );
}

function ServicesTable({ services }: { services: readonly HealthServiceResult[] }) {
  if (services.length === 0) {
    return <p className="text-xs text-muted-foreground">The endpoint lists no checks.</p>;
  }
  return (
    <div className={cn(SECTION_WELL, 'overflow-x-auto p-0')}>
      <table className="w-full text-left text-sm" aria-label="Services">
        <thead>
          <tr className={SECTION_HEADING}>
            <th className="px-3 py-2 font-semibold">Check</th>
            <th className="px-3 py-2 font-semibold">Type</th>
            <th className="px-3 py-2 font-semibold">Reading</th>
            <th className="px-3 py-2 text-right font-semibold">Status</th>
          </tr>
        </thead>
        <tbody>
          {services.map((service) => {
            const meta = SERVICE_STATUS_META[service.status];
            return (
              <tr
                key={service.key}
                className="[&>td]:shadow-[inset_0_1px_0_hsl(var(--foreground)/0.08)]"
              >
                <td className="px-3 py-2 font-mono text-xs">{service.key}</td>
                <td className="px-3 py-2 text-xs text-muted-foreground">
                  {service.componentType ?? 'Not given'}
                </td>
                <td className="px-3 py-2 text-xs tabular-nums">
                  {formatObserved(service.observedValue, service.observedUnit) ?? (
                    <span className="text-muted-foreground">Not reported</span>
                  )}
                </td>
                <td className="px-3 py-2 text-right">
                  <Chip tone={meta.tone} dot>
                    {meta.label}
                  </Chip>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function DiagnosisSection({
  diagnosis,
  canRun,
  starting,
  onRun,
  onCancel,
  now,
}: {
  diagnosis: HealthDiagnosis | null;
  canRun: boolean;
  starting: boolean;
  onRun: () => void;
  onCancel: () => void;
  now: number;
}): React.JSX.Element {
  const running = diagnosis?.status === 'running';
  const runButton = (label: string) => (
    <Button size="xs" variant="tint" disabled={!canRun || starting} onClick={onRun}>
      {starting ? <Spinner className="animate-spin" /> : <Wand2 />}
      {label}
    </Button>
  );
  return (
    <Section
      title="AI diagnosis"
      label="AI diagnosis"
      icon={<Robot />}
      actions={
        running ? (
          <Button size="xs" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        ) : diagnosis?.status === 'done' ? (
          runButton('Run again')
        ) : (
          runButton('Run diagnosis')
        )
      }
    >
      <div className={cn(SECTION_WELL, 'space-y-2')}>
        {running ? (
          <div role="status" aria-label="Diagnosis running" className="space-y-2">
            <p className="text-xs text-muted-foreground">
              {diagnosis?.cliName ?? 'The agent'} is reading the errors. It can look, but not change
              anything.
            </p>
            {[94, 86, 72, 80].map((width) => (
              <Skeleton key={width} className="h-3" style={{ width: `${width}%` }} />
            ))}
          </div>
        ) : diagnosis?.status === 'done' && diagnosis.text ? (
          <>
            <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground">
              {diagnosis.text}
            </p>
            <p className="text-[11px] text-muted-foreground">
              Read-only analysis{diagnosis.cliName ? ` by ${diagnosis.cliName}` : ''}
              {diagnosis.finishedAt ? `, ${formatAgo(diagnosis.finishedAt, now)}` : ''}. Check it
              before you act on it.
            </p>
          </>
        ) : diagnosis && diagnosis.status !== 'done' ? (
          <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">
            {diagnosis.status === 'cancelled'
              ? 'The diagnosis was stopped.'
              : diagnosis.status === 'skipped'
                ? (diagnosis.text ?? 'The diagnosis was skipped.')
                : (diagnosis.text ?? 'The diagnosis did not finish.')}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            {canRun
              ? 'No diagnosis yet. An agent can read the errors and suggest a cause.'
              : 'Nothing to diagnose while every check passes.'}
          </p>
        )}
      </div>
    </Section>
  );
}

function IncidentTimeline({
  incidents,
  now,
}: {
  incidents: readonly HealthIncident[];
  now: number;
}): React.JSX.Element {
  if (incidents.length === 0) {
    return <p className="text-xs text-muted-foreground">No incidents so far.</p>;
  }
  return (
    <ol aria-label="Incidents" className="relative space-y-3 pl-5">
      <span aria-hidden className="absolute bottom-1 left-[5px] top-1 w-px bg-foreground/10" />
      {incidents.map((one) => {
        const ongoing = one.resolvedAt === null;
        return (
          <li key={one.id} className="relative space-y-1">
            <span
              aria-hidden
              className={cn(
                'absolute -left-5 top-1 h-[11px] w-[11px] rounded-full ring-2 ring-background',
                ongoing ? 'bg-destructive' : 'bg-success',
              )}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Chip tone={ongoing ? 'destructive' : 'success'}>
                {ongoing
                  ? 'Ongoing'
                  : `Resolved after ${formatSpan(one.openedAt, one.resolvedAt ?? now)}`}
              </Chip>
              <span className="text-[11px] text-muted-foreground">
                {formatClock(one.openedAt)}
                {ongoing ? `, ${formatSpan(one.openedAt, now)} so far` : ''}
              </span>
            </div>
            <p className="break-words text-sm text-foreground">{one.summary}</p>
            <p className="text-[11px] text-muted-foreground">
              Opened as {HEALTH_STATE_META[one.state].label.toLowerCase()}
              {one.failingServices.length > 0 ? `: ${one.failingServices.join(', ')}` : ''}
            </p>
          </li>
        );
      })}
    </ol>
  );
}

function PanelShimmer(): React.JSX.Element {
  return (
    <div className="space-y-4 px-5 py-4" role="status" aria-label="Loading the target">
      <Skeleton className="h-16 w-full rounded-xl" />
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-32 w-full rounded-xl" />
      <Skeleton className="h-24 w-full rounded-xl" />
    </div>
  );
}

function reportNote(report: HealthReport | null): string | null {
  if (!report) return null;
  return report.problem ?? report.output ?? null;
}

export function HealthTargetDetail({
  targetId,
  onClose,
  onEdit,
  onSetup,
  projects,
  environmentName,
  now,
}: {
  targetId: string | null;
  onClose: () => void;
  onEdit: (target: HealthTargetSummary) => void;
  onSetup: (target: HealthTargetSummary) => void;
  projects: readonly Project[];
  environmentName?: string | null;
  now: number;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const detail = useHealthTarget(targetId);
  const actions = useHealthActions();
  const [fixOpen, setFixOpen] = useState(false);
  const [rotated, setRotated] = useState<HealthSecretReveal | null>(null);
  const [copying, setCopying] = useState(false);

  const data = detail.data ?? null;
  const target = data?.target ?? null;
  const report = data?.report ?? null;
  const project = target ? projects.find((one) => one.id === target.projectId) : undefined;
  const failing = (report?.services ?? []).filter(
    (service) => service.status !== 'pass' && service.error,
  );
  const incident = target?.openIncident ?? data?.incidents[0] ?? null;
  const problem = target ? healthBucket(target.state) === 'down' || target.state === 'warn' : false;
  const note = reportNote(report);
  const basic = target?.authMode === 'basic';

  async function copyForAi(): Promise<void> {
    if (!target) return;
    setCopying(true);
    try {
      const prompt = await queryClient.fetchQuery({
        queryKey: healthFixPromptKey(target.id),
        queryFn: async () => (await window.runova.health.fixPrompt(target.id)) ?? null,
        staleTime: 0,
      });
      if (prompt) copy(prompt, 'Prompt');
      else toast.info('Nothing is failing right now, so there is nothing to copy.');
    } catch (error) {
      toast.error('Could not build the prompt', {
        description: ipcErrorMessage(error, 'Something went wrong.'),
      });
    } finally {
      setCopying(false);
    }
  }

  async function rotate(one: HealthTargetSummary): Promise<void> {
    const noun = one.authMode === 'basic' ? 'password' : 'key';
    const confirmed = await confirmDialog({
      title: `Rotate the ${noun} for ${one.name}?`,
      description: `Runova makes a new ${noun} and the old one stops working right away. Checks fail until the server has the new hash.`,
      icon: Key,
      confirmLabel: `Rotate ${noun}`,
    });
    if (!confirmed) return;
    try {
      setRotated(await actions.rotateSecret(one.id));
    } catch (error) {
      toast.error(`Could not rotate the ${noun}`, {
        description: ipcErrorMessage(error, 'Something went wrong.'),
      });
    }
  }

  async function remove(one: HealthTargetSummary): Promise<void> {
    const confirmed = await confirmDialog({
      title: `Delete ${one.name}?`,
      description:
        'Runova stops checking it and forgets its history, incidents and key. The endpoint in your project stays as it is.',
      icon: Trash2,
      confirmLabel: 'Delete',
      variant: 'destructive',
    });
    if (!confirmed) return;
    try {
      await actions.remove.mutateAsync(one.id);
      onClose();
    } catch {
      // The mutation's toast says what went wrong; the panel stays open.
    }
  }

  return (
    <>
      <Dialog open={targetId !== null} onOpenChange={(open) => !open && onClose()}>
        <DialogContent
          className="left-auto right-0 top-0 flex h-full max-h-none w-[min(46rem,100vw)] max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none rounded-l-xl p-0 data-[state=closed]:zoom-out-100 data-[state=open]:zoom-in-100"
          aria-describedby={undefined}
        >
          {detail.isLoading ? (
            <>
              <DialogTitle className="sr-only">Loading the target</DialogTitle>
              <PanelShimmer />
            </>
          ) : !target ? (
            <>
              <DialogTitle className="sr-only">Target not found</DialogTitle>
              <EmptyState
                icon={HeartPulse}
                title={detail.isError ? 'Could not load this target' : 'This target is gone'}
                description={
                  detail.isError
                    ? ipcErrorMessage(detail.error, 'Something went wrong.')
                    : 'It may have been deleted in another window.'
                }
                action={
                  <Button size="sm" variant="soft" onClick={onClose}>
                    Close
                  </Button>
                }
              />
            </>
          ) : (
            <>
              <DialogHeader className="space-y-2 px-5 py-4 pr-12 shadow-[inset_0_-1px_0_hsl(var(--foreground)/0.08)]">
                <div className="flex flex-wrap items-center gap-2">
                  <DialogTitle className="text-lg font-semibold tracking-tight">
                    {target.name}
                  </DialogTitle>
                  <HealthStatusChip state={target.state} />
                </div>
                <DialogDescription asChild>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                    <span className="font-medium text-foreground/85">
                      {project?.name ?? 'Unknown project'}
                    </span>
                    {environmentName && <span>· {environmentName}</span>}
                    {target.serverLabel && (
                      <span className="inline-flex items-center gap-1">
                        · <Server className="h-3 w-3" /> {target.serverLabel}
                      </span>
                    )}
                    <span className="font-mono text-[11px]">· {targetHost(target.url)}</span>
                  </div>
                </DialogDescription>
                <div className="flex flex-wrap items-center gap-1.5 pt-1">
                  <Button
                    size="sm"
                    variant="soft"
                    disabled={actions.checkNow.isPending}
                    aria-busy={actions.checkNow.isPending}
                    onClick={() => actions.checkNow.mutate(target.id)}
                  >
                    {actions.checkNow.isPending ? (
                      <Spinner className="animate-spin" />
                    ) : (
                      <RefreshCw />
                    )}
                    Check now
                  </Button>
                  <SimpleTooltip
                    label={project ? undefined : 'The project for this target is missing.'}
                    wrapTrigger
                  >
                    <Button
                      size="sm"
                      variant="tint"
                      disabled={!project}
                      onClick={() => setFixOpen(true)}
                    >
                      <Wand2 />
                      Fix with AI
                    </Button>
                  </SimpleTooltip>
                  <Button
                    size="sm"
                    variant="soft"
                    disabled={copying}
                    onClick={() => void copyForAi()}
                  >
                    <Copy />
                    Copy for AI
                  </Button>
                  <Button
                    size="sm"
                    variant="soft"
                    disabled={actions.setPaused.isPending}
                    onClick={() =>
                      actions.setPaused.mutate({ targetId: target.id, paused: !target.paused })
                    }
                  >
                    {target.paused ? <Play /> : <Pause />}
                    {target.paused ? 'Resume' : 'Pause'}
                  </Button>
                  <DropdownMenu>
                    <SimpleTooltip label="More actions">
                      <DropdownMenuTrigger asChild>
                        <Button size="icon-sm" variant="ghost" aria-label="More actions">
                          <EllipsisVertical />
                        </Button>
                      </DropdownMenuTrigger>
                    </SimpleTooltip>
                    <DropdownMenuContent align="end" className="min-w-[12rem]">
                      <DropdownMenuItem onSelect={() => onEdit(target)}>
                        <Pencil className="h-3.5 w-3.5" />
                        Edit
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => onSetup(target)}>
                        <Sparkles className="h-3.5 w-3.5" />
                        Build the endpoint with AI
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => void rotate(target)}>
                        <Key className="h-3.5 w-3.5" />
                        {basic ? 'Rotate password' : 'Rotate key'}
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        className="text-destructive focus:text-destructive"
                        onSelect={() => void remove(target)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </DialogHeader>

              <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-5">
                {(target.state !== 'pass' || note) && (
                  <Notice
                    tone={
                      HEALTH_STATE_META[target.state].tone === 'success'
                        ? 'neutral'
                        : HEALTH_STATE_META[target.state].tone
                    }
                    size="sm"
                    action={
                      NO_ENDPOINT_YET.has(target.state) ? (
                        <Button size="xs" variant="soft" onClick={() => onSetup(target)}>
                          <Sparkles />
                          Build the endpoint with AI
                        </Button>
                      ) : undefined
                    }
                  >
                    <p className="font-medium">{HEALTH_STATE_META[target.state].hint}</p>
                    {note && (
                      <p className="mt-0.5 whitespace-pre-wrap break-words text-muted-foreground">
                        {note}
                      </p>
                    )}
                  </Notice>
                )}

                <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
                  <Fact label="Latency">{formatLatency(target.latencyMs)}</Fact>
                  <Fact label="Uptime, 24 h">{formatUptime(target.uptime24h)}</Fact>
                  <Fact label="Last check">
                    {target.lastCheckedAt === null ? 'Never' : formatAgo(target.lastCheckedAt, now)}
                  </Fact>
                  <Fact label="Next check">
                    {target.paused || target.nextCheckAt === null
                      ? 'Not scheduled'
                      : formatIn(target.nextCheckAt, now)}
                  </Fact>
                  <Fact label="Every">{formatHealthInterval(target.intervalSec)}</Fact>
                  <Fact label="Timeout">{target.timeoutSec} sec</Fact>
                  <Fact label="HTTP status">{report?.httpStatus ?? 'No answer'}</Fact>
                  <Fact label="Release">{report?.releaseId ?? report?.version ?? 'Not given'}</Fact>
                </dl>

                <Section title="History">
                  <UptimeStrip
                    samples={data?.samples ?? target.samples}
                    slots={100}
                    barClassName="h-8"
                  />
                  <p className="text-[11px] text-muted-foreground">
                    Each bar is one check, oldest on the left. Point at one for its time and
                    latency.
                  </p>
                </Section>

                <Section title="Response time, 24 h">
                  <HealthLatencyChart
                    latency={data?.latency ?? []}
                    incidents={data?.incidents ?? []}
                    now={now}
                  />
                </Section>

                {failing.length > 0 && (
                  <Section title="What is failing" icon={<TriangleAlert />}>
                    <div className="space-y-2">
                      {failing.map((service) => (
                        <ErrorPanel key={service.key} service={service} />
                      ))}
                    </div>
                  </Section>
                )}

                <Section title="Services">
                  {report ? (
                    <ServicesTable services={report.services} />
                  ) : (
                    <p className="text-xs text-muted-foreground">No report yet.</p>
                  )}
                </Section>

                <DiagnosisSection
                  diagnosis={incident?.diagnosis ?? null}
                  canRun={problem || incident !== null}
                  starting={actions.diagnose.isPending}
                  onRun={() => actions.diagnose.mutate(target.id)}
                  onCancel={() => actions.cancelDiagnose.mutate(target.id)}
                  now={now}
                />

                <Section title="Incidents">
                  <IncidentTimeline incidents={data?.incidents ?? []} now={now} />
                </Section>

                {report?.raw && (
                  <Disclosure
                    label="Raw response"
                    actions={
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() => copy(report.raw ?? '', 'Response')}
                      >
                        <Copy />
                        Copy response
                      </Button>
                    }
                  >
                    <pre className="max-h-80 overflow-auto rounded-xl bg-foreground/[0.04] p-3 font-mono text-[11px] leading-relaxed text-foreground/90 ring-1 ring-inset ring-foreground/[0.07]">
                      {report.raw}
                    </pre>
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      Keys, tokens and passwords are removed before the response is stored.
                    </p>
                  </Disclosure>
                )}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      {target && project && (
        <HealthFixDialog
          project={project}
          target={target}
          open={fixOpen}
          onOpenChange={setFixOpen}
        />
      )}
      <HealthSecretDialog reveal={rotated} onClose={() => setRotated(null)} />
    </>
  );
}
