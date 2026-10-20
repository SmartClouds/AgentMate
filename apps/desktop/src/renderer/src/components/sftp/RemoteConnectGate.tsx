import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Link, Lock, Pencil, Plug, Server } from '@/components/icons';
import { EmptyState, LoadFailure, Notice } from '@/components/pageKit';
import { SshVaultUnlockDialog } from '@/components/remote/SshVaultUnlockDialog';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { serverFiles, useSftpStore } from '@/stores/sftpStore';
import { PaneSkeleton } from './FilePane';
import { PANE_CARD } from './FileRow';

/** The shimmer and the words while the session opens. */
function ConnectingBody({ nickname }: { nickname: string }): React.JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <p
        role="status"
        className="flex items-center gap-2 px-4 pb-1 pt-3 text-[13px] text-muted-foreground"
      >
        <span aria-hidden className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full rounded-full bg-primary opacity-60 motion-safe:animate-ping" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-primary" />
        </span>
        Connecting to {nickname}…
      </p>
      <PaneSkeleton label={`Connecting to ${nickname}`} />
    </div>
  );
}

export interface RemoteConnectGateProps {
  serverId: string;
  /** The remote pane, drawn once the session is ready. */
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}

/**
 * The server's side of the page until its session is ready: a shimmer while it connects, the
 * vault unlock when the Servers vault is locked, the reason and a retry when the login or the
 * network fails, and a way back to Remote when the server is not saved anymore.
 */
export function RemoteConnectGate({
  serverId,
  children,
  className,
  style,
}: RemoteConnectGateProps): React.JSX.Element {
  const navigate = useNavigate();
  const files = useSftpStore((state) => serverFiles(state, serverId));
  const connect = useSftpStore((state) => state.connect);
  const [unlockOpen, setUnlockOpen] = useState(false);
  const nickname = files.session?.nickname ?? files.server?.nickname ?? 'the server';

  if (files.status === 'ready') return <>{children}</>;

  let body: React.ReactNode;
  switch (files.status) {
    case 'locked':
      body = (
        <div className="p-3">
          <Notice
            tone="warning"
            icon={Lock}
            action={
              <Button size="sm" onClick={() => setUnlockOpen(true)}>
                Unlock
              </Button>
            }
          >
            <p className="font-medium">Your saved servers are locked</p>
            <p className="mt-0.5 text-muted-foreground">
              Unlock them with your passkey to browse the files on {nickname}.
            </p>
          </Notice>
          <SshVaultUnlockDialog
            open={unlockOpen}
            onOpenChange={setUnlockOpen}
            mode="unlock"
            onUnlocked={() => void connect(serverId)}
          />
        </div>
      );
      break;
    case 'error':
      body = (
        <div className="flex flex-col items-start gap-2 p-3">
          <div className="w-full">
            <LoadFailure
              message={
                <>
                  <span className="font-medium">Couldn't connect to {nickname}.</span> {files.error}
                </>
              }
              retry={() => void connect(serverId)}
            />
          </div>
          <Button
            variant="link"
            size="sm"
            className="h-auto px-1"
            onClick={() => navigate('/remote')}
          >
            <Pencil className="size-3" /> Edit server
          </Button>
        </div>
      );
      break;
    case 'missing':
      body = (
        <EmptyState
          icon={Server}
          title="This server isn't saved anymore"
          description="It may have been removed. Saved servers live in Remote, under SSH."
          action={
            <Button onClick={() => navigate('/remote')}>
              <Link /> Open Remote
            </Button>
          }
          className="flex-1"
        />
      );
      break;
    case 'idle':
      // Before anything is known the page is about to connect; afterwards idle means disconnected.
      if (!files.server) {
        body = <ConnectingBody nickname={nickname} />;
        break;
      }
      body = (
        <EmptyState
          icon={Plug}
          title={`Not connected to ${nickname}`}
          description="Connect to browse and transfer its files."
          action={<Button onClick={() => void connect(serverId)}>Connect</Button>}
          className="flex-1"
        />
      );
      break;
    default:
      body = <ConnectingBody nickname={nickname} />;
  }

  return (
    <section aria-label={`Server ${nickname}`} style={style} className={cn(PANE_CARD, className)}>
      <div className="flex h-12 shrink-0 items-center gap-2 px-3.5 shadow-[inset_0_-1px_0_hsl(var(--border)/0.6)]">
        <Server aria-hidden className="h-3.5 w-3.5 shrink-0 text-primary" />
        <h2 className="min-w-0 truncate text-[13px] font-semibold tracking-tight">
          {files.server?.nickname ?? files.session?.nickname ?? 'Server'}
        </h2>
      </div>
      {body}
    </section>
  );
}
