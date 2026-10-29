import type { GithubLogLineKind, GithubStepLog } from '@shared/apiTypes';
import { useEffect, useRef, useState } from 'react';
import { Check, Copy, ExternalLink, Wand2 } from '@/components/icons';
import { InlineProblem } from '@/components/pipelines/InlineProblem';
import { copyText } from '@/components/pipelines/RunAnnotations';
import { stepLogText } from '@/components/pipelines/stepLog';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { useVirtualRows } from '@/hooks/useVirtualRows';
import { cn } from '@/lib/utils';

/** Where a step's log is at: GitHub only has it once the whole job is done. */
export type StepLogState =
  | { kind: 'waiting' }
  | { kind: 'loading' }
  | { kind: 'error'; reason: string; retry: () => void }
  | { kind: 'ready'; log: GithubStepLog };

const ROW_HEIGHT = 18;

const KIND_CLASS: Record<GithubLogLineKind, string> = {
  error: 'bg-destructive/[0.08] text-destructive shadow-[inset_2px_0_0_hsl(var(--destructive))]',
  warning: 'bg-warning/[0.08] text-warning shadow-[inset_2px_0_0_hsl(var(--warning))]',
  notice: 'text-primary',
  group: 'font-semibold text-foreground',
  command: 'text-primary/80',
  plain: 'text-foreground/80',
};

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/** The next line of `kind` after `from`, wrapping round, so a count can be clicked through. */
function nextOfKind(log: GithubStepLog, kind: GithubLogLineKind, from: number | null): number {
  const { lines } = log;
  for (let step = 1; step <= lines.length; step++) {
    const index = ((from ?? -1) + step) % lines.length;
    if (lines[index].kind === kind) return index;
  }
  return -1;
}

