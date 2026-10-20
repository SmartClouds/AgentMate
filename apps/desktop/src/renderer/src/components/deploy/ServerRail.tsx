import type { FileSite } from '@shared/deployFilesTypes';
import type { DeployServer } from '@shared/deployTypes';
import type { DeployWordPressSite } from '@shared/deployWordPressTypes';
import { LayoutGroup, motion, useReducedMotion } from 'framer-motion';
import { useRef } from 'react';
import { Link } from 'react-router-dom';
import { CloudflareMark } from '@/components/cloudflare/CloudflareMark';
import { ExternalLink, Plus, RefreshCw, Sliders, Spinner } from '@/components/icons';
import { Chip, SECTION_HEADING } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { ReorderableGroup, type ReorderMotion } from '@/components/ui/ReorderableGroup';
import { Skeleton } from '@/components/ui/skeleton';
import { WordPressMark } from '@/components/wordpress/WordPressMark';
import { moveId } from '@/lib/deploy/railServers';
import { cn } from '@/lib/utils';
import { useDeploySetupStore } from '@/stores/deploySetupStore';
import { type ServerState, serverState, useCoreHealth } from './coreHealth';
import { Notice } from './deployKit';
import { lastDeployText } from './files/copy';
import { useCachedFileSiteChanges } from './files/hooks';
import { siteAddress } from './files/messages';
import { NotEncryptedChip, ProtocolChip } from './files/parts';
import { lastSeenText, siteHost } from './wordpress/messages';

/** Servers and both kinds of site share one pill, so the selection slides between the groups. */
const PILL_ID = 'deploy-rail-active';

function StatusDot({ state }: { state: ServerState }): React.JSX.Element {
  if (state === 'busy' || state === 'connecting') {
    return (
      <Spinner
        className={cn(
          'h-3 w-3 motion-safe:animate-spin',
          state === 'busy' ? 'text-primary' : 'text-muted-foreground',
        )}
      />
    );
  }
  if (state === 'online') {
    return (
      <span className="relative flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full rounded-full bg-success opacity-50 motion-safe:animate-ping" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-success shadow-[0_0_6px_hsl(var(--success)/0.7)]" />
      </span>
    );
  }
  if (state === 'offline') return <span className="h-2 w-2 rounded-full bg-warning" />;
  // A hollow ring for a server with no core yet. A border would take the global border colour.
  return <span className="h-2 w-2 rounded-full ring-[1.5px] ring-inset ring-muted-foreground/60" />;
}

/** The tinted pill and glowing bar behind the selected row, as on the main menu. */
function ActivePill(): React.JSX.Element {
  const reduceMotion = useReducedMotion();
  return (
    <motion.span
      aria-hidden
      layoutId={PILL_ID}
      transition={reduceMotion ? { duration: 0 } : { type: 'spring', stiffness: 420, damping: 32 }}
      className="absolute inset-0 -z-10 rounded-lg bg-primary/12"
    >
      <span className="absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-full bg-primary shadow-[0_0_8px_hsl(var(--primary)/0.7)]" />
    </motion.span>
  );
}

/** A two-line rail row: the main menu's row, with room for a status line under the name. */
function rowClass(selected: boolean): string {
  return cn(
    // `isolate` keeps the pill behind the text without lifting every child.
    'relative isolate flex w-full cursor-pointer items-center gap-2.5 rounded-lg py-2 pl-3 pr-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
    !selected && 'hover:bg-foreground/[0.06]',
  );
}

function RowTitle({ selected, children }: { selected: boolean; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        'block truncate text-[13px] font-medium',
        selected ? 'text-primary' : 'text-foreground',
      )}
    >
      {children}
    </span>
  );
}

/**
 * A server's row while the list can be reordered. A held row lifts off the rail while the rows
 * around it slide out of its way, the same motion the Projects list has.
 */
function serverItemClass(dragging: boolean): string {
  return dragging
    ? 'relative z-10 rounded-lg bg-popover shadow-lg ring-1 ring-foreground/10 transition-none'
    : 'transition-transform duration-200 ease-out motion-reduce:transition-none';
}

