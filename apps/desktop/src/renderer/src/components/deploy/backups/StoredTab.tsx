import { coreErrorMessage } from '@shared/coreErrors';
import { backupSize } from '@shared/deploy/backupSchedule';
import type { StoredBackupInfo } from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { DeployServer } from '@shared/deployTypes';
import { useState } from 'react';
import { toast } from 'sonner';
import { Archive, ArchiveRestore, Download, Spinner, Trash2 } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { confirmDialog } from '@/stores/confirmStore';
import {
  CARD_BODY,
  LoadFailure,
  RowsSkeleton,
  SecurityCard,
  TABLE_CELL,
  TABLE_HEAD,
} from '../security/SecurityCard';
import type { StepUp } from '../security/useStepUp';
import { dateAndTime, KIND_LABEL } from './format';
import { useBackupDestinations, useBackupPlans, useStoredBackups } from './hooks';
import type { RestoreChoice } from './RestoreTab';

/**
 * What one destination holds, as its manifests say (E28): every backup there, including ones
 * other servers or other plans made, with what can be done with each.
 */
export function StoredTab({
  server,
  stepUp,
  onRestore,
}: {
  server: DeployServer;
  stepUp: StepUp;
  onRestore: (choice: RestoreChoice) => void;
}): React.JSX.Element {
  const destinations = useBackupDestinations(server.id);
  const plans = useBackupPlans(server.id);
  const [picked, setPicked] = useState<string | null>(null);
  const destinationId = picked ?? destinations.data?.[0]?.id ?? null;
  const destination = destinations.data?.find((one) => one.id === destinationId);
  const stored = useStoredBackups(server.id, destinationId);
  const [working, setWorking] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const planName = (backup: StoredBackupInfo) =>
    backup.planId
      ? (plans.data?.find((plan) => plan.id === backup.planId)?.name ?? 'A removed plan')
      : 'Back up now';

  const input = (backup: StoredBackupInfo) => ({
    serverId: server.id,
    destinationId: backup.destinationId,
    backupId: backup.backupId,
  });

  async function download(backup: StoredBackupInfo): Promise<void> {
    setWorking(backup.backupId);
    setProblem(null);
    try {
      const saved = await stepUp.run(() =>
        window.runova.deployServerBackups.downloadStored(input(backup)),
      );
      if (saved?.saved) toast.success(`Backup saved to ${saved.path}`);
    } catch (error) {
      setProblem(coreErrorMessage(error));
    } finally {
      setWorking(null);
    }
  }

  async function remove(backup: StoredBackupInfo): Promise<void> {
    const confirmed = await confirmDialog({
      title: 'Delete this backup?',
      description: `The backup of ${backup.serverName} from ${dateAndTime(backup.createdAtUnixMs)} goes from ${destination?.name ?? 'the destination'}, with all its parts.`,
      warning: 'A deleted backup cannot be brought back.',
      confirmLabel: 'Delete the backup',
      variant: 'destructive',
    });
    if (!confirmed) return;
    setWorking(backup.backupId);
    setProblem(null);
    try {
      await stepUp.run(() => window.runova.deployServerBackups.deleteStored(input(backup)));
      void stored.refetch();
    } catch (error) {
      setProblem(coreErrorMessage(error));
    } finally {
      setWorking(null);
    }
  }

  return (
    <SecurityCard
      icon={<Archive />}
      title="Backups"
      description="What a destination holds. A backup another server made there can be restored here too, with its secret key."
      actions={
        destinations.data && destinations.data.length > 0 ? (
          <Combobox
            ariaLabel="Destination"
            className="w-56"
            options={destinations.data.map((one) => ({
              value: one.id,
              label: one.name,
              keywords: [KIND_LABEL[one.kind]],
            }))}
            value={destinationId ?? ''}
            onChange={(value) => value && setPicked(value)}
          />
        ) : undefined
      }
    >
      {destinations.isPending || (destinationId !== null && stored.isPending) ? (
        <RowsSkeleton rows={3} />
      ) : destinations.isError ? (
        <LoadFailure
          message={coreErrorMessage(destinations.error)}
          onRetry={() => void destinations.refetch()}
        />
      ) : destinationId === null ? (
        <p className={cn(CARD_BODY, 'text-sm text-muted-foreground')}>
          No destinations yet. Add one in Destinations.
        </p>
      ) : stored.isError ? (
        <LoadFailure
          message={coreErrorMessage(stored.error)}
          onRetry={() => void stored.refetch()}
        />
      ) : (stored.data ?? []).length === 0 ? (
        <p className={cn(CARD_BODY, 'text-sm text-muted-foreground')}>
          {destination?.name ?? 'This destination'} holds no backups yet.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table
            aria-label={`Backups on ${destination?.name ?? ''}`}
            className="w-full text-left text-sm"
          >
            <thead>
              <tr>
                <th className={TABLE_HEAD}>Made</th>
                <th className={TABLE_HEAD}>Server</th>
                <th className={TABLE_HEAD}>Plan</th>
                <th className={TABLE_HEAD}>Size</th>
                <th className={TABLE_HEAD}>Parts</th>
                <th className={TABLE_HEAD}>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {(stored.data ?? []).map((backup) => {
                const when = dateAndTime(backup.createdAtUnixMs);
                const busy = working === backup.backupId;
                return (
                  <tr key={backup.backupId} className="border-t border-foreground/[0.06]">
                    <td className={cn(TABLE_CELL, 'whitespace-nowrap')}>{when}</td>
                    <td className={TABLE_CELL}>{backup.serverName}</td>
                    <td className={TABLE_CELL}>{planName(backup)}</td>
                    <td className={cn(TABLE_CELL, 'whitespace-nowrap')}>
                      {backupSize(backup.sizeBytes)}
                    </td>
                    <td className={cn(TABLE_CELL, 'whitespace-nowrap')}>
                      {backup.parts === 1 ? '1 file' : `${backup.parts} parts`}
                    </td>
                    <td className={cn(TABLE_CELL, 'whitespace-nowrap text-right')}>
                      {busy && (
                        <Spinner className="mr-1 inline h-3.5 w-3.5 motion-safe:animate-spin" />
                      )}
                      <SimpleTooltip label="Download to this computer">
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          disabled={working !== null}
                          aria-label={`Download the backup from ${when}`}
                          onClick={() => void download(backup)}
                        >
                          <Download className="h-3.5 w-3.5" />
                        </Button>
                      </SimpleTooltip>
                      <SimpleTooltip label="Restore">
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          disabled={server.dev}
                          aria-label={`Restore the backup from ${when}`}
                          onClick={() => onRestore(input(backup))}
                        >
                          <ArchiveRestore className="h-3.5 w-3.5" />
                        </Button>
                      </SimpleTooltip>
                      <SimpleTooltip label="Delete">
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          disabled={working !== null}
                          aria-label={`Delete the backup from ${when}`}
                          onClick={() => void remove(backup)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </SimpleTooltip>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {problem && (
        <p role="alert" className={cn(CARD_BODY, 'text-sm text-destructive')}>
          {problem}
        </p>
      )}
    </SecurityCard>
  );
}
