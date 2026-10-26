import type { PostmanRequestItem } from '@runova/core';
import type { ApiExecutionResult } from '@shared/apiClientTypes';
import { beforeEach, describe, expect, it } from 'vitest';
import { isTabDirty, useApiClientTabsStore } from './apiClientTabsStore';

/**
 * Open request tabs. A tab edits a draft; it knows which saved request it came from, whether it
 * has unsaved changes, and what its last response was. The URL and Params table stay in step.
 */

const store = () => useApiClientTabsStore.getState();
const tab = (id: string) => store().tabs.find((t) => t.id === id);

const saved: PostmanRequestItem = {
  id: 'item-1',
  name: 'List users',
  request: { method: 'GET', url: 'https://api.test/users?page=1', proxy: { keep: true } },
  event: [{ listen: 'test', script: { exec: ['pm.test("ok", () => {})'] } }],
};

beforeEach(() => {
  useApiClientTabsStore.setState({ tabs: [], activeTabId: null });
});

describe('opening and closing tabs', () => {
  it('opens a blank request tab and makes it active', () => {
    const id = store().newTab();
    expect(store().activeTabId).toBe(id);
    expect(tab(id)).toMatchObject({ name: 'Untitled Request', source: null });
    expect(tab(id)?.draft.method).toBe('GET');
    expect(isTabDirty(tab(id)!)).toBe(false);
  });

  it('opens a saved request once, and focuses its tab the second time', () => {
    const first = store().openRequest('col-1', saved);
    store().newTab();
    const second = store().openRequest('col-1', saved);

    expect(second).toBe(first);
    expect(store().tabs).toHaveLength(2);
    expect(store().activeTabId).toBe(first);
    expect(tab(first)).toMatchObject({
      name: 'List users',
      source: { collectionId: 'col-1', itemId: 'item-1' },
    });
    expect(tab(first)?.draft.params[0]).toMatchObject({ key: 'page', value: '1' });
    expect(tab(first)?.draft.events).toHaveLength(1);
  });

  it('activates the neighbour when the active tab closes', () => {
    const a = store().newTab();
    const b = store().newTab();
    const c = store().newTab();
    store().setActive(b);
    store().closeTab(b);
    expect(store().activeTabId).toBe(c);
    store().closeTab(c);
    expect(store().activeTabId).toBe(a);
    store().closeTab(a);
    expect(store().activeTabId).toBeNull();
  });

  it('closes every tab of a request or collection that was deleted', () => {
    store().openRequest('col-1', saved);
    store().openRequest('col-1', { ...saved, id: 'item-2' });
    store().openRequest('col-2', { ...saved, id: 'item-3' });

    store().forgetSource('col-1', 'item-1');
    expect(store().tabs.map((t) => t.source?.itemId)).toEqual(['item-2', 'item-3']);

    store().forgetSource('col-1');
    expect(store().tabs.map((t) => t.source?.itemId)).toEqual(['item-3']);
  });
});

describe('editing', () => {
  it('keeps the URL and Params table in step both ways', () => {
    const id = store().newTab();
    store().setUrl(id, 'https://a.test/users/:id?q=1&sort=asc');
    expect(tab(id)?.draft.params.map((p) => [p.key, p.value])).toEqual([
      ['q', '1'],
      ['sort', 'asc'],
    ]);
    expect(tab(id)?.draft.pathVariables.map((p) => p.key)).toEqual(['id']);

    const params = tab(id)!.draft.params;
    store().setParams(id, [
      { ...params[0]!, value: '2' },
      { ...params[1]!, enabled: false },
    ]);
    expect(tab(id)?.draft.url).toBe('https://a.test/users/:id?q=2');
    expect(tab(id)?.draft.params).toHaveLength(2);
  });

  it('marks a tab dirty on change and clean again once it matches what was saved', () => {
    const id = store().openRequest('col-1', saved);
    store().updateDraft(id, (draft) => ({ ...draft, method: 'POST' }));
    expect(isTabDirty(tab(id)!)).toBe(true);
    store().updateDraft(id, (draft) => ({ ...draft, method: 'GET' }));
    expect(isTabDirty(tab(id)!)).toBe(false);
  });

  it('builds the request to send, keeping fields the editor does not show', () => {
    const id = store().openRequest('col-1', saved);
    store().setUrl(id, 'https://api.test/users?page=3');
    expect(store().requestFor(id)).toMatchObject({
      method: 'GET',
      proxy: { keep: true },
      url: { raw: 'https://api.test/users?page=3' },
    });
  });

  it('counts a renamed saved request as unsaved', () => {
    const id = store().openRequest('col-1', saved);
    store().renameTab(id, 'Users');
    expect(tab(id)?.name).toBe('Users');
    expect(isTabDirty(tab(id)!)).toBe(true);
    store().renameTab(id, 'List users');
    expect(isTabDirty(tab(id)!)).toBe(false);
  });

  it('builds the item to save without marking the tab saved', () => {
    const id = store().openRequest('col-1', saved);
    store().updateDraft(id, (draft) => ({ ...draft, method: 'PATCH' }));
    expect(store().itemFor(id, 'item-1', 'Patched')).toMatchObject({
      id: 'item-1',
      name: 'Patched',
      request: { method: 'PATCH', proxy: { keep: true } },
      event: saved.event,
    });
    expect(isTabDirty(tab(id)!)).toBe(true);
  });

  it('remembers where a new request was saved and becomes clean', () => {
    const id = store().newTab();
    store().setUrl(id, 'https://a.test');
    expect(isTabDirty(tab(id)!)).toBe(true);

    const item = store().markSaved(id, { collectionId: 'col-9', itemId: 'new-item' }, 'Ping');
    expect(item).toMatchObject({ id: 'new-item', name: 'Ping', request: { method: 'GET' } });
    expect(tab(id)).toMatchObject({
      name: 'Ping',
      source: { collectionId: 'col-9', itemId: 'new-item' },
    });
    expect(isTabDirty(tab(id)!)).toBe(false);
  });
});

describe('responses', () => {
  it('tracks sending and the result per tab', () => {
    const id = store().newTab();
    store().startSending(id, 'req-1');
    expect(tab(id)?.run).toEqual({
      status: 'sending',
      requestId: 'req-1',
      startedAt: expect.any(Number),
    });

    const result = { requestId: 'req-1', ok: true } as ApiExecutionResult;
    store().finishSending(id, result);
    expect(tab(id)?.run).toEqual({ status: 'done', result });
  });

  it('drops a result that belongs to an older send', () => {
    const id = store().newTab();
    store().startSending(id, 'req-1');
    store().startSending(id, 'req-2');
    store().finishSending(id, { requestId: 'req-1', ok: true } as ApiExecutionResult);
    expect(tab(id)?.run.status).toBe('sending');
  });
});
