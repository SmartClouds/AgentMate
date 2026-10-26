import {
  draftSignature,
  draftToRequest,
  emptyDraft,
  type KeyValueRow,
  type PostmanRequest,
  type PostmanRequestItem,
  type RequestDraft,
  replaceQuery,
  requestToDraft,
  syncParamsFromUrl,
  syncPathVariables,
} from '@runova/core';
import type { ApiExecutionResult } from '@shared/apiClientTypes';
import { create } from 'zustand';

/**
 * The request tabs open in the API Client. Each tab edits a draft of one request. A tab that came
 * from a saved request remembers where it lives, so Save writes it back there, and keeps the
 * signature of what was saved so it can tell when there are unsaved changes.
 */

export interface ApiTabSource {
  collectionId: string;
  itemId: string;
}

export type ApiTabRun =
  | { status: 'idle' }
  | { status: 'sending'; requestId: string; startedAt: number }
  | { status: 'done'; result: ApiExecutionResult };

export interface ApiTab {
  id: string;
  name: string;
  source: ApiTabSource | null;
  /** The item the tab was opened from, so fields the editor does not show survive a save. */
  original: PostmanRequestItem | null;
  draft: RequestDraft;
  /** Signature of the draft as last saved (or as opened, for a new tab). */
  savedSignature: string;
  run: ApiTabRun;
}

interface ApiClientTabsState {
  tabs: ApiTab[];
  activeTabId: string | null;
  newTab: () => string;
  openRequest: (collectionId: string, item: PostmanRequestItem) => string;
  closeTab: (id: string) => void;
  setActive: (id: string) => void;
  /** Closes the tabs of a deleted request, or of a whole collection when no item is given. */
  forgetSource: (collectionId: string, itemId?: string) => void;
  updateDraft: (id: string, change: (draft: RequestDraft) => RequestDraft) => void;
  setUrl: (id: string, url: string) => void;
  setParams: (id: string, params: KeyValueRow[]) => void;
  renameTab: (id: string, name: string) => void;
  /** The request to send or save, built from the draft. */
  requestFor: (id: string) => PostmanRequest | null;
  /** The collection item a save would write, without marking anything saved yet. */
  itemFor: (id: string, itemId: string, name: string) => PostmanRequestItem | null;
  /** Records a save and returns the item that was written. */
  markSaved: (id: string, source: ApiTabSource, name: string) => PostmanRequestItem | null;
  startSending: (id: string, requestId: string) => void;
  finishSending: (id: string, result: ApiExecutionResult) => void;
}

function newTabId(): string {
  return crypto.randomUUID();
}

function mapTab(tabs: ApiTab[], id: string, change: (tab: ApiTab) => ApiTab): ApiTab[] {
  return tabs.map((tab) => (tab.id === id ? change(tab) : tab));
}

export function isTabDirty(tab: ApiTab): boolean {
  if (tab.original && tab.name !== tab.original.name) return true;
  return draftSignature(tab.draft) !== tab.savedSignature;
}

export const useApiClientTabsStore = create<ApiClientTabsState>((set, get) => ({
  tabs: [],
  activeTabId: null,

  newTab: () => {
    const draft = emptyDraft();
    const tab: ApiTab = {
      id: newTabId(),
      name: 'Untitled Request',
      source: null,
      original: null,
      draft,
      savedSignature: draftSignature(draft),
      run: { status: 'idle' },
    };
    set((state) => ({ tabs: [...state.tabs, tab], activeTabId: tab.id }));
    return tab.id;
  },

  openRequest: (collectionId, item) => {
    const existing = get().tabs.find(
      (tab) => tab.source?.collectionId === collectionId && tab.source.itemId === item.id,
    );
    if (existing) {
      set({ activeTabId: existing.id });
      return existing.id;
    }
    const draft = requestToDraft(item.request, item.event ?? []);
    const tab: ApiTab = {
      id: newTabId(),
      name: item.name,
      source: { collectionId, itemId: item.id },
      original: item,
      draft,
      savedSignature: draftSignature(draft),
      run: { status: 'idle' },
    };
    set((state) => ({ tabs: [...state.tabs, tab], activeTabId: tab.id }));
    return tab.id;
  },

  closeTab: (id) => {
    set((state) => {
      const index = state.tabs.findIndex((tab) => tab.id === id);
      if (index < 0) return state;
      const tabs = state.tabs.filter((tab) => tab.id !== id);
      let activeTabId = state.activeTabId;
      if (activeTabId === id) {
        activeTabId = (tabs[index] ?? tabs[index - 1] ?? null)?.id ?? null;
      }
      return { tabs, activeTabId };
    });
  },

  setActive: (id) => set({ activeTabId: id }),

  forgetSource: (collectionId, itemId) => {
    const doomed = get()
      .tabs.filter(
        (tab) =>
          tab.source?.collectionId === collectionId &&
          (itemId === undefined || tab.source.itemId === itemId),
      )
      .map((tab) => tab.id);
    for (const id of doomed) get().closeTab(id);
  },

  updateDraft: (id, change) => {
    set((state) => ({
      tabs: mapTab(state.tabs, id, (tab) => ({ ...tab, draft: change(tab.draft) })),
    }));
  },

  setUrl: (id, url) => {
    get().updateDraft(id, (draft) => ({
      ...draft,
      url,
      params: syncParamsFromUrl(url, draft.params),
      pathVariables: syncPathVariables(url, draft.pathVariables),
    }));
  },

  setParams: (id, params) => {
    get().updateDraft(id, (draft) => ({ ...draft, params, url: replaceQuery(draft.url, params) }));
  },

  renameTab: (id, name) => {
    set((state) => ({ tabs: mapTab(state.tabs, id, (tab) => ({ ...tab, name })) }));
  },

  requestFor: (id) => {
    const tab = get().tabs.find((t) => t.id === id);
    if (!tab) return null;
    return draftToRequest(tab.draft, tab.original?.request);
  },

  itemFor: (id, itemId, name) => {
    const tab = get().tabs.find((t) => t.id === id);
    if (!tab) return null;
    const item: PostmanRequestItem = {
      ...(tab.original ?? {}),
      id: itemId,
      name,
      request: draftToRequest(tab.draft, tab.original?.request),
    };
    if (tab.draft.events.length > 0) item.event = tab.draft.events;
    else delete item.event;
    return item;
  },

  markSaved: (id, source, name) => {
    const item = get().itemFor(id, source.itemId, name);
    if (!item) return null;
    set((state) => ({
      tabs: mapTab(state.tabs, id, (current) => ({
        ...current,
        name,
        source,
        original: item,
        savedSignature: draftSignature(current.draft),
      })),
    }));
    return item;
  },

  startSending: (id, requestId) => {
    set((state) => ({
      tabs: mapTab(state.tabs, id, (tab) => ({
        ...tab,
        run: { status: 'sending', requestId, startedAt: Date.now() },
      })),
    }));
  },

  finishSending: (id, result) => {
    set((state) => ({
      tabs: mapTab(state.tabs, id, (tab) =>
        tab.run.status === 'sending' && tab.run.requestId !== result.requestId
          ? tab
          : { ...tab, run: { status: 'done', result } },
      ),
    }));
  },
}));
