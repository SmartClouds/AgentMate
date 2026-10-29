import type { DockerContainer, DockerLogLine } from '@shared/apiTypes';
import { useEffect, useMemo, useRef, useState } from 'react';
import { TailPicker } from '@/components/deploy/logs/TailPicker';
import {
  ArrowDown,
  ArrowUp,
  Check,
  Clock,
  Copy,
  Download,
  FileText,
  Pause,
  RefreshCw,
  TriangleAlert,
} from '@/components/icons';
import { Chip, EmptyState, FOOTER_HAIRLINE, SearchPill } from '@/components/pageKit';
import { copyText } from '@/components/pipelines/RunAnnotations';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { useVirtualRows } from '@/hooks/useVirtualRows';
import {
  clockTime,
  DEFAULT_TAIL,
  findMatches,
  highlight,
  plain,
} from '@/lib/deploy/containers/logs';
import { cn } from '@/lib/utils';
import { logAsText, logFileName } from './containerLogs';
import { STATE_LABEL, STATE_TONE } from './DockerContainerRow';
import { useDockerLogs } from './useDockerLogs';

const LINE_HEIGHT = 20;
/** Within this much of the end, the view counts as at the bottom and keeps up with new lines. */
const BOTTOM_SLACK = LINE_HEIGHT * 2;

function plural(count: number, word: string): string {
  return `${count.toLocaleString('en-US')} ${word}${count === 1 ? '' : 's'}`;
}

function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

/** The next stderr line after `from`, wrapping round, so the count can be clicked through. */
function nextStderr(lines: readonly DockerLogLine[], from: number | null): number {
  for (let step = 1; step <= lines.length; step++) {
    const index = ((from ?? -1) + step) % lines.length;
    if (lines[index].stream === 'stderr') return index;
  }
  return -1;
}

/** Live, paused or not running, as a chip at the start of the footer. */
function FollowState({ running, follow }: { running: boolean; follow: boolean }) {
  if (!running) return <Chip>Not running</Chip>;
  if (!follow) {
    return (
      <Chip>
        <Pause />
        Paused
      </Chip>
    );
  }
  return (
    <Chip tone="success" dot pulse>
      Live
    </Chip>
  );
}

function LogSkeleton(): React.JSX.Element {
  return (
    <div className="space-y-2.5 p-4" data-testid="container-log-loading">
      {Array.from({ length: 9 }, (_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="h-3 w-6 shrink-0 rounded" />
          <Skeleton className="h-3 w-14 shrink-0 rounded" />
          <Skeleton className="h-3 rounded" style={{ width: `${88 - ((i * 23) % 50)}%` }} />
        </div>
      ))}
    </div>
  );
}

