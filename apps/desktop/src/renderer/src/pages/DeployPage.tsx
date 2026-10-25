import type { AppSettings } from '@agentmat/core';
import type { DeployServer } from '@shared/deployTypes';
import { sshErrorMessage } from '@shared/sshErrors';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { CloudflareDialog } from '@/components/cloudflare/CloudflareDialog';
import { CloudflareMark } from '@/components/cloudflare/CloudflareMark';
import { AppStorePanel } from '@/components/deploy/appStore/AppStorePanel';
import { AppsPanel } from '@/components/deploy/apps/AppsPanel';
import { AssistantLauncher } from '@/components/deploy/assistant/AssistantLauncher';
import { BackupsPanel } from '@/components/deploy/backups/BackupsPanel';
import { ChooseServersDialog } from '@/components/deploy/ChooseServersDialog';
import { CoreUpdatePanel } from '@/components/deploy/CoreUpdatePanel';
import { ContainersPanel } from '@/components/deploy/containers/ContainersPanel';
import { Notice } from '@/components/deploy/deployKit';
import { FileSiteView, fileSectionFromView } from '@/components/deploy/files/FileSiteView';
import { useFileSiteListUpdate, useFileSites } from '@/components/deploy/files/hooks';
import { filesProblem } from '@/components/deploy/files/messages';
import { SiteFormDialog } from '@/components/deploy/files/SiteFormDialog';
import { FirewallPanel } from '@/components/deploy/firewall/FirewallPanel';
import { InstallPanel } from '@/components/deploy/InstallPanel';
import { LogsPanel } from '@/components/deploy/logs/LogsPanel';
import { NotificationsPanel } from '@/components/deploy/notifications/NotificationsPanel';
import { ConnectionBadge } from '@/components/deploy/overview/ConnectionBadge';
import { useConnectionUpdates } from '@/components/deploy/overview/hooks';
import { OverviewPanel } from '@/components/deploy/overview/OverviewPanel';
import { RemovalPanel } from '@/components/deploy/RemovalPanel';
import { ServerRail } from '@/components/deploy/ServerRail';
import { ServerSections, sectionFromView } from '@/components/deploy/ServerSections';
import { SetupFailure } from '@/components/deploy/SetupFailure';
import { SecurityPanel } from '@/components/deploy/security/SecurityPanel';
import { ServerFilesPanel } from '@/components/deploy/serverFiles/ServerFilesPanel';
import { SitesPanel } from '@/components/deploy/sites/SitesPanel';
import { ConnectorDownloadCard } from '@/components/deploy/wordpress/ConnectorDownloadCard';
import { useSiteListUpdate, useWordPressSites } from '@/components/deploy/wordpress/hooks';
import { wpProblem } from '@/components/deploy/wordpress/messages';
import { siteSectionFromView } from '@/components/deploy/wordpress/SiteSections';
import { SiteView } from '@/components/deploy/wordpress/SiteView';
import { CloudUpload, Lock, RefreshCw, Server, Sliders } from '@/components/icons';
import { Chip, EmptyState, GLASS_CARD, GLASS_PANEL } from '@/components/pageKit';
import { SshVaultUnlockDialog } from '@/components/remote/SshVaultUnlockDialog';
import { Button } from '@/components/ui/button';
import { ResizeHandle } from '@/components/ui/ResizeHandle';
import { Skeleton } from '@/components/ui/skeleton';
import { ConnectSiteDialog } from '@/components/wordpress/ConnectSiteDialog';
import { WordPressMark } from '@/components/wordpress/WordPressMark';
import { resolveSelection, waitForRail } from '@/lib/deploy/railSelection';
import { chosenServers } from '@/lib/deploy/railServers';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { confirmDialog } from '@/stores/confirmStore';
import { useDeploySetupStore } from '@/stores/deploySetupStore';
import { usePageHeader } from '@/stores/pageHeaderStore';
import { PANEL_WIDTHS, usePanelWidth } from '@/stores/panelWidthStore';