function LogLines({
  label,
  log,
  current,
  scrollTo,
}: {
  label: string;
  log: GithubStepLog;
  current: number | null;
  /** Bumped to scroll a line into view, even the same one again. */
  scrollTo: { index: number } | null;
}): React.JSX.Element {
  const { lines } = log;
  const rows = useVirtualRows(lines.length, ROW_HEIGHT);
  const { scrollToIndex } = rows;

  useEffect(() => {
    // A few lines past the target come along, so what followed the error is in view too.
    if (scrollTo) scrollToIndex(Math.min(lines.length - 1, scrollTo.index + 3));
  }, [scrollTo, scrollToIndex, lines.length]);

  if (lines.length === 0) {
    return <p className="px-3 py-2.5 text-xs text-muted-foreground">This step printed nothing.</p>;
  }

  const digits = String(lines.length).length;
  return (
    <div
      ref={rows.containerRef}
      onScroll={rows.onScroll}
      aria-label={`${label} lines`}
      className="max-h-80 select-text overflow-auto py-1 font-mono text-[11px]"
      style={{ lineHeight: `${ROW_HEIGHT}px` }}
    >
      <div className="min-w-max" style={{ paddingTop: rows.padTop, paddingBottom: rows.padBottom }}>
        {lines.slice(rows.start, rows.end).map((line, offset) => {
          const index = rows.start + offset;
          return (
            <div
              key={index}
              data-kind={line.kind}
              data-current={current === index ? 'true' : undefined}
              className={cn(
                'flex whitespace-pre pr-4',
                KIND_CLASS[line.kind],
                current === index && 'bg-foreground/[0.1]',
              )}
              style={{ height: ROW_HEIGHT }}
            >
              {/* Left out of a selection, so copying a few lines by hand gives just the text. */}
              <span
                aria-hidden
                className="shrink-0 select-none pl-2 pr-3 text-right tabular-nums text-muted-foreground/45"
                style={{ width: `${digits + 3}ch` }}
              >
                {index + 1}
              </span>
              <span>{line.text}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * One step's output, opened under its row: the lines with errors and warnings picked out, counts
 * that jump to them, and ways to copy it, fix it with an agent, or see it on GitHub.
 */
export function StepLog({
  id,
  stepName,
  state,
  githubUrl,
  failed,
  onFix,
}: {
  id: string;
  stepName: string;
  state: StepLogState;
  /** The step on GitHub, which also streams the log of a job that is still running. */
  githubUrl: string | null;
  failed: boolean;
  /** Left out when there is no project to fix it in. */
  onFix?: () => void;
}): React.JSX.Element {
  const log = state.kind === 'ready' ? state.log : null;
  const [current, setCurrent] = useState<number | null>(null);
  const [scrollTo, setScrollTo] = useState<{ index: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const jumpedFor = useRef<GithubStepLog | null>(null);

  // A failed step opens on its first error rather than at the top of a long log.
  useEffect(() => {
    if (!log || !failed || log.errors === 0 || jumpedFor.current === log) return;
    jumpedFor.current = log;
    setScrollTo({ index: nextOfKind(log, 'error', null) });
  }, [log, failed]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  function jump(kind: GithubLogLineKind): void {
    if (!log) return;
    const index = nextOfKind(log, kind, current);
    if (index < 0) return;
    setCurrent(index);
    setScrollTo({ index });
  }

  const shell =
    'mb-1.5 ml-[1.625rem] mr-1 mt-0.5 overflow-hidden rounded-lg bg-foreground/[0.03] ring-1 ring-inset ring-foreground/[0.08]';

  if (state.kind === 'waiting') {
    return (
      <div id={id} role="region" aria-label={`${stepName} log`} className={shell}>
        <div className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
          <span className="min-w-0 flex-1">The log is ready once the job finishes.</span>
          {githubUrl ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => void window.runova.shell.openExternal(githubUrl)}
            >
              <ExternalLink />
              Watch it live on GitHub
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  const fixable = log !== null && (failed || log.errors > 0 || log.warnings > 0);
  return (
    <div id={id} role="region" aria-label={`${stepName} log`} className={shell}>
      <div className="flex min-h-8 items-center gap-1.5 px-2 py-1 shadow-[inset_0_-1px_0_hsl(var(--foreground)/0.06)]">
        <span className="pl-1 text-[10px] tabular-nums text-muted-foreground">
          {log
            ? plural(log.lines.length, 'line')
            : state.kind === 'loading'
              ? 'Reading the log…'
              : ''}
        </span>
        {log && log.errors > 0 ? (
          <SimpleTooltip label="Jump to the next error">
            <button
              type="button"
              onClick={() => jump('error')}
              className="cursor-pointer rounded-full bg-destructive/10 px-2 py-0.5 text-[10px] font-medium text-destructive outline-none transition-colors hover:bg-destructive/20 focus-visible:ring-2 focus-visible:ring-ring/60"
            >
              {plural(log.errors, 'error')}
            </button>
          </SimpleTooltip>
        ) : null}
        {log && log.warnings > 0 ? (
          <SimpleTooltip label="Jump to the next warning">
            <button
              type="button"
              onClick={() => jump('warning')}
              className="cursor-pointer rounded-full bg-warning/10 px-2 py-0.5 text-[10px] font-medium text-warning outline-none transition-colors hover:bg-warning/20 focus-visible:ring-2 focus-visible:ring-ring/60"
            >
              {plural(log.warnings, 'warning')}
            </button>
          </SimpleTooltip>
        ) : null}
        <div className="ml-auto flex items-center gap-0.5">
          {fixable && onFix ? (
            <Button type="button" variant="tint" size="xs" className="mr-1" onClick={onFix}>
              <Wand2 />
              Fix with AI
            </Button>
          ) : null}
          {log ? (
            <SimpleTooltip label={copied ? 'Copied' : 'Copy log'}>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={`Copy ${stepName} log`}
                onClick={() => {
                  void copyText(stepLogText(log), `${stepName} log copied.`);
                  setCopied(true);
                }}
              >
                {copied ? <Check className="text-success" /> : <Copy />}
              </Button>
            </SimpleTooltip>
          ) : null}
          {githubUrl ? (
            <SimpleTooltip label="Open step on GitHub">
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={`Open ${stepName} on GitHub`}
                onClick={() => void window.runova.shell.openExternal(githubUrl)}
              >
                <ExternalLink />
              </Button>
            </SimpleTooltip>
          ) : null}
        </div>
      </div>
      {state.kind === 'error' ? (
        <div className="p-2">
          <InlineProblem
            message="Could not load this log."
            reason={state.reason}
            onRetry={state.retry}
          />
        </div>
      ) : state.kind === 'loading' ? (
        <div data-testid="step-log-loading" className="space-y-1.5 p-3">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-3 rounded" style={{ width: `${92 - i * 15}%` }} />
          ))}
        </div>
      ) : (
        <LogLines label={stepName} log={state.log} current={current} scrollTo={scrollTo} />
      )}
    </div>
  );
}
