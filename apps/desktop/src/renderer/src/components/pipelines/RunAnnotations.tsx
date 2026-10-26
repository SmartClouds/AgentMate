import type {
  GithubActionsHistoryItem,
  GithubRunAnnotation,
  GithubRunAnnotationLevel,
} from '@shared/apiTypes';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ChevronDown, CircleInfo, CircleX, Copy, TriangleAlert } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';

type AnnotatedRun = Pick<
  GithubActionsHistoryItem,
  | 'id'
  | 'repo'
  | 'status'
  | 'checkSuiteId'
  | 'displayTitle'
  | 'workflowName'
  | 'runNumber'
  | 'headBranch'
>;

const LEVEL_LABEL: Record<GithubRunAnnotationLevel, { one: string; many: string }> = {
  failure: { one: 'error', many: 'errors' },
  warning: { one: 'warning', many: 'warnings' },
  notice: { one: 'notice', many: 'notices' },
};

const LEVELS: GithubRunAnnotationLevel[] = ['failure', 'warning', 'notice'];

/**
 * Turns true once the element has come near the viewport, and stays true. Annotations cost a
 * couple of GitHub calls per run, so only the runs someone scrolls past are looked up.
 */
export function useSeenOnce<T extends Element>(): [(node: T | null) => void, boolean] {
  const nodeRef = useRef<T | null>(null);
  const [seen, setSeen] = useState(false);
  const bind = useCallback((node: T | null) => {
    nodeRef.current = node;
  }, []);

  useEffect(() => {
    const node = nodeRef.current;
    if (!node || seen) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setSeen(true);
      },
      { rootMargin: '200px 0px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [seen]);

  return [bind, seen];
}

/** A finished run's annotations. Running runs are skipped since their jobs are still writing them. */
export function useRunAnnotations(item: AnnotatedRun, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.runAnnotations(item.repo, item.id),
    queryFn: () =>
      window.runova.pipelines.runAnnotations({
        repo: item.repo,
        runId: item.id,
        checkSuiteId: item.checkSuiteId,
      }),
    enabled: enabled && item.status === 'completed',
    staleTime: Number.POSITIVE_INFINITY,
    retry: 1,
  });
}

function levelName(level: GithubRunAnnotationLevel): string {
  return level === 'failure' ? 'Error' : level === 'warning' ? 'Warning' : 'Notice';
}

function annotationLocation(item: GithubRunAnnotation): string {
  if (!item.path || item.path === '.github') return '';
  if (!item.startLine) return item.path;
  if (item.endLine && item.endLine !== item.startLine) {
    return `${item.path}:${item.startLine}-${item.endLine}`;
  }
  return `${item.path}:${item.startLine}`;
}

function annotationText(item: GithubRunAnnotation): string {
  const heading = item.title && item.title !== item.message ? `: ${item.title}` : '';
  return [
    `${levelName(item.level)}${heading}`,
    [item.jobName, annotationLocation(item)].filter(Boolean).join(' · '),
    item.message,
  ]
    .filter(Boolean)
    .join('\n');
}

function allAnnotationsText(run: AnnotatedRun, annotations: GithubRunAnnotation[]): string {
  const header = [
    `${run.displayTitle || run.workflowName || 'Workflow'} annotations`,
    [run.repo, `#${run.runNumber}`, run.headBranch].filter(Boolean).join(' · '),
  ].join('\n');
  return [header, ...annotations.map(annotationText)].join('\n\n');
}

/** Copies to the clipboard and says so with a toast, or says why it could not. */
export async function copyText(text: string, success: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(success);
  } catch (error) {
    toast.error(error instanceof Error ? error.message : 'Could not copy to the clipboard.');
  }
}

export function summarizeCounts(counts: Record<GithubRunAnnotationLevel, number>): string {
  return LEVELS.filter((level) => counts[level] > 0)
    .map((level) => {
      const count = counts[level];
      return `${count} ${count === 1 ? LEVEL_LABEL[level].one : LEVEL_LABEL[level].many}`;
    })
    .join(' · ');
}

