import type { Project } from '@agentmat/core';
import type { FileSite } from '@shared/deployFilesTypes';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
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
import { CloudUpload, ExternalLink, Plus } from '@/components/icons';
import { Chip, EmptyState, GLASS_CARD, LoadFailure } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { useDeployFilesRunStore } from '@/stores/deployFilesRunStore';

/**
 * A project's Deploy tab (E23): the FTP and SFTP sites attached to the project, each with what
 * changed since its last deploy and its own Deploy button, the same flow as under Deploy. With no
 * site yet, it offers to add one with this project and its folder already filled in.
 */
export function ProjectDeploySection({ project }: { project: Project }): React.JSX.Element {
  const sitesQuery = useFileSites();
  const updateList = useFileSiteListUpdate();
  const [form, setForm] = useState<{ open: boolean; siteId: string | null }>({
    open: false,
    siteId: null,
  });

  const sites = (sitesQuery.data ?? []).filter((site) => site.projectIds.includes(project.id));
  const editing = form.siteId ? (sites.find((site) => site.id === form.siteId) ?? null) : null;
  const addSite = () => setForm({ open: true, siteId: null });

  let body: React.ReactNode;
  if (sitesQuery.isPending) {
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
  } else if (sitesQuery.isError) {
    body = (
      <LoadFailure
        message={filesProblem(sitesQuery.error)}
        retry={() => void sitesQuery.refetch()}
      />
    );
  } else if (sites.length === 0) {
    body = (
      <EmptyState
        card
        icon={CloudUpload}
        title="No FTP or SFTP site yet"
        description="Attach a site to send this project's files to a host over SFTP, FTPS or FTP. You see what changed before anything is sent."
        action={
          <Button onClick={addSite}>
            <Plus /> Add an FTP or SFTP site
          </Button>
        }
      />
    );
  } else {
    body = (
      <div className="flex flex-col gap-4">
        {sites.map((site) => (
          <SiteCard
            key={site.id}
            site={site}
            onEdit={() => setForm({ open: true, siteId: site.id })}
          />
        ))}
        <Button variant="soft" size="sm" className="self-start" onClick={addSite}>
          <Plus /> Add another site
        </Button>
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
            <h3 className="truncate text-sm font-semibold">{site.label}</h3>
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
