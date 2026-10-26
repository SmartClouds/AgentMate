import {
  type AgentHistoryProvider,
  emptyUsageTokens,
  estimateCost,
  type UsageTokens,
} from '@runova/core';
import type {
  ProjectUsageAgent,
  ProjectUsageConversation,
  ProjectUsageDay,
  ProjectUsageModel,
  ProjectUsageReport,
  ProjectUsageUncounted,
} from '../../shared/apiTypes';
import { makeTokens } from '../usage/shared';
import type { UsageBucket } from './projectUsageScan';

// Turns what the scan found into the report the project page draws: prices each model, then
// rolls the same lines up by day, agent, model and conversation. Pure, so every rule here is
// tested without a transcript or a worker.

const SEPARATOR = '\u0000';

/** How many conversations the "most expensive" list keeps. */
export const TOP_CONVERSATIONS = 8;

/** Names a conversation across agents, since two agents can hand out the same id. */
export function conversationKey(provider: AgentHistoryProvider, id: string): string {
  return `${provider}${SEPARATOR}${id}`;
}

export function parseConversationKey(key: string): {
  provider: AgentHistoryProvider;
  id: string;
} {
  const at = key.indexOf(SEPARATOR);
  return { provider: key.slice(0, at) as AgentHistoryProvider, id: key.slice(at + 1) };
}

/** A conversation the history list found, with what the report shows about it. */
export interface ListedConversation {
  provider: AgentHistoryProvider;
  id: string;
  title: string | null;
  updatedAt: number;
}

/**
 * Totals an agent keeps itself (OpenCode: one row per session, with no time per message), placed
 * on the day the session was last updated. A cost it recorded beats our estimate.
 */
export interface RecordedUsage {
  key: string;
  day: string;
  model: string | null;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  recordedCostUsd: number | null;
}

export interface ReportInput {
  days: number | null;
  folders: number;
  truncated: boolean;
  conversations: readonly ListedConversation[];
  buckets: readonly UsageBucket[];
  recorded: readonly RecordedUsage[];
  uncounted: ProjectUsageUncounted[];
  unreadable: number;
}

/** One priced piece of spend: a conversation, a day and a model. */
interface Line {
  key: string;
  day: string;
  model: string | null;
  tokens: UsageTokens;
  costUsd: number | null;
}

/** A running total. `unpriced` is set when some of its tokens have no price. */
interface Spend {
  tokens: UsageTokens;
  costUsd: number | null;
  unpriced: boolean;
}

const newSpend = (): Spend => ({ tokens: emptyUsageTokens(), costUsd: null, unpriced: false });

function addTo(spend: Spend, line: Line): void {
  spend.tokens.input += line.tokens.input;
  spend.tokens.output += line.tokens.output;
  spend.tokens.cacheRead += line.tokens.cacheRead;
  spend.tokens.cacheWrite += line.tokens.cacheWrite;
  spend.tokens.total += line.tokens.total;
  if (line.costUsd === null) spend.unpriced = true;
  else spend.costUsd = (spend.costUsd ?? 0) + line.costUsd;
}

/** A lower bound only means something when part of the cost is known. */
const isPartial = (spend: Spend): boolean => spend.unpriced && spend.costUsd !== null;

function slot<Key>(map: Map<Key, Spend>, key: Key): Spend {
  const existing = map.get(key);
  if (existing) return existing;
  const created = newSpend();
  map.set(key, created);
  return created;
}

/** Costliest first; with no price on either side, the one that used more tokens. */
const byCostThenTokens = (
  a: { costUsd: number | null; tokens: number },
  b: { costUsd: number | null; tokens: number },
): number => (b.costUsd ?? -1) - (a.costUsd ?? -1) || b.tokens - a.tokens;

function toLines(input: ReportInput): Line[] {
  const lines: Line[] = [];
  for (const bucket of input.buckets) {
    const tokens = makeTokens(bucket.input, bucket.output, bucket.cacheRead, bucket.cacheWrite);
    if (tokens.total === 0) continue;
    lines.push({
      key: bucket.key,
      day: bucket.day,
      model: bucket.model,
      tokens,
      costUsd: estimateCost(bucket.model, tokens),
    });
  }
  for (const row of input.recorded) {
    const tokens = makeTokens(row.input, row.output, row.cacheRead, row.cacheWrite);
    if (tokens.total === 0) continue;
    const recorded = row.recordedCostUsd !== null && row.recordedCostUsd > 0;
    lines.push({
      key: row.key,
      day: row.day,
      model: row.model,
      tokens,
      costUsd: recorded ? row.recordedCostUsd : row.model ? estimateCost(row.model, tokens) : null,
    });
  }
  return lines;
}

export function buildProjectReport(
  input: ReportInput,
): Extract<ProjectUsageReport, { status: 'ok' }> {
  const total = newSpend();
  const days = new Map<string, Spend>();
  const agents = new Map<AgentHistoryProvider, Spend>();
  const agentConversations = new Map<AgentHistoryProvider, Set<string>>();
  const models = new Map<string, Spend>();
  const conversations = new Map<string, Spend>();

  for (const line of toLines(input)) {
    addTo(total, line);
    addTo(slot(days, line.day), line);
    addTo(slot(conversations, line.key), line);
    if (line.model) addTo(slot(models, line.model), line);
    const { provider } = parseConversationKey(line.key);
    addTo(slot(agents, provider), line);
    const keys = agentConversations.get(provider) ?? new Set<string>();
    keys.add(line.key);
    agentConversations.set(provider, keys);
  }

  const listed = new Map(input.conversations.map((c) => [conversationKey(c.provider, c.id), c]));

  const byDay: ProjectUsageDay[] = [...days]
    .map(([day, spend]) => ({ day, tokens: spend.tokens.total, costUsd: spend.costUsd }))
    .sort((a, b) => a.day.localeCompare(b.day));

  const byAgent: ProjectUsageAgent[] = [...agents]
    .map(([provider, spend]) => ({
      provider,
      conversations: agentConversations.get(provider)?.size ?? 0,
      tokens: spend.tokens,
      costUsd: spend.costUsd,
      costPartial: isPartial(spend),
    }))
    .sort((a, b) =>
      byCostThenTokens(
        { costUsd: a.costUsd, tokens: a.tokens.total },
        { costUsd: b.costUsd, tokens: b.tokens.total },
      ),
    );

  const byModel: ProjectUsageModel[] = [...models]
    .map(([model, spend]) => ({ model, tokens: spend.tokens, costUsd: spend.costUsd }))
    .sort((a, b) => b.tokens.total - a.tokens.total);

  const top: ProjectUsageConversation[] = [...conversations]
    .map(([key, spend]) => {
      const { provider, id } = parseConversationKey(key);
      const info = listed.get(key);
      return {
        provider,
        id,
        title: info?.title ?? null,
        updatedAt: info?.updatedAt ?? 0,
        tokens: spend.tokens.total,
        costUsd: spend.costUsd,
        costPartial: isPartial(spend),
      };
    })
    .sort(byCostThenTokens)
    .slice(0, TOP_CONVERSATIONS);

  return {
    status: 'ok',
    days: input.days,
    tokens: total.tokens,
    costUsd: total.costUsd,
    costPartial: isPartial(total),
    conversations: conversations.size,
    byDay,
    byAgent,
    byModel,
    top,
    uncounted: input.uncounted,
    unreadable: input.unreadable,
    truncated: input.truncated,
    folders: input.folders,
  };
}
