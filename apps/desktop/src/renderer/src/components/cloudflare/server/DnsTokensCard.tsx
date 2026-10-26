import { cloudflareErrorPermission } from '@shared/cloudflareErrors';
import type { CloudflareZone } from '@shared/cloudflareTypes';
import { coreErrorMessage } from '@shared/coreErrors';
import type { DeployServer } from '@shared/deployTypes';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { CircleCheck, Key, Server, Spinner, Trash2 } from '@/components/icons';
import { Chip, EmptyState, FOOTER_HAIRLINE } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { relative } from '@/lib/deploy/sites/certificates';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { confirmDialog } from '@/stores/confirmStore';
import { CardBody, CloudflareCard } from '../fields';
import { GuidedFix } from './GuidedFix';

/**
 * DNS-01 for this zone (E14 T7): which servers hold a DNS token for it, so they can get wildcard
 * certificates and certificates for names behind the proxy. The app makes a token that can edit
 * this zone's DNS and nothing else, or takes one the user made; either way the account token
 * stays in the app, and the server never shows the token again.
 */

function ServerRow({ server, zone }: { server: DeployServer; zone: CloudflareZone }) {
  const id = useId();
  const queryClient = useQueryClient();
  const key = queryKeys.cloudflareDnsTokens(server.id);
  const tokens = useQuery({
    queryKey: key,
    queryFn: () => window.runova.cloudflareServer.dnsTokens(server.id),
    retry: false,
  });
  const [busy, setBusy] = useState<'mint' | 'paste' | 'remove' | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [pasting, setPasting] = useState(false);
  const [token, setToken] = useState('');
  const held = tokens.data?.find((item) => item.zone === zone.name);

  async function run(
    kind: 'mint' | 'paste' | 'remove',
    work: () => Promise<unknown>,
    done: string,
  ) {
    setBusy(kind);
    setError(null);
    try {
      await work();
      toast.success(done);
      setPasting(false);
      setToken('');
      void queryClient.invalidateQueries({ queryKey: key });
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(null);
    }
  }

  async function remove(): Promise<void> {
    const made = Boolean(held?.tokenId);
    const confirmed = await confirmDialog({
      title: `Remove the DNS token from ${server.nickname}?`,
      description: made
        ? 'The server forgets it, and the token Runova made is deleted at Cloudflare. Wildcard certificates there stop renewing until it has a token again.'
        : 'The server forgets it. The token itself stays on Cloudflare; delete it there if nothing else uses it.',
      confirmLabel: 'Remove the token',
      variant: 'destructive',
    });
    if (!confirmed) return;
    await run(
      'remove',
      () =>
        window.runova.cloudflareServer.removeDnsToken({
          serverId: server.id,
          zone: zone.name,
          deleteAtCloudflare: made,
        }),
      `${server.nickname} no longer holds a DNS token for ${zone.name}.`,
    );
  }

  const cannotMint = cloudflareErrorPermission(error) === 'apiTokens';
  return (
    <li className="space-y-2 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="flex min-w-0 items-center gap-2 text-sm font-medium text-foreground">
          <Server className="h-4 w-4 shrink-0 text-muted-foreground" /> {server.nickname}
        </span>
        {tokens.isPending ? (
          <Skeleton className="h-4 w-40" />
        ) : tokens.error ? (
          <span className="text-xs text-muted-foreground">{coreErrorMessage(tokens.error)}</span>
        ) : held ? (
          <Chip tone="success">
            <CircleCheck /> Holds a DNS token
            {held.lastUsedAtUnixMs
              ? `, last used ${relative(held.lastUsedAtUnixMs, Date.now())}`
              : ', not used yet'}
          </Chip>
        ) : (
          <Chip>No DNS token for {zone.name}</Chip>
        )}
      </div>
      {held?.lastError && <p className="text-xs text-warning">{held.lastError}</p>}
      {tokens.isSuccess && (
        <div className="flex flex-wrap gap-1.5">
          <Button
            size="sm"
            variant={held ? 'soft' : 'default'}
            disabled={busy !== null}
            onClick={() =>
              void run(
                'mint',
                () =>
                  window.runova.cloudflareServer.provisionDnsToken({
                    serverId: server.id,
                    zoneId: zone.id,
                    mode: 'mint',
                  }),
                `${server.nickname} has a DNS token for ${zone.name}.`,
              )
            }
          >
            {busy === 'mint' ? (
              <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" />
            ) : (
              <Key className="h-3.5 w-3.5" />
            )}
            {held ? 'Make a new token' : 'Make a DNS token'}
          </Button>
          <Button
            size="sm"
            variant="soft"
            disabled={busy !== null}
            onClick={() => setPasting((open) => !open)}
          >
            Paste a token
          </Button>
          {held && (
            <Button
              size="sm"
              variant="danger"
              disabled={busy !== null}
              onClick={() => void remove()}
            >
              <Trash2 className="h-3.5 w-3.5" /> Remove
            </Button>
          )}
        </div>
      )}
      {pasting && (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void run(
              'paste',
              () =>
                window.runova.cloudflareServer.provisionDnsToken({
                  serverId: server.id,
                  zoneId: zone.id,
                  mode: 'paste',
                  token,
                }),
              `${server.nickname} has a DNS token for ${zone.name}.`,
            );
          }}
        >
          <div className="min-w-0 flex-1 space-y-1">
            <Label htmlFor={`${id}-token`}>DNS token for {zone.name}</Label>
            <Input
              id={`${id}-token`}
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={token}
              onChange={(event) => setToken(event.target.value)}
              placeholder="A token with Zone > DNS > Edit on this zone only"
            />
          </div>
          <Button type="submit" size="sm" disabled={busy !== null || token.trim().length === 0}>
            {busy === 'paste' && <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" />}
            Check and send
          </Button>
        </form>
      )}
      <GuidedFix
        error={error}
        alternative={
          cannotMint ? (
            <p className="text-xs text-muted-foreground">
              Or make a token yourself on Cloudflare with only Zone &gt; DNS &gt; Edit on{' '}
              {zone.name}, and paste it here with Paste a token.
            </p>
          ) : undefined
        }
      />
    </li>
  );
}

export function DnsTokensCard({ zone }: { zone: CloudflareZone }): React.JSX.Element {
  const servers = useQuery({
    queryKey: queryKeys.deployServers,
    queryFn: () => window.runova.deploy.listServers(),
  });
  const withCore = (servers.data ?? []).filter((server) => server.core);
  return (
    <CloudflareCard
      icon={<Key />}
      title="DNS tokens on your servers"
      description={`A server with a DNS token for ${zone.name} can get wildcard certificates and certificates for names behind the proxy (DNS-01). Each token edits this zone's DNS and nothing else.`}
    >
      {servers.isPending ? (
        <div className={cn(FOOTER_HAIRLINE, 'space-y-2 px-4 py-3')} aria-busy="true">
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-7 w-56 rounded-full" />
        </div>
      ) : withCore.length === 0 ? (
        <CardBody>
          <EmptyState
            size="sm"
            icon={Server}
            title="No server core yet"
            description="Install the server core on a server in Deploy first."
          />
        </CardBody>
      ) : (
        <ul aria-label="Servers" className={cn(FOOTER_HAIRLINE, 'settings-rows')}>
          {withCore.map((server) => (
            <ServerRow key={server.id} server={server} zone={zone} />
          ))}
        </ul>
      )}
    </CloudflareCard>
  );
}