function RailItem({
  server,
  selected,
  onSelect,
  motion: reorder,
  onShift,
}: {
  server: DeployServer;
  selected: boolean;
  onSelect: (serverId: string) => void;
  motion: ReorderMotion;
  /** Moves the server one place up (-1) or down (1). Alt with the arrow keys asks for it. */
  onShift: (delta: -1 | 1) => void;
}): React.JSX.Element {
  const health = useCoreHealth(server);
  const run = useDeploySetupStore((state) => state.runs[server.id]);
  const state = serverState(server, health, run);
  const text: Record<ServerState, string> = {
    'not-installed': 'Core not installed',
    busy: run?.kind === 'uninstall' ? 'Removing the core…' : 'Installing the core…',
    connecting: 'Connecting…',
    online: `Online, core ${health.data?.version ?? ''}`.trim(),
    offline: 'Not answering',
  };

  return (
    <li {...reorder.itemProps} className={serverItemClass(reorder.dragging)}>
      {/* The whole row is the grip: a click selects, and a press that travels reorders. */}
      <button
        type="button"
        data-drag-grip
        aria-current={selected ? 'true' : undefined}
        onClick={() => onSelect(server.id)}
        onPointerDown={reorder.onGripPointerDown}
        onKeyDown={(event) => {
          if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
          event.preventDefault();
          onShift(event.key === 'ArrowUp' ? -1 : 1);
        }}
        className={rowClass(selected)}
      >
        {selected && <ActivePill />}
        <span className="flex h-4 w-4 shrink-0 items-center justify-center">
          <StatusDot state={state} />
        </span>
        <span className="min-w-0 flex-1">
          <RowTitle selected={selected}>{server.nickname}</RowTitle>
          <span className="block truncate text-[11px] text-muted-foreground">{text[state]}</span>
        </span>
      </button>
    </li>
  );
}

function SiteRailItem({
  site,
  selected,
  onSelect,
}: {
  site: DeployWordPressSite;
  selected: boolean;
  onSelect: (siteId: string) => void;
}): React.JSX.Element {
  return (
    <li>
      <button
        type="button"
        aria-current={selected ? 'true' : undefined}
        onClick={() => onSelect(site.id)}
        className={cn(rowClass(selected), 'items-start')}
      >
        {selected && <ActivePill />}
        <span className="flex h-[18px] w-4 shrink-0 items-center justify-center">
          <WordPressMark className="h-3.5 w-3.5" />
        </span>
        <span className="min-w-0 flex-1">
          <RowTitle selected={selected}>{site.label}</RowTitle>
          <span className="block truncate text-[11px] text-muted-foreground">
            {siteHost(site.siteUrl)}
          </span>
          <span className="mt-1 flex flex-wrap items-center gap-1">
            <span className="mr-0.5 text-[11px] text-muted-foreground">{lastSeenText(site)}</span>
            {site.scope === 'read' && <Chip>Read-only</Chip>}
            {site.transport === 'plain-http' && <Chip tone="warning">Plain HTTP</Chip>}
          </span>
        </span>
      </button>
    </li>
  );
}

function FileSiteRailItem({
  site,
  savedName,
  selected,
  onSelect,
}: {
  site: FileSite;
  savedName: string | null;
  selected: boolean;
  onSelect: (siteId: string) => void;
}): React.JSX.Element {
  // Only what a page already watches; the rail never starts a watch of its own.
  const changes = useCachedFileSiteChanges(site.id);
  const pending = changes?.state === 'ready' ? changes.files.length : 0;
  return (
    <li>
      <button
        type="button"
        aria-current={selected ? 'true' : undefined}
        onClick={() => onSelect(site.id)}
        className={cn(rowClass(selected), 'items-start')}
      >
        {selected && <ActivePill />}
        <span className="min-w-0 flex-1">
          <RowTitle selected={selected}>{site.label}</RowTitle>
          <span className="block truncate font-mono text-[11px] text-muted-foreground">
            {siteAddress(site, savedName)}
          </span>
          <span className="mt-1 flex flex-wrap items-center gap-1">
            <ProtocolChip protocol={site.protocol} />
            {pending > 0 ? (
              <Chip tone="primary">{pending} to deploy</Chip>
            ) : (
              <span className="mx-0.5 text-[11px] text-muted-foreground">
                {lastDeployText(site.lastDeploy)}
              </span>
            )}
            {site.needsReview && <Chip tone="warning">Needs review</Chip>}
            {site.protocol === 'ftp' && <NotEncryptedChip />}
          </span>
        </span>
      </button>
    </li>
  );
}

/** A group heading in the rail, with how many entries the group holds. */
function GroupHeading({ label, count }: { label: string; count?: number }): React.JSX.Element {
  return (
    <div className="flex h-7 items-center justify-between gap-2 px-3">
      <p className={SECTION_HEADING}>{label}</p>
      {count !== undefined && (
        <span className="rounded-full bg-foreground/[0.06] px-1.5 text-[10px] leading-4 tabular-nums text-muted-foreground">
          {count}
        </span>
      )}
    </div>
  );
}

/** A quiet row for the places this rail hands off to: Remote, and the Cloudflare dialog. */
const LINK_ROW =
  'flex h-8 items-center gap-2 rounded-lg px-3 text-[13px] text-muted-foreground outline-none transition-colors hover:bg-foreground/[0.06] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&_svg]:h-3.5 [&_svg]:w-3.5 [&_svg]:shrink-0';

