import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../shared/ipcChannels';
import type { NewsListResult } from '../../shared/newsTypes';
import { expectChannelsCovered, invoke, loadIpc } from '../../test/main/ipcHarness';
import type { NewsService } from '../news/service';

/**
 * The news channels (E42). Every payload is checked before the service sees it, so the renderer
 * can only ask for the filters, pages, slugs and ids the contract allows.
 */

// onChanged is main to renderer, broadcast by the service.
expectChannelsCovered(IPC.news, [IPC.news.onChanged]);

const RESULT: NewsListResult = {
  items: [],
  page: 1,
  totalPages: 1,
  total: 0,
  stale: false,
  checkedAt: null,
};

const service = {
  list: vi.fn(async () => RESULT),
  get: vi.fn(async () => null),
  refresh: vi.fn(async () => RESULT),
  markRead: vi.fn(async () => undefined),
  dismiss: vi.fn(async () => undefined),
} as unknown as NewsService & Record<string, ReturnType<typeof vi.fn>>;

beforeEach(async () => {
  for (const method of Object.values(service)) method.mockClear();
  await loadIpc(
    () => import('./news'),
    (module) => module.registerNewsHandlers({ service: () => service }),
  );
});

describe('news:list', () => {
  it('passes a valid query on, and treats none as no filters', async () => {
    const query = { category: ['security', 'ai'], minSeverity: 'high', page: 2, pageSize: 5 };
    await expect(invoke(IPC.news.list, query)).resolves.toEqual(RESULT);
    expect(service.list).toHaveBeenLastCalledWith(query);
    await invoke(IPC.news.list);
    expect(service.list).toHaveBeenLastCalledWith({});
  });

  it.each([
    ['an unknown category', { category: ['gossip'] }],
    ['an unknown severity', { minSeverity: 'urgent' }],
    ['a page below one', { page: 0 }],
    ['a fractional page', { page: 1.5 }],
    ['a page size over 50', { pageSize: 51 }],
    ['an unknown field', { status: 'draft' }],
    ['a string', 'security'],
  ])('rejects %s', async (_name, query) => {
    await expect(invoke(IPC.news.list, query)).rejects.toThrow(/not valid/);
    expect(service.list).not.toHaveBeenCalled();
  });
});

describe('news:get', () => {
  it('passes a slug on', async () => {
    await expect(invoke(IPC.news.get, { slug: 'git-2-45-1-fixes-rce' })).resolves.toBeNull();
    expect(service.get).toHaveBeenCalledWith('git-2-45-1-fixes-rce');
  });

  it.each([
    ['a path', { slug: '../admin' }],
    ['upper case', { slug: 'Git' }],
    ['an empty slug', { slug: '' }],
    ['a bare string', 'git'],
  ])('rejects %s', async (_name, payload) => {
    await expect(invoke(IPC.news.get, payload)).rejects.toThrow(/not valid/);
  });
});

describe('news:refresh', () => {
  it('answers the refreshed list', async () => {
    await expect(invoke(IPC.news.refresh)).resolves.toEqual(RESULT);
    expect(service.refresh).toHaveBeenCalledTimes(1);
  });
});

describe('news:markRead and news:dismiss', () => {
  it('pass an item id on', async () => {
    await invoke(IPC.news.markRead, { id: 7 });
    expect(service.markRead).toHaveBeenCalledWith(7);
    await invoke(IPC.news.dismiss, { id: 8 });
    expect(service.dismiss).toHaveBeenCalledWith(8);
  });

  it.each([
    ['a string id', { id: '7' }],
    ['a negative id', { id: -1 }],
    ['a fractional id', { id: 1.5 }],
    ['no id', {}],
  ])('reject %s', async (_name, payload) => {
    await expect(invoke(IPC.news.markRead, payload)).rejects.toThrow(/not valid/);
    await expect(invoke(IPC.news.dismiss, payload)).rejects.toThrow(/not valid/);
  });
});
