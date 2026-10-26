import type { RemoteSavedServer } from '@shared/apiTypes';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { ExternalLink, Folder, Link, LinkOff, Monitor, Pencil, Trash2 } from '@/components/icons';
import { Chip, FOOTER_HAIRLINE } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { queryKeys } from '@/lib/queryKeys';
import { timeAgo } from '@/lib/time';
import { cn } from '@/lib/utils';
import { confirmDialog } from '@/stores/confirmStore';
import { useRemoteStore } from '@/stores/remoteStore';
import { REMOTE_CARD, RemoteCardHeader } from './remoteCard';

function SavedServerRow({ server }: { server: RemoteSavedServer }): React.JSX.Element {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [nickname, setNickname] = useState(server.nickname);
  const [connecting, setConnecting] = useState(false);
  const [browsing, setBrowsing] = useState(false);

  async function refresh(): Promise<void> {
    await queryClient.invalidateQueries({ queryKey: queryKeys.remoteSavedServers });
  }

  async function saveNickname(): Promise<void> {
    setEditing(false);
    const trimmed = nickname.trim();
    if (!trimmed || trimmed === server.nickname) {
      setNickname(server.nickname);
      return;
    }
    await window.runova.remote.renameSavedServer(server.id, trimmed);
    await refresh();
  }

  async function remove(): Promise<void> {
    const confirmed = await confirmDialog({
      title: `Forget "${server.nickname}"?`,
      description: 'You can pair with it again later using a fresh code from that device.',
      confirmLabel: 'Forget',
      variant: 'destructive',
    });
    if (!confirmed) return;
    await window.runova.remote.removeSavedServer(server.id);
    await refresh();
  }

  async function connect(): Promise<void> {
    setConnecting(true);
    try {
      const result = await window.runova.remote.connectSaved(server.id);
      if (!result.ok) {
        toast.error(result.error ?? 'Could not connect.');
        return;
      }
      await window.runova.remote.openSessionWindow();
    } finally {
      setConnecting(false);
    }
  }

  async function browseFiles(): Promise<void> {
    setBrowsing(true);
    try {
      const result = await window.runova.remote.connectSavedFiles(server.id);
      if (!result.ok) {
        toast.error(result.error ?? 'Could not connect.');
        return;
      }
      navigate('/remote-files');
    } finally {
      setBrowsing(false);
    }
  }

  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 px-5 py-3">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-foreground/[0.06] text-muted-foreground">
        <Monitor className="h-4 w-4" />
      </span>
      <div className="min-w-[min(100%,12rem)] flex-1">
        {editing ? (
          <Input
            autoFocus
            aria-label="Nickname"
            value={nickname}
            onChange={(e) => setNickname(e.target.value)}
            onBlur={() => void saveNickname()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') {
                setNickname(server.nickname);
                setEditing(false);
              }
            }}
            className="h-7 max-w-xs px-3"
          />
        ) : (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="group flex max-w-full cursor-pointer items-center gap-1.5 truncate rounded-md text-[13px] font-medium text-foreground transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="truncate">{server.nickname}</span>
            <Pencil className="h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
          </button>
        )}
        <p className="truncate text-xs text-muted-foreground">
          <span className="font-mono">
            {server.ip}:{server.port}
          </span>{' '}
          · last connected {timeAgo(new Date(server.lastConnectedAt).toISOString())}
        </p>
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        <Button onClick={() => void connect()} disabled={connecting}>
          <Link className="h-3.5 w-3.5" /> {connecting ? 'Connecting…' : 'Connect'}
        </Button>
        <SimpleTooltip label="Browse this machine's files, without opening a control session">
          <Button variant="soft" onClick={() => void browseFiles()} disabled={browsing}>
            <Folder className="h-3.5 w-3.5" /> {browsing ? 'Connecting…' : 'Browse files'}
          </Button>
        </SimpleTooltip>
        <SimpleTooltip label="Forget this server">
          <Button
            size="icon"
            variant="ghost"
            aria-label={`Forget ${server.nickname}`}
            className="shrink-0 hover:bg-destructive/10 hover:text-destructive"
            onClick={() => void remove()}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </SimpleTooltip>
      </div>
    </li>
  );
}