function ContainerLogs({ container }: { container: DockerContainer }): React.JSX.Element {
  const running = container.state === 'running';
  const [wantFollow, setWantFollow] = useState(true);
  const follow = running && wantFollow;
  const [tail, setTail] = useState(DEFAULT_TAIL);
  const [showTimes, setShowTimes] = useState(true);
  const [query, setQuery] = useState('');
  const [match, setMatch] = useState(0);
  const [stderrAt, setStderrAt] = useState<number | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [copied, setCopied] = useState(false);
  const log = useDockerLogs(container.id, { tail, follow });
  const { lines } = log;

  const matches = useMemo(() => findMatches(lines, query), [lines, query]);
  const stderrCount = useMemo(
    () => lines.reduce((count, line) => count + (line.stream === 'stderr' ? 1 : 0), 0),
    [lines],
  );
  const virtual = useVirtualRows(lines.length, LINE_HEIGHT, 20);
  const box = useRef<HTMLDivElement | null>(null);
  const search = useRef<HTMLInputElement | null>(null);
  const stickToBottom = useRef(true);

  const searching = query.trim() !== '';
  const current = searching ? (matches[match] ?? null) : stderrAt;

  const scrollToEnd = () => {
    const element = box.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
    stickToBottom.current = true;
    setAtBottom(true);
    virtual.onScroll();
  };

  // A log reads from the end: the first lines in, and every new one while following, keep the
  // view at the bottom unless the user scrolled up to read.
  // biome-ignore lint/correctness/useExhaustiveDependencies: each new line is the trigger
  useEffect(() => {
    if (stickToBottom.current && !searching) scrollToEnd();
  }, [lines.length, log.status]);

  // A new search starts at its first match.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the search is the trigger
  useEffect(() => {
    setMatch(0);
  }, [query]);

  useEffect(() => {
    if (searching && matches.length > 0) {
      stickToBottom.current = false;
      virtual.scrollToIndex(matches[Math.min(match, matches.length - 1)]);
    }
  }, [searching, matches, match, virtual.scrollToIndex]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  const goToMatch = (next: number) => {
    if (matches.length === 0) return;
    setMatch((next + matches.length) % matches.length);
  };

  const goToStderr = () => {
    const index = nextStderr(lines, stderrAt);
    if (index < 0) return;
    setQuery('');
    setStderrAt(index);
    stickToBottom.current = false;
    virtual.scrollToIndex(index);
  };

  const onScroll = () => {
    const element = box.current;
    if (element) {
      const bottom = element.scrollHeight - element.scrollTop - element.clientHeight < BOTTOM_SLACK;
      stickToBottom.current = bottom;
      setAtBottom(bottom);
    }
    virtual.onScroll();
  };

  const digits = String(Math.max(lines.length, 1)).length;
  const ready = log.status === 'ready';

  return (
    <DialogContent
      className="flex h-[min(82vh,800px)] max-w-5xl flex-col gap-0 overflow-hidden p-0"
      onKeyDown={(event) => {
        // The browser's own find can't see lines drawn a screenful at a time, so Ctrl+F goes
        // to the log's search instead.
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
          event.preventDefault();
          search.current?.focus();
          search.current?.select();
        }
      }}
    >
      <DialogHeader className="flex-row items-center gap-3 px-5 pb-3 pr-14 pt-5">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/12 text-primary shadow-[0_0_18px_-8px_hsl(var(--primary)/0.8)]">
          <FileText className="h-[18px] w-[18px]" />
        </span>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-w-0 items-center gap-2">
            <DialogTitle className="truncate text-base">{container.name}</DialogTitle>
            <Chip tone={STATE_TONE[container.state]} dot={running}>
              {STATE_LABEL[container.state]}
            </Chip>
          </div>
          <DialogDescription className="truncate text-xs">
            <span className="font-mono">{container.image}</span> · {container.status}
          </DialogDescription>
        </div>
      </DialogHeader>

      <div className="flex flex-wrap items-center gap-2 px-5 pb-3">
        <SearchPill
          ref={search}
          label="Search the log"
          placeholder="Search the log"
          value={query}
          onValueChange={setQuery}
          onKeyDown={(event) => {
            if (event.key === 'Enter') goToMatch(event.shiftKey ? match - 1 : match + 1);
          }}
          className="min-w-48 max-w-sm flex-1"
          trailing={
            searching ? (
              <span
                role="status"
                className="shrink-0 pr-1 text-[11px] tabular-nums text-muted-foreground"
              >
                {matches.length === 0 ? 'No matches' : `${match + 1} of ${matches.length}`}
              </span>
            ) : null
          }
        />
        {searching && matches.length > 1 && (
          <div className="flex items-center">
            <SimpleTooltip label="Previous match (Shift+Enter)">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Previous match"
                onClick={() => goToMatch(match - 1)}
              >
                <ArrowUp />
              </Button>
            </SimpleTooltip>
            <SimpleTooltip label="Next match (Enter)">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Next match"
                onClick={() => goToMatch(match + 1)}
              >
                <ArrowDown />
              </Button>
            </SimpleTooltip>
          </div>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <TailPicker
            value={tail}
            onChange={(next) => {
              stickToBottom.current = true;
              setStderrAt(null);
              setTail(next);
            }}
          />
          <SimpleTooltip label={showTimes ? 'Hide times' : 'Show times'}>
            <Button
              variant={showTimes ? 'tint' : 'ghost'}
              size="icon-sm"
              aria-label="Show times"
              aria-pressed={showTimes}
              onClick={() => setShowTimes((shown) => !shown)}
            >
              <Clock />
            </Button>
          </SimpleTooltip>
          <SimpleTooltip
            label={
              running ? 'Keep reading new lines as they come' : 'Start the container to follow it'
            }
          >
            <label
              className={cn(
                'flex h-8 items-center gap-2 rounded-full bg-foreground/[0.04] pl-1.5 pr-3 text-xs',
                running ? 'cursor-pointer text-foreground' : 'text-muted-foreground',
              )}
            >
              <Switch
                checked={follow}
                disabled={!running}
                onCheckedChange={(next) => {
                  if (next) scrollToEnd();
                  setWantFollow(next);
                }}
                aria-label="Follow new lines"
              />
              Follow
            </label>
          </SimpleTooltip>
        </div>
      </div>

      <div className="relative mx-5 min-h-0 flex-1">
        <div
          ref={(element) => {
            box.current = element;
            virtual.containerRef(element);
          }}
          onScroll={onScroll}
          role="log"
          aria-label={`Log of ${container.name}`}
          aria-busy={log.status === 'loading'}
          className="h-full select-text overflow-auto rounded-xl bg-background/70 py-1.5 font-mono text-[12px] ring-1 ring-inset ring-foreground/[0.08]"
          style={{ lineHeight: `${LINE_HEIGHT}px` }}
        >
          {log.status === 'loading' ? (
            <LogSkeleton />
          ) : log.status === 'error' ? (
            <div role="alert" className="flex h-full items-center justify-center font-sans">
              <EmptyState
                size="sm"
                icon={TriangleAlert}
                title="Couldn't read this log"
                description={
                  <span className="block max-w-md break-words font-mono text-xs">{log.error}</span>
                }
                action={
                  <Button variant="soft" size="sm" onClick={log.reload}>
                    <RefreshCw className="h-3.5 w-3.5" />
                    Try again
                  </Button>
                }
              />
            </div>
          ) : lines.length === 0 ? (
            <div className="flex h-full items-center justify-center font-sans">
              <EmptyState
                size="sm"
                icon={FileText}
                title="Nothing logged yet"
                description={
                  follow
                    ? `${container.name} hasn't printed anything. New lines show up here as they come.`
                    : `${container.name} hasn't printed anything.`
                }
              />
            </div>
          ) : (
            <div
              className="min-w-max"
              style={{ paddingTop: virtual.padTop, paddingBottom: virtual.padBottom }}
            >
              {lines.slice(virtual.start, virtual.end).map((line, offset) => {
                const index = virtual.start + offset;
                const stderr = line.stream === 'stderr';
                const isCurrent = current === index;
                return (
                  <div
                    key={`${line.timestamp}-${index}`}
                    data-stream={line.stream}
                    data-current={isCurrent ? 'true' : undefined}
                    style={{ height: LINE_HEIGHT }}
                    className={cn(
                      'flex whitespace-pre pr-4 transition-colors hover:bg-foreground/[0.04]',
                      stderr &&
                        'bg-destructive/[0.05] shadow-[inset_2px_0_0_hsl(var(--destructive)/0.7)]',
                      isCurrent && 'bg-primary/[0.12] hover:bg-primary/[0.14]',
                    )}
                  >
                    {/* Left out of a selection, so copying a few lines by hand gives just the text. */}
                    <span
                      aria-hidden
                      className="shrink-0 select-none pl-3 pr-3 text-right tabular-nums text-muted-foreground/40"
                      style={{ width: `${digits + 4}ch` }}
                    >
                      {index + 1}
                    </span>
                    {showTimes && (
                      <span className="shrink-0 select-none pr-3 tabular-nums text-muted-foreground/75">
                        {clockTime(line.atUnixMs)}
                      </span>
                    )}
                    <span className={stderr ? 'text-destructive/90' : 'text-foreground/90'}>
                      {highlight(plain(line.text), query).map((piece, i) =>
                        piece.match ? (
                          <mark key={i} className="rounded-sm bg-warning/40 text-foreground">
                            {piece.text}
                          </mark>
                        ) : (
                          <span key={i}>{piece.text}</span>
                        ),
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        {!atBottom && lines.length > 0 && (
          <Button
            size="sm"
            shape="pill"
            className="absolute bottom-3 left-1/2 h-7 -translate-x-1/2 gap-1.5 px-3 text-xs shadow-lg motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-1"
            onClick={() => {
              setStderrAt(null);
              setQuery('');
              scrollToEnd();
            }}
          >
            <ArrowDown className="h-3 w-3" />
            Jump to latest
          </Button>
        )}
      </div>

      <div
        className={cn('mt-3 flex min-h-12 items-center gap-2 px-5 py-2.5 text-xs', FOOTER_HAIRLINE)}
      >
        <FollowState running={running} follow={follow} />
        {ready && (
          <span className="tabular-nums text-muted-foreground">{plural(lines.length, 'line')}</span>
        )}
        {ready && stderrCount > 0 && (
          <SimpleTooltip label="Jump to the next stderr line">
            <button
              type="button"
              onClick={goToStderr}
              className="cursor-pointer rounded-full bg-destructive/10 px-2 py-0.5 text-[11px] font-medium tabular-nums text-destructive outline-none transition-colors hover:bg-destructive/20 focus-visible:ring-2 focus-visible:ring-ring/60"
            >
              {`${stderrCount.toLocaleString('en-US')} from stderr`}
            </button>
          </SimpleTooltip>
        )}
        {ready && log.error && (
          <SimpleTooltip label={log.error} className="max-w-sm" wrapTrigger>
            <span className="flex min-w-0 items-center gap-1.5 text-warning">
              <TriangleAlert className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">Lost touch with docker, retrying</span>
            </span>
          </SimpleTooltip>
        )}
        <div className="ml-auto flex items-center gap-0.5">
          <SimpleTooltip label={copied ? 'Copied' : 'Copy log'}>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Copy log"
              disabled={!ready || lines.length === 0}
              onClick={() => {
                void copyText(
                  logAsText(lines, { timestamps: showTimes }),
                  `Log of ${container.name} copied.`,
                );
                setCopied(true);
              }}
            >
              {copied ? <Check className="text-success" /> : <Copy />}
            </Button>
          </SimpleTooltip>
          <SimpleTooltip label="Save as a file">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Download log"
              disabled={!ready || lines.length === 0}
              onClick={() => download(logFileName(container.name, new Date()), logAsText(lines))}
            >
              <Download />
            </Button>
          </SimpleTooltip>
        </div>
      </div>
    </DialogContent>
  );
}

/**
 * One local container's log in a roomy dialog: the last lines first, then new ones live while it
 * runs, stderr marked in its own colour, a search that marks and steps through matches, and
 * ways to copy or save what is shown. Open while `container` is set; the caller passes the
 * freshest copy of it, so the state shown follows the container list.
 */
export function ContainerLogsDialog({
  container,
  onOpenChange,
}: {
  container: DockerContainer | null;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  // The last container stays on screen while the dialog fades out.
  const [shown, setShown] = useState(container);
  useEffect(() => {
    if (container) setShown(container);
  }, [container]);
  const target = container ?? shown;

  return (
    <Dialog open={container !== null} onOpenChange={onOpenChange}>
      {target && <ContainerLogs key={target.id} container={target} />}
    </Dialog>
  );
}
