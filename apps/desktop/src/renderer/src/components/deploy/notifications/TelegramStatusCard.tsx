import { coreErrorMessage } from '@shared/coreErrors';
import type { DeployTelegramStatus, DeployTelegramTestResult } from '@shared/deployTelegramTypes';
import type { UseQueryResult } from '@tanstack/react-query';
import {
  Bell,
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
import { FactRow } from '../deployKit';
import { ago } from '../security/format';
import { CARD_BODY, LoadFailure, SecurityCard } from '../security/SecurityCard';
import {
  kindsText,
  PRIVACY_NOTE,
  SETUP_STEPS,
  type TelegramStateKey,
  telegramState,
} from './messages';

const MARKS: Record<TelegramStateKey, React.ComponentType<{ className?: string }>> = {
  off: CircleX,
  paused: Pause,
  waiting: Clock,
  sending: CircleCheck,
  failing: TriangleAlert,
};

/** The sentence a core without this feature ends up as, so the card can offer the update. */
const OLDER_CORE = /older core/i;

function deliveredText(status: DeployTelegramStatus): string {
  if (status.sentCount === 0 && status.lastSentAtUnixMs === undefined) {
    return status.enabled
      ? 'Nothing yet. A message goes out when something on the server needs a look.'
      : 'Nothing, while it is paused.';
  }
  const messages = `${status.sentCount} ${status.sentCount === 1 ? 'message' : 'messages'}`;
  return status.lastSentAtUnixMs === undefined
    ? messages
    : `${messages}, the latest ${ago(status.lastSentAtUnixMs)}`;
}

/**
 * Telegram alerts (E30) for one server: whether its core sends them, to which chat, which kinds and
 * how sending is going, in words and a mark (never colour alone). Admins and Owners read it and send
 * a test message; the token is never shown, since the core never returns it.
 */
export function TelegramStatusCard({
  query,
  owner,
  tested,
  testing,
  onTest,
  onUpdateCore,
}: {
  query: UseQueryResult<DeployTelegramStatus>;
  owner: boolean;
  tested: DeployTelegramTestResult | null;
  testing: boolean;
  onTest: () => void;
  onUpdateCore?: (() => void) | undefined;
}): React.JSX.Element {
  const status = query.data;
  const state = status ? telegramState(status) : null;
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
          icon={Bell}
          title="Get this server's alerts on Telegram"
          description={
            owner ? (
              <ol className="mx-auto max-w-md list-decimal space-y-1 pl-5 text-left">
                {SETUP_STEPS.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
            ) : (
              'An Owner can set this up. They give the server a Telegram bot and a chat, and the server then sends its alerts there.'
            )
          }
        />
      </div>
    );
  } else {
    body = (
      <div className={`${CARD_BODY} space-y-3`}>
        <dl className="settings-rows" aria-label="Telegram details">
          <FactRow label="Chat">
            <span className="font-mono text-xs">{status.chatId}</span>
          </FactRow>
          <FactRow label="Server name">{status.serverName}</FactRow>
          <FactRow label="Alerts">{kindsText(status.kinds)}</FactRow>
          <FactRow label="When it clears">
            {status.sendResolved ? 'A short note is sent' : 'Nothing is sent'}
          </FactRow>
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
        {tested && (
          <Notice
            role={tested.delivered ? 'status' : 'alert'}
            tone={tested.delivered ? 'success' : 'destructive'}
            size="sm"
          >
            {tested.message}
          </Notice>
        )}
        {!owner && (
          <p className="text-xs text-muted-foreground">Only an Owner can change Telegram alerts.</p>
        )}
        <p className="text-xs text-muted-foreground">{PRIVACY_NOTE}</p>
      </div>
    );
  }

  return (
    <SecurityCard
      icon={<Bell />}
      title="Telegram alerts"
      description="Important events and errors on this server, such as a failed backup or a container that keeps restarting, sent to a person or group on Telegram."
      extra={
        state && Mark ? (
          <Chip tone={state.tone}>
            <Mark aria-hidden />
            {state.label}
          </Chip>
        ) : undefined
      }
      actions={
        status?.configured ? (
          <Button size="sm" variant="soft" disabled={testing} onClick={onTest}>
            {testing ? (
              <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" />
            ) : (
              <Send className="h-3.5 w-3.5" />
            )}
            Send test message
          </Button>
        ) : undefined
      }
    >
      {body}
    </SecurityCard>
  );
}
