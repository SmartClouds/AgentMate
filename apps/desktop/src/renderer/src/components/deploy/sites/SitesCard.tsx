import type { SiteInfo } from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { Globe, Pencil, Plus } from '@/components/icons';
import { Chip, EmptyState, FOOTER_HAIRLINE, GLASS_CARD, TileHeader } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { SiteTab } from '@/lib/deploy/sites/problems';
import { cn } from '@/lib/utils';
import { RouteMap } from './RouteMap';

/** Every site on the server as its route, whether it is live, and a way into its editor. */

/** Whether a site or proxy has been put live yet, as a tinted chip with words, not colour alone. */
export function AppliedChip({ applied }: { applied: boolean }): React.JSX.Element {
  return applied ? (
    <Chip tone="success" dot>
      Live
    </Chip>
  ) : (
    <Chip tone="warning" dot>
      Not applied yet
    </Chip>
  );
}

export function SitesCard({
  sites,
  loading,
  error,
  admin,
  managed,
  onOpen,
  onAdd,
}: {
  sites: SiteInfo[] | undefined;
  loading: boolean;
  error: string | null;
  admin: boolean;
  /** Sites can be added once Runova looks after nginx. */
  managed: boolean;
  onOpen: (siteId: string, tab: SiteTab) => void;
  onAdd: () => void;
}): React.JSX.Element {
  const now = Date.now();
  return (
    <section className={cn(GLASS_CARD, 'overflow-hidden')}>
      <div className="space-y-1 px-4 pb-3 pt-4">
        <TileHeader
          icon={<Globe />}
          title="Websites"
          extra={
            sites && sites.length > 0 ? (
              <span className="rounded-full bg-foreground/[0.06] px-1.5 text-[10px] leading-4 tabular-nums text-muted-foreground">
                {sites.length}
              </span>
            ) : undefined
          }
          actions={
            admin && managed ? (
              <Button type="button" size="sm" onClick={onAdd}>
                <Plus className="h-3.5 w-3.5" /> Add a site
              </Button>
            ) : undefined
          }
        />
        <p className="text-xs text-muted-foreground">
          Domains nginx serves, and where each one leads.
        </p>
      </div>
      {loading ? (
        <div className="space-y-2 px-4 pb-4" aria-busy="true">
          <Skeleton className="h-12 w-full rounded-xl" />
          <Skeleton className="h-12 w-full rounded-xl" />
        </div>
      ) : error ? (
        <p role="alert" className="px-4 pb-4 text-sm text-destructive">
          {error}
        </p>
      ) : !sites || sites.length === 0 ? (
        <EmptyState
          size="sm"
          icon={Globe}
          title={managed ? 'No websites yet' : 'nginx is not set up'}
          description={
            managed
              ? 'No sites yet. Add one to put an app on a domain.'
              : 'Set up nginx above, then add a site.'
          }
        />
      ) : (
        // Hairline rows, like the Settings cards, so each route reads as one line of the card.
        <ul aria-label="Sites" className={cn('settings-rows', FOOTER_HAIRLINE)}>
          {sites.map((site) => {
            const domain = site.settings.domains[0] ?? site.settings.id;
            return (
              <li
                key={site.settings.id}
                aria-label={domain}
                className="flex flex-wrap items-center gap-3 px-4 py-3 transition-colors hover:bg-foreground/[0.03]"
              >
                <div className="min-w-0 flex-1">
                  <RouteMap site={site} now={now} onOpen={(tab) => onOpen(site.settings.id, tab)} />
                </div>
                <AppliedChip applied={site.applied} />
                <Button
                  type="button"
                  variant="soft"
                  size="sm"
                  aria-label={`Edit ${domain}`}
                  onClick={() => onOpen(site.settings.id, 'domains')}
                >
                  <Pencil className="h-3.5 w-3.5" /> {admin ? 'Edit' : 'View'}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
