import type { Project } from '@runova/core';
import type {
  DeployWordPressProgressEvent,
  DeployWordPressSettingsInput,
  DeployWordPressSite,
  DeployWordPressUpdateConnectorResult,
} from '@shared/deployWordPressTypes';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { queryKeys } from '@/lib/queryKeys';
import { wpProblem } from './messages';

/**
 * Reads and writes for WordPress sites in Deploy. Everything sits under `['deploy', 'wordpress']`,
 * so unlocking the Servers vault refreshes it with the rest of Deploy.
 *
 * Calls that carry a secret (an HTTP sign-in password) go straight to the bridge instead of
 * through `useMutation`, which would keep the call's input in the mutation cache.
 */

/** Asking a site again on every section switch is slow on shared hosting; half a minute is fresh. */
const SITE_STALE_MS = 30_000;

export const AUDIT_PAGE_SIZE = 50;
/** Held still so the audit query key does too. */
const AUDIT_FILTER = { limit: AUDIT_PAGE_SIZE } as const;

export function useWordPressSites() {
  return useQuery({
    queryKey: queryKeys.deployWordPressSites,
    queryFn: async () => (await window.runova.deployWordPress.listSites()) ?? [],
  });
}

export function useSiteInfo(siteId: string) {
  return useQuery({
    queryKey: queryKeys.deployWordPressSiteInfo(siteId),
    queryFn: async () => {
      const info = await window.runova.deployWordPress.siteInfo(siteId);
      if (!info) throw new Error('The site sent nothing back.');
      return info;
    },
    staleTime: SITE_STALE_MS,
  });
}

export function useSiteItems(siteId: string) {
  return useQuery({
    queryKey: queryKeys.deployWordPressItems(siteId),
    queryFn: async () => (await window.runova.deployWordPress.listItems(siteId)) ?? [],
    staleTime: SITE_STALE_MS,
  });
}

export function useSiteHistory(siteId: string) {
  return useQuery({
    queryKey: queryKeys.deployWordPressHistory(siteId),
    queryFn: async () => (await window.runova.deployWordPress.history(siteId)) ?? [],
    staleTime: SITE_STALE_MS,
  });
}

/** The site's audit log, newest first, a page at a time (older pages by `before`). */
export function useSiteAudit(siteId: string) {
  return useInfiniteQuery({
    queryKey: queryKeys.deployWordPressAudit(siteId, AUDIT_FILTER),
    queryFn: async ({ pageParam }) =>
      (await window.runova.deployWordPress.audit({
        siteId,
        limit: AUDIT_PAGE_SIZE,
        ...(pageParam === undefined ? {} : { before: pageParam }),
      })) ?? [],
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => (last.length < AUDIT_PAGE_SIZE ? undefined : last.at(-1)?.id),
  });
}

/** Every project, from the same query the rest of the app reads. */
export function useProjects() {
  return useQuery({
    queryKey: queryKeys.projects,
    queryFn: async (): Promise<Project[]> => (await window.runova.projects.list()) ?? [],
  });
}

/** The projects linked to this site. */
export function siteProjects(projects: Project[] | undefined, siteId: string): Project[] {
  return (projects ?? []).filter((project) => project.wordpress?.siteId === siteId);
}

/** Puts a changed site into the cached list right away, then has the list read again. */
export function useSiteListUpdate() {
  const queryClient = useQueryClient();
  return useCallback(
    (site: DeployWordPressSite | undefined) => {
      if (site) {
        queryClient.setQueryData<DeployWordPressSite[]>(queryKeys.deployWordPressSites, (sites) =>
          sites?.some((one) => one.id === site.id)
            ? sites.map((one) => (one.id === site.id ? site : one))
            : [...(sites ?? []), site],
        );
      }
      void queryClient.invalidateQueries({ queryKey: queryKeys.deployWordPressSites });
    },
    [queryClient],
  );
}

/** Changes a site's name, plain-HTTP choice or HTTP sign-in. Never through the mutation cache. */
export function useSiteSettings(siteId: string) {
  const queryClient = useQueryClient();
  const update = useSiteListUpdate();
  return useCallback(
    async (patch: Omit<DeployWordPressSettingsInput, 'siteId'>) => {
      const site = await window.runova.deployWordPress.updateSettings({ siteId, ...patch });
      update(site);
      void queryClient.invalidateQueries({ queryKey: queryKeys.deployWordPressSite(siteId) });
      return site;
    },
    [siteId, queryClient, update],
  );
}

/** The latest progress event for one operation, while it runs. */
export function useOperationProgress(
  operationId: string | null,
): DeployWordPressProgressEvent | null {
  const [event, setEvent] = useState<DeployWordPressProgressEvent | null>(null);
  useEffect(() => {
    setEvent(null);
    if (!operationId) return undefined;
    return window.runova.deployWordPress.onProgress((next) => {
      if (next.operationId === operationId) setEvent(next);
    });
  }, [operationId]);
  return event;
}

/** Asks where to save the bundled Runova Connector zip and says where it went. */
export function useSaveConnectorZip(): { save: () => Promise<void>; saving: boolean } {
  const [saving, setSaving] = useState(false);
  const save = useCallback(async () => {
    setSaving(true);
    try {
      const result = await window.runova.deployWordPress.saveConnectorZip();
      if (result?.saved) toast.success(`Saved the plugin to ${result.path}.`);
    } catch (error) {
      toast.error(wpProblem(error));
    } finally {
      setSaving(false);
    }
  }, []);
  return { save, saving };
}

export interface ConnectorUpdate {
  update: () => Promise<void>;
  updating: boolean;
  /** What the last update did; null until one has finished, and again while the next runs. */
  result: DeployWordPressUpdateConnectorResult | null;
  /** Why the last update could not be made, in words. */
  problem: string | null;
}

/**
 * Replaces the connector on a site with the version bundled in this app. The state lives here, not
 * in the version row, because the row goes away once the site is up to date and the outcome must
 * stay on screen.
 */
export function useUpdateConnector(siteId: string): ConnectorUpdate {
  const queryClient = useQueryClient();
  const [updating, setUpdating] = useState(false);
  const [result, setResult] = useState<DeployWordPressUpdateConnectorResult | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // The panel is reused for the next site; its outcome is not that site's.
  useEffect(() => {
    setResult(null);
    setProblem(null);
  }, [siteId]);
  const update = useCallback(async () => {
    setUpdating(true);
    setResult(null);
    setProblem(null);
    try {
      setResult(await window.runova.deployWordPress.updateConnector(siteId));
    } catch (error) {
      setProblem(wpProblem(error));
    } finally {
      setUpdating(false);
      // The site answers for itself again, whether or not the update worked.
      void queryClient.invalidateQueries({ queryKey: queryKeys.deployWordPressSite(siteId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.deployWordPressSites });
    }
  }, [siteId, queryClient]);
  return { update, updating, result, problem };
}

/** A fresh id for a long call, so its progress events can be told apart. */
export function newOperationId(): string {
  return crypto.randomUUID();
}
