import { CATALOG_TEMPLATES, findCatalogTemplate } from '@runova/core';
import { coreErrorMessage } from '@shared/coreErrors';
import type { DeployServer } from '@shared/deployTypes';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Problem } from '@/components/cloudflare/fields';
import { Lock } from '@/components/icons';
import { GLASS_CARD } from '@/components/pageKit';
import { Skeleton } from '@/components/ui/skeleton';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import {
  type AppStoreInstall,
  useDeployAppStoreInstallStore,
} from '@/stores/deployAppStoreInstallStore';
import { useAppsAccess } from '../apps/hooks';
import { Notice } from '../deployKit';
import { CatalogGrid } from './CatalogGrid';
import { useInstalledApps } from './hooks';
import { InstalledAppView } from './InstalledAppView';
import { InstalledList } from './InstalledList';
import { type InstallRequest, InstallSheet } from './InstallSheet';

/**
 * A server's App Store section (E12): the apps it installed, the catalog, the install sheet
 * (`&install=<template>`) and one installed app (`&app=<stack>`), each in the page's address.
 * The install itself runs in the install store, so it goes on when the page is left, and the
 * passwords it made stay in memory there, never on disk, for the card right after.
 */

export function AppStorePanel({ server }: { server: DeployServer }): React.JSX.Element {
  const serverId = server.id;
  const [params, setParams] = useSearchParams();
  const queryClient = useQueryClient();
  const access = useAppsAccess(serverId);
  const installed = useInstalledApps(serverId, access.signedIn);
  const kept = useDeployAppStoreInstallStore(
    (state): AppStoreInstall | undefined => state.installs[serverId],
  );
  const busy = kept?.busy ?? false;
  const error = kept?.error ?? null;
  const session = kept?.session ?? null;
  const installing = params.get('install');
  const appId = params.get('app');
  const template = installing ? findCatalogTemplate(installing) : null;

  const show = useCallback(
    (extra: Record<string, string>) =>
      setParams({ server: serverId, view: 'store', ...extra }, { replace: false }),
    [setParams, serverId],
  );

  // An install that finished opens its app once, even when it finished while the page was left.
  const finished = session && !session.opened ? session.stackId : null;
  useEffect(() => {
    if (!finished) return;
    useDeployAppStoreInstallStore.getState().markOpened(serverId);
    show({ app: finished });
  }, [finished, serverId, show]);

  if (access.pending) {
    return (
      <div className={cn(GLASS_CARD, 'p-4')} aria-busy="true">
        <Skeleton className="h-32 w-full rounded-lg" />
      </div>
    );
  }
  if (!access.signedIn) {
    return (
      <Notice icon={Lock}>
        Sign in to {server.nickname} on its Overview to install apps on it.
      </Notice>
    );
  }

  const taken = (installed.stacks ?? []).map((stack) => stack.name);

  function install(request: InstallRequest): void {
    void useDeployAppStoreInstallStore.getState().install(serverId, request, () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.deployApps(serverId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.deployWeb(serverId) });
    });
  }

  /** Forgets the install's passwords once its app is left, unless its domain steps still run. */
  function leaveInstalled(): void {
    const steps = session?.expose?.steps ?? [];
    if (!steps.some((one) => one.state === 'running' || one.state === 'waiting')) {
      useDeployAppStoreInstallStore.getState().dismiss(serverId);
    }
  }

  if (appId) {
    return (
      <InstalledAppView
        key={appId}
        server={server}
        access={access}
        stackId={appId}
        secrets={session?.stackId === appId ? session.secrets : null}
        expose={session?.stackId === appId ? session.expose : null}
        notice={session?.stackId === appId ? session.notice : null}
        onBack={() => {
          leaveInstalled();
          show({});
        }}
        onOpenInApps={() => {
          leaveInstalled();
          setParams({ server: serverId, view: 'apps', app: appId });
        }}
      />
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {installed.error ? (
        <Problem message={coreErrorMessage(installed.error)} onRetry={installed.refetch} />
      ) : (
        <InstalledList
          apps={installed.apps}
          loading={installed.loading}
          onOpen={(stackId) => show({ app: stackId })}
        />
      )}
      <CatalogGrid
        templates={CATALOG_TEMPLATES}
        canInstall={access.canOperate}
        onInstall={(templateId) => {
          useDeployAppStoreInstallStore.getState().clearError(serverId);
          show({ install: templateId });
        }}
      />
      {template && (
        <InstallSheet
          key={template.id}
          template={template}
          taken={taken}
          canAdmin={access.canAdmin}
          busy={busy}
          error={error}
          onCancel={() => show({})}
          onInstall={install}
        />
      )}
    </div>
  );
}
