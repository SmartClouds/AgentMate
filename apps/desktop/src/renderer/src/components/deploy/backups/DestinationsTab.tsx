import { coreErrorMessage } from '@shared/coreErrors';
import type { BackupDestinationInfo } from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { DeployServer } from '@shared/deployTypes';
import { useState } from 'react';
import { toast } from 'sonner';
import { CloudUpload, Pencil, Plus, Spinner, Trash2 } from '@/components/icons';
import { Chip } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { confirmDialog } from '@/stores/confirmStore';
import { ago } from '../security/format';
import {
  CARD_BODY,
  CARD_ROWS,
  LoadFailure,
  RowsSkeleton,
  SecurityCard,
} from '../security/SecurityCard';
import type { StepUp } from '../security/useStepUp';
import { DestinationDialog } from './DestinationDialog';
import { KIND_LABEL } from './format';
import { useBackupDestinations, useRefreshBackups } from './hooks';

/**
 * Where backups go (E28): a folder on the server, FTP or FTPS, SFTP, Google Drive, OneDrive and a
 * Telegram account. Credentials go to the core, which seals them and never hands them back.
 */
export function DestinationsTab({
  server,
  stepUp,
}: {
  server: DeployServer;
  stepUp: StepUp;
}): React.JSX.Element {
  const destinations = useBackupDestinations(server.id);
  const refresh = useRefreshBackups(server.id);
  const [editing, setEditing] = useState<{ destination: BackupDestinationInfo | null } | null>(
    null,
  );
  const [testing, setTesting] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  async function test(destination: BackupDestinationInfo): Promise<void> {
    setTesting(destination.id);
    setProblem(null);
    try {
      const result = await window.runova.deployServerBackups.testDestination({
        serverId: server.id,
        destination: {
          id: destination.id,
          name: destination.name,
          kind: destination.kind,
          settings: destination.settings,
        },
      });
      if (result.ok) toast.success(`${destination.name} took a test file and gave it back.`);
      else toast.error(`${destination.name}: ${result.problem ?? 'the test failed.'}`);
      refresh();
    } catch (error) {
      setProblem(coreErrorMessage(error));
    } finally {
      setTesting(null);
    }
  }

  async function remove(destination: BackupDestinationInfo): Promise<void> {
    const confirmed = await confirmDialog({
      title: `Remove ${destination.name}?`,
      description:
        'Plans stop sending backups there. What it already holds stays where it is; delete it from the Backups tab first if you want it gone.',
      confirmLabel: 'Remove',
      variant: 'destructive',
    });
    if (!confirmed) return;
    setProblem(null);
    try {
      await stepUp.run(() =>
        window.runova.deployServerBackups.deleteDestination({
          serverId: server.id,
          id: destination.id,
        }),
      );
      refresh();
    } catch (error) {
      setProblem(coreErrorMessage(error));
    }
  }

  return (
    <SecurityCard
      icon={<CloudUpload />}
      title="Destinations"
      description="Where the server sends its backups. Each one gets its own copy, so a backup survives the loss of any one place."
      actions={
        <Button size="sm" onClick={() => setEditing({ destination: null })}>
          <Plus className="h-3.5 w-3.5" /> Add a destination
        </Button>
      }
    >
      {destinations.isPending ? (
        <RowsSkeleton rows={2} />
      ) : destinations.isError ? (
        <LoadFailure
          message={coreErrorMessage(destinations.error)}
          onRetry={() => void destinations.refetch()}
        />
      ) : destinations.data.length === 0 ? (
        <p className={cn(CARD_BODY, 'text-sm text-muted-foreground')}>
          No destinations yet. A folder on the server is the quickest start, but a copy somewhere
          else is what saves you when the server is gone.
        </p>
      ) : (
        <ul className={CARD_ROWS}>
          {destinations.data.map((destination) => (
            <li
              key={destination.id}
              aria-label={destination.name}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3"
            >
              <span className="min-w-0 flex-1 space-y-0.5">
                <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                  {destination.name}
                  <Chip>{KIND_LABEL[destination.kind]}</Chip>
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {destination.summary}
                  {destination.lastTestedAtUnixMs
                    ? `. Tested ${ago(destination.lastTestedAtUnixMs)}.`
                    : ''}
                </span>
                {destination.lastError && (
                  <span className="block text-xs text-destructive">
                    Last problem: {destination.lastError}
                  </span>
                )}
              </span>
              <span className="flex items-center gap-1">
                <Button
                  size="sm"
                  variant="soft"
                  disabled={testing !== null}
                  onClick={() => void test(destination)}
                >
                  {testing === destination.id && (
                    <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" />
                  )}
                  Test
                </Button>
                <SimpleTooltip label="Edit">
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Edit ${destination.name}`}
                    onClick={() => setEditing({ destination })}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                </SimpleTooltip>
                <SimpleTooltip label="Remove">
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Remove ${destination.name}`}
                    onClick={() => void remove(destination)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </SimpleTooltip>
              </span>
            </li>
          ))}
        </ul>
      )}
      {problem && (
        <p role="alert" className={cn(CARD_BODY, 'text-sm text-destructive')}>
          {problem}
        </p>
      )}
      <DestinationDialog
        server={server}
        destination={editing?.destination ?? null}
        open={editing !== null}
        stepUp={stepUp}
        onOpenChange={(open) => !open && setEditing(null)}
        onSaved={refresh}
      />
    </SecurityCard>
  );
}
