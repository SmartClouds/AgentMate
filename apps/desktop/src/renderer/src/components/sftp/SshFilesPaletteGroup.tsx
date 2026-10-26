import { useQuery } from '@tanstack/react-query';
import { Command as CommandPrimitive } from 'cmdk';
import { useNavigate } from 'react-router-dom';
import { FolderOpen } from '@/components/icons';
import { queryKeys } from '@/lib/queryKeys';

// Same look as the palette's other groups.
const groupClass =
  'px-1 py-1 text-xs font-medium text-muted-foreground [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.08em] [&_[cmdk-group-heading]]:text-muted-foreground/60';
const itemClass =
  'flex cursor-pointer select-none items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-foreground outline-none transition-colors aria-selected:bg-foreground/[0.07] aria-selected:text-foreground';

/**
 * The command palette's way into the SFTP file manager (E25): "Open SFTP files: <nickname>" for
 * each saved SSH server, found by its nickname, host or user once something is typed. An empty
 * palette leaves them out, so it does not list every server next to the pages.
 */
export function SshFilesPaletteGroup({
  enabled,
  query,
  onDone,
}: {
  /** The palette is open; the server list is only read then. */
  enabled: boolean;
  /** What is typed in the palette. Nothing shows while it is empty. */
  query: string;
  /** Closes the palette. */
  onDone: () => void;
}): React.JSX.Element | null {
  const navigate = useNavigate();
  const serversQuery = useQuery({
    queryKey: queryKeys.sshServers,
    queryFn: () => window.runova.ssh.listServers(),
    enabled,
    meta: { silentLoading: true },
  });
  const servers = serversQuery.data ?? [];

  if (!query.trim() || servers.length === 0) return null;

  return (
    <CommandPrimitive.Group heading="SFTP files" className={groupClass}>
      {servers.map((server) => (
        <CommandPrimitive.Item
          key={server.id}
          value={`sftp ssh files browse ${server.nickname} ${server.host} ${server.username} ${server.id}`}
          className={itemClass}
          onSelect={() => {
            onDone();
            navigate(`/ssh-files/${server.id}`);
          }}
        >
          <FolderOpen className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1">
            <span className="block truncate">
              <span className="text-muted-foreground">Open SFTP files:</span> {server.nickname}
            </span>
            <span className="block truncate font-mono text-xs text-muted-foreground">
              {`${server.username}@${server.host}:${server.port}`}
            </span>
          </span>
        </CommandPrimitive.Item>
      ))}
    </CommandPrimitive.Group>
  );
}
