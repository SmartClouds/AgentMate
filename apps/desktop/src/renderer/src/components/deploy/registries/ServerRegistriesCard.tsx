import { coreErrorMessage } from '@shared/coreErrors';
import { registryLabel } from '@shared/deploy/registries';
import type { DeployRegistryCredential, DeployServerCredential } from '@shared/deployRegistryTypes';
import type { DeployServer } from '@shared/deployTypes';
import { useState } from 'react';
import { toast } from 'sonner';
import { Lock, Plus, Server, Trash2 } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { confirmDialog } from '@/stores/confirmStore';
import { DeployCard, LIST_ROW, LIST_WELL } from '../deployKit';
import type { ProofStepUp } from '../overview/useProofStepUp';
import { dateTime } from '../security/format';
import { ServerCredentialDialog } from './ServerCredentialDialog';

export const ADMIN_ONLY = 'Storing and removing credentials on the server needs the Admin role.';

/**
 * Credentials stored on the server (E08 T4): labelled as such everywhere, write-only, used when a
 * deploy or pull brings no sign-in of its own. Operators see which registries have one.
 */
export function ServerRegistriesCard({
  server,
  credentials,
  loading,
  error,
  canAdmin,
  local,
  proof,
  onChanged,
}: {
  server: DeployServer;
  credentials: DeployServerCredential[] | undefined;
  loading: boolean;
  error: string | null;
  canAdmin: boolean;
  local: DeployRegistryCredential[];
  proof: ProofStepUp;
  onChanged: () => void;
}): React.JSX.Element {
  const [adding, setAdding] = useState(false);

  async function remove(credential: DeployServerCredential): Promise<void> {
    const confirmed = await confirmDialog({
      title: `Remove the stored credential for ${credential.registry}?`,
      description: `Deploys and pulls on ${server.nickname} that bring no sign-in will no longer reach this registry.`,
      confirmLabel: 'Remove',
      variant: 'destructive',
    });
    if (!confirmed) return;
    try {
      const done = await proof.run(async (step) => {
        await window.runova.deployRegistry.serverRemove({
          serverId: server.id,
          credentialId: credential.id,
          ...step,
        });
        return true;
      }, 'Removing a stored credential');
      if (done) {
        toast.success(`Removed the stored credential for ${credential.registry}.`);
        onChanged();
      }
    } catch (failure) {
      toast.error(coreErrorMessage(failure));
    }
  }

  return (
    <DeployCard
      icon={<Server />}
      title="Stored on this server"
      description="For deploys and pulls nobody is there to sign in for. Encrypted with the server's own keys and never shown again, not even to you."
      bodyClassName="space-y-3"
    >
      {loading ? (
        <div aria-busy="true">
          <Skeleton className="h-12 w-full rounded-lg" />
        </div>
      ) : !credentials ? (
        <p role="alert" className="text-sm text-muted-foreground">
          The stored credentials did not load{error ? `: ${error}` : '.'}
        </p>
      ) : credentials.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing is stored on {server.nickname}.</p>
      ) : (
        <ul aria-label="Stored on this server" className={LIST_WELL}>
          {credentials.map((credential) => (
            <li
              key={credential.id}
              aria-label={`${registryLabel(credential.registry)}, stored on this server`}
              className={cn(LIST_ROW, 'flex flex-wrap items-center gap-3')}
            >
              <Lock className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-foreground">
                  {registryLabel(credential.registry)}{' '}
                  <span className="font-mono text-xs text-muted-foreground">
                    {credential.registry}
                  </span>
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {credential.username} · stored on this server
                  {credential.lastUsedAtUnixMs
                    ? ` · last used ${dateTime(credential.lastUsedAtUnixMs)}`
                    : ' · not used yet'}
                </span>
              </span>
              <SimpleTooltip label={canAdmin ? 'Remove' : ADMIN_ONLY} wrapTrigger>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  className="hover:text-destructive"
                  disabled={!canAdmin}
                  aria-label={`Remove the stored credential for ${credential.registry}`}
                  onClick={() => void remove(credential)}
                >
                  <Trash2 />
                </Button>
              </SimpleTooltip>
            </li>
          ))}
        </ul>
      )}
      <SimpleTooltip label={canAdmin ? null : ADMIN_ONLY} wrapTrigger>
        <Button size="sm" variant="soft" disabled={!canAdmin} onClick={() => setAdding(true)}>
          <Plus /> Store a credential
        </Button>
      </SimpleTooltip>
      <ServerCredentialDialog
        server={server}
        open={adding}
        local={local}
        proof={proof}
        onClose={() => setAdding(false)}
        onSaved={onChanged}
      />
    </DeployCard>
  );
}
