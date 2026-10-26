import { coreErrorMessage } from '@shared/coreErrors';
import type {
  NginxProblemInfo,
  SiteInfo,
} from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { DeployServer } from '@shared/deployTypes';
import { lazy, Suspense, useState } from 'react';
import { toast } from 'sonner';
import { ArrowLeft, Save, Spinner, Trash2, TriangleAlert } from '@/components/icons';
import { GLASS_PANEL } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { blankDraft, draftFromSite, type SiteDraft, suggestId } from '@/lib/deploy/sites/draft';
import { problemsByTab, problemsFor, type SiteTab, tabOf } from '@/lib/deploy/sites/problems';
import { type DraftErrors, settingsFromDraft } from '@/lib/deploy/sites/settings';
import { cn } from '@/lib/utils';
import { confirmDialog } from '@/stores/confirmStore';
import { DomainsTab } from './DomainsTab';
import { LogsTab } from './LogsTab';
import { PerformanceTab } from './PerformanceTab';
import { ProxyTab } from './ProxyTab';
import { SecurityTab } from './SecurityTab';
import { SslTab } from './SslTab';

/**
 * One site's settings on tabs. Saving stores the site on the server without putting it live;
 * the Apply bar does that for every saved change at once. Problems, from this computer's checks
 * or the core's, show next to their field, and each tab says how many it holds.
 */

// Monaco is large and only the Advanced tab needs it, so it loads when that tab is opened.
const AdvancedTab = lazy(() =>
  import('./AdvancedTab').then((module) => ({ default: module.AdvancedTab })),
);

/** A hairline under the tab strip, drawn as a shadow like the API Client's. */
const HAIRLINE_BELOW =
  'shadow-[inset_0_-1px_0_hsl(var(--foreground)/0.08),inset_0_1px_0_hsl(var(--foreground)/0.08)]';

const TABS: ReadonlyArray<{ value: SiteTab; label: string }> = [
  { value: 'domains', label: 'Domains' },
  { value: 'proxy', label: 'Proxy' },
  { value: 'ssl', label: 'SSL' },
  { value: 'performance', label: 'Performance' },
  { value: 'security', label: 'Security' },
  { value: 'advanced', label: 'Advanced' },
  { value: 'logs', label: 'Logs' },
];