/**
 * The page's frame, in the API Client's shape: from lg up the rail is a glass card on the left
 * with a quiet resize handle in the gap, and the rail and the content scroll on their own. Below
 * lg there is no room for a column, so the rail sits on top and the page scrolls as one.
 */
function DeployLayout({
  rail,
  contentClassName,
  children,
}: {
  rail: React.ReactNode;
  contentClassName?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  const [width, setWidth] = usePanelWidth('deployRail');
  return (
    <div className="flex flex-1 flex-col gap-2 p-2 lg:min-h-0 lg:flex-row lg:gap-0 lg:overflow-hidden">
      <div
        style={{ '--deploy-rail': `${width}px` } as React.CSSProperties}
        // The cap keeps a wide saved width from squeezing the content on a narrow window.
        className={cn(GLASS_PANEL, 'shrink-0 lg:w-[var(--deploy-rail)] lg:max-w-[36%]')}
      >
        <div className="rail-scroll p-2 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">{rail}</div>
      </div>
      <ResizeHandle
        orientation="vertical"
        label="Resize servers"
        size={width}
        min={PANEL_WIDTHS.deployRail.min}
        max={PANEL_WIDTHS.deployRail.max}
        defaultSize={PANEL_WIDTHS.deployRail.default}
        onSizeChange={setWidth}
        quiet
        className="hidden w-2 lg:flex"
      />
      <div
        className={cn(
          'rail-scroll flex min-w-0 flex-1 flex-col gap-2 lg:min-h-0 lg:overflow-y-auto',
          contentClassName,
        )}
      >
        {children}
      </div>
    </div>
  );
}

/** The page while the servers load: each card shimmers in its own spot. */
function DeployPageSkeleton(): React.JSX.Element {
  return (
    <div className="flex flex-1 flex-col gap-2 p-2 lg:flex-row" aria-busy="true">
      <div className={cn(GLASS_CARD, 'space-y-1.5 p-3 lg:w-64 lg:shrink-0')}>
        <Skeleton className="mb-3 h-3 w-16" />
        {Array.from({ length: 3 }, (_, index) => (
          <Skeleton key={index} className="h-11 w-full rounded-lg" />
        ))}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className={cn(GLASS_CARD, 'flex items-center gap-3 px-4 py-3')}>
          <Skeleton className="h-10 w-10 rounded-xl" />
          <div className="space-y-1.5">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-56" />
          </div>
        </div>
        <Skeleton className="h-8 w-96 max-w-full rounded-full" />
        <div className={cn(GLASS_CARD, 'space-y-3 p-4')}>
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-40 w-full rounded-lg" />
        </div>
      </div>
    </div>
  );
}

/** A failure that leaves nothing else to show, with the way to try again. */
function PageFailure({
  message,
  onRetry,
  children,
}: {
  message: string;
  onRetry: () => void;
  children?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex flex-1 flex-col gap-2 p-2">
      <div className={cn(GLASS_CARD, 'space-y-3 p-4')}>
        <SetupFailure message={message} />
        <Button size="sm" variant="soft" onClick={onRetry}>
          <RefreshCw /> Try again
        </Button>
      </div>
      {children}
    </div>
  );
}

/** The Servers vault holds the cores' keys and the WordPress sites' keys alike. */
function VaultLockedBanner({
  onUnlock,
  children,
}: {
  onUnlock: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Notice tone="warning" icon={Lock} className="shrink-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <p className="min-w-0 flex-1">{children}</p>
        <Button size="sm" onClick={onUnlock}>
          Unlock
        </Button>
      </div>
    </Notice>
  );
}

function ServerHeader({ server }: { server: DeployServer }): React.JSX.Element {
  return (
    <div className={cn(GLASS_CARD, 'flex shrink-0 flex-wrap items-center gap-3 px-4 py-3')}>
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/12 text-primary shadow-[0_0_28px_-12px_hsl(var(--primary)/0.7)]">
        <Server className="h-5 w-5" />
      </div>
      <div className="min-w-0">
        <h2 className="truncate text-base font-semibold leading-tight tracking-tight text-foreground">
          {server.nickname}
        </h2>
        <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
          {server.username}@{server.host}:{server.port}
        </p>
      </div>
      {server.dev && <Chip tone="warning">Development</Chip>}
      {server.core && (
        <span className="ml-auto">
          <ConnectionBadge serverId={server.id} />
        </span>
      )}
    </div>
  );
}

/**
 * Turns finished installs, updates and removals into a fresh server list and a message, once
 * each, even when they finished while the page was closed.
 */
function useFinishedRuns(onFinished: (serverId: string) => void): void {
  const runs = useDeploySetupStore((state) => state.runs);
  const clear = useDeploySetupStore((state) => state.clear);
  const queryClient = useQueryClient();
  const handling = useRef(new Set<string>());
  const finished = useRef(onFinished);
  finished.current = onFinished;

  useEffect(() => {
    for (const [serverId, run] of Object.entries(runs)) {
      if (run.status !== 'done' || handling.current.has(serverId)) continue;
      handling.current.add(serverId);
      const servers = queryClient.getQueryData<DeployServer[]>(queryKeys.deployServers) ?? [];
      const name = servers.find((server) => server.id === serverId)?.nickname ?? 'the server';
      const version =
        run.result?.version ?? (run.update?.outcome === 'updated' ? run.update.version : null);
      toast.success(
        run.kind === 'uninstall'
          ? `Removed the server core from ${name}.`
          : version
            ? `Server core ${version} is running on ${name}.`
            : `The server core is running on ${name}.`,
      );
      if (run.result?.enrollmentError) {
        toast.warning(
          `Your access to ${name} is not set up yet: ${run.result.enrollmentError} Set it up from the server card.`,
        );
      }
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.deployServers }),
        queryClient.invalidateQueries({ queryKey: queryKeys.deployHealth(serverId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.deployAccess(serverId) }),
      ]).finally(() => {
        handling.current.delete(serverId);
        clear(serverId);
        queryClient.removeQueries({ queryKey: queryKeys.deployPreflight(serverId) });
        finished.current(serverId);
      });
    }
  }, [runs, clear, queryClient]);
}