function LevelIcon({
  level,
  className,
}: {
  level: GithubRunAnnotationLevel;
  className?: string;
}): React.JSX.Element {
  if (level === 'failure') {
    return <CircleX className={cn('h-3.5 w-3.5 text-destructive', className)} />;
  }
  if (level === 'warning') {
    return <TriangleAlert className={cn('h-3.5 w-3.5 text-warning', className)} />;
  }
  return <CircleInfo className={cn('h-3.5 w-3.5 text-muted-foreground', className)} />;
}

/**
 * The strip under a run card: a toggle that says what the run left behind, opening to the full
 * list with a copy button per annotation and one for all of them.
 */
export function RunAnnotations({
  run,
  annotations,
  counts,
  flush = false,
}: {
  run: AnnotatedRun;
  annotations: GithubRunAnnotation[];
  counts: Record<GithubRunAnnotationLevel, number>;
  /** Drops the indent that lines it up under a run card, for use on its own. */
  flush?: boolean;
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  if (annotations.length === 0) return null;

  const strongest: GithubRunAnnotationLevel =
    counts.failure > 0 ? 'failure' : counts.warning > 0 ? 'warning' : 'notice';

  return (
    // Lined up under the run title, past the status glyph.
    <div className={flush ? undefined : 'pb-2.5 pl-[3.125rem] pr-3'}>
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className={cn(
            'flex cursor-pointer items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors hover:bg-foreground/[0.06]',
            strongest === 'failure'
              ? 'text-destructive'
              : strongest === 'warning'
                ? 'text-warning'
                : 'text-muted-foreground',
          )}
        >
          <LevelIcon level={strongest} className="h-3 w-3 text-current" />
          <span>{summarizeCounts(counts)}</span>
          <ChevronDown
            className={cn('h-3 w-3 transition-transform', open ? 'rotate-180' : 'rotate-0')}
          />
        </button>
        {open ? (
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto gap-1 px-2.5 text-[11px]"
            onClick={() =>
              void copyText(
                allAnnotationsText(run, annotations),
                `${annotations.length} annotation${annotations.length === 1 ? '' : 's'} copied.`,
              )
            }
          >
            <Copy className="h-3 w-3" />
            Copy all
          </Button>
        ) : null}
      </div>

      {open ? (
        <ul className="mt-1.5 space-y-1.5">
          {annotations.map((item, index) => {
            const location = annotationLocation(item);
            return (
              <li
                // Annotations have no id of their own, and the list never reorders once loaded.
                key={index}
                className={cn(
                  // Rings, not borders: the theme's global border colour would hide the tint.
                  'flex items-start gap-2.5 rounded-xl px-3 py-2 ring-1 ring-inset',
                  item.level === 'failure'
                    ? 'bg-destructive/[0.04] ring-destructive/25'
                    : item.level === 'warning'
                      ? 'bg-warning/[0.06] ring-warning/30'
                      : 'bg-foreground/[0.025] ring-foreground/[0.08]',
                )}
              >
                <LevelIcon level={item.level} className="mt-0.5 shrink-0" />
                <div className="min-w-0 flex-1">
                  {item.title && item.title !== item.message ? (
                    <p className="text-xs font-medium leading-snug">{item.title}</p>
                  ) : null}
                  <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-foreground/90 select-text">
                    {item.message}
                  </p>
                  <p className="mt-1 flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
                    <span>{item.jobName}</span>
                    {location ? (
                      <>
                        <span aria-hidden>·</span>
                        <span className="break-all font-mono">{location}</span>
                      </>
                    ) : null}
                  </p>
                </div>
                <SimpleTooltip label="Copy this annotation">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="shrink-0"
                    aria-label="Copy annotation"
                    onClick={() => void copyText(annotationText(item), 'Annotation copied.')}
                  >
                    <Copy className="h-3 w-3" />
                  </Button>
                </SimpleTooltip>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
