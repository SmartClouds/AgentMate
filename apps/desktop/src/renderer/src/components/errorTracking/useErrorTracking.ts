import type { ErrorIssueStatus } from '@runova/core';
import type {
  ErrorConnectionSummary,
  ErrorIssueDetail,
  ErrorIssuePage,
  ErrorIssuePrompt,
  ErrorIssueQuery,
  ErrorIssueRef,
  ErrorIssueSummary,
  ErrorProjectLink,
  ErrorStatusFilter,
  RemoteProject,
} from '@shared/errorTrackingTypes';
import {
  type InfiniteData,
  keepPreviousData,
  type QueryClient,
  useInfiniteQuery,
  useQueries,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { toast } from 'sonner';
import { ipcErrorMessage } from '@/components/projects/environments/ipcError';
import { queryKeys } from '@/lib/queryKeys';
import { applyIssueStatus, mergeIssuePages } from './errorView';

/**
 * The Errors tab's reads and writes (E24). The main process caches each issue query for a minute
 * and pushes `onChanged` after a connection, link or status change, so the lists poll lightly
 * (once a minute, only while the window has focus) and refresh on that push.
 *
 * A token goes in through the connections dialog with a plain call and is never put in a query
 * or mutation cache.
 */

/** Error reads report progress in their own rows, so they never raise the page overlay. */
const QUIET = { silentLoading: true } as const;
const POLL_MS = 60_000;

/** The query without the paging and refresh flags, which is also its cache key. */
export type ErrorIssueFilter = Omit<ErrorIssueQuery, 'cursor' | 'refresh'>;

/** A filter with the empty fields left out, so equal filters always share one cache entry. */
export function issueFilter(input: ErrorIssueFilter): ErrorIssueFilter {
  const out: ErrorIssueFilter = { status: input.status, period: input.period, sort: input.sort };
  if (input.projectId) out.projectId = input.projectId;
  if (input.environment) out.environment = input.environment;
  const search = input.search?.trim();
  if (search) out.search = search;
  return out;
}

const ISSUES_PREFIX = ['error-tracking', 'issues'] as const;

/** Reads everything again when the main process says something changed. */
export function useErrorTrackingChanges(): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    return window.runova.errorTracking.onChanged((event) => {
      const reason = event?.reason;
      // A status change only touches issues; connections and links can change any list.
      const queryKey = reason === 'issues' ? ISSUES_PREFIX : queryKeys.errorTracking;
      void queryClient.invalidateQueries({ queryKey }, { cancelRefetch: false });
      if (reason === 'issues') {
        void queryClient.invalidateQueries(
          { queryKey: ['error-tracking', 'issue'] },
          { cancelRefetch: false },
        );
      }
    });
  }, [queryClient]);
}

export function useErrorConnections() {
  return useQuery({
    queryKey: queryKeys.errorConnections,
    queryFn: async (): Promise<ErrorConnectionSummary[]> =>
      (await window.runova.errorTracking.listConnections()) ?? [],
    meta: QUIET,
  });
}

export function useErrorLinks(projectId?: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.errorLinks(projectId),
    queryFn: async (): Promise<ErrorProjectLink[]> =>
      (await window.runova.errorTracking.listLinks(projectId ? { projectId } : undefined)) ?? [],
    enabled,
    meta: QUIET,
  });
}

export function useErrorEnvironments(projectId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.errorEnvironments(projectId),
    queryFn: async (): Promise<string[]> =>
      (await window.runova.errorTracking.environments(projectId ? { projectId } : undefined)) ?? [],
    enabled,
    staleTime: 5 * 60_000,
    meta: QUIET,
  });
}

