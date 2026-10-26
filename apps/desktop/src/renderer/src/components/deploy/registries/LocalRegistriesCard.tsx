import { coreErrorMessage } from '@shared/coreErrors';
import { registryLabel } from '@shared/deploy/registries';
import type { DeployRegistryCredential } from '@shared/deployRegistryTypes';
import { useState } from 'react';
import { toast } from 'sonner';
import { Github, Lock, Monitor, Package, Plus, Trash2, TriangleAlert } from '@/components/icons';
import { Chip } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { confirmDialog } from '@/stores/confirmStore';
import { DeployCard, LIST_ROW, LIST_WELL } from '../deployKit';
import { GhCliDialog } from './GhCliDialog';
import { GithubTokenDialog } from './GithubTokenDialog';
import { RegistryCredentialDialog } from './RegistryCredentialDialog';

/** How a sign-in was made, in words, with the broad ones marked as such (never by colour alone). */
function sourceText(credential: DeployRegistryCredential): string {
  if (credential.source === 'packagesToken') {
    return credential.broaderScopes.length === 0 ? 'Packages-only token' : 'GitHub token';
  }
  if (credential.source === 'ghCli') return 'GitHub CLI sign-in';
  return 'User name and token';
}

function CredentialRow({
  credential,
  onRemove,
}: {
  credential: DeployRegistryCredential;
  onRemove: () => void;
}): React.JSX.Element {
  const broad = credential.broaderScopes.length > 0;
  return (
    <li
      aria-label={registryLabel(credential.registry)}
      className={cn(LIST_ROW, 'flex flex-wrap items-center gap-3')}
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/12 text-primary">
        {credential.kind === 'github' ? (
          <Github className="h-4 w-4" />
        ) : (
          <Package className="h-4 w-4" />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">
          {registryLabel(credential.registry)}{' '}
          <span className="font-mono text-xs text-muted-foreground">{credential.registry}</span>
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          {credential.username} · {sourceText(credential)}
        </span>
      </span>
      {broad && (
        <SimpleTooltip label={`Also allows: ${credential.broaderScopes.join(', ')}`}>
          <Chip
            tone="warning"
            tabIndex={0}
            className="outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <TriangleAlert aria-hidden="true" /> Broad scopes
          </Chip>
        </SimpleTooltip>
      )}
      {credential.locked && (
        <Chip>
          <Lock aria-hidden="true" /> Locked by the passkey
        </Chip>
      )}
      <SimpleTooltip label="Remove">
        <Button
          size="icon-sm"
          variant="ghost"
          className="hover:text-destructive"
          aria-label={`Remove the sign-in for ${credential.registry}`}
          onClick={onRemove}
        >
          <Trash2 />
        </Button>
      </SimpleTooltip>
    </li>
  );
}

/**
 * Sign-ins kept on this computer (E08). They go with each deploy that pulls from their registry
 * and leave the server when the deploy ends. Adding one is open to anyone using this computer;
 * the server still checks the deploy's role.
 */
export function LocalRegistriesCard({
  credentials,
  loading,
  error,
  onChanged,
}: {
  credentials: DeployRegistryCredential[] | undefined;
  loading: boolean;
  error: string | null;
  onChanged: () => void;
}): React.JSX.Element {
  const [dialog, setDialog] = useState<'github' | 'gh' | 'dockerhub' | 'custom' | null>(null);

  async function remove(credential: DeployRegistryCredential): Promise<void> {
    const confirmed = await confirmDialog({
      title: `Remove the sign-in for ${credential.registry}?`,
      description:
        'Deploys from this computer stop sending it. Images that need it will not pull unless the server stores a credential of its own.',
      confirmLabel: 'Remove',
      variant: 'destructive',
    });
    if (!confirmed) return;
    try {
      await window.runova.deployRegistry.remove(credential.id);
      toast.success(`Removed the sign-in for ${credential.registry}.`);
      onChanged();
    } catch (failure) {
      toast.error(coreErrorMessage(failure));
    }
  }

  const close = () => setDialog(null);
  const saved = () => {
    setDialog(null);
    onChanged();
  };

  return (
    <DeployCard
      icon={<Monitor />}
      title="On this computer"
      description="Sent with each deploy that pulls from the registry, kept in the server's memory for that deploy only, then wiped. Sealed here like your server passwords."
      bodyClassName="space-y-3"
    >
      {loading ? (
        <div className="space-y-2" aria-busy="true">
          <Skeleton className="h-12 w-full rounded-lg" />
          <Skeleton className="h-12 w-full rounded-lg" />
        </div>
      ) : !credentials ? (
        <p role="alert" className="text-sm text-destructive">
          The sign-ins did not load{error ? `: ${error}` : '.'}
        </p>
      ) : credentials.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No sign-ins yet. Public images pull without one.
        </p>
      ) : (
        <ul aria-label="Sign-ins on this computer" className={LIST_WELL}>
          {credentials.map((credential) => (
            <CredentialRow
              key={credential.id}
              credential={credential}
              onRemove={() => void remove(credential)}
            />
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => setDialog('github')}>
          <Github /> GitHub packages token
        </Button>
        <Button size="sm" variant="soft" onClick={() => setDialog('gh')}>
          Use the gh sign-in
        </Button>
        <Button size="sm" variant="soft" onClick={() => setDialog('dockerhub')}>
          <Plus /> Docker Hub
        </Button>
        <Button size="sm" variant="soft" onClick={() => setDialog('custom')}>
          <Plus /> Custom registry
        </Button>
      </div>
      <GithubTokenDialog open={dialog === 'github'} onClose={close} onSaved={saved} />
      <GhCliDialog open={dialog === 'gh'} onClose={close} onSaved={saved} />
      <RegistryCredentialDialog
        kind={dialog === 'dockerhub' || dialog === 'custom' ? dialog : null}
        onClose={close}
        onSaved={saved}
      />
    </DeployCard>
  );
}
