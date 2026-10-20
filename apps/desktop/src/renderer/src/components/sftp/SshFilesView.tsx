import { lazy, Suspense, useEffect, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Power } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { ResizeHandle } from '@/components/ui/ResizeHandle';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { confirmDialog } from '@/stores/confirmStore';
import { PANEL_WIDTHS, usePanelWidth } from '@/stores/panelWidthStore';
import { hasRunningTransfers, serverFiles, useSftpStore } from '@/stores/sftpStore';
import { FilePane } from './FilePane';
import { PropertiesDialog } from './PropertiesDialog';
import { RemoteConnectGate } from './RemoteConnectGate';
import { TransferQueue } from './TransferQueue';

/** Monaco is heavy and most visits never edit a file, so the editor loads on first use. */
const RemoteEditorDialog = lazy(() => import('./RemoteEditorDialog'));

/**
 * The local pane may take at most 70% of the row, and never so much that the server pane drops
 * under 320 px, where its names and toolbar no longer fit.
 */
const LOCAL_PANE_MAX_SHARE = 'min(70%, calc(100% - 320px))';

function DisconnectButton({ serverId }: { serverId: string }): React.JSX.Element {
  const nickname = useSftpStore((state) => {
    const files = serverFiles(state, serverId);
    return files.session?.nickname ?? files.server?.nickname ?? 'the server';
  });

  async function run(): Promise<void> {
    // Read at click time, so this button does not redraw on every queue snapshot.
    const state = useSftpStore.getState();
    if (hasRunningTransfers(serverFiles(state, serverId).queue)) {
      const confirmed = await confirmDialog({
        title: `Disconnect from ${nickname}?`,
        description:
          'Transfers still running are cancelled, and files part way through are not kept.',
        confirmLabel: 'Disconnect',
        variant: 'destructive',
      });
      if (!confirmed) return;
    }
    // The page stays, with a Connect button in the server's pane.
    await useSftpStore.getState().disconnect(serverId);
  }

  return (
    <SimpleTooltip label={`Disconnect from ${nickname}`}>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Disconnect"
        onClick={() => void run()}
        className="shrink-0 hover:bg-destructive/10 hover:text-destructive"
      >
        <Power />
      </Button>
    </SimpleTooltip>
  );
}

/**
 * The Transfers card: the only part that follows every snapshot. The conflict question is not
 * here but in the window's SftpConflictHost, so two views of one server never ask it twice.
 */
function QueueArea({
  serverId,
  compact,
  shown,
}: {
  serverId: string;
  compact: boolean;
  /** Off for a hidden dock tab, which then follows none of the 10-a-second snapshots. */
  shown: boolean;
}): React.JSX.Element | null {
  const queue = useSftpStore((state) => (shown ? serverFiles(state, serverId).queue : null));
  const store = useSftpStore.getState;
  if (!queue || queue.batches.length === 0) return null;
  return (
    <TransferQueue
      snapshot={queue}
      onCancel={(target) => store().cancel(serverId, target)}
      onRetry={(target) => store().retry(serverId, target)}
      onClearFinished={() => store().clearFinished(serverId)}
      // The drawer is short, so there the card starts as its one-line summary.
      defaultOpen={!compact}
      className={cn(compact ? 'max-h-[50%]' : 'max-h-[35%]', 'shrink-0')}
    />
  );
}

function PropertiesArea({ serverId }: { serverId: string }): React.JSX.Element {
  const paths = useSftpStore((state) => serverFiles(state, serverId).propertiesPaths);
  const listed = useSftpStore((state) => serverFiles(state, serverId).remote.entries);
  const store = useSftpStore.getState;
  const entries = useMemo(() => {
    const wanted = new Set(paths ?? []);
    return listed.filter((entry) => wanted.has(entry.path));
  }, [paths, listed]);
  return (
    <PropertiesDialog
      open={paths !== null && entries.length > 0}
      entries={entries}
      onOpenChange={(open) => {
        if (!open) store().closeProperties(serverId);
      }}
      onApply={(input) => store().chmod(serverId, input)}
    />
  );
}

function EditorArea({ serverId }: { serverId: string }): React.JSX.Element | null {
  const { sessionId, path, file } = useSftpStore(
    useShallow((state) => {
      const files = serverFiles(state, serverId);
      return {
        sessionId: files.session?.sessionId ?? null,
        path: files.editingPath,
        file: files.editingFile,
      };
    }),
  );
  const store = useSftpStore.getState;
  if (!sessionId || path === null) return null;
  return (
    <Suspense fallback={null}>
      <RemoteEditorDialog
        open
        sessionId={sessionId}
        serverId={serverId}
        path={path}
        initialFile={file ?? undefined}
        onOpenChange={(open) => {
          if (!open) store().closeEditor(serverId);
        }}
        onSaved={() => void store().refresh(serverId, 'remote')}
      />
    </Suspense>
  );
}

