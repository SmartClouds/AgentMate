import { CLI_REGISTRY, type CliDefinition } from '@runova/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { CliArgsField } from '@/components/CliArgsField';
import { CliLogo } from '@/components/cliLogos';
import {
  Check,
  CloudDownload,
  ExternalLink,
  RefreshCw,
  Search,
  TerminalSquare,
} from '@/components/icons';
import {
  Chip,
  EmptyState,
  GLASS_CARD,
  NoMatches,
  SearchPill,
  TOOLBAR,
  UpdateSummary,
} from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { openCliInTerminal } from '@/lib/openCli';
import { openCommandTerminal } from '@/lib/openCommandTerminal';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { useCliStore } from '@/stores/cliStore';
import { usePageHeader } from '@/stores/pageHeaderStore';

interface PendingUpdate {
  cli: CliDefinition;
  currentVersion: string | null;
  latestVersion: string;
  command: string;
}

export default function CliManagerPage(): React.JSX.Element {
  const queryClient = useQueryClient();
  const defaultCliId = useCliStore((s) => s.defaultCliId);
  const setDefaultCliId = useCliStore((s) => s.setDefaultCliId);
  const [showAll, setShowAll] = useState(false);
  const [checkingCliId, setCheckingCliId] = useState<string | null>(null);
  const [checkingAll, setCheckingAll] = useState(false);
  const [pendingUpdate, setPendingUpdate] = useState<PendingUpdate | null>(null);
  const [, setUpdateQueue] = useState<PendingUpdate[]>([]);

  const cliQuery = useQuery({
    queryKey: queryKeys.cliStatus,
    queryFn: () => window.runova.cli.detectAll(),
  });

  const [query, setQuery] = useState('');

  const shownClis = showAll
    ? CLI_REGISTRY
    : CLI_REGISTRY.filter((cli) => cliQuery.data?.find((c) => c.id === cli.id)?.installed);
  const needle = query.trim().toLowerCase();
  const visibleClis = needle
    ? shownClis.filter(
        (cli) =>
          cli.name.toLowerCase().includes(needle) || cli.description.toLowerCase().includes(needle),
      )
    : shownClis;
  const notInstalledCount =
    CLI_REGISTRY.length - (cliQuery.data?.filter((c) => c.installed).length ?? 0);

  async function handleInstall(cliId: string, cliName: string): Promise<void> {
    const command = await window.runova.cli.getInstallCommand(cliId);
    if (!command) {
      toast.error(`No install command available for ${cliName} on this OS.`);
      return;
    }
    await openCommandTerminal({ command, name: cliName, verb: 'install' });
  }

  async function handleCheckForUpdate(
    cli: CliDefinition,
    currentVersion: string | null,
  ): Promise<void> {
    setCheckingCliId(cli.id);
    try {
      const result = await window.runova.cli.checkForUpdate(cli.id, currentVersion);
      if (!result.supported) {
        toast.info(`Can't check updates for ${cli.name} automatically.`);
        return;
      }
      if (!result.latestVersion) {
        toast.error(`Couldn't reach the update server for ${cli.name}.`);
        return;
      }
      if (!result.updateAvailable) {
        toast.success(`${cli.name} is up to date (v${result.latestVersion}).`);
        return;
      }

      const command = await window.runova.cli.getUpdateCommand(cli.id);
      if (!command) {
        toast.error(`No update command available for ${cli.name} on this OS.`);
        return;
      }
      setPendingUpdate({ cli, currentVersion, latestVersion: result.latestVersion, command });
    } finally {
      setCheckingCliId(null);
    }
  }

  async function handleConfirmUpdate(): Promise<void> {
    if (!pendingUpdate) return;
    const { cli, command } = pendingUpdate;
    dismissPendingUpdate();
    await openCommandTerminal({ command, name: cli.name, verb: 'update' });
  }

  function dismissPendingUpdate(): void {
    setUpdateQueue((queue) => {
      const [next, ...rest] = queue;
      setPendingUpdate(next ?? null);
      return rest;
    });
  }

  async function handleCheckAllForUpdates(): Promise<void> {
    const installedClis = CLI_REGISTRY.filter(
      (cli) => cliQuery.data?.find((c) => c.id === cli.id)?.installed,
    );
    if (installedClis.length === 0) {
      toast.info('No installed CLIs to check.');
      return;
    }

    setCheckingAll(true);
    try {
      const updates: PendingUpdate[] = [];
      let uncheckable = 0;

      for (const cli of installedClis) {
        const currentVersion = cliQuery.data?.find((c) => c.id === cli.id)?.version ?? null;
        const result = await window.runova.cli.checkForUpdate(cli.id, currentVersion);
        if (!result.supported || !result.latestVersion) {
          uncheckable += 1;
          continue;
        }
        if (result.updateAvailable) {
          const command = await window.runova.cli.getUpdateCommand(cli.id);
          if (command) {
            updates.push({ cli, currentVersion, latestVersion: result.latestVersion, command });
          }
        }
      }

      if (updates.length === 0) {
        toast.success(
          uncheckable > 0
            ? `All checkable CLIs are up to date (${uncheckable} could not be checked).`
            : 'All CLIs are up to date.',
        );
        return;
      }

      toast.info(`${updates.length} CLI update${updates.length > 1 ? 's' : ''} available.`);
      const [first, ...rest] = updates;
      setPendingUpdate(first);
      setUpdateQueue(rest);
    } finally {
      setCheckingAll(false);
    }
  }

  usePageHeader(
    'AI CLI Manager',
    'Detected AI coding CLIs on this machine. Install missing ones with one click.',
  );

  return (
    <div className="flex flex-col gap-2 p-2">
      <div className={TOOLBAR}>
        <SearchPill
          type="search"
          value={query}
          onValueChange={setQuery}
          clearLabel="Clear filter"
          label="Filter CLIs"
          placeholder="Filter CLIs"
          className="w-full sm:w-60"
        />
        {notInstalledCount > 0 && (
          <Button
            variant="soft"
            className={cn(showAll && 'text-primary hover:text-primary')}
            onClick={() => setShowAll((v) => !v)}
          >
            {showAll ? 'Hide not installed' : `Show all CLIs (${notInstalledCount} not installed)`}
          </Button>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="soft"
            disabled={checkingAll}
            onClick={() => void handleCheckAllForUpdates()}
          >
            <CloudDownload className={checkingAll ? 'animate-pulse' : undefined} />
            {checkingAll ? 'Checking updates…' : 'Check all for updates'}
          </Button>
          <Button
            variant="soft"
            onClick={() => {
              toast.info('Re-scanning installed CLIs…');
              // `true` skips the main process's detection cache, which is what
              // makes this button different from a plain query invalidation.
              void window.runova.cli
                .detectAll(true)
                .then((fresh) => queryClient.setQueryData(queryKeys.cliStatus, fresh));
            }}
          >
            <RefreshCw /> Refresh
          </Button>
        </div>
      </div>

      {/* Until the scan lands nothing is known to be installed, which is not
          the same as nothing being installed. */}
      {!cliQuery.isPending && shownClis.length === 0 ? (
        <div className={GLASS_CARD}>
          <EmptyState
            icon={TerminalSquare}
            title="No AI CLIs installed yet"
            description='Click "Show all CLIs" above to discover and install one.'
            action={
              <Button onClick={() => setShowAll(true)}>
                <Search /> Browse the catalogue
              </Button>
            }
          />
        </div>
      ) : !cliQuery.isPending && visibleClis.length === 0 ? (
        <div className={GLASS_CARD}>
          <NoMatches query={query} />
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
          {cliQuery.isPending &&
            Array.from({ length: 6 }, (_, i) => <CliCardSkeleton key={`skeleton-${i}`} />)}
          {visibleClis.map((cli) => {
            const status = cliQuery.data?.find((c) => c.id === cli.id);
            const isDefault = defaultCliId === cli.id;
            const title = <h3 className="truncate text-sm font-semibold">{cli.name}</h3>;

            return (
              <div
                key={cli.id}
                className={cn(GLASS_CARD, 'flex flex-col', isDefault && 'ring-1 ring-primary/35')}
              >
                <div className="flex items-start gap-3 p-4 pb-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-foreground/[0.05] ring-1 ring-inset ring-foreground/[0.06]">
                    <CliLogo cliId={cli.id} className="h-5 w-5" />
                  </span>
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex min-h-5 items-center gap-2">
                      {status?.installed ? (
                        <SimpleTooltip label={`Open ${cli.name} in the terminal`}>
                          <button
                            type="button"
                            className="min-w-0 cursor-pointer rounded-sm text-left transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            onClick={() => openCliInTerminal({ cliId: cli.id })}
                          >
                            {title}
                          </button>
                        </SimpleTooltip>
                      ) : (
                        title
                      )}
                      <Chip className="ml-auto" tone={status?.installed ? 'success' : 'neutral'}>
                        {status?.installed ? (status.version ?? 'Installed') : 'Not installed'}
                      </Chip>
                    </div>
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      {cli.description}
                    </p>
                  </div>
                </div>

                <div className="mt-auto flex flex-wrap items-center gap-1.5 px-4 pb-4">
                  {status?.installed ? (
                    <>
                      <Button
                        variant={isDefault ? 'tint' : 'soft'}
                        size="sm"
                        onClick={() => setDefaultCliId(isDefault ? null : cli.id)}
                      >
                        {isDefault && <Check />}
                        {isDefault ? 'Default CLI' : 'Set as default'}
                      </Button>
                      <SimpleTooltip label="Check for updates">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          disabled={checkingCliId === cli.id}
                          onClick={() => void handleCheckForUpdate(cli, status.version)}
                        >
                          <CloudDownload
                            className={checkingCliId === cli.id ? 'animate-pulse' : undefined}
                          />
                        </Button>
                      </SimpleTooltip>
                    </>
                  ) : (
                    <Button size="sm" onClick={() => void handleInstall(cli.id, cli.name)}>
                      <TerminalSquare /> Install
                    </Button>
                  )}
                  {cli.homepageUrl && (
                    <SimpleTooltip label="Open homepage">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => void window.runova.shell.openExternal(cli.homepageUrl!)}
                      >
                        <ExternalLink />
                      </Button>
                    </SimpleTooltip>
                  )}
                </div>

                {/* The flags sit under a hairline, as the card's own settings row. */}
                {status?.installed && (
                  <div className="px-4 pb-4 pt-3 shadow-[inset_0_1px_0_hsl(var(--foreground)/0.08)]">
                    <CliArgsField cliId={cli.id} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <Dialog
        open={pendingUpdate !== null}
        onOpenChange={(open) => !open && dismissPendingUpdate()}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Update {pendingUpdate?.cli.name}?</DialogTitle>
            <DialogDescription>
              This opens a terminal session and runs the update command below.
            </DialogDescription>
          </DialogHeader>
          <UpdateSummary
            currentVersion={pendingUpdate?.currentVersion ?? null}
            latestVersion={pendingUpdate?.latestVersion ?? ''}
            command={pendingUpdate?.command ?? ''}
          />
          <DialogFooter>
            <Button variant="soft" onClick={dismissPendingUpdate}>
              Cancel
            </Button>
            <Button onClick={() => void handleConfirmUpdate()}>Update</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Stands in for one CLI card while the scan runs, in the same shape as the real one. */
function CliCardSkeleton(): React.JSX.Element {
  return (
    <div className={cn(GLASS_CARD, 'flex flex-col gap-3 p-4')}>
      <div className="flex items-start gap-3">
        <Skeleton className="h-9 w-9 shrink-0 rounded-lg" />
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-5 w-16 rounded-full" />
          </div>
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-4/5" />
        </div>
      </div>
      <div className="flex gap-1.5">
        <Skeleton className="h-7 w-24 rounded-full" />
        <Skeleton className="h-7 w-7 rounded-lg" />
      </div>
    </div>
  );
}
