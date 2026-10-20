import { lazy, Suspense, useEffect, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useShallow } from 'zustand/react/shallow';
import { Link, Power, Server } from '@/components/icons';
import { EmptyState } from '@/components/pageKit';
import { ConflictDialog } from '@/components/sftp/ConflictDialog';
import { FilePane } from '@/components/sftp/FilePane';
import { PropertiesDialog } from '@/components/sftp/PropertiesDialog';
import { RemoteConnectGate } from '@/components/sftp/RemoteConnectGate';
import { TransferQueue } from '@/components/sftp/TransferQueue';
import { Button } from '@/components/ui/button';
import { ResizeHandle } from '@/components/ui/ResizeHandle';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { confirmDialog } from '@/stores/confirmStore';
import { usePageHeader } from '@/stores/pageHeaderStore';
import { PANEL_WIDTHS, usePanelWidth } from '@/stores/panelWidthStore';
import { hasRunningTransfers, serverFiles, useSftpStore } from '@/stores/sftpStore';

/** Monaco is heavy and most visits never edit a file, so the editor loads on first use. */
const RemoteEditorDialog = lazy(() => import('@/components/sftp/RemoteEditorDialog'));

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

/** The Transfers card and the conflict question: the only parts that follow every snapshot. */
function QueueArea({ serverId }: { serverId: string }): React.JSX.Element {
  const queue = useSftpStore((state) => serverFiles(state, serverId).queue);
  const store = useSftpStore.getState;
  return (
    <>
      {queue && queue.batches.length > 0 ? (
        <TransferQueue
          snapshot={queue}
          onCancel={(target) => store().cancel(serverId, target)}
          onRetry={(target) => store().retry(serverId, target)}
          onClearFinished={() => store().clearFinished(serverId)}
          className="max-h-[35%] shrink-0"
        />
      ) : null}
      {/* The store rejects these with main's error, so the dialog tells it and unlocks. */}
      <ConflictDialog
        conflict={queue?.conflict ?? null}
        onResolve={async (decision) => {
          const conflict = serverFiles(store(), serverId).queue?.conflict;
          if (conflict) await store().resolveConflict(serverId, conflict.conflictId, decision);
        }}
        onCancelBatch={(batchId) => store().cancel(serverId, { batchId })}
      />
    </>
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

function SshFilesView({ serverId }: { serverId: string }): React.JSX.Element {
  // Only what the header needs; the queue, dialogs and panes each read their own slice.
  const summary = useSftpStore(
    useShallow((state) => {
      const files = serverFiles(state, serverId);
      const known = files.session ?? files.server;
      return known
        ? {
            nickname: known.nickname,
            username: known.username,
            host: known.host,
            port: known.port,
          }
        : null;
    }),
  );
  const [localWidth, setLocalWidth] = usePanelWidth('sftpLocalPane');
  const localStyle = useMemo(
    () => ({ width: localWidth, maxWidth: LOCAL_PANE_MAX_SHARE }),
    [localWidth],
  );
  const disconnect = useMemo(() => <DisconnectButton serverId={serverId} />, [serverId]);

  usePageHeader(
    `Files: ${summary?.nickname ?? 'server'}`,
    summary ? `${summary.username}@${summary.host}:${summary.port}` : undefined,
  );

  useEffect(() => {
    const state = useSftpStore.getState();
    state.setPageVisible(serverId, true);
    void state.initLocal(serverId);
    // A server already open (a page visit before, D3) keeps its session; a new one connects.
    if (serverFiles(state, serverId).status === 'idle') void state.connect(serverId);
    return () => useSftpStore.getState().setPageVisible(serverId, false);
  }, [serverId]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden p-2">
      <div className="flex min-h-0 flex-1">
        <FilePane serverId={serverId} side="local" style={localStyle} className="shrink-0" />
        <ResizeHandle
          orientation="vertical"
          label="Resize the panes"
          size={localWidth}
          min={PANEL_WIDTHS.sftpLocalPane.min}
          max={PANEL_WIDTHS.sftpLocalPane.max}
          defaultSize={PANEL_WIDTHS.sftpLocalPane.default}
          onSizeChange={setLocalWidth}
          quiet
          className="w-2"
        />
        <RemoteConnectGate serverId={serverId} className="min-w-0 flex-1">
          <FilePane
            serverId={serverId}
            side="remote"
            actions={disconnect}
            className="min-w-0 flex-1"
          />
        </RemoteConnectGate>
      </div>
      <QueueArea serverId={serverId} />
      <PropertiesArea serverId={serverId} />
      <EditorArea serverId={serverId} />
    </div>
  );
}

/** `/ssh-files/:serverId`: a saved SSH server as a two-pane SFTP file manager (E25). */
export default function SshFilesPage(): React.JSX.Element {
  const { serverId } = useParams<{ serverId: string }>();
  const navigate = useNavigate();

  if (!serverId) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <EmptyState
          card
          icon={Server}
          title="No server picked"
          description="Open a saved server's files from Remote, under SSH."
          action={
            <Button onClick={() => navigate('/remote')}>
              <Link /> Open Remote
            </Button>
          }
        />
      </div>
    );
  }
  return <SshFilesView key={serverId} serverId={serverId} />;
}
