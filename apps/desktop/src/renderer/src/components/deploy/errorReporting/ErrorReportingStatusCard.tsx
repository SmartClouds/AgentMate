import { coreErrorMessage } from '@shared/coreErrors';
import type {
  DeployErrorReportingStatus,
  DeployErrorReportingTestResult,
} from '@shared/deployErrorReportingTypes';
import type { UseQueryResult } from '@tanstack/react-query';
import {
  Bug,
  CircleCheck,
  CircleX,
  Clock,
  Pause,
  Send,
  Spinner,
  TriangleAlert,
} from '@/components/icons';
import { Chip, EmptyState, Notice } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { FactRow } from '../deployKit';
import { ago } from '../security/format';
import { CARD_BODY, LoadFailure, SecurityCard } from '../security/SecurityCard';
import {
  destinationOf,
  GET_A_DSN_STEPS,
  levelLabel,
  PRIVACY_NOTE,
  type ReportingStateKey,
  reportingState,
} from './messages';

const MARKS: Record<ReportingStateKey, React.ComponentType<{ className?: string }>> = {
  off: CircleX,
  paused: Pause,
  waiting: Clock,
  sending: CircleCheck,
  failing: TriangleAlert,
};

/** The sentence a core without this feature ends up as, so the card can offer the update. */
const OLDER_CORE = /older core/i;

function deliveredText(status: DeployErrorReportingStatus): string {
  if (status.sentCount === 0 && status.lastSentAtUnixMs === undefined) {
    return status.enabled
      ? 'Nothing yet. Events show up here once the core logs a warning or an error.'
      : 'Nothing, while it is paused.';
  }
  const events = `${status.sentCount} ${status.sentCount === 1 ? 'event' : 'events'}`;
  return status.lastSentAtUnixMs === undefined
    ? events
    : `${events}, the latest ${ago(status.lastSentAtUnixMs)}`;
}

/**
 * Error reporting (E29) for one server: whether the core is sending its warnings and errors to
 * Sentry, where to, and how it is going, in words and a mark (never colour alone). Admins and
 * Owners read it and send a test event; the key is never shown, since the core never returns it.
 */
export function ErrorReportingStatusCard({
  query,
  owner,
  tested,
  testing,
  onTest,
  onUpdateCore,
}: {
  query: UseQueryResult<DeployErrorReportingStatus>;
  owner: boolean;
  tested: DeployErrorReportingTestResult | null;
  testing: boolean;
  onTest: () => void;
  onUpdateCore?: (() => void) | undefined;
}): React.JSX.Element {
  const status = query.data;
  const state = status ? reportingState(status) : null;
  const Mark = state ? MARKS[state.key] : null;

  let body: React.ReactNode;
  if (query.isPending) {
    body = (
      <div className={`${CARD_BODY} space-y-3`} aria-busy="true">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="flex gap-3">
            <Skeleton className="h-3.5 w-28" />
            <Skeleton className="h-3.5 flex-1" />
          </div>
        ))}
      </div>
    );
  } else if (query.isError) {
    const message = coreErrorMessage(query.error);
    body = (
      <>
        <LoadFailure message={message} onRetry={() => void query.refetch()} />
        {OLDER_CORE.test(message) && onUpdateCore && (
          <div className="px-4 pb-3.5">
            <Button size="sm" onClick={onUpdateCore}>
              Update the core
            </Button>
          </div>
        )}
      </>
    );
  } else if (!status?.configured) {
    body = (
      <div className={CARD_BODY}>
        <EmptyState
          size="sm"
          icon={Bug}
          title="Hear about problems on this server"
          description={
            owner ? (
              <ol className="mx-auto max-w-sm list-decimal space-y-1 pl-5 text-left">
                {GET_A_DSN_STEPS.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
            ) : (
              'An Owner can set this up. They paste a Sentry DSN, and this server then sends its warnings and errors there.'
            )
          }
        />
      </div>
    );
  } else {
    body = (
      <div className={`${CARD_BODY} space-y-3`}>
        <dl className="settings-rows" aria-label="Error reporting details">
          <FactRow label="Destination">
            <span className="font-mono text-xs">{destinationOf(status)}</span>
          </FactRow>
          <FactRow label="Environment">{status.environment}</FactRow>
          <FactRow label="Server name">{status.serverName}</FactRow>
          <FactRow label="Sends">{levelLabel(status.minLevel)}</FactRow>
          <FactRow label="Delivered">{deliveredText(status)}</FactRow>
          {status.changedBy && status.changedAtUnixMs !== undefined && (
            <FactRow label="Last changed">
              {ago(status.changedAtUnixMs)} by {status.changedBy}
            </FactRow>
          )}
        </dl>
        {state?.key === 'failing' && status.lastError && (
          <Notice role="alert" tone="destructive" size="sm">
            {status.lastError}
          </Notice>
        )}
        {/* A refused test event leaves the same sentence as the failure the core holds: say it once. */}
        {tested && !(state?.key === 'failing' && tested.message === status.lastError) && (
          <Notice
            role={tested.delivered ? 'status' : 'alert'}
            tone={tested.delivered ? 'success' : 'destructive'}
            size="sm"
          >
            {tested.message}
          </Notice>
        )}
        {!owner && (
          <p className="text-xs text-muted-foreground">Only an Owner can change error reporting.</p>
        )}
        <p className="text-xs text-muted-foreground">{PRIVACY_NOTE}</p>
      </div>
    );
  }

  const canTest = status?.configured === true;
  return (
    <SecurityCard
      icon={<Bug />}
      title="Error reporting"
      description="Send this server's warnings and errors to Sentry as OpenTelemetry logs, so you hear about problems you were not watching for."
      extra={
        state && Mark ? (
          <Chip tone={state.tone}>
            <Mark aria-hidden />
            {state.label}
          </Chip>
        ) : undefined
      }
      actions={
        canTest ? (
          <SimpleTooltip
            label={status.enabled ? null : 'Turn error reporting on to send a test event.'}
            wrapTrigger
          >
            <Button size="sm" variant="soft" disabled={!status.enabled || testing} onClick={onTest}>
              {testing ? (
                <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" />
              ) : (
                <Send className="h-3.5 w-3.5" />
              )}
              Send test event
            </Button>
          </SimpleTooltip>
        ) : undefined
      }
    >
      {body}
    </SecurityCard>
  );
}
