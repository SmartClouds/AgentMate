import type {
  AlertInfo,
  AlertSeverity,
} from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { Bell, Check, CircleInfo, CircleX, TriangleAlert } from '@/components/icons';
import { Chip, type ChipTone } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { shortAge } from '@/lib/time';
import { cn } from '@/lib/utils';
import { DeployCard, LIST_ROW, LIST_WELL } from '../deployKit';

/** Open alerts from the core: disk pressure, failed jobs, a reboot waiting. */

const SEVERITY: Record<
  AlertSeverity,
  { label: string; icon: typeof Bell; tone: string; chip: ChipTone }
> = {
  critical: { label: 'Critical', icon: CircleX, tone: 'text-destructive', chip: 'destructive' },
  warning: { label: 'Warning', icon: TriangleAlert, tone: 'text-warning', chip: 'warning' },
  info: { label: 'Info', icon: CircleInfo, tone: 'text-muted-foreground', chip: 'neutral' },
};

export function AlertsCard({
  alerts,
  ready,
  error,
  now,
  acknowledging,
  onAcknowledge,
}: {
  alerts: AlertInfo[];
  ready: boolean;
  error: string | null;
  now: number;
  acknowledging: number | null;
  /** Shown to Operators and above. */
  onAcknowledge?: (alert: AlertInfo) => void;
}): React.JSX.Element {
  return (
    <DeployCard
      icon={<Bell />}
      title="Alerts"
      extra={
        ready && alerts.length > 0 ? (
          <Chip tone="warning" className="tabular-nums">
            {alerts.length} open
          </Chip>
        ) : undefined
      }
    >
      {!ready ? (
        <div aria-busy="true">
          <Skeleton className="h-10 w-full rounded-lg" />
        </div>
      ) : error && alerts.length === 0 ? (
        <p role="alert" className="text-sm text-muted-foreground">
          The alerts did not load: {error}
        </p>
      ) : alerts.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Check className="h-3.5 w-3.5 text-success" /> No open alerts.
        </p>
      ) : (
        <ul aria-label="Open alerts" className={LIST_WELL}>
          {alerts.map((alert) => {
            const severity = SEVERITY[alert.severity];
            const Icon = severity.icon;
            return (
              <li key={alert.id} className={cn(LIST_ROW, 'flex items-start gap-3')}>
                <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', severity.tone)} />
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="text-sm text-foreground">{alert.message}</p>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <Chip tone={severity.chip}>{severity.label}</Chip>
                    <span>
                      {alert.occurrences > 1 ? `${alert.occurrences} times, last ` : ''}
                      {shortAge(alert.lastSeenAtUnixMs, now)} ago
                    </span>
                    {alert.acknowledgedAtUnixMs !== undefined && (
                      <span>
                        Acknowledged{alert.acknowledgedBy ? ` by ${alert.acknowledgedBy}` : ''}
                      </span>
                    )}
                  </div>
                </div>
                {onAcknowledge && alert.acknowledgedAtUnixMs === undefined && (
                  <Button
                    size="sm"
                    variant="soft"
                    disabled={acknowledging === alert.id}
                    onClick={() => onAcknowledge(alert)}
                  >
                    <Check /> Acknowledge
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </DeployCard>
  );
}
