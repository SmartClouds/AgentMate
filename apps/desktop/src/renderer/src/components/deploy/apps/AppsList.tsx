import type { StackInfo } from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { Blocks, FileCode, Key, Plus } from '@/components/icons';
import { CARD_GRID, EmptyState, GLASS_CARD, LoadFailure } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { STATUS_TEXT, STATUS_TONE } from '@/lib/deploy/apps/format';
import { cn } from '@/lib/utils';
import { StatusPill } from './StatusPill';

/** The apps on a server, as cards: what each runs, how it is doing and where it came from. */

export const OPERATOR_ONLY = 'Deploying and changing apps needs the Operator role or higher.';

function AppCardSkeleton(): React.JSX.Element {
  return (
    <div className={cn(GLASS_CARD, 'space-y-3 p-4')} aria-busy="true">
      <div className="flex items-center justify-between gap-3">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-5 w-16 rounded-full" />
      </div>
      <Skeleton className="h-4 w-48" />
      <Skeleton className="h-4 w-24" />
    </div>
  );
}

function NewAppButton({
  canOperate,
  onNew,
}: {
  canOperate: boolean;
  onNew: () => void;
}): React.JSX.Element {
  return (
    <SimpleTooltip label={canOperate ? null : OPERATOR_ONLY} wrapTrigger>
      <Button size="sm" onClick={onNew} disabled={!canOperate}>
        <Plus className="h-3.5 w-3.5" /> New app
      </Button>
    </SimpleTooltip>
  );
}

function AppCard({ app, onOpen }: { app: StackInfo; onOpen: () => void }): React.JSX.Element {
  const source = app.source;
  return (
    <li aria-label={app.name} className={GLASS_CARD}>
      {/* The hover wash sits on the button inside, since .glass owns the card's own surface. */}
      <button
        type="button"
        onClick={onOpen}
        className="group flex h-full w-full cursor-pointer flex-col gap-2 rounded-[inherit] p-4 text-left transition-colors hover:bg-foreground/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="flex w-full items-center gap-2">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/12 text-primary">
            <Blocks className="h-4 w-4" />
          </span>
          <span className="min-w-0 flex-1 truncate font-mono text-sm font-semibold text-foreground">
            {app.name}
          </span>
          <StatusPill tone={STATUS_TONE[app.status]}>{STATUS_TEXT[app.status]}</StatusPill>
        </span>
        {source?.projectName || source?.composePath ? (
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <FileCode className="h-3 w-3 shrink-0" />
            <span className="truncate">
              {[source.projectName, source.composePath].filter(Boolean).join(' / ')}
            </span>
          </span>
        ) : null}
        <span className="mt-auto flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>
            {app.liveRevision !== undefined ? `Revision ${app.liveRevision} live` : 'Nothing live'}
          </span>
          <span>
            {app.containers === 0
              ? 'No containers'
              : `${app.runningContainers} of ${app.containers} containers running`}
          </span>
        </span>
      </button>
    </li>
  );
}

export function AppsList({
  apps,
  loading,
  error,
  canOperate,
  onRetry,
  onOpen,
  onNew,
  onRegistries,
}: {
  apps: StackInfo[] | undefined;
  loading: boolean;
  error: string | null;
  canOperate: boolean;
  onRetry: () => void;
  onOpen: (stackId: string) => void;
  onNew: () => void;
  /** Opens the registry sign-ins for private images (E08). */
  onRegistries?: () => void;
}): React.JSX.Element {
  return (
    <section aria-labelledby="apps-heading" className="@container/grid flex flex-col gap-2">
      <div className={cn(GLASS_CARD, 'flex flex-wrap items-center gap-3 px-4 py-3')}>
        <div className="min-w-0 flex-1">
          <h3 id="apps-heading" className="text-sm font-semibold text-foreground">
            Apps
          </h3>
          <p className="text-xs text-muted-foreground">
            Compose apps from your projects. Their ports stay on this server; public access comes
            through Websites.
          </p>
        </div>
        {onRegistries && (
          <Button size="sm" variant="soft" onClick={onRegistries}>
            <Key className="h-3.5 w-3.5" /> Registries
          </Button>
        )}
        {apps && apps.length > 0 && <NewAppButton canOperate={canOperate} onNew={onNew} />}
      </div>
      {loading ? (
        <div className={CARD_GRID}>
          {Array.from({ length: 3 }, (_, index) => (
            <AppCardSkeleton key={index} />
          ))}
        </div>
      ) : !apps ? (
        <LoadFailure
          message={`The apps did not load${error ? `: ${error}` : '.'}`}
          retry={onRetry}
        />
      ) : apps.length === 0 ? (
        <EmptyState
          card
          size="lg"
          icon={Blocks}
          title="No apps on this server yet"
          description="Pick a project with a compose file and one of its environments. Every deploy is kept as a revision you can roll back to."
          action={<NewAppButton canOperate={canOperate} onNew={onNew} />}
        />
      ) : (
        <ul aria-label="Apps" className={CARD_GRID}>
          {apps.map((app) => (
            <AppCard key={app.id} app={app} onOpen={() => onOpen(app.id)} />
          ))}
        </ul>
      )}
    </section>
  );
}
