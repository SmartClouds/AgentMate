import { type ApiTreeNode, findItem, isRequestItem, type PostmanRequestItem } from '@runova/core';
import type { ApiCollectionSummary } from '@shared/apiClientTypes';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { CollectionsSidebar } from '@/components/apiClient/CollectionsSidebar';
import { NameDialog } from '@/components/apiClient/NameDialog';
import { RequestEditor } from '@/components/apiClient/RequestEditor';
import { RequestTabStrip } from '@/components/apiClient/RequestTabStrip';
import { ResponsePane } from '@/components/apiClient/ResponsePane';
import { type SaveDestination, SaveRequestDialog } from '@/components/apiClient/SaveRequestDialog';
import { UrlBar } from '@/components/apiClient/UrlBar';
import { ChevronRight, FilePlus, FolderPlus, FolderTree, Pencil, Send } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { ResizeHandle } from '@/components/ui/ResizeHandle';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import {
  API_REQUEST_HEIGHT,
  API_SIDEBAR_WIDTH,
  useApiClientLayoutStore,
} from '@/stores/apiClientLayoutStore';
import { type ApiTab, isTabDirty, useApiClientTabsStore } from '@/stores/apiClientTabsStore';
import { confirmDialog } from '@/stores/confirmStore';
import { usePageHeader } from '@/stores/pageHeaderStore';

type NameDialogState =
  | { kind: 'newCollection' }
  | { kind: 'rename'; collection: ApiCollectionSummary }
  | { kind: 'newFolder'; collectionId: string; parentId: string | null };

const UNTITLED = 'Untitled Request';

/** The page's two cards: the app's glass card, rounded like the Settings cards. */
const PANEL = 'glass flex flex-col overflow-hidden rounded-[calc(var(--radius)+2px)]';

