import { coreErrorMessage } from '@shared/coreErrors';
import type { DeployServer } from '@shared/deployTypes';
import { useSearchParams } from 'react-router-dom';
import { Skeleton } from '@/components/ui/skeleton';
import { RegistriesPanel } from '../registries/RegistriesPanel';
import { AppDetail } from './AppDetail';
import { AppsList } from './AppsList';
import { useAppsAccess, useStack, useStacks } from './hooks';
import { NewAppWizard } from './NewAppWizard';

/**
 * A server's Apps section (E07). The list, one app (`&app=<id>`), and the New App wizard
 * (`&new=1`, or `&app=<id>&new=1` to deploy an app again) all live in the page's address, so a
 * link opens any of them.
 */

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
        onDeployAgain={(details) => show({ app: details.stack.id, new: '1' })}
        onDeleted={() => show({})}
        onOpenRegistries={() => show({ app: appId, registries: '1' })}
        onOpenWebsites={() => setParams({ server: serverId, view: 'websites' })}
      />
    );
  }

  return (
    <AppsList
      apps={apps.data}
      loading={apps.isPending}
      error={apps.error ? coreErrorMessage(apps.error) : null}
      canOperate={access.canOperate}
      onRetry={() => void apps.refetch()}
      onOpen={(stackId) => show({ app: stackId })}
      onNew={() => show({ new: '1' })}
      onRegistries={() => show({ registries: '1' })}
    />
  );
}
