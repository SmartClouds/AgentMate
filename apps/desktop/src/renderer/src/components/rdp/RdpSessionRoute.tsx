import type { RdpWindowState } from '@shared/apiTypes';
import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import {
  Compress,
  Download,
  Expand,
  History,
  Keyboard,
  Monitor,
  RefreshCw,
  Sparkles,
  TriangleAlert,
  Upload,
  WindowMinimize,
  X,
} from '@/components/icons';
import {
  MacTrafficLightsSpace,
  NativeCaptionButtons,
  type WindowControlsProps,
} from '@/components/layout/TitleBar';
import { SshAgentHistoryDialog } from '@/components/terminal/SshAgentHistoryDialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { formatBytes } from '@/lib/format';
import { queryKeys } from '@/lib/queryKeys';
import { isTitleBarBlankDoubleClick } from '@/lib/titleBar';
import { cn } from '@/lib/utils';
import { initRdpAgentStatus, isRdpAgentActive, useRdpAgentSession } from '@/stores/rdpAgentStore';
import { RdpAgentOverlay } from './RdpAgentOverlay';
import { RdpAgentStatusBar } from './RdpAgentStatusBar';
import { RdpAskAiDialog } from './RdpAskAiDialog';
import { RdpFailureCard } from './RdpFailureCard';
import { useRdpAgentBridge } from './useRdpAgentBridge';
import { useRdpKeyboardLock } from './useRdpKeyboardLock';
import { type RdpPhase, type RdpTransfer, useRdpSession } from './useRdpSession';

const HIDE_BAR_DELAY_MS = 1200;

function phaseBadge(phase: RdpPhase): {
  label: string;
  variant: 'success' | 'warning' | 'destructive' | 'secondary';
} {
  switch (phase.kind) {
    case 'connected':
      return { label: 'Connected', variant: 'success' };
    case 'connecting':
      return { label: 'Connecting…', variant: 'warning' };
    case 'failed':
      return { label: 'Failed', variant: 'destructive' };
    default:
      return { label: 'Disconnected', variant: 'secondary' };
  }
}

function ToolbarButton({
  label,
  onClick,
  disabled,
  active,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <SimpleTooltip label={label} side="bottom" wrapTrigger={disabled}>
      <Button
        variant={active ? 'soft' : 'ghost'}
        className="gap-1.5 px-2.5"
        disabled={disabled}
        onClick={onClick}
        // Keep keyboard focus on the remote screen.
        onMouseDown={(event) => event.preventDefault()}
      >
        {children}
      </Button>
    </SimpleTooltip>
  );
}

function TransferRow({ transfer }: { transfer: RdpTransfer }): React.JSX.Element {
  const pct =
    transfer.total > 0
      ? Math.min(100, Math.round((transfer.transferred / transfer.total) * 100))
      : 0;
  return (
    <li className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="truncate font-medium">
          {transfer.direction === 'upload' ? '↑' : '↓'} {transfer.name}
        </span>
        <span
          className={cn(
            'shrink-0',
            transfer.state === 'failed' ? 'text-destructive' : 'text-muted-foreground',
          )}
        >
          {transfer.state === 'failed'
            ? (transfer.error ?? 'Failed')
            : transfer.state === 'done'
              ? 'Done'
              : `${formatBytes(transfer.transferred)} / ${formatBytes(transfer.total)}`}
        </span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-secondary">
        <div
          className={cn(
            'h-full rounded-full transition-[width]',
            transfer.state === 'failed' ? 'bg-destructive' : 'bg-primary',
          )}
          style={{ width: `${transfer.state === 'done' ? 100 : pct}%` }}
        />
      </div>
    </li>
  );
}

/**
 * The Remote Desktop session window (`#/rdp-session?session=…`, opened by main/rdp/
 * sessionWindows.ts). Laid out like Windows' Remote Desktop Connection: a slim bar on top in a
 * normal window, and a drop-down connection bar at the top edge in full screen.
 */
