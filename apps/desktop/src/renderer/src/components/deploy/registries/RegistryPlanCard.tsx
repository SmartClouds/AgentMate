import { coreErrorMessage } from '@shared/coreErrors';
import { DOCKER_HUB, registryLabel } from '@shared/deploy/registries';
import type { DeployRegistryPlanEntry, DeployRegistryPlanInput } from '@shared/deployRegistryTypes';
import { useId } from 'react';
import { toast } from 'sonner';
import { Check, Key, Monitor, Server, TriangleAlert } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { useRefreshRegistries, useRegistryPlan } from './hooks';

/** What signs in to one registry on the next deploy, in words and with an icon. */
function EntryLine({ entry }: { entry: DeployRegistryPlanEntry }): React.JSX.Element {
  const label = registryLabel(entry.registry);
  const [Icon, tone, text] = entry.credentialId
    ? [Monitor, 'text-success', 'the sign-in from this computer goes with the deploy']
    : entry.storedOnServer
      ? [Server, 'text-success', 'the credential stored on this server signs in']
      : entry.registry === DOCKER_HUB
        ? [Check, 'text-muted-foreground', 'no sign-in, which is fine for public images']
        : [
            TriangleAlert,
            'text-warning',
            'no sign-in: the pull fails unless the images are public',
          ];
  return (
    <li aria-label={label} className="flex items-start gap-2 text-sm">
      <Icon className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${tone}`} aria-hidden="true" />
      <span>
        <span className="font-medium text-foreground">{label}</span>
        <span className="text-muted-foreground">: {text}</span>
      </span>
    </li>
  );
}

/**
 * Which registry sign-in goes with an app's deploys (E08 T6), per registry its images come from,
 * and for an existing app the choice to send this computer's sign-ins at all. Shown in the New
 * App review and on the app's page.
 */
export function RegistryPlanCard({
  input,
  stackId,
  onOpenRegistries,
}: {
  input: DeployRegistryPlanInput;
  /** An existing app: its choice can be changed here. */
  stackId: string | null;
  onOpenRegistries?: () => void;
}): React.JSX.Element | null {
  const switchId = useId();
  const plan = useRegistryPlan(input);
  const refresh = useRefreshRegistries();

  if (plan.isPending) {
    return (
      <div aria-busy="true">
        <Skeleton className="h-16 w-full rounded-xl" />
      </div>
    );
  }
  if (!plan.data) {
    return plan.error ? (
      <p className="text-xs text-muted-foreground">
        Registry sign-ins could not be worked out: {coreErrorMessage(plan.error)}
      </p>
    ) : null;
  }
  const { entries, sendSignIns, unresolved = false } = plan.data;
  const worthShowing =
    unresolved ||
    entries.some(
      (entry) => entry.registry !== DOCKER_HUB || entry.credentialId || entry.storedOnServer,
    );
  if (!worthShowing && !stackId) return null;

  async function toggle(next: boolean): Promise<void> {
    if (!stackId) return;
    try {
      await window.runova.deployRegistry.setAppChoice({
        serverId: input.serverId,
        stackId,
        sendSignIns: next,
      });
      await refresh();
    } catch (error) {
      toast.error(coreErrorMessage(error));
    }
  }

  return (
    <section
      aria-label="Registry sign-in"
      className="space-y-2 rounded-xl bg-foreground/[0.03] px-3 py-2.5 ring-1 ring-inset ring-foreground/[0.07]"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Key className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
        <span className="min-w-0 flex-1 text-sm font-medium text-foreground">Registry sign-in</span>
        {onOpenRegistries && (
          <Button size="sm" variant="soft" onClick={onOpenRegistries}>
            Manage registries
          </Button>
        )}
      </div>
      {unresolved && (
        <p className="text-xs text-muted-foreground">
          {sendSignIns
            ? "Some images take their registry from the app's .env, which only the server reads. Every sign-in from this computer goes with the deploy, and the server uses the ones those images need."
            : "Some images take their registry from the app's .env, which only the server reads. Only credentials stored on the server sign in to it."}
        </p>
      )}
      {entries.length === 0 ? (
        unresolved ? null : (
          <p className="text-xs text-muted-foreground">Every image is built here; nothing pulls.</p>
        )
      ) : (
        <ul aria-label="Registries this app pulls from" className="space-y-1">
          {entries.map((entry) => (
            <EntryLine key={entry.registry} entry={entry} />
          ))}
        </ul>
      )}
      {stackId && (
        <div className="flex items-center gap-2 pt-1">
          <Switch
            id={switchId}
            checked={sendSignIns}
            onCheckedChange={(next) => void toggle(next)}
          />
          <Label htmlFor={switchId} className="text-xs">
            Send this computer's sign-ins with this app's deploys
          </Label>
        </div>
      )}
    </section>
  );
}
