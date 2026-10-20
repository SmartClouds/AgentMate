import type { SftpWindowState } from '@shared/sftpTypes';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Toaster, toast } from 'sonner';
import { useShallow } from 'zustand/react/shallow';
import { ConfirmDialogHost } from '@/components/ConfirmDialog';
import { FolderTree } from '@/components/icons';
import {
  MacTrafficLightsSpace,
  NativeCaptionButtons,
  type WindowControlsProps,
} from '@/components/layout/TitleBar';
import { HostKeyChangedDialogHost } from '@/components/remote/HostKeyChangedDialog';
import { useIsDarkMode } from '@/lib/chartColors';
import { sftpBridge } from '@/lib/sftp/bridge';
import { isTitleBarBlankDoubleClick } from '@/lib/titleBar';
import { type PaneSide, serverFiles, useSftpStore } from '@/stores/sftpStore';
import { SftpConflictHost } from './SftpConflictHost';
import { SftpViewSwitch } from './SftpViewSwitch';
import { SshFilesView } from './SshFilesView';

/** The same glass toasts as the main window (App's AppToaster). */
function WindowToaster(): React.JSX.Element {
  const isDark = useIsDarkMode();
  return (
    <Toaster
      theme={isDark ? 'dark' : 'light'}
      className="toaster-glass"
      position="bottom-right"
      gap={12}
      closeButton
    />
  );
}

/**
 * Moves a pane, once, to the folder the opener showed (`remote=` or `local=` on the route). It
 * waits for the pane's first listing (home, which connect and initLocal start) so the two do not
 * race, and for the session on the server side. Listing a local folder from this window is also
 * what lets this window write into it. A folder that is gone leaves the pane at home, with a toast.
 */
function useStartFolder(serverId: string, side: PaneSide, path: string | null): void {
  const settled = useSftpStore((state) => {
    const files = serverFiles(state, serverId);
    if (side === 'remote' && (files.status !== 'ready' || !files.session)) return false;
    const pane = files[side];
    return !pane.loading && (pane.path !== null || pane.error !== null);
  });
  const done = useRef(false);

  useEffect(() => {
    if (!path || !settled || done.current) return;
    done.current = true;
    const store = useSftpStore.getState();
    if (serverFiles(store, serverId)[side].path === path) return;
    void store.goTo(serverId, side, path).then((result) => {
      if (result.status === 'failed') toast.error(`Could not open ${path}: ${result.problem}`);
    });
  }, [path, settled, serverId, side]);
}

function SftpWindowTitleBar({ serverId }: { serverId: string }): React.JSX.Element {
  const isMac = window.agentmat.platform === 'darwin';
  const [state, setState] = useState<SftpWindowState>({ isMaximized: false });
  const summary = useSftpStore(
    useShallow((store) => {
      const files = serverFiles(store, serverId);
      const known = files.session ?? files.server;
      return {
        nickname: known?.nickname ?? 'server',
        login: known ? `${known.username}@${known.host}` : null,
        // Once the session is gone the pane's own switch goes with it, so the bar offers it.
        ready: files.status === 'ready',
      };
    }),
  );

  useEffect(() => {
    const bridge = sftpBridge();
    void bridge
      .windowState()
      .then(setState)
      .catch(() => undefined);
    return bridge.onWindowState(setState);
  }, []);

  useEffect(() => {
    document.title = `Files: ${summary.nickname}`;
  }, [summary.nickname]);

  const controls: WindowControlsProps = {
    isMaximized: state.isMaximized,
    onMinimize: () => void sftpBridge().windowControl('minimize'),
    onMaximizeToggle: () => void sftpBridge().windowControl('maximize'),
    onClose: () => void sftpBridge().windowControl('close'),
  };

  return (
    <header
      data-sftp-window-titlebar=""
      className="flex h-11 shrink-0 items-center gap-3 border-b border-border bg-background pl-4 pr-0 [-webkit-app-region:drag]"
      onDoubleClick={(event) => {
        if (isTitleBarBlankDoubleClick(event)) controls.onMaximizeToggle();
      }}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {isMac && <MacTrafficLightsSpace />}
        <FolderTree className="h-4 w-4 shrink-0 text-primary" />
        <h1 className="truncate text-sm font-semibold">Files: {summary.nickname}</h1>
        {summary.login && (
          <span className="truncate text-xs text-muted-foreground">{summary.login}</span>
        )}
      </div>
      {!summary.ready && (
        <div className="flex shrink-0 items-center pr-2 [-webkit-app-region:no-drag]">
          <SftpViewSwitch serverId={serverId} variant="window" />
        </div>
      )}
      {!isMac && <NativeCaptionButtons {...controls} />}
    </header>
  );
}

/**
 * The SSH file manager in a window of its own (`#/sftp-window?server=…&theme=…`, opened by
 * main/sftp/window.ts). Main makes this window another owner of the session before it loads, so
 * connecting here gets the same session back and the queue comes along with it. The theme on
 * the hash is painted before React renders (applyInitialTheme in main.tsx).
 *
 * It renders outside the app shell, so it mounts the hosts the file manager leans on itself: the
 * toasts, the confirm dialog, the host key question and the conflict dialog. The vault unlock
 * dialog comes with the view (RemoteConnectGate).
 */
export default function SftpWindowRoute(): React.JSX.Element {
  const { search } = useLocation();
  const query = new URLSearchParams(search);
  const serverId = query.get('server') ?? '';
  useStartFolder(serverId, 'remote', query.get('remote'));
  useStartFolder(serverId, 'local', query.get('local'));
  const viewActions = useMemo(
    () => <SftpViewSwitch serverId={serverId} variant="window" />,
    [serverId],
  );

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
      <SftpWindowTitleBar serverId={serverId} />
      {serverId ? (
        <SshFilesView
          key={serverId}
          serverId={serverId}
          variant="window"
          viewActions={viewActions}
        />
      ) : (
        <p className="m-auto text-sm text-muted-foreground">No server to show.</p>
      )}
      <WindowToaster />
      <ConfirmDialogHost />
      <HostKeyChangedDialogHost />
      <SftpConflictHost />
    </div>
  );
}
