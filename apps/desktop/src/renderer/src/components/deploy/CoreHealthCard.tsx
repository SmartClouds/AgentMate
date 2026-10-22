import type { DeployCoreRecord, DeployServer } from '@shared/deployTypes';
import { sshErrorMessage } from '@shared/sshErrors';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { EllipsisVertical, RefreshCw, Rocket, Trash2 } from '@/components/icons';
import { Chip } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { formatUptime } from '@/lib/deploy/setup';
import { queryKeys } from '@/lib/queryKeys';
import { withHostKeyTrust } from '@/lib/ssh/hostKeyTrust';
import { shortAge, timeAgo } from '@/lib/time';
import { cn } from '@/lib/utils';
import { TRANSPORT_PHRASE, TRANSPORT_TEXT, useCoreHealth } from './coreHealth';
import { DeployCard } from './deployKit';
import { SetupFailure } from './SetupFailure';

function Fact({
  label,
  children,
  mono,
}: {
  label: string;
  children: React.ReactNode;
  mono?: boolean;
}): React.JSX.Element {
  return (
    <div className="min-w-0 rounded-xl bg-foreground/[0.03] px-3 py-2.5 ring-1 ring-inset ring-foreground/[0.07]">
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd
        className={cn('mt-0.5 truncate text-sm font-medium text-foreground', mono && 'font-mono')}
      >
        {children}
      </dd>
    </div>
  );
}

/** Re-renders every so often so "up for" and "checked" stay true between checks. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** A live look at a server's core: whether it answers, its version and how long it has run. */
export function CoreHealthCard({
  server,
  core,
  onReinstall,
  onRemove,
}: {
  server: DeployServer;
  core: DeployCoreRecord;
  onReinstall?: () => void;
  onRemove?: (keepData: boolean) => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const health = useCoreHealth(server);
  const now = useNow(15_000);
  const [checking, setChecking] = useState(false);

  async function checkNow(): Promise<void> {
    setChecking(true);
    try {
      await queryClient.fetchQuery({
        queryKey: queryKeys.deployHealth(server.id),
        queryFn: () => withHostKeyTrust(server.id, () => window.agentmat.deploy.health(server.id)),
        staleTime: 0,
      });
    } catch {
      // The card shows the failure from the query itself.
    } finally {
      setChecking(false);
    }
  }

  const answering = health.isSuccess && !health.isError;
  // The check goes through direct TLS when it answers, so it says which way the core is reached.
  const transport = health.data?.transport ?? core.transport;
  const status = health.isError ? (
    <Chip tone="warning">Not answering</Chip>
  ) : answering ? (
    <Chip tone="success" dot pulse>
      Online
    </Chip>
  ) : (
    <Chip>Connecting…</Chip>
  );

  return (
    <DeployCard
      icon={<Rocket />}
      title="Server core"
      extra={status}
      description={
        health.isError
          ? 'The last check did not get an answer.'
          : health.data
            ? `Answering through ${TRANSPORT_PHRASE[transport]}, checked ${shortAge(health.data.checkedAt, now)} ago.`
            : 'Checking whether the core answers.'
      }
      actions={
        <>
          <SimpleTooltip label="Check now">
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Check now"
              disabled={checking}
              onClick={() => void checkNow()}
            >
              <RefreshCw className={cn(checking && 'motion-safe:animate-spin')} />
            </Button>
          </SimpleTooltip>
          {(onReinstall || onRemove) && (
            <DropdownMenu>
              <SimpleTooltip label="More actions">
                <DropdownMenuTrigger asChild>
                  <Button size="icon-sm" variant="ghost" aria-label="More actions">
                    <EllipsisVertical />
                  </Button>
                </DropdownMenuTrigger>
              </SimpleTooltip>
              <DropdownMenuContent align="end">
                {onReinstall && (
                  <DropdownMenuItem onSelect={onReinstall}>
                    <Rocket className="h-3.5 w-3.5" /> Update or reinstall
                  </DropdownMenuItem>
                )}
                {onRemove && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={() => onRemove(true)}>
                      <Trash2 className="h-3.5 w-3.5" /> Remove the core, keep its data
                    </DropdownMenuItem>
                    <DropdownMenuItem tone="danger" onSelect={() => onRemove(false)}>
                      <Trash2 className="h-3.5 w-3.5" /> Remove the core and its data
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </>
      }
      bodyClassName="space-y-3"
    >
      {health.isError && (
        <div className="space-y-2">
          <SetupFailure message={sshErrorMessage(health.error)} />
          <p className="text-xs text-muted-foreground">
            If the server just restarted, the core starts with it and answers again shortly.
          </p>
        </div>
      )}
      <dl className="grid grid-cols-2 gap-2 md:grid-cols-3">
        <Fact label="Version" mono>
          {health.data ? (
            health.data.version
          ) : health.isPending ? (
            <Skeleton className="h-5 w-16" />
          ) : (
            core.version
          )}
        </Fact>
        <Fact label="Up for">
          {health.data ? (
            formatUptime(health.data.startedAtUnixMs, now)
          ) : health.isPending ? (
            <Skeleton className="h-5 w-20" />
          ) : (
            'Unknown'
          )}
        </Fact>
        <Fact label="Installed">
          {server.dev ? 'From your checkout' : timeAgo(new Date(core.installedAt).toISOString())}
        </Fact>
        <Fact label="Operating system">{core.os}</Fact>
        <Fact label="Processor" mono>
          {core.architecture}
        </Fact>
        <Fact label="Connection">{TRANSPORT_TEXT[transport]}</Fact>
      </dl>
    </DeployCard>
  );
}
