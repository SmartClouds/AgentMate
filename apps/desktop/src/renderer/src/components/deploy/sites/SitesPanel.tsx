import { coreErrorMessage } from '@shared/coreErrors';
import type { NginxApplyResult } from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { DeployServer } from '@shared/deployTypes';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { Globe } from '@/components/icons';
import { EmptyState, GLASS_CARD } from '@/components/pageKit';
import { Skeleton } from '@/components/ui/skeleton';
import type { SiteTab } from '@/lib/deploy/sites/problems';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { useFinishedOnce, useFollowedJob } from '@/stores/deployFollowedJobStore';
import { CoreAccessCard } from '../CoreAccessCard';
import { JobLogDialog } from '../overview/JobLogDialog';
import { hasRole } from '../security/format';
import { ApplyBar } from './ApplyBar';
import { useNginxStatus, useRefreshWeb, useSites, useStreams } from './hooks';
import { NginxCard } from './NginxCard';
import { SiteEditor } from './SiteEditor';
import { SitesCard } from './SitesCard';
import { StreamProxiesCard } from './StreamProxiesCard';

/**
 * A server's Websites section: nginx, the sites with their routes, TCP and UDP proxies, and the
 * Apply bar that puts saved changes live. Everyone signed in sees it; Admins change sites and
 * certificates, Owners also write custom directives, and the core checks every call again.
 */

interface Editing {
  /** Null for a new site. */
  siteId: string | null;
  tab: SiteTab;
  /** For a new site: the domains it starts with (from Cloudflare's "point domain"). */
  domains?: string[];
}

const DOMAIN = /^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/** `?newSite=a.example.com,www.a.example.com`, as Cloudflare's point-domain dialog links here. */
function domainsFrom(param: string | null): string[] | null {
  if (!param) return null;
  const domains = param
    .split(',')
    .map((domain) => domain.trim().toLowerCase())
    .filter((domain) => DOMAIN.test(domain))
    .slice(0, 10);
  return domains.length > 0 ? domains : null;
}

export function SitesPanel({ server }: { server: DeployServer }): React.JSX.Element {
  const access = useQuery({
    queryKey: queryKeys.deployAccess(server.id),
    queryFn: () => window.runova.deploy.access(server.id),
    retry: false,
    staleTime: 30_000,
  });
  const signedIn = access.data?.state === 'signed-in';
  const status = useNginxStatus(server.id, signedIn);
  const sites = useSites(server.id, signedIn);
  const streams = useStreams(server.id, signedIn);
  const refresh = useRefreshWeb(server.id);
  const [params, setParams] = useSearchParams();
  const linkedDomains = domainsFrom(params.get('newSite'));
  const [editing, setEditing] = useState<Editing | null>(() =>
    linkedDomains ? { siteId: null, tab: 'domains', domains: linkedDomains } : null,
  );
  useEffect(() => {
    if (!params.has('newSite')) return;
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete('newSite');
        return next;
      },
      { replace: true },
    );
  }, [params, setParams]);
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState<NginxApplyResult | null>(null);
  const [installJob, setInstallJob] = useFollowedJob(server.id, 'nginx');
  const installFinished = useFinishedOnce(server.id, () => void refresh());
  const [installing, setInstalling] = useState(false);

  if (access.isPending) {
    return (
      <div className="flex flex-col gap-2" aria-busy="true">
        <div className={cn(GLASS_CARD, 'space-y-3 p-4')}>
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-3 w-56" />
        </div>
        <div className={cn(GLASS_CARD, 'space-y-3 p-4')}>
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-12 w-full rounded-xl" />
          <Skeleton className="h-12 w-full rounded-xl" />
        </div>
      </div>
    );
  }
  if (!signedIn) {
    return (
      <div className="flex flex-col gap-2">
        <EmptyState
          card
          size="sm"
          icon={Globe}
          title="Not signed in"
          description={`Sign in to see the websites on ${server.nickname}.`}
        />
        <CoreAccessCard server={server} />
      </div>
    );
  }

  const roles = access.data?.user?.roles;
  const admin = hasRole(roles, 'admin');
  const owner = hasRole(roles, 'owner');
  const nginx = status.data;
  const managed = nginx?.managed ?? false;
  const applyProblems = applied && !applied.applied ? applied.problems : [];

  async function install(): Promise<void> {
    setInstalling(true);
    try {
      setInstallJob(await window.runova.deploySites.install(server.id));
    } catch (error) {
      toast.error(coreErrorMessage(error));
    } finally {
      setInstalling(false);
    }
  }

  async function apply(): Promise<void> {
    setApplying(true);
    try {
      const result = await window.runova.deploySites.applyChanges(server.id);
      setApplied(result);
      if (result.applied) {
        toast.success(
          result.release ? `Applied. nginx runs release ${result.release}.` : 'Applied.',
        );
      }
    } catch (error) {
      setApplied({ applied: false, problems: [], warnings: [], error: coreErrorMessage(error) });
    } finally {
      setApplying(false);
      void refresh();
    }
  }

  const editedSite = editing?.siteId
    ? sites.data?.find((site) => site.settings.id === editing.siteId)
    : undefined;

  return (
    <div className="flex flex-col gap-2">
      <ApplyBar
        pending={nginx?.pendingChanges ?? false}
        applying={applying}
        admin={admin}
        result={applied}
        onApply={() => void apply()}
        onShowProblem={(problem) => {
          if (problem.scope === 'site' && problem.id)
            setEditing({ siteId: problem.id, tab: problem.tab });
        }}
      />
      {editing && (editing.siteId === null || editedSite) ? (
        <SiteEditor
          key={editing.siteId ?? 'new'}
          server={server}
          site={editedSite}
          admin={admin}
          owner={owner}
          applyProblems={applyProblems}
          initialTab={editing.tab}
          initialDomains={editing.domains}
          onClose={() => setEditing(null)}
          onSaved={(site) => {
            void refresh();
            if (editing.siteId === null) setEditing({ siteId: site.settings.id, tab: 'ssl' });
          }}
          onChanged={() => void refresh()}
        />
      ) : (
        <>
          <NginxCard
            status={nginx}
            loading={status.isPending}
            error={status.error ? coreErrorMessage(status.error) : null}
            admin={admin}
            installing={installing}
            onInstall={() => void install()}
          />
          <SitesCard
            sites={sites.data}
            loading={sites.isPending}
            error={sites.error ? coreErrorMessage(sites.error) : null}
            admin={admin}
            managed={managed}
            onOpen={(siteId, tab) => setEditing({ siteId, tab })}
            onAdd={() => setEditing({ siteId: null, tab: 'domains' })}
          />
          <StreamProxiesCard
            serverId={server.id}
            proxies={streams.data}
            loading={streams.isPending}
            error={streams.error ? coreErrorMessage(streams.error) : null}
            admin={admin}
            available={managed && (nginx?.streamSupported ?? false)}
            onChanged={() => void refresh()}
          />
        </>
      )}
      <JobLogDialog
        serverId={server.id}
        job={installJob}
        canCancel={admin}
        onClose={() => setInstallJob(null)}
        onFinished={installFinished}
      />
    </div>
  );
}
