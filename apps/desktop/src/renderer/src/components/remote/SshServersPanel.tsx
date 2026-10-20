import type { SshSavedServer } from '@shared/apiTypes';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FolderOpen, History, Link, Pencil, Plus, Server, Trash2 } from '@/components/icons';
import { EmptyState, FOOTER_HAIRLINE } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { queryKeys } from '@/lib/queryKeys';
import { timeAgo } from '@/lib/time';
import { confirmDialog } from '@/stores/confirmStore';
import { useTerminalStore } from '@/stores/terminalStore';
import { REMOTE_CARD, RemoteCardHeader, ServerRowsSkeleton } from './remoteCard';
import { ServersVaultControls } from './ServersVaultControls';
import { SshHistoryPanel } from './SshHistoryPanel';
import { SshServerFormDialog } from './SshServerFormDialog';
import { SshVaultUnlockDialog } from './SshVaultUnlockDialog';

type ServerAction = 'connect' | 'history' | 'files';

function authMethodLabel(server: SshSavedServer): string {
  return server.authMethod === 'password' ? 'Password' : 'Private key';
}

function SavedSshServerRow({
  server,
  onConnect,
  onHistory,
  onFiles,
  onEdit,
  onRemoved,
}: {
  server: SshSavedServer;
  onConnect: (server: SshSavedServer) => Promise<void>;
  onHistory: (server: SshSavedServer) => Promise<void>;
  /** Opens the SFTP file manager on this server (E25). */
  onFiles: (server: SshSavedServer) => Promise<void>;
  onEdit: (server: SshSavedServer) => void;
  onRemoved: () => void;
}): React.JSX.Element {
  const [connecting, setConnecting] = useState(false);
  const [removing, setRemoving] = useState(false);

  async function remove(): Promise<void> {
    const confirmed = await confirmDialog({
      title: `Remove "${server.nickname}"?`,
      description: 'You can add it again later with the same details.',
      confirmLabel: 'Remove',
      variant: 'destructive',
    });
    if (!confirmed) return;
    setRemoving(true);
    try {
      await window.agentmat.ssh.removeServer(server.id);
      onRemoved();
    } finally {
      setRemoving(false);
    }
  }

  async function connect(): Promise<void> {
    setConnecting(true);
    try {
      await onConnect(server);
    } finally {
      setConnecting(false);
    }
  }

  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 px-5 py-3">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-foreground/[0.06] text-muted-foreground">
        <Server className="h-4 w-4" />
      </span>
      <div className="min-w-[min(100%,12rem)] flex-1">
        <p className="truncate text-[13px] font-medium text-foreground">{server.nickname}</p>
        <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <span className="truncate font-mono">
            {server.username}@{server.host}:{server.port}
          </span>
          <span className="shrink-0 rounded-full bg-foreground/[0.06] px-1.5 text-[10px] font-medium leading-4">
            {authMethodLabel(server)}
          </span>
          {server.lastConnectedAt ? (
            <span className="truncate">
              last connected {timeAgo(new Date(server.lastConnectedAt).toISOString())}
            </span>
          ) : null}
        </p>
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-1">
        <SimpleTooltip label="AI history on this server">
          <Button
            size="icon"
            variant="ghost"
            className="shrink-0"
            aria-label="AI history on this server"
            onClick={() => void onHistory(server)}
          >
            <History className="h-3.5 w-3.5" />
          </Button>
        </SimpleTooltip>
        <SimpleTooltip label="Edit this server">
          <Button
            size="icon"
            variant="ghost"
            className="shrink-0"
            aria-label={`Edit ${server.nickname}`}
            onClick={() => onEdit(server)}
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>
        </SimpleTooltip>
        <SimpleTooltip label="Remove this server">
          <Button
            size="icon"
            variant="ghost"
            className="shrink-0 hover:bg-destructive/10 hover:text-destructive"
            aria-label={`Remove ${server.nickname}`}
            onClick={() => void remove()}
            disabled={removing}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </SimpleTooltip>
        <SimpleTooltip label="Browse files over SFTP">
          <Button variant="soft" className="ml-1" onClick={() => void onFiles(server)}>
            <FolderOpen className="h-3.5 w-3.5" /> Files
          </Button>
        </SimpleTooltip>
        <Button onClick={() => void connect()} disabled={connecting}>
          <Link className="h-3.5 w-3.5" /> {connecting ? 'Connecting…' : 'Connect'}
        </Button>
      </div>
    </li>
  );
}

