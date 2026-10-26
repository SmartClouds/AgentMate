import { summarizeChecks } from '@runova/core';
import type {
  MergePullRequestIpcInput,
  MergePullRequestResult,
  MergeStepResult,
  PrActionResult,
  PullRequestStatus,
} from '@shared/apiTypes';
import { type QueryClient, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef } from 'react';
import { toast } from 'sonner';
import { create } from 'zustand';
import { queryKeys } from '@/lib/queryKeys';
import { useWorkspaceStore } from '@/stores/workspaceStore';

export interface RecentMerge {
  number: number;
  base: string;
  head: string;
  steps: MergeStepResult[];
}

/**
 * The last merge made from the tab, per project. Cleanup switches to the default branch, which
 * turns the tab into its "start from a branch" state; this keeps the outcome on screen there.
 */
export const useRecentMerges = create<{
  byProject: Record<string, RecentMerge>;
  record: (projectId: string, merge: RecentMerge) => void;
  dismiss: (projectId: string) => void;
}>((set) => ({
  byProject: {},
  record: (projectId, merge) =>
    set((state) => ({ byProject: { ...state.byProject, [projectId]: merge } })),
  dismiss: (projectId) =>
    set((state) => {
      const { [projectId]: _gone, ...rest } = state.byProject;
      return { byProject: rest };
    }),
}));

const FAST_POLL_MS = 15_000;
const SLOW_POLL_MS = 60_000;

/**
 * How often to ask GitHub again. Running checks change by the minute, so they are watched
 * closely; nothing is polled when there is no PR GitHub could still change.
 */
export function pullRequestRefetchInterval(status: PullRequestStatus | undefined): number | false {
  if (!status?.cliAvailable || !status.authenticated || !status.github) return false;
  if (!status.branch || status.onDefaultBranch) return false;
  if (!status.pr) return SLOW_POLL_MS;
  if (status.pr.state !== 'OPEN') return false;
  return summarizeChecks(status.pr.checks).running > 0 ? FAST_POLL_MS : SLOW_POLL_MS;
}

/** The facts from the live git state that make the PR worth reading again when they change. */
export interface PullRequestWatch {
  visible: boolean;
  branch: string | null | undefined;
  head: string | null | undefined;
  ahead: number | undefined;
  /** Set once the branch is published, from the app or from a terminal. */
  upstream?: string | null;
}

export interface PullRequestProgress {
  tone: 'success' | 'error' | 'warning' | 'info';
  title: string;
  description?: string;
}

/**
 * What happened on GitHub between two reads of the same open PR, worth a toast: checks that
 * finished, a review decision, new review comments. Merges and closes are left out, the merge
 * card already says so when it's done from here.
 */
export function pullRequestProgress(
  prev: PullRequestStatus | undefined,
  next: PullRequestStatus | undefined,
): PullRequestProgress[] {
  const before = prev?.pr;
  const after = next?.pr;
  if (!before || !after || before.number !== after.number) return [];
  if (before.state !== 'OPEN' || after.state !== 'OPEN') return [];
  const notes: PullRequestProgress[] = [];

  const was = summarizeChecks(before.checks);
  const now = summarizeChecks(after.checks);
  if (was.running > 0 && now.running === 0 && now.total > 0) {
    notes.push(
      now.failed > 0
        ? {
            tone: 'error',
            title: `Checks failed on #${after.number}`,
            description: `${now.failed} of ${now.total} ${now.total === 1 ? 'check' : 'checks'} failed.`,
          }
        : {
            tone: 'success',
            title: `Checks passed on #${after.number}`,
            description: `All ${now.total} ${now.total === 1 ? 'check' : 'checks'} passed.`,
          },
    );
  }

  if (after.reviewDecision !== before.reviewDecision) {
    if (after.reviewDecision === 'APPROVED') {
      notes.push({ tone: 'success', title: `#${after.number} was approved` });
    } else if (after.reviewDecision === 'CHANGES_REQUESTED') {
      notes.push({ tone: 'warning', title: `Changes requested on #${after.number}` });
    }
  }

  const openBefore = before.threads.filter((thread) => !thread.isResolved).length;
  const openAfter = after.threads.filter((thread) => !thread.isResolved).length;
  if (openAfter > openBefore) {
    const added = openAfter - openBefore;
    notes.push({
      tone: 'info',
      title: `${added} new review ${added === 1 ? 'comment' : 'comments'} on #${after.number}`,
    });
  }
  return notes;
}

function openPullRequestSection(): void {
  useWorkspaceStore.getState().revealPanelSection('pullRequest');
}

/**
 * Says the branch is on GitHub and, when it could have a pull request but has none yet,
 * offers to open one. Reads the last known PR status, so it never waits on gh.
 */
export function announcePublishedBranch(
  queryClient: QueryClient,
  projectId: string,
  branch: string | null | undefined,
  title = 'Branch published',
): void {
  void queryClient.invalidateQueries({ queryKey: queryKeys.pullRequest(projectId) });
  const status = queryClient.getQueryData<PullRequestStatus>(queryKeys.pullRequest(projectId));
  const canOpenPr = status?.github && status.authenticated && !status.onDefaultBranch && !status.pr;
  toast.success(title, {
    description: canOpenPr
      ? `${branch ?? 'The branch'} is on GitHub. Open a pull request to get it reviewed.`
      : undefined,
    action: canOpenPr
      ? { label: 'Create pull request', onClick: openPullRequestSection }
      : undefined,
  });
}

