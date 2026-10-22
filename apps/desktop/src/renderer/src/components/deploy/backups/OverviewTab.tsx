import { coreErrorMessage } from '@shared/coreErrors';
import type { DeployServer } from '@shared/deployTypes';
import { useState } from 'react';
import { Archive, CalendarDays, Key } from '@/components/icons';
import { Chip, Notice } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { ago, fromNow } from '../security/format';
import {
  CARD_BODY,
  CARD_ROWS,
  LoadFailure,
  RowsSkeleton,
  SecurityCard,
} from '../security/SecurityCard';
import type { StepUp } from '../security/useStepUp';
import { BackUpNowDialog } from './BackUpNowDialog';
import type { BackupsTab } from './BackupsPanel';
import { describeCron, RUN_STATE } from './format';
import { useBackupPlans, useBackupSecret } from './hooks';
import { RunHistory } from './RunHistory';

/**
 * The Backups section's first tab: whether a secret key is set (nothing can be made without one),
 * Back up now, when each plan last ran and runs next, and the history.
 */
export function OverviewTab({
  server,
  stepUp,
  onOpenTab,
}: {
  server: DeployServer;
  stepUp: StepUp;
  onOpenTab: (tab: BackupsTab) => void;
}): React.JSX.Element {
  const secret = useBackupSecret(server.id);
  const plans = useBackupPlans(server.id);
  const [backingUp, setBackingUp] = useState(false);
  const noSecret = secret.data !== undefined && !secret.data.isSet;

  return (
    <>
      {noSecret && (
        <Notice tone="warning" icon={Key} className="text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>
              No secret key yet. Backups are encrypted with a secret key only you know, so none can
              be made until you set one.
            </span>
            <Button size="sm" variant="soft" onClick={() => onOpenTab('secret')}>
              Set the secret key
            </Button>
          </div>
        </Notice>
      )}
      <SecurityCard
        icon={<Archive />}
        title="Back up now"
        description="The whole server: the panel's data and keys, its settings, the apps and their volumes, images that cannot be pulled again, standalone containers and the firewall rules. Encrypted on the server with your secret key."
      >
        <div className={cn(CARD_BODY, 'flex flex-wrap items-center gap-2')}>
          {secret.isPending ? (
            <Skeleton className="h-8 w-32 rounded-full" />
          ) : (
            <Button size="sm" disabled={!secret.data?.isSet} onClick={() => setBackingUp(true)}>
              <Archive className="h-3.5 w-3.5" /> Back up now
            </Button>
          )}
          {secret.isError && (
            <span role="alert" className="text-xs text-destructive">
              {coreErrorMessage(secret.error)}
            </span>
          )}
        </div>
      </SecurityCard>
      <SecurityCard
        icon={<CalendarDays />}
        title="Plans"
        description="Backups on a schedule. They run on the server, with this app closed too."
        actions={
          <Button size="sm" variant="soft" onClick={() => onOpenTab('plans')}>
            Manage plans
          </Button>
        }
      >
        {plans.isPending ? (
          <RowsSkeleton rows={2} />
        ) : plans.isError ? (
          <LoadFailure
            message={coreErrorMessage(plans.error)}
            onRetry={() => void plans.refetch()}
          />
        ) : plans.data.length === 0 ? (
          <p className={cn(CARD_BODY, 'text-sm text-muted-foreground')}>
            No plans yet. A plan backs up on a schedule and keeps the last few on each destination.
          </p>
        ) : (
          <ul aria-label="Plans" className={CARD_ROWS}>
            {plans.data.map((plan) => (
              <li key={plan.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-foreground">{plan.name}</span>
                  <span className="block text-xs text-muted-foreground">
                    {describeCron(plan.cron)} ({plan.timeZone})
                  </span>
                </span>
                <span className="text-xs text-muted-foreground">
                  {plan.lastRun ? (
                    <>
                      Last run {ago(plan.lastRun.startedAtUnixMs)}{' '}
                      <Chip tone={RUN_STATE[plan.lastRun.state].tone}>
                        {RUN_STATE[plan.lastRun.state].label}
                      </Chip>
                    </>
                  ) : (
                    'Not run yet'
                  )}
                </span>
                <span className="text-xs text-muted-foreground">
                  {!plan.enabled
                    ? 'Paused'
                    : plan.nextRunAtUnixMs
                      ? `Next run ${fromNow(plan.nextRunAtUnixMs)}`
                      : 'Next run not known'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </SecurityCard>
      <RunHistory serverId={server.id} />
      <BackUpNowDialog
        server={server}
        open={backingUp}
        stepUp={stepUp}
        onOpenChange={setBackingUp}
      />
    </>
  );
}
