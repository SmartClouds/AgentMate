import type { LockHolderView } from '@agentmat/studio';
import { formatWhen } from '../format';
import { Button, EmptyState, Lock } from '../kit';

export interface LockedCardProps {
  holder: LockHolderView;
  stale: boolean;
  onTakeOver: () => void;
  onRetry: () => void;
}

/**
 * The video is open in another copy of AgentMate (the dev build, or another computer on a shared
 * drive). Only one may edit it at a time, so this says who has it; when that copy stopped
 * answering, the user can take it over.
 */
export function LockedCard({
  holder,
  stale,
  onTakeOver,
  onRetry,
}: LockedCardProps): React.JSX.Element {
  return (
    <EmptyState
      card
      icon={Lock}
      title="Open in another AgentMate"
      description={
        <>
          <p>
            {holder.appId} on {holder.host} has this video open. Only one copy of AgentMate can edit
            a video at a time, so nothing gets lost.
          </p>
          {stale && (
            <p className="mt-2">
              It last checked in {formatWhen(holder.heartbeatAt)}. If it crashed or that computer is
              off, you can take the video over.
            </p>
          )}
        </>
      }
      action={
        <div className="flex gap-2">
          <Button variant="outline" onClick={onRetry}>
            Try again
          </Button>
          {stale && <Button onClick={onTakeOver}>Take over</Button>}
        </div>
      }
    />
  );
}
