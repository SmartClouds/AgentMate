import type {
  GithubWorkflowInfo,
  GithubWorkflowRunInfo,
  ProjectPipelineStatus,
} from '@shared/apiTypes';
import { useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { type RunTone, runTone } from '@/components/pipelines/runStatus';
import { queryKeys } from '@/lib/queryKeys';

const RANK: Record<string, number> = {
  failed: 0,
  running: 1,
  queued: 2,
  passed: 3,
  cancelled: 4,
  other: 5,
};

/** Shortest time a retry shows its spinner, so an instant failure still reads as a retry. */
const RETRY_FEEDBACK_MS = 600;

export interface PipelineRow {
  workflow: GithubWorkflowInfo;
  /** The workflow's latest run, or null when it has never run. */
  run: GithubWorkflowRunInfo | null;
  tone: RunTone | null;
}

/** Why there are no rows to show, for the notice that takes their place. */
export type PipelineNotice =
  | { kind: 'error'; error: string | null }
  | { kind: 'no-cli' }
  | { kind: 'signed-out' }
  | { kind: 'no-remote' }
  | { kind: 'no-workflows'; repo: string };

export type PipelinesView =
  | { kind: 'loading' }
  | { kind: 'notice'; notice: PipelineNotice }
  | { kind: 'ready'; rows: PipelineRow[]; repo: string };

export interface PipelinesState {
  view: PipelinesView;
  /** Reads again, keeping `retrying` on for a beat so a click never looks like it did nothing. */
  retry: () => void;
  retrying: boolean;
  /** Reads again without the retry feedback. */
  refresh: () => void;
  fetching: boolean;
}

/**
 * GitHub Actions for one project: each workflow's latest run, failures first. The Pipelines section
 * and its larger-view dialog both render from one call of this, so they never disagree.
 *
 * Only reads while `enabled`, because a folded section renders nothing and should not poll GitHub.
 */
export function usePipelineStatus(
  projectId: string,
  { enabled }: { enabled: boolean },
): PipelinesState {
  const status = useQuery({
    queryKey: queryKeys.pipelineStatus(projectId),
    queryFn: () => window.runova.pipelines.status(projectId),
    enabled,
    refetchInterval: enabled ? 30_000 : false,
    meta: { silentLoading: true },
  });

  // A refresh that fails (offline, rate limited) must not replace rows the user is working with.
  // Swapping them for the error notice unmounts every row, and with it an open Fix with AI dialog.
  const lastGood = useRef<{ projectId: string; data: ProjectPipelineStatus } | null>(null);
  if (status.data && !status.data.error) lastGood.current = { projectId, data: status.data };

  const [retrying, setRetrying] = useState(false);
  function retry(): void {
    if (retrying) return;
    setRetrying(true);
    const minimum = new Promise((done) => setTimeout(done, RETRY_FEEDBACK_MS));
    void Promise.all([status.refetch(), minimum]).finally(() => setRetrying(false));
  }

  return {
    view: toView(status.isPending, status.data, lastGood.current, projectId),
    retry,
    retrying,
    refresh: () => void status.refetch(),
    fetching: status.isFetching,
  };
}

function toView(
  pending: boolean,
  latest: ProjectPipelineStatus | undefined,
  lastGood: { projectId: string; data: ProjectPipelineStatus } | null,
  projectId: string,
): PipelinesView {
  if (pending) return { kind: 'loading' };

  const remembered = lastGood?.projectId === projectId ? lastGood.data : undefined;
  const data = latest?.error || !latest ? (remembered ?? latest) : latest;

  if (!data || data.error) {
    return { kind: 'notice', notice: { kind: 'error', error: data?.error ?? null } };
  }
  if (!data.cliAvailable) return { kind: 'notice', notice: { kind: 'no-cli' } };
  if (!data.authenticated) return { kind: 'notice', notice: { kind: 'signed-out' } };
  if (!data.github) return { kind: 'notice', notice: { kind: 'no-remote' } };

  const repo = `${data.github.owner}/${data.github.repo}`;
  if (data.workflows.length === 0) {
    return { kind: 'notice', notice: { kind: 'no-workflows', repo } };
  }

  const rows = data.workflows
    .map((workflow): PipelineRow => {
      const run = data.runsByWorkflowId[workflow.id] ?? null;
      return { workflow, run, tone: run ? runTone(run) : null };
    })
    .sort(
      (a, b) => (RANK[a.tone?.outcome ?? 'other'] ?? 9) - (RANK[b.tone?.outcome ?? 'other'] ?? 9),
    );
  return { kind: 'ready', rows, repo };
}
