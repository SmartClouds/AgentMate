import { getModelPrice, MODEL_PRICES, type UsageTokens } from '@runova/core';
import { describe, expect, it } from 'vitest';
import {
  buildProjectReport,
  conversationKey,
  type ListedConversation,
  parseConversationKey,
  type RecordedUsage,
  type ReportInput,
} from './projectUsageReport';
import type { UsageBucket } from './projectUsageScan';

/**
 * Turns buckets into the report the Usage tab draws. Prices come from the catalog, so every
 * expected cost is worked out from `getModelPrice` rather than typed in as a dollar amount.
 */

const [PRICED, PRICED_B] = Object.keys(MODEL_PRICES);
const UNPRICED = 'a-model-nobody-has-priced';

function costOf(model: string, tokens: Partial<Omit<UsageTokens, 'total'>>): number {
  const price = getModelPrice(model);
  if (!price) throw new Error(`${model} has no price`);
  return (
    ((tokens.input ?? 0) * price.input +
      (tokens.output ?? 0) * price.output +
      (tokens.cacheRead ?? 0) * price.cacheRead +
      (tokens.cacheWrite ?? 0) * price.cacheWrite) /
    1_000_000
  );
}

const A = conversationKey('claude-code', 'aaaa');
const B = conversationKey('claude-code', 'bbbb');
const C = conversationKey('codex', 'cccc');

const conversations: ListedConversation[] = [
  { provider: 'claude-code', id: 'aaaa', title: 'Refactor billing', updatedAt: 300 },
  { provider: 'claude-code', id: 'bbbb', title: null, updatedAt: 200 },
  { provider: 'codex', id: 'cccc', title: 'Fix the build', updatedAt: 100 },
];

function bucket(
  key: string,
  day: string,
  model: string,
  tokens: Partial<Omit<UsageTokens, 'total'>>,
): UsageBucket {
  return {
    key,
    day,
    model,
    input: tokens.input ?? 0,
    output: tokens.output ?? 0,
    cacheRead: tokens.cacheRead ?? 0,
    cacheWrite: tokens.cacheWrite ?? 0,
  };
}

function report(overrides: Partial<ReportInput> = {}) {
  return buildProjectReport({
    days: null,
    folders: 1,
    truncated: false,
    conversations,
    buckets: [],
    recorded: [],
    uncounted: [],
    unreadable: 0,
    ...overrides,
  });
}

describe('conversationKey', () => {
  it('round-trips the agent and the id', () => {
    expect(parseConversationKey(conversationKey('codex', 'abc-1'))).toEqual({
      provider: 'codex',
      id: 'abc-1',
    });
  });

  it('keeps ids of two agents apart', () => {
    expect(conversationKey('codex', 'x')).not.toBe(conversationKey('claude-code', 'x'));
  });
});