export function ControllerPanel(): React.JSX.Element {
  const navigate = useNavigate();
  const connection = useRemoteStore((s) => s.state?.connection);
  const [code, setCode] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [connectingFiles, setConnectingFiles] = useState(false);

  const savedServersQuery = useQuery({
    queryKey: queryKeys.remoteSavedServers,
    queryFn: () => window.runova.remote.listSavedServers(),
  });
  const savedServers = savedServersQuery.data ?? [];

  const status = connection?.status ?? 'idle';
  const connected = status === 'connected';
  const active = status === 'connecting' || status === 'connected';
  const filesOnly = connection?.intent === 'files';

  async function connect(): Promise<void> {
    if (!code.trim()) {
      toast.error('Paste a pairing code first.');
      return;
    }
    setConnecting(true);
    try {
      const result = await window.runova.remote.connect(code.trim());
      if (!result.ok) {
        toast.error(result.error ?? 'Could not connect.');
        return;
      }
      setCode('');
      await window.runova.remote.openSessionWindow();
    } finally {
      setConnecting(false);
    }
  }

  async function connectFiles(): Promise<void> {
    if (!code.trim()) {
      toast.error('Paste a pairing code first.');
      return;
    }
    setConnectingFiles(true);
    try {
      const result = await window.runova.remote.connectFiles(code.trim());
      if (!result.ok) {
        toast.error(result.error ?? 'Could not connect.');
        return;
      }
      setCode('');
      navigate('/remote-files');
    } finally {
      setConnectingFiles(false);
    }
  }

  if (active) {
    return (
      <section className={REMOTE_CARD}>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3 px-5 py-4">
          <div className="flex min-w-[min(100%,16rem)] flex-1 items-center gap-3">
            <div
              className={cn(
                'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl',
                connected
                  ? 'bg-success/12 text-success shadow-[0_0_32px_-12px_hsl(var(--success)/0.8)]'
                  : 'bg-warning/12 text-warning',
              )}
            >
              <Monitor className="h-4 w-4" />
            </div>
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="truncate text-sm font-semibold">
                  {connection?.remoteDeviceName ?? 'Remote device'}
                </span>
                <Chip tone={connected ? 'success' : 'warning'} dot pulse={!connected}>
                  {connected ? 'Connected' : 'Connecting…'}
                </Chip>
              </div>
              <p className="text-xs text-muted-foreground">
                {filesOnly ? 'Files only, no control session.' : 'Open in its own window.'}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {filesOnly ? (
              <Button variant="soft" onClick={() => navigate('/remote-files')}>
                <Folder className="h-3.5 w-3.5" /> Open file manager
              </Button>
            ) : (
              <Button variant="soft" onClick={() => void window.runova.remote.openSessionWindow()}>
                <ExternalLink className="h-3.5 w-3.5" /> Show remote window
              </Button>
            )}
            <Button variant="destructive" onClick={() => void window.runova.remote.disconnect()}>
              <LinkOff className="h-3.5 w-3.5" /> Disconnect
            </Button>
          </div>
        </div>
      </section>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {savedServers.length > 0 && (
        <section className={REMOTE_CARD}>
          <RemoteCardHeader
            icon={Monitor}
            title="Saved servers"
            description="Reconnect with one click, no pairing code needed."
          />
          <ul className={cn('settings-rows', FOOTER_HAIRLINE)}>
            {savedServers.map((server) => (
              <SavedServerRow key={server.id} server={server} />
            ))}
          </ul>
        </section>
      )}

      <section className={REMOTE_CARD}>
        <RemoteCardHeader
          icon={Link}
          title="Pair a new device"
          description="Paste the pairing code generated by the other Runova (or the contents of its QR code) to take control over your local network. It's remembered afterwards, so you won't need the code again."
        />
        <div className={cn('flex flex-col gap-3 px-5 py-4', FOOTER_HAIRLINE)}>
          <Textarea
            value={code}
            onChange={(e) => setCode(e.target.value)}
            spellCheck={false}
            aria-label="Pairing code"
            placeholder="RUNOVA1:…"
            className="h-24 resize-none p-3 font-mono text-xs"
          />
          {status === 'error' && connection?.error && (
            <p className="text-xs text-destructive">{connection.error}</p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="lg"
              onClick={() => void connect()}
              disabled={connecting || connectingFiles}
            >
              <Link className="h-4 w-4" /> {connecting ? 'Connecting…' : 'Connect'}
            </Button>
            <SimpleTooltip label="Skip the control session, just browse and transfer files">
              <Button
                variant="soft"
                size="lg"
                onClick={() => void connectFiles()}
                disabled={connecting || connectingFiles}
              >
                <Folder className="h-4 w-4" />{' '}
                {connectingFiles ? 'Connecting…' : 'Connect (files only)'}
              </Button>
            </SimpleTooltip>
          </div>
        </div>
      </section>
    </div>
  );
}