/** Every connection's provider projects, for the link pickers. */
export function useRemoteProjects(connectionIds: readonly string[], enabled = true) {
  const results = useQueries({
    queries: connectionIds.map((id) => ({
      queryKey: queryKeys.errorRemoteProjects(id),
      queryFn: async (): Promise<RemoteProject[]> =>
        (await window.runova.errorTracking.remoteProjects(id)) ?? [],
      enabled,
      staleTime: 5 * 60_000,
      meta: QUIET,
    })),
  });
  const byConnection = new Map<string, RemoteProject[]>();
  connectionIds.forEach((id, i) => {
    byConnection.set(id, results[i]?.data ?? []);
  });
  return {
    byConnection,
    isLoading: results.some((one) => one.isLoading),
    errors: connectionIds
      .map((id, i) => ({ connectionId: id, error: results[i]?.error ?? null }))
      .filter((one) => one.error !== null),
  };
}

type IssuePages = InfiniteData<ErrorIssuePage, string | null>;

/**
 * One filter's issues, page by page. `refresh` skips the main process's cache; `stale` is set when
 * a refresh failed while rows from before are still on screen.
 */
export function useErrorIssues(
  filter: ErrorIssueFilter,
  { enabled = true, poll = true }: { enabled?: boolean; poll?: boolean } = {},
) {
  useErrorTrackingChanges();
  const forceRef = useRef(false);
  const query = useInfiniteQuery({
    queryKey: queryKeys.errorIssues(filter),
    queryFn: async ({ pageParam }): Promise<ErrorIssuePage> => {
      const request: ErrorIssueQuery = { ...filter, cursor: pageParam };
      if (forceRef.current) request.refresh = true;
      return (
        (await window.runova.errorTracking.listIssues(request)) ?? {
          issues: [],
          nextCursor: null,
          failures: [],
          fetchedAt: Date.now(),
        }
      );
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled,
    // A new filter keeps the old rows up (dimmed) until its answer lands, instead of a shimmer.
    placeholderData: keepPreviousData,
    // Only the list on screen polls; a count elsewhere rides on its reads.
    refetchInterval: poll ? POLL_MS : false,
    meta: QUIET,
  });

  const queryClient = useQueryClient();
  const { refetch } = query;
  const refresh = useCallback(() => {
    // Back to the first page: a cursor from minutes ago can go stale, and the provider then
    // refuses every page after it, so a refresh the user asks for always starts over.
    queryClient.setQueryData<IssuePages>(queryKeys.errorIssues(filter), (data) =>
      data && data.pages.length > 1
        ? { pages: data.pages.slice(0, 1), pageParams: data.pageParams.slice(0, 1) }
        : data,
    );
    forceRef.current = true;
    void refetch().finally(() => {
      forceRef.current = false;
    });
  }, [refetch, queryClient, filter]);

  const pages = query.data?.pages;
  const merged = useMemo(() => mergeIssuePages(pages ?? []), [pages]);
  const failedRefresh =
    query.data !== undefined &&
    query.error !== null &&
    query.errorUpdatedAt >= query.dataUpdatedAt &&
    !query.isPlaceholderData;

  return {
    issues: merged.issues,
    failures: merged.failures,
    loaded: query.data !== undefined && !query.isPlaceholderData,
    fetchedAt: pages?.[0]?.fetchedAt ?? null,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    isPlaceholder: query.isPlaceholderData,
    error: query.data === undefined ? query.error : null,
    stale: failedRefresh ? ipcErrorMessage(query.error, 'Something went wrong.') : null,
    /** The failure was the next page, not a refresh of what is shown. */
    moreFailed: failedRefresh && query.isFetchNextPageError,
    hasMore: query.hasNextPage,
    loadingMore: query.isFetchingNextPage,
    loadMore: () => void query.fetchNextPage(),
    refresh,
  };
}

export function useErrorIssue(ref: ErrorIssueRef | null) {
  return useQuery({
    queryKey: queryKeys.errorIssue(ref?.connectionId ?? '', ref?.issueId ?? ''),
    queryFn: async (): Promise<ErrorIssueDetail | null> =>
      ref ? ((await window.runova.errorTracking.getIssue(ref)) ?? null) : null,
    enabled: ref !== null,
    meta: QUIET,
  });
}

/** The fix prompt's key, under the issue so a change to it refreshes the prompt too. */
export function errorFixPromptKey(ref: ErrorIssueRef) {
  return [...queryKeys.errorIssue(ref.connectionId, ref.issueId), 'fix-prompt'] as const;
}

async function readPrompt(ref: ErrorIssueRef): Promise<ErrorIssuePrompt | null> {
  return (await window.runova.errorTracking.fixPrompt(ref)) ?? null;
}

export function useErrorFixPrompt(ref: ErrorIssueRef, enabled: boolean) {
  return useQuery({
    queryKey: errorFixPromptKey(ref),
    queryFn: () => readPrompt(ref),
    enabled,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
    meta: QUIET,
  });
}

/** The prompt for Copy for AI, from the cache when the Fix dialog already built it. */
export function fetchErrorFixPrompt(
  queryClient: QueryClient,
  ref: ErrorIssueRef,
): Promise<ErrorIssuePrompt | null> {
  return queryClient.fetchQuery({
    queryKey: errorFixPromptKey(ref),
    queryFn: () => readPrompt(ref),
    staleTime: 60_000,
  });
}

const DONE: Record<ErrorIssueStatus, string> = {
  resolved: 'Issue resolved',
  ignored: 'Issue ignored',
  unresolved: 'Issue reopened',
};

const VERB: Record<ErrorIssueStatus, string> = {
  resolved: 'resolve',
  ignored: 'ignore',
  unresolved: 'reopen',
};

/**
 * Resolve, ignore or reopen an issue. The lists and the open issue change at once; when the
 * provider refuses, they go back and a toast says why. A resolve or ignore offers Undo.
 */
export function useIssueStatusChange() {
  const queryClient = useQueryClient();

  const change = useCallback(
    async (
      issue: ErrorIssueSummary,
      status: ErrorIssueStatus,
      ignoreMinutes: number | null = null,
    ): Promise<void> => {
      const ref: ErrorIssueRef = { connectionId: issue.connectionId, issueId: issue.id };
      const detailKey = queryKeys.errorIssue(ref.connectionId, ref.issueId);
      await queryClient.cancelQueries({ queryKey: ISSUES_PREFIX });
      const lists = queryClient.getQueriesData<IssuePages>({ queryKey: ISSUES_PREFIX });
      const before = queryClient.getQueryData<ErrorIssueDetail | null>(detailKey);

      for (const [key, data] of lists) {
        if (!data?.pages) continue;
        const filterStatus =
          (key[2] as { status?: ErrorStatusFilter } | undefined)?.status ?? 'all';
        queryClient.setQueryData<IssuePages>(key, {
          ...data,
          pages: data.pages.map((one) => applyIssueStatus(one, ref, status, filterStatus)),
        });
      }
      if (before) {
        queryClient.setQueryData<ErrorIssueDetail>(detailKey, {
          ...before,
          issue: { ...before.issue, status },
        });
      }

      try {
        await window.runova.errorTracking.setIssueStatus({ ...ref, status, ignoreMinutes });
        toast.success(DONE[status], {
          description: issue.shortId,
          action:
            status === 'unresolved'
              ? undefined
              : { label: 'Undo', onClick: () => void change(issue, 'unresolved') },
        });
      } catch (error) {
        for (const [key, data] of lists) queryClient.setQueryData(key, data);
        if (before) queryClient.setQueryData(detailKey, before);
        toast.error(`Could not ${VERB[status]} the issue`, {
          description: ipcErrorMessage(error, 'Something went wrong.'),
        });
      } finally {
        void queryClient.invalidateQueries({ queryKey: ISSUES_PREFIX });
        void queryClient.invalidateQueries({ queryKey: detailKey });
      }
    },
    [queryClient],
  );

  return change;
}
