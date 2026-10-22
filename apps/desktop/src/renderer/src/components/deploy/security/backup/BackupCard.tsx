import type { DeployServer } from '@shared/deployTypes';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Archive, ArchiveRestore } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { CARD_BODY, SecurityCard } from '../SecurityCard';
import { useStepUp } from '../useStepUp';
import { CreateBackupDialog } from './CreateBackupDialog';
import { RestoreDialog } from './RestoreDialog';

/**
 * Backups of the core (Owners): what goes in, how it is protected, and the two ways in, making
 * one and restoring one. Restoring needs SSH as root, which the DevHost does not have.
 */
export function BackupCard({
  server,
  userName,
}: {
  server: DeployServer;
  userName?: string;
}): React.JSX.Element {
  const stepUp = useStepUp(server);
  const [, setParams] = useSearchParams();
  const [creating, setCreating] = useState(false);
  const [restoring, setRestoring] = useState(false);
  return (
    <SecurityCard
      icon={<Archive />}
      title="Backups"
      description="A backup holds the core's database (users, computers, sites, certificates, settings), the keys that open what it keeps encrypted, and the apps' files. It is encrypted on the server with a passphrase you choose (AES-256-GCM, the key stretched with PBKDF2), saved on this computer, and deleted from the server."
    >
      <p className={`${CARD_BODY} text-xs text-muted-foreground`}>
        For backups of the whole server (apps, volumes and firewall rules too), on a schedule and
        sent to other places, use the{' '}
        <Button
          size="sm"
          variant="link"
          className="h-auto p-0 text-xs"
          onClick={() => setParams({ server: server.id, view: 'backups' })}
        >
          Backups section
        </Button>
        . This card keeps the quick backup of the core alone.
      </p>
      <div className={`${CARD_BODY} flex flex-wrap gap-2`}>
        <Button size="sm" onClick={() => setCreating(true)}>
          <Archive className="h-3.5 w-3.5" /> Back up now
        </Button>
        <SimpleTooltip
          label={server.dev ? 'The DevHost has no SSH to restore over.' : undefined}
          wrapTrigger
        >
          <Button size="sm" variant="soft" disabled={server.dev} onClick={() => setRestoring(true)}>
            <ArchiveRestore className="h-3.5 w-3.5" /> Restore a backup
          </Button>
        </SimpleTooltip>
      </div>
      <CreateBackupDialog
        server={server}
        open={creating}
        stepUp={stepUp}
        onOpenChange={setCreating}
      />
      <RestoreDialog
        server={server}
        open={restoring}
        defaultUserName={userName}
        onOpenChange={setRestoring}
      />
      {stepUp.dialog}
    </SecurityCard>
  );
}