/**
 * Where the file manager is drawn: the `/ssh-files/:serverId` page, a tab of the terminal drawer,
 * or the pop-out window.
 */
export type SshFilesVariant = 'page' | 'dock' | 'window';

export interface SshFilesViewProps {
  serverId: string;
  /** The dock is drawn compact: fewer columns, tighter rows, the queue folded to one line. */
  variant: SshFilesVariant;
  /** Controls drawn in the server pane's title row before Disconnect (the view switch). */
  viewActions?: React.ReactNode;
  /**
   * Whether the view counts as on screen, so a transfer finishing meanwhile gets no toast.
   * While false it also draws no Properties or editor dialog. Defaults to true. The dock stays mounted in a closed drawer or behind another tab, so it
   * passes whether it is really shown.
   */
  trackVisibility?: boolean;
}

/**
 * The SSH file manager for one saved server (E25): this computer and the server side by side,
 * the Transfers card under them, and the properties and editor dialogs. The page, the docked
 * panel and the pop-out window are each a view of the same store entry and the same session in
 * main. The page header and the conflict question belong to whatever hosts the view.
 *
 * Mounting it connects a server that has no session yet; leaving keeps the session (D3).
 */
export function SshFilesView({
  serverId,
  variant,
  viewActions,
  trackVisibility = true,
}: SshFilesViewProps): React.JSX.Element {
  const compact = variant === 'dock';
  const [localWidth, setLocalWidth] = usePanelWidth('sftpLocalPane');
  const localStyle = useMemo(
    () => ({ width: localWidth, maxWidth: LOCAL_PANE_MAX_SHARE }),
    [localWidth],
  );
  const actions = useMemo(
    () => (
      <>
        {viewActions}
        <DisconnectButton serverId={serverId} />
      </>
    ),
    [serverId, viewActions],
  );

  useEffect(() => {
    void useSftpStore.getState().initLocal(serverId);
  }, [serverId]);

  // A server already open (a page visit before, D3) keeps its session; a new one connects once
  // the view is on screen. A hidden dock tab never logs in on its own, so a disconnect made on
  // the page holds until the user looks at the files again.
  useEffect(() => {
    if (!trackVisibility) return;
    const state = useSftpStore.getState();
    if (serverFiles(state, serverId).status === 'idle') void state.connect(serverId);
  }, [serverId, trackVisibility]);

  // Apart from the connect above, so a dock tab shown and hidden again never reconnects.
  useEffect(() => {
    if (!trackVisibility) return undefined;
    useSftpStore.getState().setPageVisible(serverId, true);
    return () => useSftpStore.getState().setPageVisible(serverId, false);
  }, [serverId, trackVisibility]);

  return (
    <div
      data-sftp-view={variant}
      className={cn(
        'flex min-h-0 flex-1 flex-col overflow-hidden',
        compact ? 'gap-1.5 p-1.5' : 'gap-2 p-2',
      )}
    >
      <div className="flex min-h-0 flex-1">
        <FilePane
          serverId={serverId}
          side="local"
          compact={compact}
          style={localStyle}
          className="shrink-0"
        />
        <ResizeHandle
          orientation="vertical"
          label="Resize the panes"
          size={localWidth}
          min={PANEL_WIDTHS.sftpLocalPane.min}
          max={PANEL_WIDTHS.sftpLocalPane.max}
          defaultSize={PANEL_WIDTHS.sftpLocalPane.default}
          onSizeChange={setLocalWidth}
          quiet
          className={compact ? 'w-1.5' : 'w-2'}
        />
        <RemoteConnectGate serverId={serverId} className="min-w-0 flex-1">
          <FilePane
            serverId={serverId}
            side="remote"
            compact={compact}
            actions={actions}
            className="min-w-0 flex-1"
          />
        </RemoteConnectGate>
      </div>
      <QueueArea serverId={serverId} compact={compact} shown={trackVisibility} />
      {/* The dialogs are portals, so a hidden dock tab would leave them up over the rest of the
          app. They come back when the tab does: what they show is kept in the store. */}
      {trackVisibility ? (
        <>
          <PropertiesArea serverId={serverId} />
          <EditorArea serverId={serverId} />
        </>
      ) : null}
    </div>
  );
}
