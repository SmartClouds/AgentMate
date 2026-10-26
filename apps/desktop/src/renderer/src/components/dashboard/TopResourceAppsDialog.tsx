import type { TopResourceApp, TopResourceKind } from '@shared/apiTypes';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { StopCircle } from '@/components/icons';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { formatPercent } from '@/lib/format';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { confirmDialog } from '@/stores/confirmStore';

const COPY: Record<
  TopResourceKind,
  { title: string; description: string; empty: string; unavailable: string }
> = {
  cpu: {
    title: 'Top CPU apps',
    description: 'Apps using the most CPU right now, updated every few seconds.',
    empty: 'No process is using a measurable amount of CPU.',
    unavailable: "Couldn't read CPU process usage on this system.",
  },
  gpu: {
    title: 'Top GPU apps',
    description: 'Apps using the most GPU right now, updated every few seconds.',
    empty: 'No apps are using the GPU right now.',
    unavailable: "This system doesn't report which apps are using the GPU.",
  },
  memory: {
    title: 'Top memory apps',
    description: 'Apps using the most RAM right now, updated every few seconds.',
    empty: 'No process is using a measurable amount of memory.',
    unavailable: "Couldn't read memory process usage on this system.",
  },
  disk: {
    title: 'Top disk apps',
    description: 'Apps doing the most disk I/O right now, updated every few seconds.',
    empty: 'No process is doing measurable disk I/O.',
    unavailable: "This system doesn't report which apps are using the disk.",
  },
};

