import { coreErrorMessage } from '@shared/coreErrors';
import type { StreamProxyInfo } from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { useState } from 'react';
import { toast } from 'sonner';
import { NetworkIcon, Pencil, Plus, Trash2 } from '@/components/icons';
import { FOOTER_HAIRLINE, GLASS_CARD, TileHeader } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { confirmDialog } from '@/stores/confirmStore';
import { AppliedChip } from './SitesCard';
import { StreamProxyDialog } from './StreamProxyDialog';

/** Public TCP and UDP ports nginx passes on, each with who may connect. */

export function StreamProxiesCard({
  serverId,
  proxies,
  loading,
  error,
  admin,
  available,
  onChanged,
}: {
  serverId: string;
  proxies: StreamProxyInfo[] | undefined;
  loading: boolean;
  error: string | null;
  admin: boolean;
  /** nginx is managed and has its stream module. */
  available: boolean;
  onChanged: () => void;
}): React.JSX.Element {
  const [editing, setEditing] = useState<StreamProxyInfo | 'new' | null>(null);

  async function remove(proxy: StreamProxyInfo): Promise<void> {
    const confirmed = await confirmDialog({
      title: `Delete the ${proxy.settings.protocol.toUpperCase()} proxy on port ${proxy.settings.listenPort}?`,
      description: 'Connections to that port stop with the next apply.',
      confirmLabel: 'Delete the proxy',
      variant: 'destructive',
    });
    if (!confirmed) return;
    try {
      await window.runova.deploySites.removeStream(serverId, proxy.settings.id);
      toast.success('Proxy deleted. Apply to close the port.');
      onChanged();
    } catch (failure) {
      toast.error(coreErrorMessage(failure));
    }
  }

  return (
    <section className={cn(GLASS_CARD, 'overflow-hidden')}>
      <div className="space-y-1 px-4 pb-3 pt-4">
        <TileHeader
          icon={<NetworkIcon />}
          title="TCP and UDP proxies"
          actions={
            admin && available ? (
              <Button type="button" size="sm" variant="soft" onClick={() => setEditing('new')}>
                <Plus className="h-3.5 w-3.5" /> Add a proxy
              </Button>
            ) : undefined
          }
        />
        <p className="text-xs text-muted-foreground">
          For databases, game servers and anything else that is not a website.
        </p>
      </div>
      {loading ? (
        <div className="px-4 pb-4">
          <Skeleton className="h-10 w-full rounded-xl" aria-busy="true" />
        </div>
      ) : error ? (
        <p role="alert" className="px-4 pb-4 text-sm text-destructive">
          {error}
        </p>
      ) : !proxies || proxies.length === 0 ? (
        <p className="px-4 pb-4 text-sm text-muted-foreground">No TCP or UDP proxies.</p>
      ) : (
        <ul aria-label="Stream proxies" className={cn('settings-rows', FOOTER_HAIRLINE)}>
          {proxies.map((proxy) => {
            const s = proxy.settings;
            const name = `${s.protocol.toUpperCase()} ${s.listenPort}`;
            return (
              <li
                key={s.id}
                aria-label={name}
                className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm transition-colors hover:bg-foreground/[0.03]"
              >
                <span className="font-mono text-foreground">{name}</span>
                <span className="text-muted-foreground">to</span>
                <span className="font-mono text-foreground">{s.upstream.address}</span>
                <span className="text-xs text-muted-foreground">
                  {s.allowFrom && s.allowFrom.length > 0
                    ? `${s.allowFrom.length} allowed ${s.allowFrom.length === 1 ? 'address' : 'addresses'}`
                    : 'open to anyone'}
                </span>
                <span className="ml-auto flex items-center gap-1">
                  <AppliedChip applied={proxy.applied} />
                  {admin && (
                    <>
                      <SimpleTooltip label="Edit">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Edit ${name}`}
                          onClick={() => setEditing(proxy)}
                        >
                          <Pencil />
                        </Button>
                      </SimpleTooltip>
                      <SimpleTooltip label="Delete">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          className="hover:bg-destructive/10 hover:text-destructive"
                          aria-label={`Delete ${name}`}
                          onClick={() => void remove(proxy)}
                        >
                          <Trash2 />
                        </Button>
                      </SimpleTooltip>
                    </>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <StreamProxyDialog
        serverId={serverId}
        proxy={editing === 'new' ? null : editing}
        open={editing !== null}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          toast.success('Proxy saved. Apply to open the port.');
          onChanged();
        }}
      />
    </section>
  );
}
