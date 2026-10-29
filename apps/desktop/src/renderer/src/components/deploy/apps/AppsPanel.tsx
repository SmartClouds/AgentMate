import { coreErrorMessage } from '@shared/coreErrors';
import type { StackDetails } from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { DeployServer } from '@shared/deployTypes';
import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Spinner } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  emptyDraft,
  isAppRunBusy,
  useDeployAppRunStore,
  wizardKey,
} from '@/stores/deployAppRunStore';
import { Notice } from '../deployKit';
import { RegistriesPanel } from '../registries/RegistriesPanel';
import { AppDetail } from './AppDetail';
import { AppsList } from './AppsList';
import { useAppsAccess, useStack, useStacks } from './hooks';
import { NewAppWizard } from './NewAppWizard';
import type { WizardSource } from './wizard/types';

/**
 * A server's Apps section (E07). The list, one app (`&app=<id>`), and the New App wizard
 * (`&new=1`, or `&app=<id>&new=1` to deploy an app again) all live in the page's address, so a
 * link opens any of them. A deploy started in the wizard goes on when the wizard is left, and
 * the list says so with a way back to it.
 */

/** A wizard's deploy that is on its way, or waits for the user, on this server. */
interface InFlight {
  key: string;
  name: string;
  existingStackId: string | null;
  waiting: boolean;
}

function useDeploysInFlight(serverId: string): InFlight[] {
  const wizards = useDeployAppRunStore((state) => state.wizards);
  return useMemo(
    () =>
      Object.entries(wizards).flatMap(([key, wizard]) => {
        const waiting = wizard.run.phase === 'confirm';
        if (wizard.serverId !== serverId || !(isAppRunBusy(wizard.run) || waiting)) return [];
        const tail = key.slice(serverId.length + 1);
        return [{ key, name: wizard.name, existingStackId: tail === 'new' ? null : tail, waiting }];
      }),
    [wizards, serverId],
  );
}

/** Opens a wizard afresh, unless a deploy from it is still on its way or waiting. */
function freshWizard(serverId: string, existingStackId: string | null): void {
  const key = wizardKey(serverId, existingStackId);
  const kept = useDeployAppRunStore.getState().wizards[key];
  if (kept && (isAppRunBusy(kept.run) || kept.run.phase === 'confirm')) return;
  useDeployAppRunStore.getState().reset(key);
}

/**
 * Opens Deploy again on Configure with an edited source, so the new files are checked before
 * they ship. The services kept private carry over unless the compose file changed.
 */
function editedWizard(serverId: string, details: StackDetails, source: WizardSource): void {
  freshWizard(serverId, details.stack.id);
  const store = useDeployAppRunStore.getState();
  const key = wizardKey(serverId, details.stack.id);
  // A deploy still on its way keeps the wizard; it shows that deploy rather than the edit.
  if (store.wizards[key]) return;
  const sameCompose = source.composePath === details.stack.source?.composePath;
  store.open(
    key,
    emptyDraft({
      step: 'configure',
      reached: 1,
      source,
      nameTouched: true,
      proxied: sameCompose ? details.revisions[0]?.proxiedServices : undefined,
    }),
  );
}

function DeployAgain({
  serverId,
  stackId,
  access,
  onCancel,
  onOpenApp,
}: {
  serverId: string;
  stackId: string;
  access: ReturnType<typeof useAppsAccess>;
  onCancel: () => void;
  onOpenApp: (stackId: string) => void;
}): React.JSX.Element {
  const details = useStack(serverId, stackId, access.signedIn, false);
  if (details.isPending) return <Skeleton className="h-64 w-full rounded-xl" aria-busy="true" />;
  if (!details.data) {
    return (
      <p role="alert" className="text-sm text-muted-foreground">
        The app did not load{details.error ? `: ${coreErrorMessage(details.error)}` : '.'}
      </p>
    );
  }
  return (
    <NewAppWizard
      serverId={serverId}
      access={access}
      existing={details.data}
      onCancel={onCancel}
      onOpenApp={onOpenApp}
    />
  );
}

export function AppsPanel({ server }: { server: DeployServer }): React.JSX.Element {
  const serverId = server.id;
  const [params, setParams] = useSearchParams();
  const access = useAppsAccess(serverId);
  const apps = useStacks(serverId, access.signedIn);
  const appId = params.get('app');
  const wizard = params.get('new') === '1';
  const registries = params.get('registries') === '1';
  const inFlight = useDeploysInFlight(serverId);

  const show = (extra: Record<string, string>) =>
    setParams({ server: serverId, view: 'apps', ...extra }, { replace: false });

  if (access.pending) {
    return <Skeleton className="h-40 w-full rounded-xl" aria-busy="true" />;
  }

  if (!access.signedIn) {
    return (
      <p className="text-sm text-muted-foreground">
        Sign in to {server.nickname} on its Overview to see and deploy its apps.
      </p>
    );
  }

  if (registries) {
    return (
      <RegistriesPanel
        server={server}
        access={access}
        onBack={() => show(appId ? { app: appId } : {})}
      />
    );
  }

  if (wizard && appId) {
    return (
      <DeployAgain
        serverId={serverId}
        stackId={appId}
        access={access}
        onCancel={() => show({ app: appId })}
        onOpenApp={(stackId) => show({ app: stackId })}
      />
    );
  }

  if (wizard) {
    return (
      <NewAppWizard
        serverId={serverId}
        access={access}
        onCancel={() => show({})}
        onOpenApp={(stackId) => show({ app: stackId })}
      />
    );
  }

  if (appId) {
    return (
      <AppDetail
        serverId={serverId}
        stackId={appId}
        access={access}
        onBack={() => show({})}
        onDeployAgain={(details) => {
          freshWizard(serverId, details.stack.id);
          show({ app: details.stack.id, new: '1' });
        }}
        onEditSource={(details, source) => {
          editedWizard(serverId, details, source);
          show({ app: details.stack.id, new: '1' });
        }}
        onDeleted={() => show({})}
        onOpenRegistries={() => show({ app: appId, registries: '1' })}
        onOpenWebsites={() => setParams({ server: serverId, view: 'websites' })}
      />
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {inFlight.map((deploy) => (
        <Notice
          key={deploy.key}
          role="status"
          aria-label="Deploy in progress"
          tone="primary"
          icon={deploy.waiting ? undefined : Spinner}
          iconClassName={deploy.waiting ? undefined : 'motion-safe:animate-spin'}
          action={
            <Button
              size="sm"
              variant="soft"
              onClick={() =>
                show(
                  deploy.existingStackId ? { app: deploy.existingStackId, new: '1' } : { new: '1' },
                )
              }
            >
              Show
            </Button>
          }
        >
          {deploy.waiting
            ? `The deploy of ${deploy.name} waits for you to accept what the server found.`
            : `Deploying ${deploy.name}…`}
        </Notice>
      ))}
      <AppsList
        apps={apps.data}
        loading={apps.isPending}
        error={apps.error ? coreErrorMessage(apps.error) : null}
        canOperate={access.canOperate}
        onRetry={() => void apps.refetch()}
        onOpen={(stackId) => show({ app: stackId })}
        onNew={() => {
          freshWizard(serverId, null);
          show({ new: '1' });
        }}
        onRegistries={() => show({ registries: '1' })}
      />
    </div>
  );
}