function formatMem(bytes: number): string {
  if (bytes < 1024 ** 2) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function formatBytesPerSec(value: number): string {
  if (value < 1024) return `${value.toFixed(0)} B/s`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB/s`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB/s`;
}

function AppMonogram({ name }: { name: string }): React.JSX.Element {
  const letter = name.match(/[A-Za-z0-9]/)?.[0]?.toUpperCase() ?? '?';
  return (
    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-sm bg-primary/15 text-[10px] font-semibold text-primary">
      {letter}
    </span>
  );
}

function AppRow({
  app,
  barMax,
  valueMode,
  onKill,
  killing,
}: {
  app: TopResourceApp;
  barMax: number;
  valueMode: 'percent' | 'memory' | 'rate';
  onKill: (app: TopResourceApp) => void;
  killing: boolean;
}): React.JSX.Element {
  const value =
    valueMode === 'memory'
      ? (app.memBytes ?? 0)
      : valueMode === 'rate'
        ? (app.rateBytesPerSec ?? 0)
        : app.percent;
  const width = barMax > 0 ? Math.max(2, Math.min(100, (value / barMax) * 100)) : 0;
  const readout =
    valueMode === 'memory' && app.memBytes != null
      ? formatMem(app.memBytes)
      : valueMode === 'rate' && app.rateBytesPerSec != null
        ? formatBytesPerSec(app.rateBytesPerSec)
        : formatPercent(app.percent);
  const meta = [
    app.processCount > 1 ? `${app.processCount} processes` : `PID ${app.pid}`,
    valueMode !== 'memory' && app.memBytes != null && app.memBytes > 0
      ? formatMem(app.memBytes)
      : null,
  ].filter(Boolean);

  return (
    <div className="flex items-start gap-2 py-2">
      {app.iconDataUrl ? (
        <img src={app.iconDataUrl} alt="" className="mt-0.5 h-5 w-5 shrink-0 rounded-sm" />
      ) : (
        <span className="mt-0.5">
          <AppMonogram name={app.name} />
        </span>
      )}
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-baseline justify-between gap-3">
          <span className="truncate text-sm font-medium">{app.name}</span>
          <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
            {readout}
          </span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-foreground/10">
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-500"
            style={{ width: `${width}%` }}
          />
        </div>
        <div className="truncate text-[11px] text-muted-foreground">{meta.join(' · ')}</div>
      </div>
      <SimpleTooltip label={`End ${app.name}`}>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="mt-0.5 hover:text-destructive"
          disabled={killing}
          aria-label={`End ${app.name}`}
          onClick={() => onKill(app)}
        >
          <StopCircle className="h-3.5 w-3.5" />
        </Button>
      </SimpleTooltip>
    </div>
  );
}

export function TopResourceAppsDialog({
  open,
  onOpenChange,
  resource,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  resource: TopResourceKind;
}): React.JSX.Element {
  const copy = COPY[resource];
  const queryClient = useQueryClient();
  const [killingPid, setKillingPid] = useState<number | null>(null);
  const query = useQuery({
    queryKey: queryKeys.topResourceApps(resource),
    queryFn: () => window.runova.system.topApps(resource),
    enabled: open,
    refetchInterval: open ? 2000 : false,
    meta: { silentLoading: true },
  });

  const apps = query.data?.apps ?? [];
  const available = query.data?.available ?? true;
  const valueMode: 'percent' | 'memory' | 'rate' =
    resource === 'memory'
      ? 'memory'
      : resource === 'disk'
        ? 'rate'
        : resource === 'gpu' &&
            apps.length > 0 &&
            apps.every((app) => app.percent <= 0) &&
            apps.some((app) => (app.memBytes ?? 0) > 0)
          ? 'memory'
          : 'percent';
  const barMax =
    valueMode === 'memory'
      ? Math.max(...apps.map((app) => app.memBytes ?? 0), 1)
      : valueMode === 'rate'
        ? Math.max(...apps.map((app) => app.rateBytesPerSec ?? 0), 1)
        : Math.max(...apps.map((app) => app.percent), 1);
  const showSkeleton = query.isPending && apps.length === 0;

  async function handleKill(app: TopResourceApp): Promise<void> {
    const confirmed = await confirmDialog({
      title: `End ${app.name}?`,
      description:
        app.processCount > 1
          ? `This ends process ${app.pid}. ${app.name} may still have other processes running.`
          : `This ends ${app.name} (PID ${app.pid}). Unsaved work in that app may be lost.`,
      confirmLabel: 'End process',
      variant: 'destructive',
    });
    if (!confirmed) return;
    setKillingPid(app.pid);
    try {
      const result = await window.runova.system.killProcess(app.pid);
      if (!result.ok) {
        toast.error(result.error ?? `Could not end ${app.name}.`);
        return;
      }
      toast.success(`Ended ${app.name}.`);
      await queryClient.invalidateQueries({ queryKey: queryKeys.topResourceApps(resource) });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : `Could not end ${app.name}.`);
    } finally {
      setKillingPid(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.description}</DialogDescription>
        </DialogHeader>
        <ScrollArea
          className={cn(
            'min-h-0',
            showSkeleton || apps.length > 0 ? 'h-[min(22rem,50vh)]' : 'h-auto',
          )}
        >
          {showSkeleton ? (
            <div className="space-y-3 py-1">
              {Array.from({ length: 6 }, (_, i) => (
                <div key={i} className="flex items-start gap-2">
                  <Skeleton className="mt-0.5 h-5 w-5 rounded-sm" />
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <div className="flex justify-between">
                      <Skeleton className="h-4 w-28" />
                      <Skeleton className="h-3 w-10" />
                    </div>
                    <Skeleton className="h-1.5 w-full rounded-full" />
                    <Skeleton className="h-3 w-24" />
                  </div>
                </div>
              ))}
            </div>
          ) : query.isError ? (
            <p className="py-6 text-sm text-muted-foreground">
              Couldn&apos;t read process usage. Close this and try again.
            </p>
          ) : !available ? (
            <p className="py-6 text-sm text-muted-foreground">{copy.unavailable}</p>
          ) : apps.length === 0 ? (
            <p className="py-6 text-sm text-muted-foreground">{copy.empty}</p>
          ) : (
            <div className="divide-y divide-border/60 pr-3">
              {apps.map((app) => (
                <AppRow
                  key={`${app.name}-${app.pid}`}
                  app={app}
                  barMax={barMax}
                  valueMode={valueMode}
                  killing={killingPid === app.pid}
                  onKill={(target) => void handleKill(target)}
                />
              ))}
            </div>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
