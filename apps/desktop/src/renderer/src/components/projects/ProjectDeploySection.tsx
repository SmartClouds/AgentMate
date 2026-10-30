import type { Project } from '@runova/core';
import type { StackInfo } from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { FileSite } from '@shared/deployFilesTypes';
import type { DeployServer } from '@shared/deployTypes';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { StatusPill } from '@/components/deploy/apps/StatusPill';
import { startNewAppFor } from '@/components/deploy/apps/wizard/startNewApp';
import { DeployPanel } from '@/components/deploy/files/DeployPanel';
import { NeedsReviewNotice } from '@/components/deploy/files/FileSiteView';
import {
  useFileSiteListUpdate,
  useFileSites,
  useSavedServerNames,
} from '@/components/deploy/files/hooks';
import { filesProblem, siteAddress } from '@/components/deploy/files/messages';
import { NotEncryptedChip, ProtocolChip } from '@/components/deploy/files/parts';
import { SiteFormDialog } from '@/components/deploy/files/SiteFormDialog';
import {
  Blocks,
  ChevronDown,
  ChevronRight,
  CloudUpload,
  ExternalLink,
  Plus,
  Rocket,
  Server,
} from '@/components/icons';
import { Chip, EmptyState, GLASS_CARD, LoadFailure, Notice } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { STATUS_TEXT, STATUS_TONE } from '@/lib/deploy/apps/format';
import { cn } from '@/lib/utils';
import { useDeployFilesRunStore } from '@/stores/deployFilesRunStore';
import { type ServerApps, useProjectRunovaApps } from './useProjectRunovaApps';

/**
 * A project's Deploy tab (E23): where the project is deployed. First the apps it runs on Runova
 * servers, in short, each a link to its place under Deploy; then the FTP and SFTP sites attached
 * to the project, each with what changed since its last deploy and its own Deploy button. With
 * nothing yet, it offers both ways, with this project already filled in.
 */
export function ProjectDeploySection({ project }: { project: Project }): React.JSX.Element {
  const sitesQuery = useFileSites();
  const runova = useProjectRunovaApps(project.id);
  const updateList = useFileSiteListUpdate();
  const [form, setForm] = useState<{ open: boolean; siteId: string | null }>({
    open: false,
    siteId: null,
  });

  const sites = (sitesQuery.data ?? []).filter((site) => site.projectIds.includes(project.id));
  const editing = form.siteId ? (sites.find((site) => site.id === form.siteId) ?? null) : null;
  const addSite = () => setForm({ open: true, siteId: null });

  let body: React.ReactNode;
  // A slow core only holds the tab back while nothing else is there to show.
  if (sitesQuery.isPending || (runova.pending && sites.length === 0 && runova.count === 0)) {
    body = (
      <div className="flex flex-col gap-2" aria-busy="true">
        {Array.from({ length: 2 }, (_, index) => (
          <div key={index} className={cn(GLASS_CARD, 'space-y-2 p-4')}>
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-3 w-64 max-w-full" />
            <Skeleton className="h-9 w-full rounded-lg" />
          </div>
        ))}
      </div>
    );
  } else if (!sitesQuery.isError && sites.length === 0 && runova.count === 0) {
    body = (
      <div className="flex flex-col gap-2">
        <EmptyState
          card
          icon={Rocket}
          title="Not deployed yet"
          description="Run this project as an app on one of your Runova servers, or send its files to a host over SFTP, FTPS or FTP."
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <DeployWithRunovaButton project={project} servers={runova.servers} />
              <Button variant="soft" onClick={addSite}>
                <CloudUpload /> Add an FTP or SFTP site
              </Button>
            </div>
          }
        />
        <UncheckedServers perServer={runova.perServer} />
      </div>
    );
  } else {
    body = (
      <div className="flex flex-col gap-6">
        <RunovaGroup project={project} runova={runova} />
        <FilesGroup
          sitesQuery={sitesQuery}
          sites={sites}
          onAdd={addSite}
          onEdit={(siteId) => setForm({ open: true, siteId })}
        />
      </div>
    );
  }

  return (
    <>
      {body}
      <SiteFormDialog
        open={form.open}
        onOpenChange={(open) => setForm((current) => ({ ...current, open }))}
        site={editing}
        initialProjectId={form.siteId ? null : project.id}
        onSaved={updateList}
      />
    </>
  );
}

function GroupHeading({
  id,
  title,
  description,
  action,
}: {
  id: string;
  title: string;
  description: string;
  action?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-end gap-x-3 gap-y-2 px-1">
      <div className="min-w-0 flex-1">
        <h3 id={id} className="text-sm font-semibold text-foreground">
          {title}
        </h3>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      {action}
    </div>
  );
}

/** A short card for a group with nothing in it, so the group still says how to start. */
function GroupEmpty({
  icon: Icon,
  text,
  action,
}: {
  icon: React.ComponentType<{ className?: string }>;
  text: string;
  action: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className={cn(GLASS_CARD, 'flex flex-wrap items-center gap-3 px-4 py-3')}>
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <Icon className="h-4 w-4" />
      </span>
      <p className="min-w-0 flex-1 text-sm text-muted-foreground">{text}</p>
      {action}
    </div>
  );
}

