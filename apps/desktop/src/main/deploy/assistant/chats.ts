import type { SshAgentHistoryRun } from '../../../shared/apiTypes';
import type { DeployAssistantChatSummary } from '../../../shared/deployAssistantTypes';

/**
 * The Deploy AI's chats, out of its runs. Each follow-up is a run of its own that continues the
 * one before it, so a chat is a chain of runs, listed by its newest and named by its first.
 */

/** More runs than a server keeps on disk, so a chain is never cut short by this. */
const MAX_CHAIN = 100;

/** The run with this id and the runs it continued, oldest first. Empty when it is unknown. */
export function chainOf(runs: readonly SshAgentHistoryRun[], runId: string): SshAgentHistoryRun[] {
  const byId = new Map(runs.map((run) => [run.id, run]));
  const chain: SshAgentHistoryRun[] = [];
  let next: string | undefined = runId;
  while (next && chain.length < MAX_CHAIN) {
    const found = byId.get(next);
    if (!found || chain.includes(found)) break;
    chain.unshift(found);
    next = found.continuedFromRunId;
  }
  return chain;
}

function lastActivity(run: SshAgentHistoryRun): number {
  return run.endedAt ?? run.entries.at(-1)?.at ?? run.startedAt;
}

/** Every chat in `runs`, the most recently active first. */
export function chatsFrom(runs: readonly SshAgentHistoryRun[]): DeployAssistantChatSummary[] {
  const continued = new Set(runs.map((run) => run.continuedFromRunId).filter(Boolean));
  return runs
    .filter((run) => !continued.has(run.id))
    .map((newest) => {
      const chain = chainOf(runs, newest.id);
      const first = chain[0] ?? newest;
      const app = [...chain].reverse().find((run) => run.app)?.app;
      return {
        runId: newest.id,
        title: first.prompt,
        startedAt: first.startedAt,
        updatedAt: lastActivity(newest),
        status: newest.status,
        turns: chain.length,
        aiLabel: newest.aiLabel,
        ...(app ? { app } : {}),
      };
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}