/** The WordPress sites group under the servers, with its own loading and failure states. */
function SiteGroup({
  sites,
  loading,
  error,
  selectedSiteId,
  onSelectSite,
  onRetrySites,
  onConnectSite,
}: {
  sites: DeployWordPressSite[];
  loading: boolean;
  error: string | null;
  selectedSiteId: string | null;
  onSelectSite: (siteId: string) => void;
  onRetrySites?: () => void;
  onConnectSite?: () => void;
  /** Left out, the FTP and SFTP group is not shown at all. */
  fileSites?: FileSite[];
  fileSitesLoading?: boolean;
  fileSitesError?: string | null;
  selectedFileSiteId?: string | null;
  onSelectFileSite?: (siteId: string) => void;
  onRetryFileSites?: () => void;
  onAddFileSite?: () => void;
}): React.JSX.Element {
  return (
    <div className="mt-3 flex flex-col gap-1">
      <GroupHeading label="WordPress sites" count={!loading && !error ? sites.length : undefined} />
      {loading ? (
        <div className="px-1" aria-busy="true">
          <Skeleton className="h-14 w-full rounded-lg" />
        </div>
      ) : error ? (
        <Notice role="alert" tone="destructive" className="mx-1 text-xs">
          <p>The WordPress sites did not load: {error}</p>
          {onRetrySites && (
            <Button size="sm" variant="soft" className="mt-2" onClick={onRetrySites}>
              <RefreshCw /> Try again
            </Button>
          )}
        </Notice>
      ) : (
        sites.length > 0 && (
          <ul aria-label="WordPress sites" className="flex flex-col gap-px">
            {sites.map((site) => (
              <SiteRailItem
                key={site.id}
                site={site}
                selected={site.id === selectedSiteId}
                onSelect={onSelectSite}
              />
            ))}
          </ul>
        )
      )}
      {onConnectSite && (
        <Button variant="soft" size="sm" className="mx-1 mt-1" onClick={onConnectSite}>
          <Plus /> Connect a WordPress site
        </Button>
      )}
    </div>
  );
}

/** The FTP and SFTP sites group under the WordPress sites, with its own loading and failure. */
function FileSiteGroup({
  sites,
  servers,
  loading,
  error,
  selectedId,
  onSelect,
  onRetry,
  onAdd,
}: {
  sites: FileSite[];
  servers: DeployServer[];
  loading: boolean;
  error: string | null;
  selectedId: string | null;
  onSelect: (siteId: string) => void;
  onRetry?: () => void;
  onAdd?: () => void;
}): React.JSX.Element {
  const names = new Map(servers.map((server) => [server.id, server.nickname]));
  return (
    <div className="mt-3 flex flex-col gap-1">
      <GroupHeading
        label="FTP and SFTP sites"
        count={!loading && !error ? sites.length : undefined}
      />
      {loading ? (
        <div className="space-y-1 px-1" aria-busy="true">
          <Skeleton className="h-14 w-full rounded-lg" />
        </div>
      ) : error ? (
        <Notice role="alert" tone="destructive" className="mx-1 text-xs">
          <p>The FTP and SFTP sites did not load: {error}</p>
          {onRetry && (
            <Button size="sm" variant="soft" className="mt-2" onClick={onRetry}>
              <RefreshCw /> Try again
            </Button>
          )}
        </Notice>
      ) : (
        sites.length > 0 && (
          <ul aria-label="FTP and SFTP sites" className="flex flex-col gap-px">
            {sites.map((site) => (
              <FileSiteRailItem
                key={site.id}
                site={site}
                savedName={
                  site.connection.kind === 'saved'
                    ? (names.get(site.connection.sshServerId) ?? null)
                    : null
                }
                selected={site.id === selectedId}
                onSelect={onSelect}
              />
            ))}
          </ul>
        )
      )}
      {onAdd && (
        <Button variant="soft" size="sm" className="mx-1 mt-1" onClick={onAdd}>
          <Plus /> Add an FTP or SFTP site
        </Button>
      )}
    </div>
  );
}

/**
 * The servers the user chose for Deploy, in the order they arranged them, each with how its core
 * is doing so the one that needs a look stands out. Under them come the WordPress sites connected
 * through the AgentMate Connector plugin and the FTP and SFTP sites.
 */
