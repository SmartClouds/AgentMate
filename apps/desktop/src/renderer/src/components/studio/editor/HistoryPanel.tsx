import type { HistoryEntryView } from '@agentmat/studio';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { AiRunsList, type AiRunsListProps } from '../ai/AiRunsList';
import { studioClient } from '../client';
import { errorMessage, formatWhen } from '../format';
import {
  Button,
  Chip,
  cn,
  confirmDialog,
  FileText,
  GLASS_PANEL,
  History,
  LoadFailure,
  SECTION_HEADING,
  SEGMENT_TRACK,
  SimpleTooltip,
  Skeleton,
  segmentClass,
} from '../kit';
import { studioKeys } from '../queryKeys';

const PAGE = 50;

const ACTOR: Record<
  HistoryEntryView['actor'],
  { label: string; tone: 'primary' | 'neutral' | 'success' }
> = {
  user: { label: 'You', tone: 'neutral' },
  ai: { label: 'AI', tone: 'primary' },
  system: { label: 'Studio', tone: 'success' },
};

export interface HistoryPanelProps {
  videoId: string;
  currentSeq: number;
  onRestore: (seq: number) => void;
  /** The video's AI runs, for the second tab. */
  ai?: AiRunsListProps;
}

/**
 * Every change ever made to the video, newest first. Nothing is ever dropped from it: restoring an
 * older version adds a new entry, so the version restored from is still there to come back to.
 */
export function HistoryPanel({
  videoId,
  currentSeq,
  onRestore,
  ai,
}: HistoryPanelProps): React.JSX.Element {
  const [tab, setTab] = useState<'changes' | 'ai'>('changes');
  const history = useInfiniteQuery({
    queryKey: studioKeys.history(videoId),
    queryFn: ({ pageParam }) => studioClient().history({ videoId, before: pageParam, limit: PAGE }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => (last.length === PAGE ? last.at(-1)?.seq : undefined),
  });
  const entries = history.data?.pages.flat() ?? [];

  async function restore(entry: HistoryEntryView) {
    const ok = await confirmDialog({
      title: `Go back to version ${entry.seq}?`,
      description: `The video returns to how it was after "${entry.label}". This is added as a new change, so nothing after it is lost.`,
      confirmLabel: 'Restore this version',
    });
    if (ok) onRestore(entry.seq);
  }

  return (
    <aside className={cn(GLASS_PANEL, 'max-h-[calc(100vh-10rem)]')} aria-label="History">
      <div className="flex items-center gap-2 px-3 pb-1 pt-3">
        <History className="h-3.5 w-3.5 text-muted-foreground" />
        <h2 className={SECTION_HEADING}>History</h2>
        {ai && (
          <div className={cn(SEGMENT_TRACK, 'ml-auto')} role="tablist" aria-label="History view">
            {(
              [
                ['changes', 'Changes'],
                ['ai', 'AI runs'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                className={segmentClass(tab === id)}
                onClick={() => setTab(id)}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </div>
      {ai && tab === 'ai' ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          <AiRunsList {...ai} />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {history.isLoading && (
            <div className="space-y-2 p-1" aria-busy="true">
              {Array.from({ length: 5 }, (_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          )}
          {history.error && (
            <LoadFailure
              message={`The history did not load. ${errorMessage(history.error)}`}
              retry={() => void history.refetch()}
            />
          )}
          <ol className="space-y-0.5">
            {entries.map((entry) => {
              const actor = ACTOR[entry.actor];
              const current = entry.seq === currentSeq;
              return (
                <li
                  key={entry.seq}
                  className="group flex items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-foreground/[0.04]"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium" dir="auto">
                      {entry.label}
                    </p>
                    <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                      <Chip tone={actor.tone}>{actor.label}</Chip>
                      <span>{formatWhen(entry.at)}</span>
                      <span className="tabular-nums">v{entry.seq}</span>
                      {current && <Chip tone="success">Current</Chip>}
                    </p>
                  </div>
                  {entry.generationId && ai && (
                    <SimpleTooltip label="What the AI was asked">
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        aria-label="AI run details"
                        className="opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
                        onClick={() => ai.onDetails(entry.generationId as string)}
                      >
                        <FileText />
                      </Button>
                    </SimpleTooltip>
                  )}
                  {!current && (
                    <Button
                      size="xs"
                      variant="ghost"
                      className="opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
                      onClick={() => void restore(entry)}
                    >
                      Restore
                    </Button>
                  )}
                </li>
              );
            })}
          </ol>
          {history.hasNextPage && (
            <Button
              size="sm"
              variant="ghost"
              className="mt-1 w-full"
              disabled={history.isFetchingNextPage}
              onClick={() => void history.fetchNextPage()}
            >
              {history.isFetchingNextPage ? 'Loading...' : 'Show older changes'}
            </Button>
          )}
        </div>
      )}
    </aside>
  );
}
