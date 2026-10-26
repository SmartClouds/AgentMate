import type { DeployWordPressSite } from '@shared/deployWordPressTypes';
import { wordPressErrorCode, wordPressErrorMessage } from '@shared/wordpressErrors';
import { CircleCheck, Plus } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { WordPressMark } from '@/components/wordpress/WordPressMark';
import { cn } from '@/lib/utils';
import { RunError } from './FlowParts';

/** A connected WordPress site to pick, with "Connect a new site" under the list (E21). */

export function siteHost(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/+$/, '');
}

export function SitePicker({
  sites,
  loading,
  error,
  selectedId,
  onSelect,
  onConnect,
  highlightUrl,
}: {
  sites: readonly DeployWordPressSite[] | undefined;
  loading: boolean;
  error: unknown;
  selectedId: string | null;
  onSelect: (site: DeployWordPressSite) => void;
  onConnect: () => void;
  /** A site at this address is marked as the likely match and listed first. */
  highlightUrl?: string;
}): React.JSX.Element {
  const match = highlightUrl ? siteHost(highlightUrl).toLowerCase() : null;
  const ordered = [...(sites ?? [])].sort((a, b) => {
    const aMatch = match !== null && siteHost(a.siteUrl).toLowerCase() === match ? 0 : 1;
    const bMatch = match !== null && siteHost(b.siteUrl).toLowerCase() === match ? 0 : 1;
    return aMatch - bMatch;
  });

  return (
    <div className="space-y-3">
      {loading ? (
        <div role="status" aria-label="Loading sites" className="space-y-1.5">
          <Skeleton className="h-14 w-full rounded-lg" />
          <Skeleton className="h-14 w-full rounded-lg" />
        </div>
      ) : error ? (
        <RunError message={wordPressErrorMessage(error)} code={wordPressErrorCode(error)} />
      ) : ordered.length === 0 ? (
        <p className="rounded-lg bg-foreground/[0.03] px-3 py-6 text-center text-sm text-muted-foreground ring-1 ring-inset ring-foreground/[0.07]">
          No WordPress sites are connected yet. Connect one with a key from the Runova Connector
          plugin.
        </p>
      ) : (
        <ul aria-label="Connected sites" className="space-y-1.5">
          {ordered.map((site) => {
            const selected = site.id === selectedId;
            const sameAddress = match !== null && siteHost(site.siteUrl).toLowerCase() === match;
            return (
              <li key={site.id}>
                <button
                  type="button"
                  aria-pressed={selected}
                  onClick={() => onSelect(site)}
                  className={cn(
                    'flex w-full cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 text-left ring-1 ring-inset transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    selected
                      ? 'bg-primary/10 ring-primary/40'
                      : 'bg-foreground/[0.03] ring-foreground/[0.07] hover:bg-foreground/[0.06]',
                  )}
                >
                  <WordPressMark className="h-5 w-5" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{site.label}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {siteHost(site.siteUrl)}
                    </span>
                  </span>
                  {sameAddress ? (
                    <span className="shrink-0 rounded-full bg-success/12 px-2 py-0.5 text-[10px] font-medium text-success">
                      Same address
                    </span>
                  ) : null}
                  {site.scope === 'read' ? (
                    <span className="shrink-0 rounded-full bg-foreground/[0.07] px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                      Read only
                    </span>
                  ) : null}
                  {selected ? <CircleCheck className="h-4 w-4 shrink-0 text-primary" /> : null}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <Button variant="outline" size="sm" onClick={onConnect}>
        <Plus className="h-3.5 w-3.5" /> Connect a new site
      </Button>
    </div>
  );
}