export function SshServersPanel(): React.JSX.Element {
  const queryClient = useQueryClient();
  const openSshSession = useTerminalStore((s) => s.openSshSession);
  const navigate = useNavigate();
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<SshSavedServer | undefined>(undefined);
  const [unlockOpen, setUnlockOpen] = useState(false);
  const [unlockMode, setUnlockMode] = useState<'unlock' | 'set'>('unlock');
  // What to do with a server once the vault is unlocked: connect to it, or show its history.
  const [pendingAction, setPendingAction] = useState<{
    server: SshSavedServer;
    action: ServerAction;
  } | null>(null);
  const [historyServer, setHistoryServer] = useState<SshSavedServer | null>(null);

  const serversQuery = useQuery({
    queryKey: queryKeys.sshServers,
    queryFn: () => window.agentmat.ssh.listServers(),
  });
  const servers = serversQuery.data ?? [];

  async function refreshServers(): Promise<void> {
    await queryClient.invalidateQueries({ queryKey: queryKeys.sshServers });
  }
  async function refreshVault(): Promise<void> {
    await queryClient.invalidateQueries({ queryKey: queryKeys.sshVaultStatus });
  }

  function openAdd(): void {
    setEditing(undefined);
    setFormOpen(true);
  }
  function openEdit(server: SshSavedServer): void {
    setEditing(server);
    setFormOpen(true);
  }

  function runAction(server: SshSavedServer, action: ServerAction): void {
    if (action === 'connect') {
      openSshSession(server);
      return;
    }
    if (action === 'files') {
      // The page opens the session itself, host key prompt included; this only goes there.
      navigate(`/ssh-files/${server.id}`);
      return;
    }
    setHistoryServer(server);
    // Coming back from an unlock the panel may hold a vault-locked error; read again.
    void queryClient.invalidateQueries({ queryKey: queryKeys.sshConversations(server.id) });
  }

  function askToUnlock(server: SshSavedServer, action: ServerAction): void {
    setPendingAction({ server, action });
    setUnlockMode('unlock');
    setUnlockOpen(true);
  }

  /** Every action reads the server's stored secret, so a locked vault asks for its passkey first. */
  async function withUnlockedVault(server: SshSavedServer, action: ServerAction): Promise<void> {
    const status = await window.agentmat.ssh.vaultStatus();
    if (status.hasPasskey && !status.unlocked) {
      askToUnlock(server, action);
      return;
    }
    runAction(server, action);
  }

  function handleUnlocked(): void {
    void refreshVault();
    if (pendingAction) {
      runAction(pendingAction.server, pendingAction.action);
      setPendingAction(null);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <section className={REMOTE_CARD}>
        <RemoteCardHeader
          icon={Server}
          title="Saved servers"
          description="Connect over SSH with one click, no terminal typing."
          actions={
            <>
              <ServersVaultControls
                onRequestDialog={(mode) => {
                  setUnlockMode(mode);
                  setUnlockOpen(true);
                }}
              />
              {servers.length > 0 ? (
                <Button onClick={openAdd}>
                  <Plus className="h-3.5 w-3.5" /> Add server
                </Button>
              ) : null}
            </>
          }
        />
        <div className={FOOTER_HAIRLINE}>
          {serversQuery.isPending ? (
            <ServerRowsSkeleton />
          ) : servers.length === 0 ? (
            <EmptyState
              size="sm"
              icon={Server}
              title="No servers yet"
              description="Add one to connect with a click, right from a terminal tab."
              action={
                <Button onClick={openAdd}>
                  <Plus className="h-3.5 w-3.5" /> Add server
                </Button>
              }
            />
          ) : (
            <ul className="settings-rows">
              {servers.map((server) => (
                <SavedSshServerRow
                  key={server.id}
                  server={server}
                  onConnect={(s) => withUnlockedVault(s, 'connect')}
                  onHistory={(s) => withUnlockedVault(s, 'history')}
                  onFiles={(s) => withUnlockedVault(s, 'files')}
                  onEdit={openEdit}
                  onRemoved={() => void refreshServers()}
                />
              ))}
            </ul>
          )}
        </div>
      </section>

      <SshServerFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        initial={editing}
        onSaved={() => void refreshServers()}
      />
      <SshVaultUnlockDialog
        open={unlockOpen}
        onOpenChange={(open) => {
          setUnlockOpen(open);
          // Backing out drops the action, so a later unlock from the header doesn't run it.
          // `handleUnlocked` still sees it: it reads this render's value.
          if (!open) setPendingAction(null);
        }}
        mode={unlockMode}
        onUnlocked={handleUnlocked}
      />
      <SshHistoryPanel
        server={historyServer}
        onOpenChange={(open) => {
          if (!open) setHistoryServer(null);
        }}
        onRequestUnlock={() => {
          if (historyServer) askToUnlock(historyServer, 'history');
        }}
      />
    </div>
  );
}
