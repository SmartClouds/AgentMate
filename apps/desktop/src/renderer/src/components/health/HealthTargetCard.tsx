import type { HealthServiceResult } from '@runova/core';
import type { HealthTargetSummary } from '@shared/healthTypes';
import { useId, useState } from 'react';
import { ChevronDown, Server, TriangleAlert } from '@/components/icons';
import { Chip, GLASS_CARD, SECTION_HEADING } from '@/components/pageKit';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { HealthStatusChip } from './HealthStatusChip';
import {
  formatAgo,
  formatIn,
  formatLatency,
  formatObserved,
  formatUptime,
  healthBucket,
  SERVICE_STATUS_META,
  targetHost,
} from './healthView';
import { UptimeStrip } from './UptimeStrip';
import { useHealthTarget } from './useHealth';

/**
 * One watched endpoint on the Health page: what it is and where it runs, how it is doing now,
 * its last fifty checks, and the problem in a line when there is one. The name opens the detail
 * panel; the services row unfolds the per-check results, which are only read when asked for.
 */

const EDGE: Record<ReturnType<typeof healthBucket>, string> = {
  healthy: '',
  degraded: 'ring-1 ring-inset ring-warning/25',
  down: 'ring-1 ring-inset ring-destructive/30',
  paused: '',
  pending: '',
};

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 space-y-0.5">
      <dt className={SECTION_HEADING}>{label}</dt>
      <dd className="truncate text-xs font-medium tabular-nums text-foreground">{children}</dd>
    </div>
  );
}

export function ServiceRows({
  services,
  label = 'Services',
}: {
  services: readonly HealthServiceResult[];
  label?: string;
}): React.JSX.Element {
  if (services.length === 0) {
    return <p className="px-1 py-2 text-xs text-muted-foreground">The endpoint lists no checks.</p>;
  }
  return (
    <ul aria-label={label} className="divide-y divide-foreground/[0.06]">
      {services.map((service) => {
        const meta = SERVICE_STATUS_META[service.status];
        const observed = formatObserved(service.observedValue, service.observedUnit);
        return (
          <li key={service.key} className="flex items-center gap-2 px-1 py-1.5">
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground/90">
              {service.key}
            </span>
            {observed && (
              <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                {observed}
              </span>
            )}
            <Chip tone={meta.tone} dot>
              {meta.label}
            </Chip>
          </li>
        );
      })}
    </ul>
  );
}

function CardServices({ targetId }: { targetId: string }): React.JSX.Element {
  const detail = useHealthTarget(targetId);
  if (detail.isLoading) {
    return (
      <div className="space-y-2 px-1 py-1.5" role="status" aria-label="Loading services">
        <Skeleton className="h-3 w-3/4" />
        <Skeleton className="h-3 w-2/3" />
      </div>
    );
  }
  const services = detail.data?.report?.services ?? [];
  if (detail.isError || !detail.data?.report) {
    return (
      <p className="px-1 py-2 text-xs text-muted-foreground">
        {detail.isError ? 'Could not read the last report.' : 'No report yet.'}
      </p>
    );
  }
  return <ServiceRows services={services} />;
}

