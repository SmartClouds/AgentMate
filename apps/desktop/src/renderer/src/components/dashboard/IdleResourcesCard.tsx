import { type ActivityResource, formatIdleDuration } from '@runova/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import { IdleMinutesInput } from '@/components/dashboard/IdleMinutesInput';
import { useStopIdleResources } from '@/components/dashboard/useStopIdleResources';
import {
  Android,
  Clock,
  Docker,
  RefreshCw,
  SettingsIcon,
  Spinner,
  StopCircle,
  X,
} from '@/components/icons';
import { TileHeader } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { useIdleResourceSettings } from '@/hooks/useIdleResourceSettings';
import { useResourceActivity } from '@/hooks/useResourceActivity';
import { formatBytes, formatPercent } from '@/lib/format';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';

/** Tall enough for three rows, which is what the chart slot beside it has room for. */
const ROW_HEIGHT = 28;

function usageLine(resource: ActivityResource): string {
  const cpu =
    resource.cpuPercent === null ? 'CPU unknown' : `CPU ${formatPercent(resource.cpuPercent)}`;
  const memory = resource.memBytes === null ? null : `Memory ${formatBytes(resource.memBytes)}`;
  return [cpu, memory].filter(Boolean).join(' · ');
}

function IdleRow({
  resource,
  stopping,
  onStop,
}: {
  resource: ActivityResource;
  stopping: boolean;
  onStop: () => void;
}): React.JSX.Element {
  const Icon = resource.kind === 'docker' ? Docker : Android;
  const details = (
    <span className="block max-w-64 space-y-0.5">
      <span className="block break-all font-medium">{resource.name}</span>
      {resource.detail ? (
        <span className="block break-all text-muted-foreground">{resource.detail}</span>
      ) : null}
      <span className="block text-muted-foreground">{usageLine(resource)}</span>
    </span>
  );
  return (
    <div className="flex items-center gap-2 text-sm" style={{ height: ROW_HEIGHT }}>
      <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <SimpleTooltip label={details}>
        <span className="min-w-0 flex-1 truncate">{resource.name}</span>
      </SimpleTooltip>
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
        idle {formatIdleDuration(resource.idleForMs)}
      </span>
      <SimpleTooltip label={`Stop ${resource.name}`}>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Stop ${resource.name}`}
          disabled={stopping}
          onClick={onStop}
        >
          {stopping ? <Spinner className="animate-spin" /> : <StopCircle />}
        </Button>
      </SimpleTooltip>
    </div>
  );
}

function Message({ height, children }: { height: number; children: ReactNode }): React.JSX.Element {
  return (
    <div
      className="flex items-center justify-center px-2 text-center text-sm text-muted-foreground"
      style={{ height }}
    >
      {children}
    </div>
  );
}

/**
 * Running containers and emulators that nothing has touched for the chosen time, each with a Stop
 * button. "Touched" is the tracker's judgement (CPU, plus network and disk for containers), made
 * in the main process so it keeps counting while this page is closed.
 */
export function IdleResourcesCard({
  className,
  dragHandle,
  onRemove,
  chartHeight,
}: {
  className?: string;
  dragHandle?: ReactNode;
  onRemove?: () => void;
  chartHeight: number;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const query = useResourceActivity();
  const settings = useIdleResourceSettings();
  const { pendingKeys, stopOne, stopAll } = useStopIdleResources();

  const refresh = useMutation({
    mutationFn: () => window.runova.resourceActivity.snapshot({ fresh: true }),
    meta: { silentLoading: true },
    onSuccess: (snapshot) => queryClient.setQueryData(queryKeys.resourceActivity, snapshot),
    onError: () => toast.error('Could not refresh Docker and emulator usage.'),
  });

  const snapshot = query.data;
  const resources = snapshot?.resources ?? [];
  const idle = resources.filter((one) => one.idle);
  const unmeasured = resources.filter((one) => !one.measurable).length;
  const idleMinutes = settings.loaded
    ? settings.minutes
    : (snapshot?.idleMinutes ?? settings.minutes);
  const idleLabel = formatIdleDuration(idleMinutes * 60_000);

  const notes: string[] = [];
  if (snapshot) {
    notes.push(`Idle after ${idleLabel}`);
    const watchedMs = snapshot.generatedAt - snapshot.watchingSince;
    if (watchedMs < idleMinutes * 60_000) {
      notes.push(`watching for ${formatIdleDuration(watchedMs)}`);
    }
    if (snapshot.docker === 'unavailable' && resources.length > 0)
      notes.push('Docker is not running');
    if (unmeasured > 0) {
      notes.push(`${unmeasured} emulator${unmeasured === 1 ? '' : 's'} can't be measured`);
    }
  }

  let body: ReactNode;
  if (!snapshot) {
    body = query.isError ? (
      <Message height={chartHeight}>Could not read Docker and emulator usage.</Message>
    ) : (
      <div className="space-y-0" style={{ height: chartHeight }}>
        {[0, 1, 2].map((slot) => (
          <div key={slot} className="flex items-center" style={{ height: ROW_HEIGHT }}>
            <Skeleton className="h-4 w-full" />
          </div>
        ))}
      </div>
    );
  } else if (resources.length === 0) {
    body = (
      <Message height={chartHeight}>
        {snapshot.docker === 'unavailable' ? 'Docker is not running.' : 'Nothing is running.'}
      </Message>
    );
  } else if (idle.length === 0) {
    body = (
      <Message height={chartHeight}>
        Nothing idle. Everything running was active in the last {idleLabel}.
      </Message>
    );
  } else {
    body = (
      <div className="overflow-y-auto overscroll-contain" style={{ height: chartHeight }}>
        {idle.map((resource) => (
          <IdleRow
            key={resource.key}
            resource={resource}
            stopping={pendingKeys.has(resource.key)}
            onStop={() => stopOne(resource)}
          />
        ))}
      </div>
    );
  }

  return (
    <div className={className}>
      <div className="flex h-full flex-col p-4">
        <TileHeader
          className="mb-2"
          icon={<Clock />}
          title="Idle Docker and Emulators"
          actions={
            <>
              <Popover>
                <SimpleTooltip label="Idle settings">
                  <PopoverTrigger asChild>
                    <Button variant="ghost" size="icon-sm" aria-label="Idle settings">
                      <SettingsIcon className="h-3.5 w-3.5" />
                    </Button>
                  </PopoverTrigger>
                </SimpleTooltip>
                <PopoverContent className="w-72 space-y-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="idle-card-minutes" className="text-xs">
                      List as idle after
                    </Label>
                    <div className="flex items-center gap-2">
                      <IdleMinutesInput
                        id="idle-card-minutes"
                        value={idleMinutes}
                        onCommit={settings.setMinutes}
                      />
                      <span className="text-xs text-muted-foreground">minutes (1 to 1440)</span>
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <Label htmlFor="idle-card-notify" className="text-xs">
                      Notify me when something goes idle
                    </Label>
                    <Switch
                      id="idle-card-notify"
                      checked={settings.notify}
                      onCheckedChange={settings.setNotify}
                    />
                  </div>
                </PopoverContent>
              </Popover>
              <SimpleTooltip label="Check again now">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Check again now"
                  disabled={refresh.isPending}
                  onClick={() => refresh.mutate()}
                >
                  <RefreshCw className={cn('h-3.5 w-3.5', refresh.isPending && 'animate-spin')} />
                </Button>
              </SimpleTooltip>
              {dragHandle}
              {onRemove && (
                <SimpleTooltip label="Remove from dashboard">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Remove from dashboard"
                    onClick={onRemove}
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </SimpleTooltip>
              )}
            </>
          }
        />
        <div className="mb-2 flex h-8 items-center justify-between gap-3">
          {snapshot ? (
            <>
              <div className="flex min-w-0 items-baseline gap-2">
                <span className="text-2xl font-semibold tabular-nums">{idle.length}</span>
                <span className="truncate text-xs text-muted-foreground">
                  idle of {resources.length} running
                </span>
              </div>
              {idle.length >= 2 ? (
                <Button
                  variant="soft"
                  size="xs"
                  className="shrink-0"
                  disabled={idle.some((one) => pendingKeys.has(one.key))}
                  onClick={() => void stopAll(idle, idleMinutes)}
                >
                  Stop all idle
                </Button>
              ) : null}
            </>
          ) : (
            <>
              <Skeleton className="h-8 w-16 self-center" />
              <Skeleton className="h-3 w-28 self-center" />
            </>
          )}
        </div>
        <div className="mb-2 flex h-6 items-center">
          {snapshot ? (
            <SimpleTooltip label={notes.join(' · ')}>
              <span className="truncate text-xs text-muted-foreground">{notes.join(' · ')}</span>
            </SimpleTooltip>
          ) : (
            <Skeleton className="h-3 w-40" />
          )}
        </div>
        {body}
      </div>
    </div>
  );
}
