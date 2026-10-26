import { useQuery } from '@tanstack/react-query';
import { Command as CommandPrimitive } from 'cmdk';
import { useNavigate } from 'react-router-dom';
import { Lock, LockOpen } from '@/components/icons';
import { queryKeys } from '@/lib/queryKeys';
import { EntryAvatar } from './EntryAvatar';
import { entrySubtitle } from './entryTypes';

// Same look as the palette's other groups.
const groupClass =
  'px-1 py-1 text-xs font-medium text-muted-foreground [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.08em] [&_[cmdk-group-heading]]:text-muted-foreground/60';
const itemClass =
  'flex cursor-pointer select-none items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-foreground outline-none transition-colors aria-selected:bg-foreground/[0.07] aria-selected:text-foreground';

/**
 * The Vault's part of the command palette. Entry titles only appear while the vault is unlocked,
 * from the same list the Vault page already holds.
 */
export function VaultPaletteGroup({
  enabled,
  onDone,
}: {
  enabled: boolean;
  onDone: () => void;
}): React.JSX.Element | null {
  const navigate = useNavigate();
  const statusQuery = useQuery({
    queryKey: queryKeys.vaultStatus,
    queryFn: () => window.runova.vault.status(),
    enabled,
    meta: { silentLoading: true },
  });
  const state = statusQuery.data?.state;
  const entriesQuery = useQuery({
    queryKey: queryKeys.vaultEntries,
    queryFn: () => window.runova.vault.list(),
    enabled: enabled && state === 'unlocked',
    meta: { silentLoading: true },
  });

  if (!state || state === 'uninitialized') return null;

  if (state === 'locked') {
    return (
      <CommandPrimitive.Group heading="Vault" className={groupClass}>
        <CommandPrimitive.Item
          value="unlock vault passwords"
          className={itemClass}
          onSelect={() => {
            onDone();
            navigate('/vault');
          }}
        >
          <LockOpen className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          Unlock Vault
        </CommandPrimitive.Item>
      </CommandPrimitive.Group>
    );
  }

  return (
    <CommandPrimitive.Group heading="Vault" className={groupClass}>
      <CommandPrimitive.Item
        value="lock vault passwords"
        className={itemClass}
        onSelect={() => {
          onDone();
          void window.runova.vault.lock();
        }}
      >
        <Lock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        Lock Vault
      </CommandPrimitive.Item>
      {(entriesQuery.data ?? []).map((entry) => (
        <CommandPrimitive.Item
          key={entry.id}
          value={`vault ${entry.title} ${entry.host} ${entry.username} ${entry.tags.join(' ')} ${entry.id}`}
          className={itemClass}
          onSelect={() => {
            onDone();
            navigate('/vault', { state: { entryId: entry.id } });
          }}
        >
          <EntryAvatar entry={entry} size="sm" />
          <span className="min-w-0 flex-1">
            <span className="block truncate">{entry.title}</span>
            <span className="block truncate text-xs text-muted-foreground">
              {entrySubtitle(entry)}
            </span>
          </span>
        </CommandPrimitive.Item>
      ))}
    </CommandPrimitive.Group>
  );
}