export function usePullRequest(projectId: string, watch: PullRequestWatch) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: queryKeys.pullRequest(projectId),
    queryFn: () => window.runova.pullRequests.status(projectId),
    enabled: watch.visible,
    refetchInterval: (q) => (watch.visible ? pullRequestRefetchInterval(q.state.data) : false),
    meta: { silentLoading: true },
  });

  // Checks and reviews move on GitHub while the user works elsewhere in the app; each poll
  // that brings news says so once.
  const lastSeen = useRef(query.data);
  useEffect(() => {
    const prev = lastSeen.current;
    lastSeen.current = query.data;
    for (const note of pullRequestProgress(prev, query.data)) {
      toast[note.tone](note.title, {
        description: note.description,
        action: { label: 'View', onClick: openPullRequestSection },
      });
    }
  }, [query.data]);

  // A commit, push, publish or branch switch changes what the tab should show; the first
  // render is already covered by the query itself.
  const fingerprint = `${watch.branch ?? ''}|${watch.head ?? ''}|${watch.ahead ?? ''}|${watch.upstream ?? ''}`;
  const seen = useRef(fingerprint);
  useEffect(() => {
    if (seen.current === fingerprint) return;
    seen.current = fingerprint;
    if (watch.visible) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.pullRequest(projectId) });
    }
  }, [fingerprint, projectId, queryClient, watch.visible]);

  // This status is read independently from the git status watcher that already knows the
  // branch, so the two can disagree for a moment (they are separate reads of the same repo).
  // A stale "you are on the default branch" from that mismatch would otherwise strand the tab
  // until something else changes the fingerprint above; asked again once, it corrects itself.
  const mismatchRetried = useRef<string | null>(null);
  useEffect(() => {
    if (!watch.visible || !watch.branch || !query.data?.branch || query.isFetching) return;
    if (watch.branch === query.data.branch) return;
    const key = `${watch.branch}|${query.data.branch}`;
    if (mismatchRetried.current === key) return;
    mismatchRetried.current = key;
    void queryClient.invalidateQueries({ queryKey: queryKeys.pullRequest(projectId) });
  }, [watch.visible, watch.branch, query.data, query.isFetching, projectId, queryClient]);

  return query;
}

function patchThreads(
  queryClient: QueryClient,
  projectId: string,
  threadId: string,
  resolved: boolean,
): void {
  queryClient.setQueryData<PullRequestStatus>(queryKeys.pullRequest(projectId), (status) =>
    status?.pr
      ? {
          ...status,
          pr: {
            ...status.pr,
            threads: status.pr.threads.map((thread) =>
              thread.id === threadId ? { ...thread, isResolved: resolved } : thread,
            ),
          },
        }
      : status,
  );
}

export interface PullRequestActions {
  comment: (number: number, body: string) => Promise<boolean>;
  reply: (threadId: string, body: string) => Promise<boolean>;
  resolveThread: (threadId: string, resolved: boolean) => Promise<boolean>;
  markReady: (number: number) => Promise<boolean>;
  merge: (input: Omit<MergePullRequestIpcInput, 'projectId'>) => Promise<MergePullRequestResult>;
  cleanup: (base: string, head: string) => Promise<MergePullRequestResult>;
  refresh: () => void;
}

export function usePullRequestActions(projectId: string): PullRequestActions {
  const queryClient = useQueryClient();
  return useMemo<PullRequestActions>(() => {
    const api = window.runova.pullRequests;
    const refresh = (): void => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.pullRequest(projectId) });
    };
    const settle = (result: PrActionResult): boolean => {
      if (!result.ok) toast.error(result.error ?? 'GitHub did not accept that.');
      refresh();
      return result.ok;
    };
    const afterMerge = (result: MergePullRequestResult): MergePullRequestResult => {
      refresh();
      // The branch list, history and changes panel all describe a branch that may be gone.
      void queryClient.invalidateQueries({ queryKey: queryKeys.gitWorkspaceState(projectId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.gitStatus(projectId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.gitBranchHistories(projectId) });
      return result;
    };

    return {
      refresh,
      comment: async (number, body) => settle(await api.comment({ projectId, number, body })),
      reply: async (threadId, body) => settle(await api.replyThread({ projectId, threadId, body })),
      resolveThread: async (threadId, resolved) => {
        patchThreads(queryClient, projectId, threadId, resolved);
        const result = await api.resolveThread({ projectId, threadId, resolved });
        if (!result.ok) patchThreads(queryClient, projectId, threadId, !resolved);
        return settle(result);
      },
      markReady: async (number) => settle(await api.markReady(projectId, number)),
      merge: async (input) => afterMerge(await api.merge({ projectId, ...input })),
      cleanup: async (base, head) => afterMerge(await api.cleanup({ projectId, base, head })),
    };
  }, [projectId, queryClient]);
}