function RunovaGroup({
  project,
  runova,
}: {
  project: Project;
  runova: ReturnType<typeof useProjectRunovaApps>;
}): React.JSX.Element {
  const withApps = runova.perServer.filter((entry) => entry.apps.length > 0);
  let content: React.ReactNode;
  if (withApps.length > 0) {
    content = withApps.map((entry) => <ServerAppsCard key={entry.server.id} entry={entry} />);
  } else if (runova.pending) {
    content = (
      <div className={cn(GLASS_CARD, 'space-y-2 p-4')} aria-busy="true">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-10 w-full rounded-lg" />
      </div>
    );
  } else {
    content = (
      <GroupEmpty
        icon={Blocks}
        text="Not deployed with Runova yet."
        action={<DeployWithRunovaButton project={project} servers={runova.servers} size="sm" />}
      />
    );
  }

  return (
    <section aria-labelledby="project-deploy-runova" className="flex flex-col gap-2">
      <GroupHeading
        id="project-deploy-runova"
        title="Runova"
        description="Apps this project runs on your servers. Open one to manage it under Deploy."
        action={
          withApps.length > 0 ? (
            <DeployWithRunovaButton
              project={project}
              servers={runova.servers}
              size="sm"
              variant="soft"
              label="Deploy to a server"
            />
          ) : undefined
        }
      />
      {content}
      <UncheckedServers perServer={runova.perServer} />
    </section>
  );
}

function ServerAppsCard({ entry }: { entry: ServerApps }): React.JSX.Element {
  const { server, apps } = entry;
  return (
    <section aria-label={server.nickname} className={GLASS_CARD}>
      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/12 text-primary">
          <Server className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h4 className="truncate text-sm font-semibold leading-tight">{server.nickname}</h4>
          <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
            {server.username}@{server.host}
          </p>
        </div>
        {server.dev && <Chip tone="warning">Development</Chip>}
        <Button asChild size="sm" variant="ghost" className="shrink-0">
          <Link to={`/deploy?server=${encodeURIComponent(server.id)}`}>
            <ExternalLink /> Open server
          </Link>
        </Button>
      </div>
      <ul aria-label={`Apps on ${server.nickname}`} className="border-t border-border/60">
        {apps.map((app) => (
          <AppRow key={app.id} serverId={server.id} app={app} />
        ))}
      </ul>
    </section>
  );
}

function AppRow({ serverId, app }: { serverId: string; app: StackInfo }): React.JSX.Element {
  const source = app.source;
  const where = [source?.composePath, source?.environmentName].filter(Boolean).join(' · ');
  const to = `/deploy?server=${encodeURIComponent(serverId)}&view=apps&app=${encodeURIComponent(app.id)}`;
  return (
    <li className="border-b border-border/40 last:border-b-0">
      <Link
        to={to}
        aria-label={`Open ${app.name}`}
        className="group flex items-center gap-3 px-4 py-2.5 transition-colors last:rounded-b-[inherit] hover:bg-foreground/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/12 text-primary">
          <Blocks className="h-3.5 w-3.5" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="truncate font-mono text-sm font-semibold text-foreground">
              {app.name}
            </span>
            <StatusPill tone={STATUS_TONE[app.status]}>{STATUS_TEXT[app.status]}</StatusPill>
          </span>
          <span className="flex min-w-0 flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
            {where && <span className="truncate">{where}</span>}
            <span>
              {app.liveRevision !== undefined
                ? `Revision ${app.liveRevision} live`
                : 'Nothing live'}
            </span>
            <span>
              {app.containers === 0
                ? 'No containers'
                : `${app.runningContainers} of ${app.containers} running`}
            </span>
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-muted-foreground transition-colors group-hover:text-foreground">
          Open <ChevronRight className="h-3 w-3" />
        </span>
      </Link>
    </li>
  );
}

/**
 * The servers whose apps could not be read, in one quiet line, so a signed-out or unreachable
 * server never hides what the others have.
 */
function UncheckedServers({ perServer }: { perServer: ServerApps[] }): React.JSX.Element | null {
  const signedOut = perServer.filter((entry) => entry.state === 'signed-out');
  const failed = perServer.filter((entry) => entry.state === 'error');
  if (signedOut.length === 0 && failed.length === 0) return null;
  const first = signedOut[0] ?? failed[0];

  const names = (entries: ServerApps[]) => entries.map((entry) => entry.server.nickname).join(', ');
  const parts: string[] = [];
  if (signedOut.length > 0) {
    parts.push(`Sign in to ${names(signedOut)} to see whether this project runs there.`);
  }
  if (failed.length > 0) {
    const reason = failed.length === 1 && failed[0].error ? `: ${failed[0].error}` : '.';
    parts.push(`Could not reach ${names(failed)}${reason}`);
  }

  return (
    <Notice
      tone={failed.length > 0 ? 'warning' : 'neutral'}
      size="sm"
      action={
        <div className="flex gap-1.5">
          {failed.length > 0 && (
            <Button size="sm" variant="ghost" onClick={() => failed.forEach((e) => e.retry())}>
              Try again
            </Button>
          )}
          <Button asChild size="sm" variant="soft">
            <Link to={`/deploy?server=${encodeURIComponent(first.server.id)}`}>Open in Deploy</Link>
          </Button>
        </div>
      }
    >
      {parts.join(' ')}
    </Notice>
  );
}

