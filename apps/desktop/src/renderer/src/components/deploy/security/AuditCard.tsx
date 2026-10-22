import { coreErrorMessage } from '@shared/coreErrors';
import type {
  AuditEventInfo,
  AuditVerificationInfo,
} from '@shared/deploy/protocol/generated/AgentMate.ServerCore.Contracts';
import type {
  DeployAuditExportFormat,
  DeployAuditFilter,
  DeployAuditResult,
} from '@shared/deploySecurityTypes';
import type { DeployServer } from '@shared/deployTypes';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import {
  Ban,
  CircleCheck,
  CircleX,
  Download,
  History,
  Minus,
  Shield,
  Spinner,
  TriangleAlert,
} from '@/components/icons';
import { Chip, type ChipTone, EmptyState, FOOTER_HAIRLINE } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { Notice } from '../deployKit';
import { dateTime } from './format';
import {
  CARD_BODY,
  LoadFailure,
  RowsSkeleton,
  SecurityCard,
  TABLE_CELL,
  TABLE_HEAD,
} from './SecurityCard';

const PAGE_SIZE = 50;

/** The core's actions come in groups by their first word; a prefix ending in a dot picks a group. */
const ACTIONS = [
  { value: '', label: 'Every action' },
  { value: 'auth.', label: 'Sign-ins and accounts' },
  { value: 'user.', label: 'Users' },
  { value: 'device.', label: 'Devices and enrollment' },
  { value: 'session.', label: 'Sessions' },
  { value: 'packages.', label: 'Package updates' },
  { value: 'service.', label: 'Service restarts' },
  { value: 'system.', label: 'Reboots' },
  { value: 'job.', label: 'Jobs' },
  { value: 'alert.', label: 'Alerts' },
  { value: 'admin.', label: 'Commands over SSH' },
] as const;

const RESULTS: ReadonlyArray<{ value: DeployAuditResult | ''; label: string }> = [
  { value: '', label: 'Any result' },
  { value: 'success', label: 'Succeeded' },
  { value: 'denied', label: 'Refused' },
  { value: 'failed', label: 'Failed' },
  { value: 'cancelled', label: 'Cancelled' },
];

const RANGES = [
  { value: 'all', label: 'Any time', ms: 0 },
  { value: '1h', label: 'Last hour', ms: 60 * 60_000 },
  { value: '24h', label: 'Last 24 hours', ms: 24 * 60 * 60_000 },
  { value: '7d', label: 'Last 7 days', ms: 7 * 24 * 60 * 60_000 },
  { value: '30d', label: 'Last 30 days', ms: 30 * 24 * 60 * 60_000 },
] as const;

interface Filters {
  action: string;
  actor: string;
  result: DeployAuditResult | '';
  range: (typeof RANGES)[number]['value'];
  /** Fixed when the range is picked, so the query (and its key) holds still. */
  fromUnixMs?: number;
}

const NO_FILTERS: Filters = { action: '', actor: '', result: '', range: 'all' };

function toFilter(filters: Filters): DeployAuditFilter {
  return {
    ...(filters.action ? { action: filters.action } : {}),
    ...(filters.actor ? { actor: filters.actor } : {}),
    ...(filters.result ? { result: filters.result } : {}),
    ...(filters.fromUnixMs === undefined ? {} : { fromUnixMs: filters.fromUnixMs }),
  };
}

const OUTCOME: Record<string, { label: string; icon: typeof CircleCheck; tone: ChipTone }> = {
  success: { label: 'Succeeded', icon: CircleCheck, tone: 'success' },
  denied: { label: 'Refused', icon: Ban, tone: 'warning' },
  failed: { label: 'Failed', icon: CircleX, tone: 'destructive' },
  cancelled: { label: 'Cancelled', icon: Minus, tone: 'neutral' },
};

/** Who acted, for a reader: a user, a removed one, nobody, or an admin command over SSH. */
function actor(event: AuditEventInfo): string {
  if (event.actorUserName) return event.actorUserName;
  if (event.actorUserId) return 'A removed user';
  try {
    const parameters = JSON.parse(event.parameters ?? '{}') as {
      via?: unknown;
      sudoUser?: unknown;
    };
    if (parameters.via === 'admin-cli') {
      return `Command over SSH (${typeof parameters.sudoUser === 'string' ? parameters.sudoUser : 'root'})`;
    }
  } catch {
    // Not JSON: nothing more to say about who.
  }
  return 'Nobody signed in';
}

