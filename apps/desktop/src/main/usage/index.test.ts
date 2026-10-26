import type { ProviderUsage, SubscriptionWindow } from '@runova/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The usage list the status bar, the Token Usage page and the widgets all read. These pin what a
 * list or a refresh hands out when a provider's read fails: its card becomes an error, the limits
 * it still has travel with it, a failed read recalls the last limits it had, and a refresh drops
 * the caches behind one provider and no others. Every scanner is stubbed, so nothing reads the real
 * home folder or the network.
 */

const cursor = vi.hoisted(() => ({ fetchCursorSessionUsage: vi.fn() }));
const scanner = vi.hoisted(() => ({ scanLocalProvider: vi.fn() }));
const opencode = vi.hoisted(() => ({ scanOpencodeUsage: vi.fn() }));
const copilot = vi.hoisted(() => ({ fetchCopilotUsage: vi.fn() }));
const claude = vi.hoisted(() => ({ clearLiveWindowCache: vi.fn() }));
const cursorAccount = vi.hoisted(() => ({ clearCursorAccountCache: vi.fn() }));

vi.mock('./cursorSession', () => cursor);
vi.mock('./localScanner', () => scanner);
vi.mock('./opencode', () => opencode);
vi.mock('./copilot', () => copilot);
vi.mock('./claudeAccount', () => claude);
vi.mock('./cursorAccount', () => cursorAccount);
vi.mock('./apiProviders', () => ({ fetchApiProviderUsage: vi.fn() }));
vi.mock('./knownProjects', () => ({ loadKnownProjects: vi.fn(async () => []) }));

const PRO_PLUS = { id: 'pro-plus', label: 'Pro+' };

function snapshot(providerId: string, over: Partial<ProviderUsage> = {}): ProviderUsage {
  const period = {
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    costUsd: null,
  };
  return {
    providerId,
    status: 'ok',
    today: period,
    last7d: period,
    last30d: period,
    currency: 'USD',
    updatedAt: new Date().toISOString(),
    ...over,
  };
}

/** Cursor with its monthly limit at `percent`, reset five hours away. */
function cursorWithLimit(percent: number): ProviderUsage {
  const windows: SubscriptionWindow[] = [
    {
      key: 'month',
      label: 'Monthly usage',
      percent,
      resetAt: new Date(Date.now() + 5 * 3_600_000).toISOString(),
    },
  ];
  return snapshot('cursor', {
    subscription: { mode: 'subscription', plan: PRO_PLUS, windows, source: 'account' },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type Index = typeof import('./index');
type Shared = typeof import('./shared');

/** A fresh copy of the modules, so each test starts with empty caches. */
async function load(): Promise<{ index: Index; shared: Shared }> {
  vi.resetModules();
  const index = await import('./index');
  const shared = await import('./shared');
  return { index, shared };
}

beforeEach(() => {
  vi.clearAllMocks();
  // The fold logs each failure so it is not silent. The tests check the outcome, not the log.
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  scanner.scanLocalProvider.mockImplementation(async (id: string) => snapshot(id));
  opencode.scanOpencodeUsage.mockImplementation(async () => snapshot('opencode'));
  copilot.fetchCopilotUsage.mockImplementation(async () => snapshot('copilot'));
  cursor.fetchCursorSessionUsage.mockImplementation(async () => cursorWithLimit(41));
});

describe('the usage list', () => {
  it('folds one failing provider into its own error card and returns the rest', async () => {
    scanner.scanLocalProvider.mockImplementation(async (id: string) => {
      if (id === 'claude-code') throw new Error('scan broke');
      return snapshot(id);
    });
    const { index } = await load();

    const list = await index.getAllUsage({}, true);

    expect(list.find((u) => u.providerId === 'claude-code')).toMatchObject({
      status: 'error',
      error: 'scan broke',
    });
    expect(list.find((u) => u.providerId === 'codex')?.status).toBe('ok');
  });

  it('hands a failed read the limits that the last good read reported', async () => {
    const { index } = await load();
    const good = await index.getAllUsage({}, true);
    expect(good.find((u) => u.providerId === 'cursor')?.lastLimits).toBeUndefined();

    cursor.fetchCursorSessionUsage.mockRejectedValueOnce(new Error('Could not reach Cursor.'));
    const list = await index.getAllUsage({}, true);

    const card = list.find((u) => u.providerId === 'cursor');
    expect(card?.status).toBe('error');
    expect(card?.lastLimits?.windows[0]).toMatchObject({ percent: 41 });
  });

  it('keeps the limits of a partly failed read on its error card, as current', async () => {
    const { index, shared } = await load();
    cursor.fetchCursorSessionUsage.mockRejectedValueOnce(
      new shared.PartialUsageError('Cursor did not answer in time.', {
        subscription: cursorWithLimit(41).subscription,
        window: undefined,
      }),
    );

    const list = await index.getAllUsage({}, true);

    const card = list.find((u) => u.providerId === 'cursor');
    expect(card).toMatchObject({ status: 'error', error: 'Cursor did not answer in time.' });
    expect(card?.subscription?.windows).toHaveLength(1);
    // These limits are current, so nothing has to be recalled for the card.
    expect(card?.lastLimits).toBeUndefined();
  });

  it('still rejects a single read with the partial error, which widgets and watchers rely on', async () => {
    const { index, shared } = await load();
    const partial = new shared.PartialUsageError('Cursor did not answer in time.', {
      subscription: undefined,
      window: undefined,
    });
    cursor.fetchCursorSessionUsage.mockRejectedValueOnce(partial);

    await expect(index.getProviderUsage('cursor', undefined, true)).rejects.toBe(partial);
  });

  it('does not let an older read that fails late evict a newer cached read', async () => {
    const { index } = await load();
    const older = deferred<ProviderUsage>();
    const newer = deferred<ProviderUsage>();
    cursor.fetchCursorSessionUsage
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);

    const first = index.getProviderUsage('cursor', undefined);
    const second = index.getProviderUsage('cursor', undefined, true);
    newer.resolve(cursorWithLimit(55));
    await second;
    older.reject(new Error('Could not reach Cursor.'));
    await expect(first).rejects.toThrow('Could not reach Cursor.');

    // The newer read is still cached, so this does not go back to Cursor.
    await index.getProviderUsage('cursor', undefined);
    expect(cursor.fetchCursorSessionUsage).toHaveBeenCalledTimes(2);
  });
});

describe('refreshing one provider', () => {
  it('re-reads that provider even with a warm cache, and clears only its own caches', async () => {
    const { index } = await load();
    await index.getProviderUsage('cursor', undefined);
    await index.getProviderUsage('cursor', undefined);
    expect(cursor.fetchCursorSessionUsage).toHaveBeenCalledTimes(1);

    await index.refreshProviderUsage('cursor', undefined);
    expect(cursor.fetchCursorSessionUsage).toHaveBeenCalledTimes(2);
    expect(cursorAccount.clearCursorAccountCache).toHaveBeenCalledTimes(1);
    expect(claude.clearLiveWindowCache).not.toHaveBeenCalled();

    await index.refreshProviderUsage('claude-code', undefined);
    expect(claude.clearLiveWindowCache).toHaveBeenCalledTimes(1);
  });

  it('turns a failed refresh into an error card rather than rejecting', async () => {
    cursor.fetchCursorSessionUsage.mockRejectedValueOnce(new Error('Could not reach Cursor.'));
    const { index } = await load();

    const usage = await index.refreshProviderUsage('cursor', undefined);

    expect(usage).toMatchObject({
      providerId: 'cursor',
      status: 'error',
      error: 'Could not reach Cursor.',
    });
  });
});