/** What the name dialog says for each thing it can name. */
function nameDialogCopy(state: NameDialogState | null) {
  switch (state?.kind) {
    case 'rename':
      return {
        title: 'Rename collection',
        description: 'The new name shows in the sidebar and in exported files.',
        icon: <Pencil />,
        label: 'Collection name',
        initialValue: state.collection.name,
        placeholder: 'Collection name',
        confirmLabel: 'Rename',
      };
    case 'newFolder':
      return {
        title: 'New folder',
        description: 'Folders group related requests inside a collection.',
        icon: <FolderPlus />,
        label: 'Folder name',
        initialValue: '',
        placeholder: 'e.g. Users, Orders, Auth',
        confirmLabel: 'Create',
      };
    default:
      return {
        title: 'New collection',
        description:
          'A collection keeps related requests together. It is saved in the Postman format, so you can export it any time.',
        icon: <FolderTree />,
        label: 'Collection name',
        initialValue: '',
        placeholder: 'e.g. Payments API',
        confirmLabel: 'Create',
      };
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requestIdsUnder(node: ApiTreeNode): string[] {
  if (node.kind === 'request') return [node.id];
  return (node.children ?? []).flatMap(requestIdsUnder);
}

export default function ApiClientPage(): React.JSX.Element {
  usePageHeader(
    'API Client',
    'Build, send and save HTTP requests. Collections use the Postman format.',
  );

  const queryClient = useQueryClient();
  const collectionsQuery = useQuery({
    queryKey: queryKeys.apiCollections,
    queryFn: () => window.runova.apiClient.listCollections(),
  });
  const collections = collectionsQuery.data ?? [];

  const tabs = useApiClientTabsStore((s) => s.tabs);
  const activeTabId = useApiClientTabsStore((s) => s.activeTabId);
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;

  const sidebarWidth = useApiClientLayoutStore((s) => s.sidebarWidth);
  const setSidebarWidth = useApiClientLayoutStore((s) => s.setSidebarWidth);

  const [nameDialog, setNameDialog] = useState<NameDialogState | null>(null);
  const [savingTabId, setSavingTabId] = useState<string | null>(null);

  const refresh = useCallback(
    () => queryClient.invalidateQueries({ queryKey: queryKeys.apiCollections }),
    [queryClient],
  );

  const send = useCallback(async (tabId: string) => {
    const store = useApiClientTabsStore.getState();
    const tab = store.tabs.find((t) => t.id === tabId);
    const request = store.requestFor(tabId);
    if (!tab || !request || !tab.draft.url.trim() || tab.run.status === 'sending') return;

    const requestId = crypto.randomUUID();
    store.startSending(tabId, requestId);
    try {
      const result = await window.runova.apiClient.execute({
        requestId,
        request,
        events: tab.draft.events,
        name: tab.name,
        collectionId: tab.source?.collectionId ?? null,
        itemId: tab.source?.itemId ?? null,
      });
      useApiClientTabsStore.getState().finishSending(tabId, result);
    } catch (error) {
      useApiClientTabsStore.getState().finishSending(tabId, {
        requestId,
        ok: false,
        cancelled: false,
        error: message(error),
        response: null,
        sent: null,
        tests: [],
        console: [],
        scriptErrors: [],
        startedAt: Date.now(),
      });
    }
  }, []);

  const cancel = useCallback((tab: ApiTab) => {
    if (tab.run.status === 'sending') void window.runova.apiClient.cancel(tab.run.requestId);
  }, []);

  /** Writes a tab back to where it came from, or asks where a new one should go. */
  const save = useCallback(
    async (tabId: string) => {
      const store = useApiClientTabsStore.getState();
      const tab = store.tabs.find((t) => t.id === tabId);
      if (!tab) return;
      if (!tab.source) {
        setSavingTabId(tabId);
        return;
      }
      const item = store.itemFor(tabId, tab.source.itemId, tab.name);
      if (!item) return;
      try {
        await window.runova.apiClient.saveRequest({
          collectionId: tab.source.collectionId,
          parentId: null,
          item,
        });
        useApiClientTabsStore.getState().markSaved(tabId, tab.source, tab.name);
        await refresh();
      } catch (error) {
        toast.error('Could not save the request', { description: message(error) });
      }
    },
    [refresh],
  );

  const saveNew = useCallback(
    async (tabId: string, destination: SaveDestination, name: string) => {
      let collectionId: string;
      if ('newCollectionName' in destination) {
        collectionId = (
          await window.runova.apiClient.createCollection(destination.newCollectionName)
        ).id;
      } else {
        collectionId = destination.collectionId;
      }
      const itemId = crypto.randomUUID();
      const item = useApiClientTabsStore.getState().itemFor(tabId, itemId, name);
      if (!item) return;
      await window.runova.apiClient.saveRequest({
        collectionId,
        parentId: destination.parentId,
        item,
      });
      useApiClientTabsStore.getState().markSaved(tabId, { collectionId, itemId }, name);
      await refresh();
      toast.success(`Saved “${name}”`);
    },
    [refresh],
  );

  const closeTab = useCallback(async (tabId: string) => {
    const tab = useApiClientTabsStore.getState().tabs.find((t) => t.id === tabId);
    if (!tab) return;
    if (isTabDirty(tab)) {
      const discard = await confirmDialog({
        title: 'Discard unsaved changes?',
        description: `“${tab.name}” has changes that were not saved.`,
        confirmLabel: 'Discard',
        variant: 'destructive',
      });
      if (!discard) return;
    }
    if (tab.run.status === 'sending') void window.runova.apiClient.cancel(tab.run.requestId);
    useApiClientTabsStore.getState().closeTab(tabId);
  }, []);

  const openRequest = useCallback(
    async (collectionId: string, itemId: string) => {
      try {
        const collection = await queryClient.fetchQuery({
          queryKey: queryKeys.apiCollection(collectionId),
          queryFn: () => window.runova.apiClient.getCollection(collectionId),
          staleTime: 0,
        });
        const item = findItem(collection, itemId);
        if (!item || !isRequestItem(item)) throw new Error('That request no longer exists.');
        useApiClientTabsStore.getState().openRequest(collectionId, item);
      } catch (error) {
        toast.error('Could not open the request', { description: message(error) });
        void refresh();
      }
    },
    [queryClient, refresh],
  );

  const addRequest = useCallback(
    async (collectionId: string, parentId: string | null) => {
      const item: PostmanRequestItem = {
        id: crypto.randomUUID(),
        name: 'New Request',
        request: { method: 'GET', url: '' },
      };
      try {
        await window.runova.apiClient.saveRequest({ collectionId, parentId, item });
        useApiClientTabsStore.getState().openRequest(collectionId, item);
        await refresh();
      } catch (error) {
        toast.error('Could not add the request', { description: message(error) });
      }
    },
    [refresh],
  );

  const deleteCollection = useCallback(
    async (collection: ApiCollectionSummary) => {
      const confirmed = await confirmDialog({
        title: `Delete “${collection.name}”?`,
        description: `Its ${collection.requestCount} saved request${collection.requestCount === 1 ? '' : 's'} will be deleted too. This cannot be undone.`,
        confirmLabel: 'Delete',
        variant: 'destructive',
      });
      if (!confirmed) return;
      try {
        await window.runova.apiClient.removeCollection(collection.id);
        useApiClientTabsStore.getState().forgetSource(collection.id);
        await refresh();
      } catch (error) {
        toast.error('Could not delete the collection', { description: message(error) });
      }
    },
    [refresh],
  );

  const deleteItem = useCallback(
    async (collectionId: string, node: ApiTreeNode) => {
      const confirmed = await confirmDialog({
        title: `Delete “${node.name}”?`,
        description:
          node.kind === 'folder'
            ? 'Everything in this folder will be deleted too. This cannot be undone.'
            : 'This cannot be undone.',
        confirmLabel: 'Delete',
        variant: 'destructive',
      });
      if (!confirmed) return;
      try {
        await window.runova.apiClient.removeItem(collectionId, node.id);
        for (const id of requestIdsUnder(node)) {
          useApiClientTabsStore.getState().forgetSource(collectionId, id);
        }
        await refresh();
      } catch (error) {
        toast.error('Could not delete it', { description: message(error) });
      }
    },
    [refresh],
  );

  // Captured before the editors see them: Monaco has its own meaning for Ctrl+Enter.
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      if (!rootRef.current?.contains(event.target as Node)) return;
      const tabId = useApiClientTabsStore.getState().activeTabId;
      if (event.key === 'Enter' && tabId) {
        event.preventDefault();
        event.stopPropagation();
        void send(tabId);
      } else if (event.key.toLowerCase() === 's' && !event.shiftKey && tabId) {
        event.preventDefault();
        event.stopPropagation();
        void save(tabId);
      } else if (event.key.toLowerCase() === 'n' && !event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        useApiClientTabsStore.getState().newTab();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [send, save]);

  const savingTab = tabs.find((t) => t.id === savingTabId) ?? null;

  return (
    // The page already sits in the content island, so the sidebar and the request area are glass
    // cards on it with a small gap between them, the way cards sit on every other page. The
    // gap is the resize handle itself, whose line only shows while it is in use.
    <div ref={rootRef} className="flex min-h-0 flex-1 overflow-hidden p-2">
      <aside
        aria-label="API collections"
        // The cap keeps a wide saved width from squeezing the request area on a narrow window.
        style={{ width: sidebarWidth, maxWidth: '42%' }}
        className={cn(PANEL, 'shrink-0')}
      >
        <CollectionsSidebar
          collections={collections}
          loading={collectionsQuery.isPending}
          activeItem={activeTab?.source ?? null}
          onOpenRequest={(collectionId, itemId) => void openRequest(collectionId, itemId)}
          onNewCollection={() => setNameDialog({ kind: 'newCollection' })}
          onNewRequest={(collectionId, parentId) => void addRequest(collectionId, parentId)}
          onNewFolder={(collectionId, parentId) =>
            setNameDialog({ kind: 'newFolder', collectionId, parentId })
          }
          onRenameCollection={(collection) => setNameDialog({ kind: 'rename', collection })}
          onDeleteCollection={(collection) => void deleteCollection(collection)}
          onDeleteItem={(collectionId, node) => void deleteItem(collectionId, node)}
        />
      </aside>
      <ResizeHandle
        orientation="vertical"
        label="Resize collections"
        size={sidebarWidth}
        min={API_SIDEBAR_WIDTH.min}
        max={API_SIDEBAR_WIDTH.max}
        defaultSize={API_SIDEBAR_WIDTH.default}
        onSizeChange={setSidebarWidth}
        quiet
        className="w-2"
      />

      {/* A container, so the URL bar can tighten up when this card is narrow. */}
      <div className={cn(PANEL, '@container/request min-w-0 flex-1')}>
        <RequestTabStrip
          tabs={tabs}
          activeTabId={activeTabId}
          isDirty={isTabDirty}
          onSelect={(id) => useApiClientTabsStore.getState().setActive(id)}
          onClose={(id) => void closeTab(id)}
          onNew={() => useApiClientTabsStore.getState().newTab()}
        />
        {activeTab ? (
          <RequestWorkspace
            key={activeTab.id}
            tab={activeTab}
            collectionName={collections.find((c) => c.id === activeTab.source?.collectionId)?.name}
            onSend={() => void send(activeTab.id)}
            onCancel={() => cancel(activeTab)}
            onSave={() => void save(activeTab.id)}
          />
        ) : (
          <EmptyWorkspace onNew={() => useApiClientTabsStore.getState().newTab()} />
        )}
      </div>

      <SaveRequestDialog
        open={savingTab !== null}
        onOpenChange={(open) => !open && setSavingTabId(null)}
        initialName={
          savingTab
            ? savingTab.name === UNTITLED
              ? savingTab.draft.url.trim() || 'New Request'
              : savingTab.name
            : ''
        }
        collections={collections}
        onSave={(destination, name) =>
          savingTab ? saveNew(savingTab.id, destination, name) : Promise.resolve()
        }
      />

      <NameDialog
        open={nameDialog !== null}
        onOpenChange={(open) => !open && setNameDialog(null)}
        {...nameDialogCopy(nameDialog)}
        onSubmit={async (name) => {
          if (!nameDialog) return;
          if (nameDialog.kind === 'newCollection') {
            await window.runova.apiClient.createCollection(name);
          } else if (nameDialog.kind === 'rename') {
            await window.runova.apiClient.renameCollection(nameDialog.collection.id, name);
          } else {
            await window.runova.apiClient.createFolder(
              nameDialog.collectionId,
              nameDialog.parentId,
              name,
            );
          }
          await refresh();
        }}
      />
    </div>
  );
}

function EmptyWorkspace({ onNew }: { onNew: () => void }): React.JSX.Element {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/12 text-primary shadow-[0_0_40px_-12px_hsl(var(--primary)/0.7)]">
        <Send className="h-6 w-6" />
      </div>
      <div className="max-w-sm space-y-1.5">
        <h2 className="text-base font-semibold tracking-tight">Send your first request</h2>
        <p className="text-sm text-muted-foreground">
          Start a new request, or open one from a collection on the left.
        </p>
      </div>
      <Button onClick={onNew}>
        <FilePlus /> New request
      </Button>
      <p className="text-xs text-muted-foreground">
        Shortcut:{' '}
        <kbd className="rounded-md border border-border bg-foreground/[0.05] px-1.5 py-0.5 font-mono text-[10px]">
          Ctrl
        </kbd>{' '}
        +{' '}
        <kbd className="rounded-md border border-border bg-foreground/[0.05] px-1.5 py-0.5 font-mono text-[10px]">
          N
        </kbd>
      </p>
    </div>
  );
}

interface RequestWorkspaceProps {
  tab: ApiTab;
  collectionName: string | undefined;
  onSend: () => void;
  onCancel: () => void;
  onSave: () => void;
}

function RequestWorkspace({
  tab,
  collectionName,
  onSend,
  onCancel,
  onSave,
}: RequestWorkspaceProps): React.JSX.Element {
  const updateDraft = useApiClientTabsStore((s) => s.updateDraft);
  const setUrl = useApiClientTabsStore((s) => s.setUrl);
  const renameTab = useApiClientTabsStore((s) => s.renameTab);
  const requestHeight = useApiClientLayoutStore((s) => s.requestHeight);
  const setRequestHeight = useApiClientLayoutStore((s) => s.setRequestHeight);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="space-y-2 px-3 pb-3 pt-2.5">
        <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          {collectionName && (
            <>
              <span className="flex min-w-0 max-w-[45%] shrink-0 items-center gap-1.5 pl-1">
                <FolderTree className="h-3 w-3 shrink-0 text-primary" />
                <span className="truncate">{collectionName}</span>
              </span>
              <ChevronRight className="h-2.5 w-2.5 shrink-0 opacity-60" />
            </>
          )}
          <input
            aria-label="Request name"
            value={tab.name}
            onChange={(event) => renameTab(tab.id, event.target.value)}
            onBlur={(event) => {
              if (!event.target.value.trim()) renameTab(tab.id, UNTITLED);
            }}
            className="min-w-0 flex-1 rounded-md bg-transparent px-1.5 py-0.5 text-sm font-medium text-foreground outline-none transition-colors hover:bg-foreground/[0.06] focus-visible:bg-foreground/[0.06] focus-visible:ring-2 focus-visible:ring-ring/40"
          />
        </div>
        <UrlBar
          method={tab.draft.method}
          url={tab.draft.url}
          sending={tab.run.status === 'sending'}
          onMethodChange={(method) => updateDraft(tab.id, (d) => ({ ...d, method }))}
          onUrlChange={(url) => setUrl(tab.id, url)}
          onSend={onSend}
          onCancel={onCancel}
          onSave={onSave}
        />
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        <div style={{ height: requestHeight }} className="min-h-0 shrink-0">
          <RequestEditor tab={tab} />
        </div>
        <ResizeHandle
          orientation="horizontal"
          label="Resize request and response"
          size={requestHeight}
          min={API_REQUEST_HEIGHT.min}
          max={API_REQUEST_HEIGHT.max}
          defaultSize={API_REQUEST_HEIGHT.default}
          onSizeChange={setRequestHeight}
        />
        <div className="min-h-0 flex-1">
          <ResponsePane run={tab.run} onCancel={onCancel} />
        </div>
      </div>
    </div>
  );
}