export function SiteEditor({
  server,
  site,
  admin,
  owner,
  applyProblems,
  initialTab = 'domains',
  initialDomains,
  onClose,
  onSaved,
  onChanged,
}: {
  server: DeployServer;
  /** Undefined for a new site. */
  site: SiteInfo | undefined;
  admin: boolean;
  owner: boolean;
  applyProblems: readonly NginxProblemInfo[];
  initialTab?: SiteTab;
  /** For a new site: the domains to start with, such as the ones just pointed here in Cloudflare. */
  initialDomains?: string[];
  onClose: () => void;
  onSaved: (site: SiteInfo) => void;
  /** Something changed on the server behind this site (a certificate, its snippets). */
  onChanged: () => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState<SiteDraft>(() => {
    if (site) return draftFromSite(site);
    const blank = blankDraft();
    return initialDomains?.length
      ? { ...blank, domains: [...initialDomains], id: suggestId(initialDomains[0]) }
      : blank;
  });
  const [tab, setTab] = useState<SiteTab>(initialTab);
  const [local, setLocal] = useState<DraftErrors>({});
  const [saveProblems, setSaveProblems] = useState<NginxProblemInfo[]>([]);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const readOnly = !admin;
  const id = site?.settings.id ?? draft.id;
  const placed = problemsFor([...saveProblems, ...applyProblems], 'site', id);
  const counts = problemsByTab([
    ...placed,
    ...Object.keys(local).map((path) => ({
      scope: 'site' as const,
      path,
      tab: tabOf(path),
      message: '',
    })),
  ]);
  const error = (path: string) =>
    local[path] ?? placed.find((problem) => problem.path === path)?.message;
  const set = (patch: Partial<SiteDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const tabProps = { draft, set, error, readOnly };
  const title = site ? (site.settings.domains[0] ?? site.settings.id) : 'New site';

  async function save(): Promise<void> {
    const { settings, errors } = settingsFromDraft(draft);
    setLocal(errors);
    setFailure(null);
    const first = Object.keys(errors)[0];
    if (first) {
      setTab(tabOf(first));
      return;
    }
    setSaving(true);
    try {
      const result = await window.runova.deploySites.save(server.id, settings);
      setSaveProblems(result.problems);
      if (result.problems.length > 0 || !result.site) {
        const firstProblem = problemsFor(result.problems, 'site', settings.id)[0];
        if (firstProblem) setTab(firstProblem.tab);
        return;
      }
      toast.success(`${result.site.settings.domains[0]} saved. Apply to put it live.`);
      setDraft(draftFromSite(result.site));
      onSaved(result.site);
    } catch (caught) {
      setFailure(coreErrorMessage(caught));
    } finally {
      setSaving(false);
    }
  }

  async function remove(): Promise<void> {
    if (!site) return;
    const confirmed = await confirmDialog({
      title: `Delete ${title}?`,
      description:
        'The site, its settings and its certificate go with the next apply. Its app keeps running.',
      confirmLabel: 'Delete the site',
      variant: 'destructive',
    });
    if (!confirmed) return;
    try {
      await window.runova.deploySites.remove(server.id, site.settings.id);
      toast.success(`${title} deleted. Apply to take it offline.`);
      onChanged();
      onClose();
    } catch (caught) {
      setFailure(coreErrorMessage(caught));
    }
  }

  return (
    <section aria-label={`Site ${title}`} className={cn(GLASS_PANEL, 'min-w-0')}>
      <div className="flex flex-wrap items-center gap-2 px-3 py-2.5">
        <Button type="button" variant="soft" size="sm" onClick={onClose}>
          <ArrowLeft className="h-3.5 w-3.5" /> All sites
        </Button>
        <h3 className="min-w-0 flex-1 truncate font-mono text-sm font-semibold">{title}</h3>
        {admin && site && (
          <Button type="button" variant="danger" size="sm" onClick={() => void remove()}>
            <Trash2 className="h-3.5 w-3.5" /> Delete
          </Button>
        )}
        {admin && (
          <Button type="button" size="sm" disabled={saving} onClick={() => void save()}>
            {saving ? (
              <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            {site ? 'Save changes' : 'Save the site'}
          </Button>
        )}
      </div>
      {failure && (
        <p role="alert" className="flex items-center gap-2 px-4 pb-2 text-sm text-destructive">
          <TriangleAlert className="h-3.5 w-3.5" /> {failure}
        </p>
      )}
      <Tabs value={tab} onValueChange={(value) => setTab(value as SiteTab)} className="min-w-0">
        {/* The API Client's tab strip: a quiet hairline under the tabs instead of a border. */}
        <TabsList
          aria-label="Site settings"
          className="h-9 border-none bg-transparent px-1.5"
          containerClassName={cn('border-b-0', HAIRLINE_BELOW)}
        >
          {TABS.filter((entry) => entry.value !== 'logs' || site).map((entry) => {
            const count = counts[entry.value] ?? 0;
            return (
              <TabsTrigger key={entry.value} value={entry.value}>
                {entry.label}
                {count > 0 && (
                  <span className="ml-1.5 inline-flex h-4 items-center gap-0.5 rounded-full bg-destructive/12 px-1.5 text-[10px] font-semibold text-destructive">
                    <TriangleAlert className="h-2.5 w-2.5" aria-hidden />
                    <span className="sr-only">
                      , {count === 1 ? 'one problem' : `${count} problems`}
                    </span>
                    <span aria-hidden>{count}</span>
                  </span>
                )}
              </TabsTrigger>
            );
          })}
        </TabsList>
        <div className="p-3">
          <TabsContent value="domains" className="mt-0">
            <DomainsTab {...tabProps} />
          </TabsContent>
          <TabsContent value="proxy" className="mt-0">
            <ProxyTab {...tabProps} />
          </TabsContent>
          <TabsContent value="ssl" className="mt-0">
            <SslTab {...tabProps} server={server} site={site} admin={admin} onChanged={onChanged} />
          </TabsContent>
          <TabsContent value="performance" className="mt-0">
            <PerformanceTab {...tabProps} />
          </TabsContent>
          <TabsContent value="security" className="mt-0">
            <SecurityTab {...tabProps} />
          </TabsContent>
          <TabsContent value="advanced" className="mt-0">
            <Suspense fallback={<Skeleton className="h-40 w-full" aria-busy="true" />}>
              <AdvancedTab
                serverId={server.id}
                site={site}
                owner={owner}
                applyProblems={applyProblems}
                onSaved={onSaved}
              />
            </Suspense>
          </TabsContent>
          {site && (
            <TabsContent value="logs" className="mt-0">
              <LogsTab serverId={server.id} siteId={site.settings.id} />
            </TabsContent>
          )}
        </div>
      </Tabs>
    </section>
  );
}
