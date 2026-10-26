import { coreErrorMessage } from '@shared/coreErrors';
import type {
  DeployErrorReportingStatus,
  DeployErrorReportingTestResult,
} from '@shared/deployErrorReportingTypes';
import type { DeployServer } from '@shared/deployTypes';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { Pencil } from '@/components/icons';
import { Skeleton } from '@/components/ui/skeleton';
import { queryKeys } from '@/lib/queryKeys';
import { confirmDialog } from '@/stores/confirmStore';
import { useProofStepUp } from '../overview/useProofStepUp';
import { CARD_BODY, SecurityCard } from '../security/SecurityCard';
import { ErrorReportingForm, type ErrorReportingValues } from './ErrorReportingForm';
import { ErrorReportingStatusCard } from './ErrorReportingStatusCard';
import { destinationOf } from './messages';

/**
 * Error reporting (E29) for one server: its core sends warnings and errors to a Sentry project as
 * OpenTelemetry logs. Admins and Owners see how it stands and send a test event; Owners set it up,
 * change it and remove it, each after a step-up when the last one ran out. The DSN only ever goes
 * in, from the form to the core, which seals it and never returns it.
 */
export function ErrorReportingCard({
  server,
  owner,
  onUpdateCore,
}: {
  server: DeployServer;
  owner: boolean;
  /** Opens the core update, for a server whose core does not have this feature yet. */
  onUpdateCore?: (() => void) | undefined;
}): React.JSX.Element {
  const serverId = server.id;
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: queryKeys.deployErrorReporting(serverId),
    queryFn: () => window.runova.deployErrorReporting.status(serverId),
    retry: false,
  });
  const stepUp = useProofStepUp(server);
  const [busy, setBusy] = useState<'save' | 'remove' | null>(null);
  const [testing, setTesting] = useState(false);
  const [tested, setTested] = useState<DeployErrorReportingTestResult | null>(null);
  const [problems, setProblems] = useState<string[]>([]);

  function settled(next: DeployErrorReportingStatus): void {
    queryClient.setQueryData(queryKeys.deployErrorReporting(serverId), next);
    setTested(null);
    setProblems([]);
  }

  async function save(values: ErrorReportingValues): Promise<boolean> {
    setBusy('save');
    setProblems([]);
    try {
      const result = await stepUp.run(
        (proof) => window.runova.deployErrorReporting.save({ serverId, ...values, ...proof }),
        'change error reporting',
      );
      if (!result) return false;
      if (result.problems.length > 0 || !result.status) {
        setProblems(result.problems);
        return false;
      }
      settled(result.status);
      toast.success(
        result.status.enabled
          ? `Error reporting is on. ${server.nickname} sends to ${destinationOf(result.status) ?? 'Sentry'}.`
          : 'Error reporting is saved and paused.',
      );
      return true;
    } catch (error) {
      toast.error(coreErrorMessage(error));
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function remove(): Promise<void> {
    const confirmed = await confirmDialog({
      title: `Stop reporting errors from ${server.nickname}?`,
      description:
        'The core forgets the DSN and stops sending. Nothing already in Sentry is deleted, and you can set it up again by pasting the DSN.',
      confirmLabel: 'Remove',
      variant: 'destructive',
    });
    if (!confirmed) return;
    setBusy('remove');
    try {
      const next = await stepUp.run(
        (proof) => window.runova.deployErrorReporting.remove({ serverId, ...proof }),
        'remove error reporting',
      );
      if (!next) return;
      settled(next);
      toast.success('Error reporting was removed.');
    } catch (error) {
      toast.error(coreErrorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function sendTest(): Promise<void> {
    setTesting(true);
    setTested(null);
    try {
      setTested(await window.runova.deployErrorReporting.test(serverId));
      void query.refetch();
    } catch (error) {
      toast.error(coreErrorMessage(error));
    } finally {
      setTesting(false);
    }
  }

  const status = query.data;
  return (
    <div className="space-y-2">
      <ErrorReportingStatusCard
        query={query}
        owner={owner}
        tested={tested}
        testing={testing}
        onTest={() => void sendTest()}
        onUpdateCore={onUpdateCore}
      />
      {owner && query.isPending && (
        <SecurityCard icon={<Pencil />} title="Settings" tone="neutral">
          <div className={`${CARD_BODY} space-y-3`} aria-busy="true">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-2/3" />
          </div>
        </SecurityCard>
      )}
      {owner && status && (
        <SecurityCard
          icon={<Pencil />}
          title="Settings"
          tone="neutral"
          description={
            status.configured
              ? 'Change where logs go or what is sent. Leave the DSN empty to keep the one on the server.'
              : 'Paste the DSN, choose what to send, and turn it on. The core starts sending at once, with no restart.'
          }
        >
          <div className={CARD_BODY}>
            <ErrorReportingForm
              // A saved change starts the form again from what the core now holds, and empties the key.
              key={`${status.configured}-${status.changedAtUnixMs ?? 'never'}`}
              status={status}
              busy={busy}
              problems={problems}
              onSubmit={save}
              onRemove={() => void remove()}
            />
          </div>
        </SecurityCard>
      )}
      {stepUp.dialog}
    </div>
  );
}
