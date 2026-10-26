import { CATALOG_TEMPLATES, findCatalogTemplate } from '@runova/core';
import { coreErrorMessage } from '@shared/coreErrors';
import type { DeployServer } from '@shared/deployTypes';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Problem } from '@/components/cloudflare/fields';
import { Lock } from '@/components/icons';
import { GLASS_CARD } from '@/components/pageKit';
import { Skeleton } from '@/components/ui/skeleton';
import { suggestId } from '@/lib/deploy/sites/draft';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { useAppsAccess } from '../apps/hooks';
import { Notice } from '../deployKit';
import { CatalogGrid } from './CatalogGrid';
import { useInstalledApps } from './hooks';
import { type ExposeStep, InstalledAppView } from './InstalledAppView';
import { InstalledList } from './InstalledList';
import { type InstallRequest, InstallSheet } from './InstallSheet';

/**
 * A server's App Store section (E12): the apps it installed, the catalog, the install sheet
 * (`&install=<template>`) and one installed app (`&app=<stack>`), each in the page's address.
 * The passwords of an install stay in this component's memory only, for the card right after.
 */

interface Session {
  stackId: string;
  secrets: Record<string, string>;
  expose: { domain: string; steps: ExposeStep[] } | null;
  /** Why nothing was deployed, when the server refused the files. */
  notice: string | null;
}

export function AppStorePanel({ server }: { server: DeployServer }): React.JSX.Element {
  const serverId = server.id;
  const [params, setParams] = useSearchParams();
  const queryClient = useQueryClient();
  const access = useAppsAccess(serverId);
  const installed = useInstalledApps(serverId, access.signedIn);
  const [session, setSession] = useState<Session | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const installing = params.get('install');
  const appId = params.get('app');
  const template = installing ? findCatalogTemplate(installing) : null;

  const show = (extra: Record<string, string>) =>
    setParams({ server: serverId, view: 'store', ...extra }, { replace: false });

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

  function step(stackId: string, id: ExposeStep['id'], next: Partial<ExposeStep>): void {
    setSession((current) =>
      current?.stackId === stackId && current.expose
        ? {
            ...current,
            expose: {
              ...current.expose,
              steps: current.expose.steps.map((item) =>
                item.id === id ? { ...item, ...next } : item,
              ),
            },
          }
        : current,
    );
  }

  /** The site in Websites, nginx applied, then the certificate: each its own step. */
  async function expose(stackId: string, request: InstallRequest, domain: string): Promise<void> {
    const render = request.check.render;
    const web = render?.web;
    const port =
      web && render.ports.find((p) => p.service === web.service && p.target === web.port);
    if (!port) {
      step(stackId, 'site', { state: 'failed', detail: 'The app has no web port to point at.' });
      return;
    }
    const siteId = suggestId(domain);
    let at: ExposeStep['id'] = 'site';
    try {
      const saved = await window.runova.deploySites.save(serverId, {
        id: siteId,
        domains: [domain],
        upstream: {
          kind: 'servicePort',
          // A label the core takes (letters, digits, '.', '_', '-', at most 63).
          service: `${request.draft.name}-${web.service}`.slice(0, 63),
          port: port.published,
          verifyCertificate: true,
          sendUpstreamHost: false,
        },
        websocket: true,
        gzip: true,
        http2: true,
        redirectToHttps: false,
      });
      if (!saved.site) {
        throw new Error(
          saved.problems.map((item) => item.message).join(' ') || 'nginx refused the site.',
        );
      }
      step(stackId, 'site', {
        state: 'done',
        detail: `Site ${siteId} forwards to 127.0.0.1:${port.published}.`,
      });
      at = 'apply';
      step(stackId, 'apply', { state: 'running' });
      const applied = await window.runova.deploySites.applyChanges(serverId);
      if (!applied.applied) throw new Error(applied.error ?? 'nginx kept its old configuration.');
      step(stackId, 'apply', { state: 'done' });
      if (!request.draft.certificate) {
        step(stackId, 'certificate', {
          state: 'skipped',
          detail: "Add one later from the site's SSL tab in Websites.",
        });
        return;
      }
      at = 'certificate';
      step(stackId, 'certificate', { state: 'running' });
      await window.runova.deployCerts.issue({
        serverId,
        siteId,
        acceptTermsOfService: true,
        staging: false,
      });
      step(stackId, 'certificate', {
        state: 'done',
        detail: "Let's Encrypt is checking the domain. The site's SSL tab shows when it arrives.",
      });
    } catch (failure) {
      step(stackId, at, { state: 'failed', detail: coreErrorMessage(failure) });
    } finally {
      void queryClient.invalidateQueries({ queryKey: queryKeys.deployWeb(serverId) });
    }
  }

  async function install(request: InstallRequest): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const result = await window.runova.deployAppStore.install({
        serverId,
        templateId: request.template.id,
        version: request.draft.version,
        name: request.draft.name,
        params: request.check.params,
        secrets: request.check.secrets,
        domain: request.check.domain,
      });
      const stackId = result.stack.id;
      const domain = request.check.domain;
      setSession({
        stackId,
        secrets: request.check.secrets,
        expose: domain
          ? {
              domain,
              steps: [
                { id: 'site', label: 'Add the site in Websites', state: 'running' },
                { id: 'apply', label: 'Apply nginx', state: 'skipped' },
                { id: 'certificate', label: 'Ask for a certificate', state: 'skipped' },
              ],
            }
          : null,
        notice: result.job
          ? null
          : (result.revision.error ?? 'The server refused the files, so nothing was deployed.'),
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.deployApps(serverId) });
      show({ app: stackId });
      if (domain) void expose(stackId, request, domain);
    } catch (failure) {
      setError(coreErrorMessage(failure));
    } finally {
      setBusy(false);
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
        onBack={() => show({})}
        onOpenInApps={() => setParams({ server: serverId, view: 'apps', app: appId })}
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
          setError(null);
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
          onInstall={(request) => void install(request)}
        />
      )}
    </div>
  );
}
