import type { DeployWordPressSite } from '@shared/deployWordPressTypes';
import { FileText, RefreshCw, Spinner } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { DeployCard } from '../deployKit';
import { SetupFailure } from '../SetupFailure';
import { useSiteAudit } from './hooks';
import { AUDIT_EVENT_LABEL, AUDIT_EVENT_WARNS, siteTimeText, wpProblem } from './messages';

/**
 * The site's own audit log: key creation, connections, refused requests, pulls, deploys and
 * rollbacks, newest first, a page at a time. The same log shows in wp-admin. Every field comes
 * from the site, so it is shown as text only.
 */
export function AuditLogList({ site }: { site: DeployWordPressSite }): React.JSX.Element {
  const audit = useSiteAudit(site.id);
  const entries = audit.data?.pages.flat() ?? [];

  let body: React.ReactNode;
  if (audit.isPending) {
    body = (
      <div className="space-y-2" aria-busy="true">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-9 w-full rounded-lg" />
        ))}
      </div>
    );
  } else if (audit.isError) {
    body = (
      <div className="space-y-3">
        <SetupFailure message={wpProblem(audit.error)} />
        <Button size="sm" variant="soft" onClick={() => void audit.refetch()}>
          <RefreshCw /> Try again
        </Button>
      </div>
    );
  } else if (entries.length === 0) {
    body = <p className="text-sm text-muted-foreground">Nothing has been recorded yet.</p>;
  } else {
    body = (
      <div className="space-y-3">
        <div className="overflow-x-auto rounded-xl bg-foreground/[0.02] ring-1 ring-inset ring-foreground/[0.07]">
          <table className="w-full min-w-[36rem] border-collapse text-left text-xs">
            <caption className="sr-only">Audit log, newest first</caption>
            <thead className="bg-foreground/[0.04] text-muted-foreground">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">
                  When
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  What
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Connection
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  From
                </th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                // A hairline as an inset shadow, since a border would take the global colour.
                <tr
                  key={entry.id}
                  className="align-top [&>td]:shadow-[inset_0_1px_0_hsl(var(--foreground)/0.07)]"
                >
                  <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                    {siteTimeText(entry.at)}
                  </td>
                  <td className="max-w-[20rem] px-3 py-2">
                    <span
                      className={cn(
                        'block font-medium',
                        AUDIT_EVENT_WARNS.has(entry.event) ? 'text-warning' : 'text-foreground',
                      )}
                    >
                      {AUDIT_EVENT_LABEL[entry.event] ?? entry.event}
                    </span>
                    {entry.detail && (
                      <SimpleTooltip label={entry.detail}>
                        <span className="block truncate text-muted-foreground">{entry.detail}</span>
                      </SimpleTooltip>
                    )}
                  </td>
                  <td className="max-w-[12rem] truncate px-3 py-2 text-foreground">
                    {entry.connectionLabel ?? 'None'}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 font-mono text-muted-foreground">
                    {entry.ip}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {audit.hasNextPage && (
          <Button
            size="sm"
            variant="soft"
            disabled={audit.isFetchingNextPage}
            onClick={() => void audit.fetchNextPage()}
          >
            {audit.isFetchingNextPage && <Spinner className="motion-safe:animate-spin" />}
            Load older entries
          </Button>
        )}
      </div>
    );
  }

  return (
    <DeployCard
      icon={<FileText />}
      title="Audit log"
      description="What the connector recorded on the site, newest first: keys, connections, refused requests, pulls, deploys and rollbacks. wp-admin shows the same log under Tools > Runova Connector."
      actions={
        <Button
          size="sm"
          variant="soft"
          disabled={audit.isFetching}
          onClick={() => void audit.refetch()}
        >
          <RefreshCw /> Refresh
        </Button>
      }
    >
      {body}
    </DeployCard>
  );
}