export default function RdpSessionRoute(): React.JSX.Element {
  const sessionId = new URLSearchParams(useLocation().search).get('session') ?? '';
  const hostRef = useRef<HTMLDivElement>(null);
  const session = useRdpSession(sessionId, hostRef);
  const [windowState, setWindowState] = useState<RdpWindowState>({
    isMaximized: false,
    isFullScreen: false,
  });
  const [barVisible, setBarVisible] = useState(false);
  const [transfersOpen, setTransfersOpen] = useState(false);
  const [askAiOpen, setAskAiOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const isMac = window.agentmat.platform === 'darwin';
  const agentState = useRdpAgentSession(sessionId);
  const agentActive = isRdpAgentActive(agentState);
  const nicknameRef = useRef(session.nickname);
  nicknameRef.current = session.nickname;

  // The AI task in main sees and works this session through this window.
  useRdpAgentBridge(sessionId, session.agentTargets);
  useEffect(() => initRdpAgentStatus(() => nicknameRef.current), []);

  useEffect(() => {
    void window.agentmat.rdpWindow.getState().then(setWindowState);
    return window.agentmat.rdpWindow.onStateChange(setWindowState);
  }, []);

  // Ctrl+Alt+Break toggles full screen, as in the Windows client. Captured before the remote
  // screen sees the keys.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.ctrlKey && event.altKey && (event.code === 'Pause' || event.key === 'Cancel')) {
        event.preventDefault();
        event.stopImmediatePropagation();
        void window.agentmat.rdpWindow.fullscreenToggle();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);

  const { phase, options } = session;
  const connected = phase.kind === 'connected';
  useRdpKeyboardLock(connected);
  // Files travel over the clipboard channel, so they need clipboard sharing on.
  const fileTransfer = (options?.clipboard && options.fileTransfer) ?? false;
  const fixedResolution = options != null && options.resolution !== 'fitWindow';
  const activeTransfers = session.transfers.filter((t) => t.state === 'active').length;
  const badge = phaseBadge(phase);

  const controlProps: WindowControlsProps = {
    isMaximized: windowState.isMaximized,
    onMinimize: () => void window.agentmat.rdpWindow.minimize(),
    onMaximizeToggle: () => void window.agentmat.rdpWindow.maximizeToggle(),
    onClose: () => void window.agentmat.rdpWindow.close(),
  };

  const showBar = (): void => {
    clearTimeout(hideTimer.current);
    setBarVisible(true);
  };
  const scheduleHideBar = (): void => {
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      setBarVisible(false);
      setTransfersOpen(false);
    }, HIDE_BAR_DELAY_MS);
  };

  const actions = (
    <>
      <ToolbarButton
        label={
          agentActive
            ? 'The AI is already working on this desktop'
            : 'Ask AI to do a task on this desktop'
        }
        disabled={!connected || agentActive}
        onClick={() => setAskAiOpen(true)}
      >
        <Sparkles className="h-3.5 w-3.5" /> Ask AI
      </ToolbarButton>
      {/* Kept in the app rather than on the server, so it opens even while disconnected. */}
      <ToolbarButton
        label="The AI tasks run on this desktop, with every action and message"
        active={historyOpen}
        onClick={() => setHistoryOpen(true)}
      >
        <History className="h-3.5 w-3.5" /> AI history
      </ToolbarButton>
      <ToolbarButton
        label="Send Ctrl+Alt+Del to the server"
        disabled={!connected}
        onClick={session.ctrlAltDel}
      >
        <Keyboard className="h-3.5 w-3.5" /> Ctrl+Alt+Del
      </ToolbarButton>
      {fileTransfer && (
        <>
          <ToolbarButton
            label="Pick files to paste on the server. You can also copy files here and press Ctrl+V there, or drag them into this window."
            disabled={!connected}
            onClick={() => void session.pickAndSendFiles()}
          >
            <Upload className="h-3.5 w-3.5" /> Send files
          </ToolbarButton>
          <ToolbarButton
            label={
              session.remoteFiles.length === 0
                ? 'Copy files on the server (Ctrl+C) to paste them here with Ctrl+V, or save them with this button'
                : session.remoteClipboard === 'copying'
                  ? 'Copying the files you copied on the server to your clipboard. You can also save them to a folder with this button.'
                  : session.remoteClipboard === 'ready'
                    ? 'The files you copied on the server are on your clipboard, so Ctrl+V pastes them in any folder. This button saves them to a folder you pick.'
                    : 'Save the files you copied on the server to this computer'
            }
            disabled={!connected || session.remoteFiles.length === 0}
            active={session.remoteFiles.length > 0}
            onClick={() => void session.saveRemoteFiles()}
          >
            <Download className="h-3.5 w-3.5" /> Save files
            {session.remoteFiles.length > 0 && (
              <Badge className="ml-0.5 h-4 px-1.5 text-[10px]">{session.remoteFiles.length}</Badge>
            )}
          </ToolbarButton>
        </>
      )}
      {fixedResolution && (
        <ToolbarButton
          label={session.scale === 'fit' ? 'Show at actual size' : 'Scale to fit the window'}
          disabled={!connected}
          onClick={() => session.setScale(session.scale === 'fit' ? 'real' : 'fit')}
        >
          {session.scale === 'fit' ? '1:1' : 'Fit'}
        </ToolbarButton>
      )}
      {session.transfers.length > 0 && (
        <ToolbarButton
          label="File transfers"
          active={transfersOpen}
          onClick={() => setTransfersOpen((open) => !open)}
        >
          {activeTransfers > 0 ? `${activeTransfers} transferring` : 'Transfers'}
        </ToolbarButton>
      )}
      <ToolbarButton
        label={
          windowState.isFullScreen
            ? 'Leave full screen (Ctrl+Alt+Break)'
            : 'Full screen (Ctrl+Alt+Break). Windows key shortcuts like Win+V then go to the server.'
        }
        onClick={() => void window.agentmat.rdpWindow.fullscreenToggle()}
      >
        {windowState.isFullScreen ? (
          <Compress className="h-3.5 w-3.5" />
        ) : (
          <Expand className="h-3.5 w-3.5" />
        )}
      </ToolbarButton>
    </>
  );

  const transfersPanel = transfersOpen && session.transfers.length > 0 && (
    <div className="absolute right-3 top-full z-30 mt-2 w-96 rounded-lg border border-border bg-popover p-3 shadow-xl [-webkit-app-region:no-drag]">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-medium">File transfers</span>
        <Button size="sm" variant="ghost" onClick={session.clearFinishedTransfers}>
          Clear finished
        </Button>
      </div>
      <ul className="flex max-h-72 flex-col gap-2.5 overflow-y-auto pr-1">
        {session.transfers.map((transfer) => (
          <TransferRow key={transfer.key} transfer={transfer} />
        ))}
      </ul>
    </div>
  );

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-black text-foreground">
      {!windowState.isFullScreen && (
        <div
          className="relative flex h-11 shrink-0 items-center gap-3 border-b border-border bg-background pl-4 pr-0 [-webkit-app-region:drag]"
          onDoubleClick={(e) => {
            if (isTitleBarBlankDoubleClick(e)) controlProps.onMaximizeToggle();
          }}
        >
          <div className="flex min-w-0 shrink items-center gap-2">
            {isMac && <MacTrafficLightsSpace />}
            <Monitor className="h-4 w-4 shrink-0 text-primary" />
            <span className="truncate text-sm font-semibold">{session.nickname}</span>
            <Badge variant={badge.variant} className="shrink-0 gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-current" />
              {badge.label}
            </Badge>
          </div>
          <div className="flex flex-1 items-center justify-end gap-0.5 pr-2 [-webkit-app-region:no-drag]">
            {actions}
          </div>
          {!isMac && <NativeCaptionButtons {...controlProps} />}
          {transfersPanel}
        </div>
      )}

      {windowState.isFullScreen && (
        <>
          {/* An invisible strip along the top edge that brings the connection bar down. */}
          <div className="absolute inset-x-0 top-0 z-20 h-1.5" onMouseEnter={showBar} />
          <div
            className={cn(
              'absolute left-1/2 top-0 z-30 flex -translate-x-1/2 items-center gap-1 rounded-b-lg border border-t-0 border-border bg-background/95 py-1 pl-3 pr-1 shadow-xl backdrop-blur transition-transform duration-200',
              barVisible ? 'translate-y-0' : '-translate-y-full',
            )}
            onMouseEnter={showBar}
            onMouseLeave={scheduleHideBar}
          >
            <Monitor className="h-3.5 w-3.5 text-primary" />
            <span className="mr-2 max-w-48 truncate text-sm font-semibold">{session.nickname}</span>
            {actions}
            <ToolbarButton label="Minimize" onClick={controlProps.onMinimize}>
              <WindowMinimize className="h-3.5 w-3.5" />
            </ToolbarButton>
            <ToolbarButton label="Disconnect and close" onClick={controlProps.onClose}>
              <X className="h-3.5 w-3.5" />
            </ToolbarButton>
            {transfersPanel}
          </div>
        </>
      )}

      <RdpAgentStatusBar sessionId={sessionId} onOpenHistory={() => setHistoryOpen(true)} />

      {session.notice && (
        <div
          className={cn(
            'flex shrink-0 items-center gap-3 border-b px-4 py-1.5 text-xs',
            // Solid background: the session area behind it is black.
            session.notice.tone === 'warning'
              ? 'border-warning/30 bg-background text-warning'
              : 'border-border bg-background text-foreground',
          )}
        >
          <span className="min-w-0 flex-1 truncate">{session.notice.message}</span>
          {session.notice.action && (
            <Button size="xs" variant="ghost" onClick={session.notice.action.run}>
              {session.notice.action.label}
            </Button>
          )}
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Dismiss"
            onClick={session.dismissNotice}
          >
            <X />
          </Button>
        </div>
      )}

      <div
        className="relative min-h-0 flex-1"
        onDragOver={(event) => {
          if (fileTransfer && connected) event.preventDefault();
        }}
        onDrop={(event) => {
          if (fileTransfer && connected) void session.dropFiles(event.nativeEvent);
        }}
      >
        <div ref={hostRef} className="absolute inset-0 overflow-hidden" />

        {connected && (
          <RdpAgentOverlay
            sessionId={sessionId}
            getRemoteElement={session.getRemoteElement}
            getCanvas={session.agentTargets.getCanvas}
          />
        )}

        {phase.kind !== 'connected' && (
          <div className="absolute inset-0 z-10 flex overflow-y-auto bg-background">
            {phase.kind === 'failed' ? (
              <RdpFailureCard
                failure={phase}
                onClose={controlProps.onClose}
                onReconnect={session.reconnect}
                onReviewCertificate={session.reviewCertificate}
              />
            ) : (
              <div className="m-auto flex max-w-md flex-col items-center gap-4 px-6 py-8 text-center">
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/15 text-primary">
                  <Monitor
                    className={cn('h-5 w-5', phase.kind === 'connecting' && 'animate-pulse')}
                  />
                </div>
                <div className="space-y-1.5">
                  <p className="text-base font-semibold">
                    {phase.kind === 'connecting'
                      ? `Connecting to ${session.nickname}…`
                      : 'Disconnected'}
                  </p>
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    {phase.kind === 'connecting'
                      ? 'Signing in and setting up the remote session.'
                      : phase.reason || 'The remote session ended.'}
                  </p>
                </div>
                {phase.kind === 'ended' && (
                  <div className="flex gap-2">
                    <Button variant="ghost" onClick={controlProps.onClose}>
                      Close
                    </Button>
                    <Button onClick={session.reconnect}>
                      <RefreshCw className="h-3.5 w-3.5" /> Reconnect
                    </Button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      <RdpAskAiDialog sessionId={sessionId} open={askAiOpen} onOpenChange={setAskAiOpen} />
      <SshAgentHistoryDialog
        sessionId={sessionId}
        sessionTitle={session.nickname}
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        source={{
          kind: 'rdp',
          queryKey: queryKeys.rdpAgentHistory(sessionId),
          load: () => window.agentmat.rdpAgent.history(sessionId),
          live: agentState,
        }}
      />

      <Dialog
        open={session.certificate != null}
        onOpenChange={(open) => {
          if (!open) void session.respondCertificate(false);
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <TriangleAlert className="h-4 w-4 text-warning" /> The server's certificate changed
            </DialogTitle>
            <DialogDescription>
              {session.certificate?.host} is presenting a different certificate than the last time
              you connected. That's expected after the server is reinstalled or its certificate is
              renewed. If neither happened, someone could be intercepting the connection.
            </DialogDescription>
          </DialogHeader>
          {session.certificate && (
            <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1.5 text-xs">
              <dt className="text-muted-foreground">Issued to</dt>
              <dd className="break-all">{session.certificate.subject || 'Unknown'}</dd>
              <dt className="text-muted-foreground">Issued by</dt>
              <dd className="break-all">{session.certificate.issuer || 'Unknown'}</dd>
              <dt className="text-muted-foreground">Valid until</dt>
              <dd>{session.certificate.validTo}</dd>
              <dt className="text-muted-foreground">Saved</dt>
              <dd className="break-all font-mono">{session.certificate.expectedFingerprint}</dd>
              <dt className="text-muted-foreground">Now</dt>
              <dd className="break-all font-mono">{session.certificate.actualFingerprint}</dd>
            </dl>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => void session.respondCertificate(false)}>
              Don't connect
            </Button>
            <Button onClick={() => void session.respondCertificate(true)}>Trust and connect</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