export function ServerRail({
  servers,
  allServers,
  selectedId,
  onSelect,
  onChooseServers,
  onReorderServers,
  sites,
  sitesLoading = false,
  sitesError = null,
  selectedSiteId = null,
  onSelectSite,
  onRetrySites,
  onConnectSite,
  onOpenCloudflare,
  fileSites,
  fileSitesLoading = false,
  fileSitesError = null,
  selectedFileSiteId = null,
  onSelectFileSite,
  onRetryFileSites,
  onAddFileSite,
}: {
  servers: DeployServer[];
  /**
   * Every saved server, shown or not, to name the one an FTP or SFTP site connects through.
   * Left out, the rail's own servers are all it knows.
   */
  allServers?: DeployServer[];
  selectedId: string | null;
  onSelect: (serverId: string) => void;
  /** Left out, there is no row for choosing which servers the rail lists. */
  onChooseServers?: () => void;
  /** Gets the server ids in their new order after a drag. Left out, the servers can't be moved. */
  onReorderServers?: (orderedIds: string[]) => void;
  /** Opens the Cloudflare dialog over Deploy. */
  onOpenCloudflare: () => void;
  /** Left out, the WordPress group is not shown at all. */
  sites?: DeployWordPressSite[];
  sitesLoading?: boolean;
  sitesError?: string | null;
  selectedSiteId?: string | null;
  onSelectSite?: (siteId: string) => void;
  onRetrySites?: () => void;
  onConnectSite?: () => void;
  /** Left out, the FTP and SFTP group is not shown at all. */
  fileSites?: FileSite[];
  fileSitesLoading?: boolean;
  fileSitesError?: string | null;
  selectedFileSiteId?: string | null;
  onSelectFileSite?: (siteId: string) => void;
  onRetryFileSites?: () => void;
  onAddFileSite?: () => void;
}): React.JSX.Element {
  const navRef = useRef<HTMLElement>(null);

  function reorder(from: number, to: number): void {
    onReorderServers?.(
      moveId(
        servers.map((server) => server.id),
        from,
        to,
      ),
    );
  }

  /**
   * Moving a row can re-mount it, which drops the keyboard, so the moved row takes it back. Only
   * when it was dropped: a key pressed elsewhere in the meantime keeps its focus.
   */
  function shift(index: number, delta: -1 | 1): void {
    const to = index + delta;
    if (!onReorderServers || to < 0 || to >= servers.length) return;
    const movedId = servers[index].id;
    reorder(index, to);
    window.requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active && active !== document.body) return;
      const row = Array.from(
        navRef.current?.querySelectorAll<HTMLElement>('[data-reorder-id]') ?? [],
      ).find((item) => item.dataset.reorderId === movedId);
      row?.querySelector<HTMLElement>('[data-drag-grip]')?.focus();
    });
  }

  return (
    <nav ref={navRef} aria-label="Servers" className="flex flex-col gap-1">
      <LayoutGroup id="deploy-rail">
        <GroupHeading label="Servers" count={servers.length} />
        {servers.length === 0 && (
          <p className="px-3 text-xs text-muted-foreground">No servers shown.</p>
        )}
        <ReorderableGroup
          as="ul"
          items={servers}
          getId={(server) => server.id}
          enabled={onReorderServers !== undefined}
          className="flex flex-col gap-px"
          onMove={reorder}
          renderItem={(server, motion, index) => (
            <RailItem
              server={server}
              selected={server.id === selectedId}
              onSelect={onSelect}
              motion={motion}
              onShift={(delta) => shift(index, delta)}
            />
          )}
        />
        <div className="flex flex-col gap-px">
          {onChooseServers && (
            <button type="button" onClick={onChooseServers} className={cn(LINK_ROW, 'w-full')}>
              <Sliders /> Choose servers to show
            </button>
          )}
          <Link to="/remote" className={LINK_ROW}>
            <ExternalLink /> Add or edit servers in Remote
          </Link>
          <button type="button" onClick={onOpenCloudflare} className={cn(LINK_ROW, 'w-full')}>
            <CloudflareMark /> Cloudflare: domains and DNS
          </button>
        </div>
        {(sites !== undefined || sitesLoading || sitesError !== null) && onSelectSite && (
          <SiteGroup
            sites={sites ?? []}
            loading={sitesLoading}
            error={sitesError}
            selectedSiteId={selectedSiteId}
            onSelectSite={onSelectSite}
            onRetrySites={onRetrySites}
            onConnectSite={onConnectSite}
          />
        )}
        {(fileSites !== undefined || fileSitesLoading || fileSitesError !== null) &&
          onSelectFileSite && (
            <FileSiteGroup
              sites={fileSites ?? []}
              servers={allServers ?? servers}
              loading={fileSitesLoading}
              error={fileSitesError}
              selectedId={selectedFileSiteId}
              onSelect={onSelectFileSite}
              onRetry={onRetryFileSites}
              onAdd={onAddFileSite}
            />
          )}
      </LayoutGroup>
    </nav>
  );
}
