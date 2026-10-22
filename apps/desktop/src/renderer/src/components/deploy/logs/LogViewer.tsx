import type {
  ContainerList,
  SiteInfo,
} from '@shared/deploy/protocol/generated/AgentMate.ServerCore.Contracts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Download, RefreshCw, Robot } from '@/components/icons';
import { SearchPill } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { useVirtualRows } from '@/hooks/useVirtualRows';
import { useChartColors } from '@/lib/chartColors';
import {
  clockTime,
  DEFAULT_TAIL,
  highlight,
  MAX_TEXT_LOG_TAIL,
} from '@/lib/deploy/containers/logs';
import {
  entriesAsText,
  filterEntries,
  type LogLevel,
  matchingEntries,
  rangeStart,
  TIME_RANGES,
  type TimeRange,
} from '@/lib/deploy/logs/entries';
import { cn } from '@/lib/utils';
import { LogSourcePicker, parseSourceValue } from './LogSourcePicker';
import { TailPicker } from './TailPicker';
import { type LogSource, MAX_STACK_SERVICES, useLogSource } from './useLogSource';

/**
 * The logs center's viewer (E09 T1): one source at a time, followed live, with a search that
 * marks and steps through matches, a level filter (levels read from each line, shown in words),
 * a time range, how many lines to start with, and a download of what is shown. Every line is
 * plain text: it comes from the server and could say anything. Scoped to one app, it offers only
 * that app's logs.
 */

const LINE_HEIGHT = 20;
const LEVELS: ReadonlyArray<{ value: LogLevel; label: string }> = [
  { value: 'debug', label: 'Every level' },
  { value: 'info', label: 'Info and above' },
  { value: 'warn', label: 'Warnings and errors' },
  { value: 'error', label: 'Errors only' },
];
const LEVEL_WORD: Record<LogLevel, string> = {
  debug: 'dbg',
  info: 'info',
  warn: 'warn',
  error: 'err',
};