/**
 * Starts a Runova deploy of the project: the server's New App wizard, opened with the project
 * picked. With several servers it asks which; with none it leads to Deploy to set one up.
 */
function DeployWithRunovaButton({
  project,
  servers,
  size,
  variant,
  label = 'Deploy with Runova',
}: {
  project: Project;
  servers: DeployServer[];
  size?: 'sm';
  variant?: 'soft';
  label?: string;
}): React.JSX.Element {
  const navigate = useNavigate();
  const start = (serverId: string) => {
    startNewAppFor(serverId, project);
    navigate(`/deploy?server=${encodeURIComponent(serverId)}&view=apps&new=1`);
  };

  if (servers.length === 0) {
    return (
      <SimpleTooltip label="Install the server core on a server under Deploy first.">
        <Button size={size} variant={variant} onClick={() => navigate('/deploy')}>
          <Rocket /> {label}
        </Button>
      </SimpleTooltip>
    );
  }

  if (servers.length === 1) {
    return (
      <Button size={size} variant={variant} onClick={() => start(servers[0].id)}>
        <Rocket /> {label}
      </Button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size={size} variant={variant}>
          <Rocket /> {label} <ChevronDown className="h-3 w-3 opacity-70" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Deploy to</DropdownMenuLabel>
        {servers.map((server) => (
          <DropdownMenuItem key={server.id} onSelect={() => start(server.id)}>
            <Server /> {server.nickname}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function FilesGroup({
  sitesQuery,
  sites,
  onAdd,
  onEdit,
}: {
  sitesQuery: ReturnType<typeof useFileSites>;
  sites: FileSite[];
  onAdd: () => void;
  onEdit: (siteId: string) => void;
}): React.JSX.Element {
  let content: React.ReactNode;
  if (sitesQuery.isError) {
    content = (
      <LoadFailure
        message={filesProblem(sitesQuery.error)}
        retry={() => void sitesQuery.refetch()}
      />
    );
  } else if (sites.length === 0) {
    content = (
      <GroupEmpty
        icon={CloudUpload}
        text="No FTP or SFTP site yet."
        action={
          <Button size="sm" variant="soft" onClick={onAdd}>
            <Plus /> Add an FTP or SFTP site
          </Button>
        }
      />
    );
  } else {
    content = (
      <>
        {sites.map((site) => (
          <SiteCard key={site.id} site={site} onEdit={() => onEdit(site.id)} />
        ))}
        <Button variant="soft" size="sm" className="self-start" onClick={onAdd}>
          <Plus /> Add another site
        </Button>
      </>
    );
  }

  return (
    <section aria-labelledby="project-deploy-files" className="flex flex-col gap-4">
      <GroupHeading
        id="project-deploy-files"
        title="FTP and SFTP"
        description="Send this project's files to a host. You see what changed before anything is sent."
      />
      {content}
    </section>
  );
}

function SiteCard({ site, onEdit }: { site: FileSite; onEdit: () => void }): React.JSX.Element {
  const navigate = useNavigate();
  const names = useSavedServerNames();
  const savedName =
    site.connection.kind === 'saved' ? (names.get(site.connection.sshServerId) ?? null) : null;

  return (
    <section aria-label={site.label} className="flex flex-col gap-2">
      <div className={cn(GLASS_CARD, 'flex flex-wrap items-center gap-3 px-4 py-3')}>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="truncate text-sm font-semibold">{site.label}</h4>
            <ProtocolChip protocol={site.protocol} />
            {site.protocol === 'ftp' && <NotEncryptedChip focusable />}
            {site.deployOnSave && (
              <Chip tone="primary" dot>
                Deploy on save
              </Chip>
            )}
          </div>
          <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
            {siteAddress(site, savedName)}
          </p>
        </div>
        <Button asChild size="sm" variant="ghost" className="shrink-0">
          <Link to={`/deploy?files=${site.id}`}>
            <ExternalLink /> Open in Deploy
          </Link>
        </Button>
      </div>
      {site.needsReview && (
        <NeedsReviewNotice
          needsReview={site.needsReview}
          onReview={() => useDeployFilesRunStore.getState().requestStart(site.id)}
        />
      )}
      <DeployPanel
        site={site}
        compact
        onEdit={onEdit}
        onOpenSettings={() => navigate(`/deploy?files=${site.id}&view=settings`)}
      />
    </section>
  );
}