describe('buildProjectReport totals', () => {
  it('adds every conversation, model and day, and prices each model', () => {
    const result = report({
      buckets: [
        bucket(A, '2026-09-17', PRICED, { input: 1000, output: 200 }),
        bucket(A, '2026-09-18', PRICED_B, { cacheRead: 5000 }),
        bucket(C, '2026-09-18', PRICED, { output: 40 }),
      ],
    });

    expect(result.tokens).toEqual({
      input: 1000,
      output: 240,
      cacheRead: 5000,
      cacheWrite: 0,
      total: 6240,
    });
    expect(result.costUsd).toBeCloseTo(
      costOf(PRICED, { input: 1000, output: 240 }) + costOf(PRICED_B, { cacheRead: 5000 }),
      10,
    );
    expect(result.costPartial).toBe(false);
    expect(result.conversations).toBe(2);
  });

  it('is empty, not an error, for a project with no spend', () => {
    const result = report();

    expect(result.tokens.total).toBe(0);
    expect(result.costUsd).toBeNull();
    expect(result.costPartial).toBe(false);
    expect(result.conversations).toBe(0);
    expect(result.byDay).toEqual([]);
    expect(result.byAgent).toEqual([]);
    expect(result.byModel).toEqual([]);
    expect(result.top).toEqual([]);
  });

  it('marks the cost a lower bound when some tokens ran on an unpriced model', () => {
    const result = report({
      buckets: [
        bucket(A, '2026-09-17', PRICED, { input: 1000 }),
        bucket(A, '2026-09-17', UNPRICED, { input: 9_000_000 }),
      ],
    });

    expect(result.costUsd).toBeCloseTo(costOf(PRICED, { input: 1000 }), 10);
    expect(result.costPartial).toBe(true);
    expect(result.tokens.total).toBe(9_001_000);
  });

  it('has no cost, and no lower bound, when nothing is priced', () => {
    const result = report({ buckets: [bucket(A, '2026-09-17', UNPRICED, { input: 50 })] });

    expect(result.costUsd).toBeNull();
    expect(result.costPartial).toBe(false);
  });

  it('passes the period, folders and warnings through', () => {
    const result = report({
      days: 30,
      folders: 3,
      truncated: true,
      unreadable: 2,
      uncounted: [{ provider: 'gemini-cli', conversations: 4 }],
    });

    expect(result).toMatchObject({
      days: 30,
      folders: 3,
      truncated: true,
      unreadable: 2,
      uncounted: [{ provider: 'gemini-cli', conversations: 4 }],
    });
  });
});

describe('buildProjectReport breakdowns', () => {
  const buckets = [
    bucket(A, '2026-09-18', PRICED, { output: 10 }),
    bucket(A, '2026-09-17', PRICED, { input: 100 }),
    bucket(B, '2026-09-17', PRICED, { input: 100 }),
    bucket(C, '2026-09-19', PRICED_B, { output: 5 }),
  ];

  it('lists the days with spend, oldest first', () => {
    const { byDay } = report({ buckets });

    expect(byDay.map((d) => d.day)).toEqual(['2026-09-17', '2026-09-18', '2026-09-19']);
    expect(byDay[0].tokens).toBe(200);
    expect(byDay[0].costUsd).toBeCloseTo(costOf(PRICED, { input: 200 }), 10);
  });

  it('leaves a day without a cost when nothing that day is priced', () => {
    const { byDay } = report({ buckets: [bucket(A, '2026-09-17', UNPRICED, { input: 1 })] });

    expect(byDay).toEqual([{ day: '2026-09-17', tokens: 1, costUsd: null }]);
  });

  it('groups by agent, counting its conversations', () => {
    const { byAgent } = report({ buckets });

    const claude = byAgent.find((a) => a.provider === 'claude-code');
    expect(claude?.conversations).toBe(2);
    expect(claude?.tokens.total).toBe(210);
    expect(byAgent.find((a) => a.provider === 'codex')?.conversations).toBe(1);
  });

  it('lists the agent that cost more first', () => {
    const { byAgent } = report({
      buckets: [
        bucket(A, '2026-09-17', PRICED, { input: 5_000_000 }),
        bucket(C, '2026-09-17', PRICED, { input: 5 }),
      ],
    });

    expect(byAgent.map((a) => a.provider)).toEqual(['claude-code', 'codex']);
  });

  it('groups by model, most tokens first', () => {
    const { byModel } = report({ buckets });

    expect(byModel.map((m) => m.model)).toEqual([PRICED, PRICED_B]);
    expect(byModel[0].tokens.total).toBe(210);
    expect(byModel[0].costUsd).toBeCloseTo(costOf(PRICED, { input: 200, output: 10 }), 10);
  });

  it('gives an unpriced model no cost', () => {
    const { byModel } = report({ buckets: [bucket(A, '2026-09-17', UNPRICED, { input: 7 })] });

    expect(byModel).toEqual([expect.objectContaining({ model: UNPRICED, costUsd: null })]);
  });
});