export function HealthTargetCard({
  target,
  now,
  onOpen,
  selected = false,
}: {
  target: HealthTargetSummary;
  now: number;
  onOpen: (targetId: string) => void;
  selected?: boolean;
}): React.JSX.Element {
  const titleId = useId();
  const servicesId = useId();
  const [expanded, setExpanded] = useState(false);
  const bucket = healthBucket(target.state);
  const scheduled = !target.paused && target.state !== 'locked' && target.nextCheckAt !== null;

  return (
    <article
      aria-labelledby={titleId}
      className={cn(
        GLASS_CARD,
        'group relative flex min-w-0 flex-col gap-3 p-3.5 transition-shadow',
        EDGE[bucket],
        selected && 'ring-2 ring-inset ring-primary/40',
      )}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <h4 id={titleId} className="truncate text-sm font-semibold leading-tight">
            <button
              type="button"
              aria-label={`Open ${target.name}`}
              onClick={() => onOpen(target.id)}
              className="cursor-pointer rounded-sm text-left outline-none after:absolute after:inset-0 after:rounded-[inherit] after:content-[''] hover:text-primary focus-visible:after:ring-2 focus-visible:after:ring-ring"
            >
              {target.name}
            </button>
          </h4>
          <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            {target.serverLabel && (
              <>
                <Server className="h-3 w-3 shrink-0" />
                <span className="shrink-0 font-medium text-foreground/80">
                  {target.serverLabel}
                </span>
                <span aria-hidden className="text-muted-foreground/50">
                  ·
                </span>
              </>
            )}
            <span className="truncate font-mono text-[11px]">{targetHost(target.url)}</span>
          </div>
        </div>
        <HealthStatusChip state={target.state} />
      </div>

      <dl className="grid grid-cols-3 gap-2">
        <Fact label="Latency">{formatLatency(target.latencyMs)}</Fact>
        <Fact label="Checked">
          {target.lastCheckedAt === null ? 'Never' : formatAgo(target.lastCheckedAt, now)}
        </Fact>
        <Fact label="Next">
          {scheduled && target.nextCheckAt !== null
            ? formatIn(target.nextCheckAt, now)
            : 'Not scheduled'}
        </Fact>
      </dl>

      <div className="space-y-1.5">
        <UptimeStrip samples={target.samples} className="relative z-10" />
        <div className="flex items-center justify-between text-[11px] text-muted-foreground">
          <span>Last {Math.min(50, Math.max(target.samples.length, 1))} checks</span>
          <span className="tabular-nums">
            <span className="font-medium text-foreground/85">{formatUptime(target.uptime24h)}</span>{' '}
            uptime, 24 h
          </span>
        </div>
      </div>

      {target.headline && (
        <p
          className={cn(
            'flex items-start gap-1.5 rounded-lg px-2.5 py-1.5 text-xs ring-1 ring-inset',
            bucket === 'degraded'
              ? 'bg-warning/10 text-foreground ring-warning/25 [&_svg]:text-warning'
              : 'bg-destructive/[0.08] text-foreground ring-destructive/25 [&_svg]:text-destructive',
          )}
        >
          <TriangleAlert className="mt-px h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 break-words">{target.headline}</span>
        </p>
      )}

      {target.servicesTotal > 0 && (
        <div className="relative z-10 -mx-1">
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={servicesId}
            onClick={() => setExpanded((open) => !open)}
            className="flex w-full cursor-pointer items-center gap-1.5 rounded-lg px-1 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronDown
              className={cn('h-3 w-3 transition-transform', !expanded && '-rotate-90')}
            />
            <span>
              {target.servicesTotal} service{target.servicesTotal === 1 ? '' : 's'}
              {target.servicesFailing > 0 ? `, ${target.servicesFailing} failing` : ', all passing'}
            </span>
          </button>
          <div id={servicesId} hidden={!expanded}>
            {expanded && <CardServices targetId={target.id} />}
          </div>
        </div>
      )}
    </article>
  );
}

/** The card's shape while the first list loads, so the page does not jump when it lands. */
export function HealthTargetCardSkeleton(): React.JSX.Element {
  return (
    <div
      className={cn(GLASS_CARD, 'flex flex-col gap-3 p-3.5')}
      aria-hidden
      data-testid="health-card-skeleton"
    >
      <div className="flex items-start gap-3">
        <div className="flex-1 space-y-2">
          <Skeleton className="h-3.5 w-28" />
          <Skeleton className="h-3 w-44" />
        </div>
        <Skeleton className="h-5 w-16 rounded-full" />
      </div>
      <div className="grid grid-cols-3 gap-2">
        <Skeleton className="h-6" />
        <Skeleton className="h-6" />
        <Skeleton className="h-6" />
      </div>
      <Skeleton className="h-6 w-full" />
    </div>
  );
}