function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export function LogViewer({
  serverId,
  containers,
  sites,
  initial,
  scope,
  onAskAi,
}: {
  serverId: string;
  containers: ContainerList | undefined;
  sites: readonly SiteInfo[] | undefined;
  /** The source to start on, as LogSourcePicker writes it. */
  initial?: string;
  /** 'stack' keeps the choice to the app in `containers`. */
  scope?: 'stack';
  onAskAi?: (source: LogSource) => void;
}): React.JSX.Element {
  const [value, setValue] = useState(initial ?? 'journal:docker.service');
  const [follow, setFollow] = useState(true);
  const [run, setRun] = useState(0);
  const [tail, setTail] = useState(DEFAULT_TAIL);
  const [query, setQuery] = useState('');
  const [minLevel, setMinLevel] = useState<LogLevel>('debug');
  const [range, setRange] = useState<TimeRange>('all');
  const [current, setCurrent] = useState(0);
  const source = useMemo(
    () => parseSourceValue(value, containers, sites),
    [value, containers, sites],
  );
  const live = useLogSource(serverId, source, { follow, run, tail });
  const textLog = source?.kind === 'journal' || source?.kind === 'site';
  const shown = useMemo(
    () => filterEntries(live.entries, { minLevel, since: rangeStart(range, Date.now()) }),
    [live.entries, minLevel, range],
  );
  const matches = useMemo(() => matchingEntries(shown, query), [shown, query]);
  const virtual = useVirtualRows(shown.length, LINE_HEIGHT, 20);
  const box = useRef<HTMLDivElement | null>(null);
  const atBottom = useRef(true);
  const { categorical } = useChartColors();
  // An app's services each get a colour of the categorical palette, with their name beside it.
  const serviceColor = useMemo(() => {
    const origins = source?.kind === 'stack' ? source.containers.map((item) => item.service) : [];
    return (origin: string) =>
      categorical[Math.max(0, origins.indexOf(origin)) % categorical.length];
  }, [source, categorical]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: each new line is the trigger
  useEffect(() => {
    const element = box.current;
    if (!element || !follow || !atBottom.current || query) return;
    element.scrollTop = element.scrollHeight;
    virtual.onScroll();
  }, [shown.length, follow, query]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the search is the trigger
  useEffect(() => setCurrent(0), [query]);

  const goTo = (next: number) => {
    if (matches.length === 0) return;
    const index = (next + matches.length) % matches.length;
    setCurrent(index);
    virtual.scrollToIndex(matches[index] ?? 0);
  };
  const label = source?.label ?? 'log';

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <LogSourcePicker
          value={value}
          containers={containers}
          sites={sites}
          scope={scope}
          onChange={setValue}
        />
        <Combobox
          className="h-8 w-44 text-xs"
          value={minLevel}
          onChange={(next) => setMinLevel(next as LogLevel)}
          options={LEVELS.map((level) => ({ value: level.value, label: level.label }))}
          ariaLabel="Level"
        />
        <Combobox
          className="h-8 w-40 text-xs"
          value={range}
          onChange={(next) => setRange(next as TimeRange)}
          options={TIME_RANGES.map((item) => ({ value: item.value, label: item.label }))}
          ariaLabel="Time range"
        />
        {source?.kind !== 'audit' && (
          <TailPicker
            value={tail}
            max={textLog ? MAX_TEXT_LOG_TAIL : undefined}
            onChange={(next) => {
              atBottom.current = true;
              setTail(next);
            }}
          />
        )}
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
        <Button variant="soft" onClick={() => setRun((n) => n + 1)}>
          <RefreshCw /> Read again
        </Button>
        <Button
          variant="soft"
          disabled={shown.length === 0}
          onClick={() => download(`${label.replace(/[^\w.-]+/g, '-')}.log`, entriesAsText(shown))}
        >
          <Download /> Download
        </Button>
        {onAskAi && source && (
          <Button onClick={() => onAskAi(source)}>
            <Robot /> Ask the AI
          </Button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <SearchPill
          value={query}
          onValueChange={setQuery}
          onKeyDown={(event) => {
            if (event.key === 'Enter') goTo(event.shiftKey ? current - 1 : current + 1);
          }}
          placeholder="Search the log"
          label="Search the log"
          className="min-w-48 flex-1"
        />
        {query && (
          <span className="text-xs tabular-nums text-muted-foreground" role="status">
            {matches.length === 0 ? 'No matches' : `${current + 1} of ${matches.length}`}
          </span>
        )}
        {query && matches.length > 1 && (
          <>
            <SimpleTooltip label="Previous match">
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Previous match"
                onClick={() => goTo(current - 1)}
              >
                <ArrowUp />
              </Button>
            </SimpleTooltip>
            <SimpleTooltip label="Next match">
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Next match"
                onClick={() => goTo(current + 1)}
              >
                <ArrowDown />
              </Button>
            </SimpleTooltip>
          </>
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
        className="min-h-72 flex-1 overflow-auto rounded-xl bg-background/60 py-1 font-mono text-[12px] ring-1 ring-inset ring-foreground/[0.08]"
        role="log"
        aria-label={`Log: ${label}`}
        aria-busy={!live.ready}
      >
        {!source ? (
          <p className="p-3 font-sans text-sm text-muted-foreground">Choose a log to read.</p>
        ) : !live.ready ? (
          <div className="space-y-2 p-3">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-3" style={{ width: `${90 - i * 8}%` }} />
            ))}
          </div>
        ) : shown.length === 0 ? (
          <p className="p-3 font-sans text-sm text-muted-foreground">
            {live.entries.length > 0 ? 'No line matches the filters.' : 'Nothing in this log yet.'}
          </p>
        ) : (
          <div style={{ paddingTop: virtual.padTop, paddingBottom: virtual.padBottom }}>
            {shown.slice(virtual.start, virtual.end).map((entry, offset) => {
              const index = virtual.start + offset;
              const selected = query !== '' && matches[current] === index;
              return (
                <div
                  key={entry.key}
                  style={{ height: LINE_HEIGHT }}
                  data-level={entry.level}
                  className={cn(
                    'flex items-center gap-2 whitespace-pre px-3 leading-5',
                    entry.level === 'error' && 'bg-destructive/5',
                    selected && 'bg-primary/10',
                  )}
                >
                  <span className="shrink-0 text-muted-foreground/80">
                    {entry.atUnixMs === null ? '--:--:--' : clockTime(entry.atUnixMs)}
                  </span>
                  <span
                    className={cn(
                      'w-8 shrink-0 text-[10px] uppercase',
                      entry.level === 'error'
                        ? 'text-destructive'
                        : entry.level === 'warn'
                          ? 'text-warning'
                          : 'text-muted-foreground/60',
                    )}
                  >
                    {LEVEL_WORD[entry.level]}
                  </span>
                  {source.kind === 'stack' && (
                    <span
                      className="w-24 shrink-0 truncate"
                      style={{ color: serviceColor(entry.origin) }}
                    >
                      {entry.origin}
                    </span>
                  )}
                  <span className="text-foreground">
                    {highlight(entry.text, query).map((piece, i) =>
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
      {source?.kind === 'stack' && source.containers.length > MAX_STACK_SERVICES && (
        <p role="note" className="text-xs text-muted-foreground">
          Showing the first {MAX_STACK_SERVICES} of {source.containers.length} services together.
          Pick one service to read it alone.
        </p>
      )}
      {live.error && (
        <p role="status" className="text-xs text-destructive">
          {live.error}
        </p>
      )}
    </div>
  );
}