function Outcome({ result }: { result: string }): React.JSX.Element {
  const outcome = OUTCOME[result] ?? { label: result, icon: Minus, tone: 'neutral' };
  const Icon = outcome.icon;
  return (
    <Chip tone={outcome.tone}>
      <Icon />
      {outcome.label}
    </Chip>
  );
}

function Verification({ result }: { result: AuditVerificationInfo }): React.JSX.Element {
  if (result.intact) {
    return (
      <Notice role="status" tone="success" icon={CircleCheck}>
        The trail is intact: all {result.checked.toLocaleString()} events check out. Each one still
        hashes to what the next one recorded.
      </Notice>
    );
  }
  return (
    <Notice role="alert" tone="destructive" icon={TriangleAlert}>
      The trail is broken at event {result.brokenAt}. That event, or one before it, was changed or
      removed after it was written. The {result.checked.toLocaleString()} events before it check
      out.
    </Notice>
  );
}

/**
 * A core's audit trail, for Admins and Owners: every sign-in, change and refusal, newest first, a
 * page at a time, filtered by who, what, result and time. The events come from whoever called
 * the core, so they are shown as text only. The trail can be saved to a file and its hash chain
 * checked.
 */
export function AuditCard({ server }: { server: DeployServer }): React.JSX.Element {
  const id = useId();
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [actorDraft, setActorDraft] = useState('');
  const [verification, setVerification] = useState<AuditVerificationInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [exporting, setExporting] = useState(false);
  const filter = toFilter(filters);

  const audit = useInfiniteQuery({
    queryKey: queryKeys.deployAudit(server.id, filter),
    queryFn: ({ pageParam }) =>
      window.agentmat.deploySecurity.queryAudit({
        serverId: server.id,
        ...filter,
        limit: PAGE_SIZE,
        ...(pageParam === undefined ? {} : { beforeId: pageParam }),
      }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => last.nextBeforeId,
    retry: false,
  });

  const set = (patch: Partial<Filters>) => setFilters((current) => ({ ...current, ...patch }));
  const commitActor = () => {
    if (actorDraft.trim() !== filters.actor) set({ actor: actorDraft.trim() });
  };

  async function verify(): Promise<void> {
    setChecking(true);
    try {
      setVerification(await window.agentmat.deploySecurity.verifyAudit(server.id));
    } catch (error) {
      toast.error(coreErrorMessage(error));
    } finally {
      setChecking(false);
    }
  }

  async function save(format: DeployAuditExportFormat): Promise<void> {
    setExporting(true);
    try {
      const saved = await window.agentmat.deploySecurity.exportAudit({
        serverId: server.id,
        format,
        filter,
      });
      if (saved.saved) {
        toast.success(
          `Saved ${(saved.count ?? 0).toLocaleString()} events to ${saved.path}.`,
          saved.truncated
            ? {
                description:
                  'More matched than one export holds, so the file has the newest. Narrow the filters to reach older ones.',
              }
            : {},
        );
      }
    } catch (error) {
      toast.error(coreErrorMessage(error));
    } finally {
      setExporting(false);
    }
  }

  const events = audit.data?.pages.flatMap((page) => page.events) ?? [];
  let body: React.ReactNode;
  if (audit.isPending) {
    body = <RowsSkeleton rows={4} />;
  } else if (audit.isError) {
    body = (
      <LoadFailure message={coreErrorMessage(audit.error)} onRetry={() => void audit.refetch()} />
    );
  } else if (events.length === 0) {
    body = (
      <div className={CARD_BODY}>
        <EmptyState
          size="sm"
          icon={History}
          title={
            Object.keys(filter).length > 0
              ? 'Nothing matches these filters.'
              : 'Nothing has been recorded yet.'
          }
        />
      </div>
    );
  } else {
    body = (
      <div>
        <div className="overflow-x-auto">
          {/* The caption comes first, so .settings-rows also draws the line above the headings. */}
          <table className="settings-rows w-full min-w-[40rem] border-collapse text-left text-xs">
            <caption className="sr-only">Audit events, newest first</caption>
            <thead>
              <tr>
                <th scope="col" className={TABLE_HEAD}>
                  When
                </th>
                <th scope="col" className={TABLE_HEAD}>
                  Who
                </th>
                <th scope="col" className={TABLE_HEAD}>
                  What
                </th>
                <th scope="col" className={TABLE_HEAD}>
                  On
                </th>
                <th scope="col" className={TABLE_HEAD}>
                  Result
                </th>
              </tr>
            </thead>
            <tbody className="settings-rows">
              {events.map((event) => (
                <tr
                  key={event.id}
                  className="align-top transition-colors hover:bg-foreground/[0.03]"
                >
                  <td className={cn(TABLE_CELL, 'whitespace-nowrap text-muted-foreground')}>
                    {dateTime(event.atUnixMs)}
                  </td>
                  <td className={TABLE_CELL}>
                    <span className="block text-foreground">{actor(event)}</span>
                    {event.deviceName && (
                      <span className="block text-muted-foreground">{event.deviceName}</span>
                    )}
                  </td>
                  <td className={cn(TABLE_CELL, 'max-w-[18rem]')}>
                    <span className="block font-mono text-foreground">{event.action}</span>
                    {event.parameters && (
                      <SimpleTooltip label={event.parameters} className="font-mono">
                        <span className="block truncate font-mono text-muted-foreground">
                          {event.parameters}
                        </span>
                      </SimpleTooltip>
                    )}
                  </td>
                  <td className={cn(TABLE_CELL, 'max-w-[12rem] truncate text-foreground')}>
                    {event.target ?? ''}
                  </td>
                  <td className={TABLE_CELL}>
                    <Outcome result={event.result} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {audit.hasNextPage && (
          <div className={cn(FOOTER_HAIRLINE, 'flex justify-center px-4 py-3')}>
            <Button
              size="sm"
              variant="soft"
              disabled={audit.isFetchingNextPage}
              onClick={() => void audit.fetchNextPage()}
            >
              {audit.isFetchingNextPage && (
                <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" />
              )}
              Load older events
            </Button>
          </div>
        )}
      </div>
    );
  }

  return (
    <SecurityCard
      icon={<History />}
      title="Audit trail"
      description="Every sign-in, change and refusal on this core, newest first. Each entry is chained to the one before it, so an edit or a deletion shows when the chain is checked."
      actions={
        <>
          <Button size="sm" variant="soft" disabled={checking} onClick={() => void verify()}>
            {checking ? (
              <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" />
            ) : (
              <Shield className="h-3.5 w-3.5" />
            )}
            Check the chain
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="soft" disabled={exporting}>
                <Download className="h-3.5 w-3.5" /> Export
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => void save('csv')}>As CSV</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void save('json')}>As JSON</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      }
    >
      <div className={cn(CARD_BODY, 'space-y-3')}>
        {verification && (
          <div className="space-y-1">
            <Verification result={verification} />
            <p className="text-xs text-muted-foreground">
              Someone with root on the server could still rewrite the whole file; the check shows
              any change short of that.
            </p>
          </div>
        )}
        <form
          className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
          onSubmit={(event) => {
            event.preventDefault();
            commitActor();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-actor`}>Who</Label>
            <Input
              id={`${id}-actor`}
              value={actorDraft}
              onChange={(event) => setActorDraft(event.target.value)}
              onBlur={commitActor}
              placeholder="A user name"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-action`}>Action</Label>
            <Combobox
              id={`${id}-action`}
              options={ACTIONS}
              value={filters.action}
              onChange={(action) => set({ action })}
              searchPlaceholder="Search actions…"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-result`}>Result</Label>
            <Combobox
              id={`${id}-result`}
              searchable={false}
              options={RESULTS}
              value={filters.result}
              onChange={(result) => set({ result: result as Filters['result'] })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-range`}>When</Label>
            <Combobox
              id={`${id}-range`}
              searchable={false}
              options={RANGES}
              value={filters.range}
              onChange={(value) => {
                const range = RANGES.find((option) => option.value === value);
                set({
                  range: range?.value ?? 'all',
                  fromUnixMs: range?.ms ? Date.now() - range.ms : undefined,
                });
              }}
            />
          </div>
        </form>
      </div>
      {body}
    </SecurityCard>
  );
}
