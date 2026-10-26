import type { ContainerSummary } from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, RefreshCw, Wand2 } from '@/components/icons';
import { SearchPill } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
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
import { TailPicker } from '../logs/TailPicker';
import { useContainerLog } from './hooks';

/**
 * A container's log (E06 T8), as plain text (it can hold anything a program printed): the last
 * few hundred lines (or as many as asked for), then every new one while following, with a search
 * that marks and steps through its matches. stderr lines say "err" in their own column, not only
 * in another colour.
 */

const LINE_HEIGHT = 20;

export function ContainerLogsTab({
  serverId,
  container,
  onSendToCli,
}: {
  serverId: string;
  container: ContainerSummary;
  onSendToCli?: () => void;
}): React.JSX.Element {
  const [follow, setFollow] = useState(container.state === 'running');
  const [run, setRun] = useState(0);
  const [tail, setTail] = useState(DEFAULT_TAIL);
  const [query, setQuery] = useState('');
  const [current, setCurrent] = useState(0);
  const log = useContainerLog(serverId, container.id, { follow, tail, run });
  const matches = useMemo(() => findMatches(log.lines, query), [log.lines, query]);
  const virtual = useVirtualRows(log.lines.length, LINE_HEIGHT, 20);
  const atBottom = useRef(true);
  const box = useRef<HTMLDivElement | null>(null);

  // While following, new lines keep the view at the bottom unless the user scrolled up to read.
  // biome-ignore lint/correctness/useExhaustiveDependencies: each new line is the trigger
  useEffect(() => {
    const element = box.current;
    if (!element || !follow || !atBottom.current || query) return;
    element.scrollTop = element.scrollHeight;
    virtual.onScroll();
  }, [log.lines.length, follow, query]);

  // A new search starts at its first match.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the search is the trigger
  useEffect(() => {
    setCurrent(0);
  }, [query]);

  const goTo = (next: number) => {
    if (matches.length === 0) return;
    const index = (next + matches.length) % matches.length;
    setCurrent(index);
    virtual.scrollToIndex(matches[index]);
  };

  const running = container.state === 'running';
  const status = log.error
    ? log.error
    : log.ended && follow
      ? running
        ? 'The log stream ended.'
        : 'The container stopped, so the log ends here.'
      : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <SearchPill
          label="Search the log"
          placeholder="Search the log"
          value={query}
          onValueChange={setQuery}
          onKeyDown={(event) => {
            if (event.key === 'Enter') goTo(event.shiftKey ? current - 1 : current + 1);
          }}
          className="min-w-48 flex-1"
        />
        {query && (
          <span className="text-xs tabular-nums text-muted-foreground" role="status">
            {matches.length === 0 ? 'No matches' : `${current + 1} of ${matches.length}`}
          </span>
        )}
        {query && matches.length > 1 && (
          <>
            <SimpleTooltip label="Previous match (Shift+Enter)">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Previous match"
                onClick={() => goTo(current - 1)}
              >
                <ArrowUp />
              </Button>
            </SimpleTooltip>
            <SimpleTooltip label="Next match (Enter)">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Next match"
                onClick={() => goTo(current + 1)}
              >
                <ArrowDown />
              </Button>
            </SimpleTooltip>
          </>
        )}
        <TailPicker
          value={tail}
          onChange={(next) => {
            atBottom.current = true;
            setTail(next);
          }}
        />
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <Switch
            checked={follow}
            onCheckedChange={(next) => {
              atBottom.current = true;
              setFollow(next);
            }}
            aria-label="Follow new lines"
          />
          Follow
        </label>
        {log.ended && (
          <Button size="sm" variant="soft" onClick={() => setRun((n) => n + 1)}>
            <RefreshCw className="h-3.5 w-3.5" /> Read again
          </Button>
        )}
        {onSendToCli && (
          <Button size="sm" variant="soft" onClick={onSendToCli} disabled={log.lines.length === 0}>
            <Wand2 className="h-3.5 w-3.5" /> Send to the project CLI
          </Button>
        )}
      </div>

      <div
        ref={(element) => {
          box.current = element;
          virtual.containerRef(element);
        }}
        onScroll={() => {
          const element = box.current;
          if (element) {
            atBottom.current =
              element.scrollHeight - element.scrollTop - element.clientHeight < LINE_HEIGHT * 2;
          }
          virtual.onScroll();
        }}
        className="min-h-48 flex-1 overflow-auto rounded-xl bg-background/70 py-1 font-mono text-[12px] ring-1 ring-inset ring-foreground/[0.08]"
        role="log"
        aria-label={`Log of ${container.name}`}
        aria-busy={!log.ready}
      >
        {!log.ready ? (
          <div className="space-y-2 p-3">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-3" style={{ width: `${90 - i * 8}%` }} />
            ))}
          </div>
        ) : log.lines.length === 0 ? (
          <p className="p-3 font-sans text-sm text-muted-foreground">
            {log.error ? 'Nothing to show.' : 'Nothing in the log yet.'}
          </p>
        ) : (
          <div style={{ paddingTop: virtual.padTop, paddingBottom: virtual.padBottom }}>
            {log.lines.slice(virtual.start, virtual.end).map((line, offset) => {
              const index = virtual.start + offset;
              const selected = matches[current] === index && query !== '';
              return (
                <div
                  key={`${line.timestamp}-${index}`}
                  style={{ height: LINE_HEIGHT }}
                  className={cn(
                    'flex items-center gap-2 whitespace-pre px-3 leading-5',
                    line.stream === 'stderr' && 'bg-destructive/5',
                    selected && 'bg-primary/10',
                  )}
                  data-stream={line.stream}
                >
                  <span className="shrink-0 text-muted-foreground/80">
                    {clockTime(line.atUnixMs)}
                  </span>
                  <span
                    className={cn(
                      'w-6 shrink-0 text-[10px] uppercase',
                      line.stream === 'stderr' ? 'text-destructive' : 'text-muted-foreground/60',
                    )}
                  >
                    {line.stream === 'stderr' ? 'err' : 'out'}
                  </span>
                  <span className="text-foreground">
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
      {status && (
        <p
          role="status"
          className={cn('text-xs', log.error ? 'text-destructive' : 'text-muted-foreground')}
        >
          {status}
        </p>
      )}
    </div>
  );
}
