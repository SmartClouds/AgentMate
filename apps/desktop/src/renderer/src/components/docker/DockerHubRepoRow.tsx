import type { DockerHubRepository, DockerHubTag } from '@shared/apiTypes';
import { coreErrorMessage } from '@shared/coreErrors';
import { useQuery } from '@tanstack/react-query';
import { useId } from 'react';
import {
  ChevronRight,
  CloudDownload,
  Download,
  Globe,
  Lock,
  Package,
  Spinner,
  Star,
  Tag,
} from '@/components/icons';
import { Chip } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { formatBytes } from '@/lib/format';
import { queryKeys } from '@/lib/queryKeys';
import { shortAge } from '@/lib/time';
import { cn } from '@/lib/utils';
import { hubReference } from './images';

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

function agoText(ms: number | null): string {
  if (ms === null) return 'never';
  return Date.now() - ms < 60_000 ? 'just now' : `${shortAge(ms)} ago`;
}

function TagRow({
  repository,
  tag,
  onMachine,
  pulling,
  onPull,
}: {
  repository: DockerHubRepository;
  tag: DockerHubTag;
  onMachine: boolean;
  pulling: boolean;
  onPull: () => void;
}): React.JSX.Element {
  const ref = hubReference(repository.namespace, repository.name, tag.name);
  return (
    <li
      aria-label={tag.name}
      className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 pl-12 pr-3.5"
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <Tag className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
        <span className="truncate font-mono text-xs text-foreground">{tag.name}</span>
        {onMachine && <Chip tone="success">On this machine</Chip>}
      </span>
      <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
        {tag.platforms.join(', ')}
      </span>
      <span className="w-16 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
        {tag.sizeBytes === null ? '?' : formatBytes(tag.sizeBytes)}
      </span>
      <span className="w-20 shrink-0 text-right text-xs text-muted-foreground">
        {agoText(tag.lastPushed)}
      </span>
      <Button
        size="xs"
        variant={onMachine ? 'ghost' : 'soft'}
        className="w-24 shrink-0"
        disabled={pulling}
        aria-busy={pulling}
        aria-label={`Pull ${ref}`}
        onClick={onPull}
      >
        {pulling ? (
          <Spinner className="h-3 w-3 motion-safe:animate-spin" />
        ) : (
          <CloudDownload className="h-3 w-3" />
        )}
        {pulling ? 'Pulling…' : onMachine ? 'Pull again' : 'Pull'}
      </Button>
    </li>
  );
}

function TagList({
  repository,
  localRefs,
  pulling,
  onPull,
}: {
  repository: DockerHubRepository;
  localRefs: Set<string>;
  pulling: Set<string>;
  onPull: (tag: DockerHubTag) => void;
}): React.JSX.Element {
  const tags = useQuery({
    queryKey: queryKeys.dockerHubTags(repository.namespace, repository.name),
    queryFn: () => window.runova.dockerHub.tags(repository.namespace, repository.name),
    // Opening and closing a repository again should not ask Hub every time.
    staleTime: 60_000,
    retry: false,
  });
  const name = `${repository.namespace}/${repository.name}`;

  if (tags.isPending) {
    return (
      <div
        className="space-y-2 py-2.5 pl-12 pr-3.5"
        role="status"
        aria-label={`Loading tags of ${name}`}
      >
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    );
  }
  if (tags.error) {
    return (
      <div
        role="alert"
        className="flex items-center gap-2 py-2.5 pl-12 pr-3.5 text-xs text-destructive"
      >
        <span className="min-w-0 flex-1">{coreErrorMessage(tags.error)}</span>
        <Button size="xs" variant="soft" onClick={() => void tags.refetch()}>
          Try again
        </Button>
      </div>
    );
  }
  if (tags.data.length === 0) {
    return <p className="py-2.5 pl-12 pr-3.5 text-xs text-muted-foreground">No tags pushed yet.</p>;
  }
  return (
    <ul aria-label={`Tags of ${name}`} className="settings-rows">
      {tags.data.map((tag) => {
        const ref = hubReference(repository.namespace, repository.name, tag.name);
        return (
          <TagRow
            key={tag.name}
            repository={repository}
            tag={tag}
            onMachine={localRefs.has(ref)}
            pulling={pulling.has(ref)}
            onPull={() => onPull(tag)}
          />
        );
      })}
    </ul>
  );
}

/**
 * One repository of the signed-in account. The whole header is the button that opens it, and
 * its tags are read from Hub only once it is open.
 */
export function DockerHubRepoRow({
  repository,
  open,
  localRefs,
  pulling,
  onToggle,
  onPull,
}: {
  repository: DockerHubRepository;
  open: boolean;
  localRefs: Set<string>;
  /** References being pulled right now, as `hubReference` spells them. */
  pulling: Set<string>;
  onToggle: () => void;
  onPull: (tag: DockerHubTag) => void;
}): React.JSX.Element {
  const panelId = useId();
  return (
    <li aria-label={`${repository.namespace}/${repository.name}`}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={onToggle}
        className="flex w-full cursor-pointer items-center gap-3 px-3.5 py-3 text-left outline-none transition-colors hover:bg-foreground/[0.03] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <ChevronRight
          aria-hidden
          className={cn(
            'h-3 w-3 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none',
            open && 'rotate-90',
          )}
        />
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/12 text-primary">
          <Package className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1 space-y-1">
          <span className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span className="min-w-0 truncate text-sm">
              <span className="text-muted-foreground">{repository.namespace}/</span>
              <span className="font-medium text-foreground">{repository.name}</span>
            </span>
            {repository.isPrivate ? (
              <Chip tone="warning">
                <Lock aria-hidden /> Private
              </Chip>
            ) : (
              <Chip>
                <Globe aria-hidden /> Public
              </Chip>
            )}
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            {repository.description || 'No description'}
          </span>
        </span>
        <span className="hidden shrink-0 items-center gap-3 text-xs tabular-nums text-muted-foreground sm:flex">
          <span className="flex items-center gap-1">
            <Star className="h-3 w-3" aria-hidden />
            <span>{compact.format(repository.starCount)}</span>
            <span className="sr-only"> stars</span>
          </span>
          <span className="flex items-center gap-1">
            <Download className="h-3 w-3" aria-hidden />
            <span>{compact.format(repository.pullCount)}</span>
            <span className="sr-only"> pulls</span>
          </span>
          <span className="w-24 text-right">Pushed {agoText(repository.lastUpdated)}</span>
        </span>
      </button>
      <div
        id={panelId}
        hidden={!open}
        className="bg-foreground/[0.02] shadow-[inset_0_1px_0_hsl(var(--foreground)/0.06)]"
      >
        {open && (
          <TagList
            repository={repository}
            localRefs={localRefs}
            pulling={pulling}
            onPull={onPull}
          />
        )}
      </div>
    </li>
  );
}
