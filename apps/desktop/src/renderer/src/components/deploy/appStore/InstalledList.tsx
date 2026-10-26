import { checkCatalogUpdate } from '@runova/core';
import { ChevronRight, RefreshCw } from '@/components/icons';
import { Chip, GLASS_CARD, SECTION_HEADING } from '@/components/pageKit';
import { Skeleton } from '@/components/ui/skeleton';
import { STATUS_TEXT, STATUS_TONE } from '@/lib/deploy/apps/format';
import { cn } from '@/lib/utils';
import { StatusPill } from '../apps/StatusPill';
import { GLASS_EDGE } from '../deployKit';
import type { InstalledStoreApp } from './hooks';

/** The apps this server got from the App Store, each with its status and any update waiting. */

export function InstalledList({
  apps,
  loading,
  onOpen,
}: {
  apps: InstalledStoreApp[];
  loading: boolean;
  onOpen: (stackId: string) => void;
}): React.JSX.Element | null {
  if (loading && apps.length === 0) {
    return (
      <div className={cn(GLASS_CARD, 'p-3')} aria-busy="true">
        <Skeleton className="h-10 w-full rounded-lg" />
      </div>
    );
  }
  if (apps.length === 0) return null;
  return (
    <section aria-label="Installed from the App Store" className="space-y-2">
      <h3 className={cn(SECTION_HEADING, 'px-1')}>Installed</h3>
      <ul className="grid gap-2 xl:grid-cols-2">
        {apps.map(({ stack, install }) => {
          const check = checkCatalogUpdate(install.template, install.installed);
          const waiting = check.status === 'update' || check.newerVersions.length > 0;
          const version = install.template.versions.find((item) => item.id === install.version);
          return (
            <li key={stack.id} aria-label={stack.name}>
              <button
                type="button"
                onClick={() => onOpen(stack.id)}
                className={cn(
                  GLASS_CARD,
                  GLASS_EDGE.interactive,
                  'flex w-full cursor-pointer items-center gap-3 px-3 py-2.5 text-left transition-[box-shadow]',
                )}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{stack.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {version?.label ?? `${install.template.name} ${install.version}`}
                    {install.domain ? ` on ${install.domain}` : ''}
                  </span>
                </span>
                {waiting && (
                  <Chip tone="primary">
                    <RefreshCw /> Update available
                  </Chip>
                )}
                <StatusPill tone={STATUS_TONE[stack.status]}>
                  {STATUS_TEXT[stack.status]}
                </StatusPill>
                <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
