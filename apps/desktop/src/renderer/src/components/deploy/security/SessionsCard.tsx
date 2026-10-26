import { coreErrorMessage } from '@shared/coreErrors';
import type { SessionInfo } from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { DeployServer } from '@shared/deployTypes';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Clock } from '@/components/icons';
import { Chip } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { queryKeys } from '@/lib/queryKeys';
import { confirmDialog } from '@/stores/confirmStore';
import { ago, fromNow } from './format';
import { CARD_ROWS, LoadFailure, RowsSkeleton, SecurityCard } from './SecurityCard';

/**
 * The signed-in user's own sessions on a core, one per sign-in on any of their computers, this
 * one marked. Ending one signs that computer out at once; this one ends with Sign out instead.
 */
export function SessionsCard({ server }: { server: DeployServer }): React.JSX.Element {
  const queryClient = useQueryClient();
  const sessions = useQuery({
    queryKey: queryKeys.deploySessions(server.id),
    queryFn: () => window.runova.deploySecurity.listSessions(server.id),
    retry: false,
  });

  async function end(work: () => Promise<string>): Promise<void> {
    try {
      toast.success(await work());
    } catch (error) {
      toast.error(coreErrorMessage(error));
    } finally {
      void queryClient.invalidateQueries({ queryKey: queryKeys.deploySecurity(server.id) });
    }
  }

  async function endOne(session: SessionInfo): Promise<void> {
    const confirmed = await confirmDialog({
      title: `End the session on ${session.deviceName}?`,
      description: `${session.deviceName} is signed out of the core and asks for your password the next time it is used.`,
      confirmLabel: 'End the session',
      variant: 'destructive',
    });
    if (!confirmed) return;
    await end(async () => {
      await window.runova.deploySecurity.revokeSession(server.id, session.id);
      return `${session.deviceName} is signed out.`;
    });
  }

  async function endOthers(): Promise<void> {
    const confirmed = await confirmDialog({
      title: 'End all your other sessions?',
      description:
        'Every computer of yours but this one is signed out of the core and asks for your password the next time it is used.',
      confirmLabel: 'End them',
      variant: 'destructive',
      typeToConfirm: server.nickname,
    });
    if (!confirmed) return;
    await end(async () => {
      const count = await window.runova.deploySecurity.revokeOtherSessions(server.id);
      return `Ended ${count} other ${count === 1 ? 'session' : 'sessions'}.`;
    });
  }

  const others = sessions.data?.filter((session) => !session.current) ?? [];
  let body: React.ReactNode;
  if (sessions.isPending) {
    body = <RowsSkeleton rows={2} />;
  } else if (sessions.isError) {
    body = (
      <LoadFailure
        message={coreErrorMessage(sessions.error)}
        onRetry={() => void sessions.refetch()}
      />
    );
  } else {
    body = (
      <ul aria-label="Sessions" className={CARD_ROWS}>
        {sessions.data.map((session) => (
          <li
            key={session.id}
            aria-label={session.deviceName}
            className="flex flex-wrap items-center gap-3 px-4 py-3"
          >
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="truncate text-sm font-medium text-foreground">
                  {session.deviceName}
                </span>
                {session.current && <Chip tone="primary">This session</Chip>}
              </div>
              <p className="text-xs text-muted-foreground">
                {[
                  `Signed in ${ago(session.createdAtUnixMs)}`,
                  `Active ${ago(session.lastRenewedAtUnixMs)}`,
                  `Ends ${fromNow(session.expiresAtUnixMs)}`,
                ].join(' · ')}
              </p>
            </div>
            {!session.current && (
              <Button
                size="sm"
                variant="danger"
                aria-label={`End the session on ${session.deviceName}`}
                onClick={() => void endOne(session)}
              >
                End
              </Button>
            )}
          </li>
        ))}
      </ul>
    );
  }

  return (
    <SecurityCard
      icon={<Clock />}
      title="Your sessions"
      description="Each time you signed in to this core, on any of your computers. A session lasts up to 180 days, or 30 without use."
      actions={
        others.length > 0 && (
          <Button size="sm" variant="danger" onClick={() => void endOthers()}>
            End all other sessions
          </Button>
        )
      }
    >
      {body}
    </SecurityCard>
  );
}