describe('buildProjectReport top conversations', () => {
  it('names the costliest conversations first, with their titles', () => {
    const { top } = report({
      buckets: [
        bucket(B, '2026-09-17', PRICED, { input: 10 }),
        bucket(A, '2026-09-17', PRICED, { input: 10_000_000 }),
        bucket(C, '2026-09-17', PRICED, { input: 1_000 }),
      ],
    });

    expect(top.map((t) => t.id)).toEqual(['aaaa', 'cccc', 'bbbb']);
    expect(top[0]).toMatchObject({
      provider: 'claude-code',
      title: 'Refactor billing',
      updatedAt: 300,
      tokens: 10_000_000,
    });
    expect(top[0].costUsd).toBeCloseTo(costOf(PRICED, { input: 10_000_000 }), 10);
  });

  it('puts unpriced conversations after priced ones, by tokens', () => {
    const { top } = report({
      buckets: [
        bucket(A, '2026-09-17', UNPRICED, { input: 9_000 }),
        bucket(B, '2026-09-17', PRICED, { input: 1 }),
        bucket(C, '2026-09-17', UNPRICED, { input: 90_000 }),
      ],
    });

    expect(top.map((t) => t.id)).toEqual(['bbbb', 'cccc', 'aaaa']);
    expect(top[1].costUsd).toBeNull();
  });

  it('keeps only the eight costliest', () => {
    const many: ListedConversation[] = Array.from({ length: 12 }, (_, i) => ({
      provider: 'claude-code',
      id: `id${i}`,
      title: null,
      updatedAt: i,
    }));

    const { top } = report({
      conversations: many,
      buckets: many.map((c, i) =>
        bucket(conversationKey(c.provider, c.id), '2026-09-17', PRICED, { input: 1000 * (i + 1) }),
      ),
    });

    expect(top).toHaveLength(8);
    expect(top[0].id).toBe('id11');
  });

  it('still counts a conversation the list did not name', () => {
    const { top, conversations: counted } = report({
      conversations: [],
      buckets: [bucket(A, '2026-09-17', PRICED, { input: 3 })],
    });

    expect(counted).toBe(1);
    expect(top[0]).toMatchObject({ id: 'aaaa', title: null, updatedAt: 0 });
  });

  it('flags a conversation whose cost is only part of its tokens', () => {
    const { top } = report({
      buckets: [
        bucket(A, '2026-09-17', PRICED, { input: 1000 }),
        bucket(A, '2026-09-17', UNPRICED, { input: 1000 }),
      ],
    });

    expect(top[0].costPartial).toBe(true);
  });
});

describe('buildProjectReport with OpenCode totals', () => {
  const OPENCODE = conversationKey('opencode', 'ses_1');
  const row = (overrides: Partial<RecordedUsage>): RecordedUsage => ({
    key: OPENCODE,
    day: '2026-09-20',
    model: PRICED,
    input: 1000,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    recordedCostUsd: null,
    ...overrides,
  });

  it('prefers the cost OpenCode recorded', () => {
    const result = report({ recorded: [row({ recordedCostUsd: 1.23 })] });

    expect(result.costUsd).toBe(1.23);
    expect(result.byAgent[0]).toMatchObject({ provider: 'opencode', conversations: 1 });
  });

  it('estimates from the catalog when it recorded none', () => {
    const result = report({ recorded: [row({})] });

    expect(result.costUsd).toBeCloseTo(costOf(PRICED, { input: 1000 }), 10);
    expect(result.byDay).toEqual([{ day: '2026-09-20', tokens: 1000, costUsd: result.costUsd }]);
  });

  it('has tokens but no cost when it names no model and recorded none', () => {
    const result = report({ recorded: [row({ model: null })] });

    expect(result.tokens.total).toBe(1000);
    expect(result.costUsd).toBeNull();
    expect(result.byModel).toEqual([]);
  });

  it('adds up with the file based agents', () => {
    const result = report({
      buckets: [bucket(A, '2026-09-20', PRICED, { input: 500 })],
      recorded: [row({ recordedCostUsd: 2 })],
    });

    expect(result.tokens.total).toBe(1500);
    expect(result.costUsd).toBeCloseTo(costOf(PRICED, { input: 500 }) + 2, 10);
    expect(result.conversations).toBe(2);
  });
});