/** Stands in while the settings have not said which servers were chosen. */
const NO_SERVERS: string[] = [];

export default function DeployPage(): React.JSX.Element {
  usePageHeader(
    'Deploy',
    'Install the server core on your servers, keep an eye on them, and upload sites over SFTP or FTP.',
  );
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  // The SSH installer, for an update or reinstall; and the update through the core itself.
  const [updating, setUpdating] = useState<string | null>(null);
  const [coreUpdating, setCoreUpdating] = useState<string | null>(null);
  const [unlockOpen, setUnlockOpen] = useState(false);
  const queryClient = useQueryClient();
  const runs = useDeploySetupStore((state) => state.runs);
  const uninstall = useDeploySetupStore((state) => state.uninstall);

  const serversQuery = useQuery({
    queryKey: queryKeys.deployServers,
    queryFn: () => window.agentmat.deploy.listServers(),
  });
  // Every saved server can be deployed to, but the page lists only the ones the user chose.
  const settingsQuery = useQuery({
    queryKey: queryKeys.settings,
    queryFn: () => window.agentmat.settings.get(),
    meta: { silentLoading: true },
  });
  const chosenIds = settingsQuery.data?.deployServerIds ?? NO_SERVERS;
  // Memoized: the rail keeps the order a drag leaves it in until this list changes.
  const servers = useMemo(
    () => chosenServers(serversQuery.data ?? [], chosenIds),
    [serversQuery.data, chosenIds],
  );
  const [chooseOpen, setChooseOpen] = useState(false);
  const saveChoice = useMutation({
    mutationFn: (ids: string[]) => window.agentmat.settings.update({ deployServerIds: ids }),
    meta: { silentLoading: true },
    onError: (error) => {
      toast.error(`Could not save the list of servers: ${sshErrorMessage(error)}`);
      // The rail shows the choice that failed to save, so read the saved one back.
      void queryClient.invalidateQueries({ queryKey: queryKeys.settings });
    },
  });
  /** The rail shows a new choice or order at once; saving it goes on in the background. */
  function chooseServers(ids: string[]): void {
    queryClient.setQueryData<AppSettings>(queryKeys.settings, (current) =>
      current ? { ...current, deployServerIds: ids } : current,
    );
    saveChoice.mutate(ids);
  }
  const vaultQuery = useQuery({
    queryKey: queryKeys.sshVaultStatus,
    queryFn: () => window.agentmat.ssh.vaultStatus(),
  });
  const sitesQuery = useWordPressSites();
  const updateSiteList = useSiteListUpdate();
  const [connectOpen, setConnectOpen] = useState(false);
  const fileSitesQuery = useFileSites();
  const updateFileSiteList = useFileSiteListUpdate();
  // The add and edit dialog for FTP and SFTP sites: adding when `siteId` is null.
  const [fileForm, setFileForm] = useState<{ open: boolean; siteId: string | null }>({
    open: false,
    siteId: null,
  });
  useConnectionUpdates();
  useFinishedRuns((serverId) => {
    setUpdating((current) => (current === serverId ? null : current));
    setCoreUpdating((current) => (current === serverId ? null : current));
  });
  // The Cloudflare dialog lives in the address. A link out of Deploy (point a domain, then add its
  // website) takes the dialog away with the rest of it, and closing it keeps the server selected.
  const cloudflareOpen = params.get('dialog') === 'cloudflare';
  function setCloudflareOpen(open: boolean): void {
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        if (open) next.set('dialog', 'cloudflare');
        else next.delete('dialog');
        return next;
      },
      { replace: true },
    );
  }

  // The servers and which of them were chosen both have to be in before the rail can list any. A
  // site asked for by the address, or no servers to fall back on: wait for the sites rather
  // than flash a server (and start its health checks) or an empty state.
  if (
    serversQuery.isPending ||
    settingsQuery.isPending ||
    waitForRail(
      params,
      {
        servers: serversQuery.isPending,
        wpSites: sitesQuery.isPending,
        fileSites: fileSitesQuery.isPending,
      },
      { servers: servers.length, wpSites: sitesQuery.data?.length ?? 0 },
    )
  ) {
    return <DeployPageSkeleton />;
  }

  if (serversQuery.isError || settingsQuery.isError) {
    return (
      <PageFailure
        message={sshErrorMessage(serversQuery.isError ? serversQuery.error : settingsQuery.error)}
        // Both are needed to list anything, so trying again asks again for whichever failed.
        onRetry={() => {
          if (serversQuery.isError) void serversQuery.refetch();
          if (settingsQuery.isError) void settingsQuery.refetch();
        }}
      />
    );
  }

  const saved = serversQuery.data;
  const sites = sitesQuery.data ?? [];
  const fileSites = fileSitesQuery.data ?? [];
  const fileFormSite = fileForm.siteId
    ? (fileSites.find((site) => site.id === fileForm.siteId) ?? null)
    : null;
  const fileFormDialog = (
    <SiteFormDialog
      open={fileForm.open}
      onOpenChange={(open) => setFileForm((current) => ({ ...current, open }))}
      site={fileFormSite}
      onSaved={(site) => {
        updateFileSiteList(site);
        // A new site opens; an edited one stays where it was.
        if (!fileForm.siteId) setParams({ files: site.id }, { replace: true });
      }}
    />
  );
  const openAddFileSite = () => setFileForm({ open: true, siteId: null });
  const connectDialog = (
    <ConnectSiteDialog
      open={connectOpen}
      onOpenChange={setConnectOpen}
      onConnected={(site) => {
        updateSiteList(site);
        setParams({ site: site.id }, { replace: true });
      }}
    />
  );
  const unlockDialog = (
    <SshVaultUnlockDialog
      open={unlockOpen}
      onOpenChange={setUnlockOpen}
      mode="unlock"
      onUnlocked={() => {
        void queryClient.invalidateQueries({ queryKey: queryKeys.sshVaultStatus });
        void queryClient.invalidateQueries({ queryKey: ['deploy'] });
      }}
    />
  );
  const cloudflareDialog = (
    <CloudflareDialog open={cloudflareOpen} onOpenChange={setCloudflareOpen} />
  );
  const chooseDialog = (
    <ChooseServersDialog
      open={chooseOpen}
      onOpenChange={setChooseOpen}
      servers={saved}
      chosenIds={chosenIds}
      onSave={chooseServers}
    />
  );

  // A failure only stands in for the page when there is no server to pick either. With saved
  // servers still to choose from, the empty state below is the more useful way out.
  const noneSaved = saved.length === 0;
  if (noneSaved && sitesQuery.isError && fileSites.length === 0) {
    return (
      <PageFailure message={wpProblem(sitesQuery.error)} onRetry={() => void sitesQuery.refetch()}>
        {unlockDialog}
      </PageFailure>
    );
  }

  if (noneSaved && sites.length === 0 && fileSitesQuery.isError) {
    return (
      <PageFailure
        message={filesProblem(fileSitesQuery.error)}
        onRetry={() => void fileSitesQuery.refetch()}
      >
        {unlockDialog}
      </PageFailure>
    );
  }

  if (servers.length === 0 && sites.length === 0 && fileSites.length === 0) {
    return (
      <div className="flex flex-1 flex-col gap-2 p-2">
        <EmptyState
          card
          size="lg"
          icon={Server}
          title={noneSaved ? 'No servers yet' : 'No servers chosen yet'}
          description={
            noneSaved
              ? 'Deploy works with the servers you save in Remote, with WordPress sites that run the AgentMate Connector plugin, and with any host that offers FTP or SFTP. Add a server in Remote, or connect a site.'
              : `Deploy lists only the servers you choose. You have ${saved.length} saved server${saved.length === 1 ? '' : 's'}. Pick the ones to deploy to, or connect a site.`
          }
          action={
            <div className="flex flex-wrap justify-center gap-2">
              {noneSaved ? (
                <Button onClick={() => navigate('/remote')}>
                  <Server /> Open Remote
                </Button>
              ) : (
                <Button onClick={() => setChooseOpen(true)}>
                  <Sliders /> Choose servers to show
                </Button>
              )}
              <Button variant="soft" onClick={() => setConnectOpen(true)}>
                <WordPressMark className="h-3.5 w-3.5" /> Connect a WordPress site
              </Button>
              <Button variant="soft" onClick={openAddFileSite}>
                <CloudUpload className="h-3.5 w-3.5" /> Add an FTP or SFTP site
              </Button>
              <Button variant="soft" onClick={() => setCloudflareOpen(true)}>
                <CloudflareMark className="h-3.5 w-3.5" /> Manage Cloudflare
              </Button>
            </div>
          }
        />
        <ConnectorDownloadCard />
        {connectDialog}
        {cloudflareDialog}
        {fileFormDialog}
        {chooseDialog}
      </div>
    );
  }

  const locked = vaultQuery.data?.hasPasskey === true && !vaultQuery.data.unlocked;
  const selection = resolveSelection(params, servers, sites, fileSites);
  /**
   * With no server in the address the page shows the first one in the rail, so a drag that moves
   * that server would switch the page to another. Pinning the one on screen keeps it where it is.
   */
  function reorderServers(ids: string[]): void {
    if (selection.kind === 'server' && params.get('server') === null) {
      setParams({ server: selection.server.id }, { replace: true });
    }
    chooseServers(ids);
  }
  const railProps = {
    servers,
    allServers: saved,
    onSelect: (serverId: string) => setParams({ server: serverId }, { replace: true }),
    // With nothing saved there is nothing to choose from: the rail's link to Remote is the way on.
    onChooseServers: noneSaved ? undefined : () => setChooseOpen(true),
    onReorderServers: reorderServers,
    sites,
    sitesLoading: sitesQuery.isPending,
    sitesError: sitesQuery.isError ? wpProblem(sitesQuery.error) : null,
    onSelectSite: (siteId: string) => setParams({ site: siteId }, { replace: true }),
    onRetrySites: () => void sitesQuery.refetch(),
    onConnectSite: () => setConnectOpen(true),
    onOpenCloudflare: () => setCloudflareOpen(true),
    fileSites,
    fileSitesLoading: fileSitesQuery.isPending,
    fileSitesError: fileSitesQuery.isError ? filesProblem(fileSitesQuery.error) : null,
    onSelectFileSite: (siteId: string) => setParams({ files: siteId }, { replace: true }),
    onRetryFileSites: () => void fileSitesQuery.refetch(),
    onAddFileSite: openAddFileSite,
  };

  if (selection.kind === 'files') {
    const fileSite = selection.site;
    // No Deploy AI here either: the assistant works on a server's core.
    return (
      <DeployLayout
        rail={<ServerRail {...railProps} selectedId={null} selectedFileSiteId={fileSite.id} />}
      >
        {locked && (
          <VaultLockedBanner onUnlock={() => setUnlockOpen(true)}>
            Your saved servers and site logins are locked with a passkey. Unlock them to deploy to
            this site.
          </VaultLockedBanner>
        )}
        <FileSiteView
          key={fileSite.id}
          site={fileSite}
          section={fileSectionFromView(params.get('view'))}
          onSectionChange={(next) =>
            setParams(
              next === 'changes' ? { files: fileSite.id } : { files: fileSite.id, view: next },
              { replace: true },
            )
          }
          onEdit={() => setFileForm({ open: true, siteId: fileSite.id })}
          onRemoved={() => setParams({}, { replace: true })}
        />
        {connectDialog}
        {unlockDialog}
        {cloudflareDialog}
        {fileFormDialog}
        {chooseDialog}
      </DeployLayout>
    );
  }

  if (selection.kind === 'wordpress') {
    const selectedSite = selection.site;
    // No Deploy AI here: the assistant works on a server's core, which a WordPress site has not.
    return (
      <DeployLayout
        rail={<ServerRail {...railProps} selectedId={null} selectedSiteId={selectedSite.id} />}
      >
        {locked && (
          <VaultLockedBanner onUnlock={() => setUnlockOpen(true)}>
            Your saved servers and WordPress sites are locked with a passkey. Unlock them to reach
            this site.
          </VaultLockedBanner>
        )}
        <SiteView
          key={selectedSite.id}
          site={selectedSite}
          section={siteSectionFromView(params.get('view'))}
          onSectionChange={(next) =>
            setParams(
              next === 'overview'
                ? { site: selectedSite.id }
                : { site: selectedSite.id, view: next },
              { replace: true },
            )
          }
          onDisconnected={() => setParams({}, { replace: true })}
        />
        {connectDialog}
        {unlockDialog}
        {cloudflareDialog}
        {fileFormDialog}
        {chooseDialog}
      </DeployLayout>
    );
  }

  // With every list empty the page showed the empty state above, so this is a server.
  if (selection.kind !== 'server') return <DeployPageSkeleton />;
  const selected = selection.server;
  const run = runs[selected.id];
  const section = sectionFromView(params.get('view'));

  async function remove(server: DeployServer, keepData: boolean): Promise<void> {
    const confirmed = await confirmDialog({
      title: `Remove the server core from ${server.nickname}?`,
      description: keepData
        ? 'The service and the program go. Its data folder and settings stay, so a later install picks up where this one left off.'
        : 'The service, the program, its data folder and its settings all go. Nothing of the core is left on the server.',
      warning: keepData ? undefined : 'Deleted data cannot be brought back.',
      confirmLabel: keepData ? 'Remove the core' : 'Remove the core and its data',
      variant: 'destructive',
    });
    if (confirmed) void uninstall(server.id, keepData, null);
  }

  // The DevHost runs from the checkout, so it has nothing to update.
  const updateCore = selected.dev ? undefined : () => setCoreUpdating(selected.id);
  let content: React.ReactNode;
  let sections = false;
  if (run?.kind === 'uninstall') {
    content = <RemovalPanel server={selected} run={run} />;
  } else if (!selected.core || updating === selected.id || run?.kind === 'install') {
    content = (
      <InstallPanel
        server={selected}
        onCancel={selected.core ? () => setUpdating(null) : undefined}
      />
    );
  } else if (coreUpdating === selected.id || run?.kind === 'update') {
    content = (
      <CoreUpdatePanel
        server={selected}
        onUseSsh={() => {
          setCoreUpdating(null);
          setUpdating(selected.id);
        }}
        onCancel={() => setCoreUpdating(null)}
      />
    );
  } else if (section === 'websites') {
    sections = true;
    content = <SitesPanel server={selected} />;
  } else if (section === 'logs') {
    sections = true;
    content = <LogsPanel server={selected} />;
  } else if (section === 'firewall') {
    sections = true;
    content = <FirewallPanel server={selected} />;
  } else if (section === 'backups') {
    sections = true;
    content = <BackupsPanel server={selected} />;
  } else if (section === 'security') {
    sections = true;
    content = <SecurityPanel server={selected} onUpdateCore={updateCore} />;
  } else if (section === 'notifications') {
    sections = true;
    content = <NotificationsPanel server={selected} onUpdateCore={updateCore} />;
  } else if (section === 'containers') {
    sections = true;
    content = <ContainersPanel server={selected} />;
  } else if (section === 'files') {
    sections = true;
    content = <ServerFilesPanel server={selected} />;
  } else if (section === 'apps') {
    sections = true;
    content = <AppsPanel server={selected} />;
  } else if (section === 'store') {
    sections = true;
    content = <AppStorePanel server={selected} />;
  } else {
    sections = true;
    content = (
      <OverviewPanel
        server={selected}
        core={selected.core}
        onUpdate={updateCore}
        onReinstall={selected.dev ? undefined : () => setUpdating(selected.id)}
        onRemove={selected.dev ? undefined : (keepData) => void remove(selected, keepData)}
      />
    );
  }

  return (
    <>
      <DeployLayout
        rail={<ServerRail {...railProps} selectedId={selected.id} />}
        // Room at the bottom so the Deploy AI button never covers the last controls.
        contentClassName={sections ? 'pb-16' : undefined}
      >
        {locked && (
          <VaultLockedBanner onUnlock={() => setUnlockOpen(true)}>
            Your saved servers are locked with a passkey. Unlock them to reach their cores.
          </VaultLockedBanner>
        )}
        <ServerHeader server={selected} />
        {sections && (
          <ServerSections
            value={section}
            onChange={(next) =>
              setParams(
                next === 'overview' ? { server: selected.id } : { server: selected.id, view: next },
                { replace: true },
              )
            }
          />
        )}
        {content}
      </DeployLayout>
      {sections && <AssistantLauncher server={selected} />}
      {connectDialog}
      {unlockDialog}
      {cloudflareDialog}
      {fileFormDialog}
      {chooseDialog}
    </>
  );
}
