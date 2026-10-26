import type { GenerationDetail } from '@runova/studio';
import { useQueries } from '@tanstack/react-query';
import { useState } from 'react';
import { studioAiClient } from '../client';
import { TextDiff } from '../editor/TextDiff';
import { errorMessage, formatWhen } from '../format';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  SEGMENT_TRACK,
  Skeleton,
  segmentClass,
} from '../kit';
import { studioKeys } from '../queryKeys';
import { STAGE_LABELS, STATUS_LABELS } from './GenerationDetailsDialog';
import { runLabel } from './runSettings';

export interface CompareRunsDialogProps {
  videoId: string;
  /** The two runs, older first; null keeps the dialog closed. */
  ids: [string, string] | null;
  onOpenChange: (open: boolean) => void;
}

function rows(g: GenerationDetail): [string, string][] {
  return [
    ['Stage', STAGE_LABELS[g.stage]],
    ['Result', STATUS_LABELS[g.status].label],
    ['CLI, model and effort', runLabel(g)],
    ['Style', g.params.styleId ?? 'none'],
    ['Length asked for', g.params.targetSeconds ? `${g.params.targetSeconds} s` : '-'],
    ['Attempts', String(g.attempts.length)],
    ['Started', formatWhen(g.startedAt)],
  ];
}

/**
 * Two AI runs side by side (E39): the stage, the CLI, model and effort each ran with, and what each
 * was asked, so a method that worked can be told apart from one that did not.
 */
export function CompareRunsDialog({
  videoId,
  ids,
  onOpenChange,
}: CompareRunsDialogProps): React.JSX.Element {
  const [shown, setShown] = useState<'instruction' | 'request'>('instruction');
  const details = useQueries({
    queries: (ids ?? []).map((id) => ({
      queryKey: studioKeys.generationDetail(videoId, id),
      queryFn: () => studioAiClient().generationDetail(videoId, id),
      enabled: ids !== null,
    })),
  });
  const [a, b] = details.map((d) => d.data);
  const failed = details.find((d) => d.error)?.error;
  const lastRequest = (g: GenerationDetail | undefined) => g?.texts.at(-1)?.request ?? '';

  return (
    <Dialog open={ids !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Two AI runs</DialogTitle>
          <DialogDescription>
            How each ran and what each was asked, older on the left.
          </DialogDescription>
        </DialogHeader>
        {failed ? (
          <p className="text-sm text-destructive">{errorMessage(failed)}</p>
        ) : !a || !b ? (
          <Skeleton className="h-60 w-full" />
        ) : (
          <div className="space-y-3">
            <table aria-label="The two runs" className="w-full text-sm">
              <tbody>
                {rows(a).map(([label, left], k) => {
                  const right = rows(b)[k]?.[1] ?? '';
                  return (
                    <tr key={label} className={left !== right ? 'bg-primary/[0.05]' : undefined}>
                      <th
                        scope="row"
                        className="w-44 py-1 pr-3 text-left font-normal text-muted-foreground"
                      >
                        {label}
                      </th>
                      <td className="py-1 pr-3">{left}</td>
                      <td className="py-1">{right}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className={SEGMENT_TRACK} role="radiogroup" aria-label="Compare">
              {(
                [
                  ['instruction', 'What was asked'],
                  ['request', 'The full request'],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={shown === value}
                  className={segmentClass(shown === value)}
                  onClick={() => setShown(value)}
                >
                  {label}
                </button>
              ))}
            </div>
            <TextDiff
              key={shown}
              path={shown === 'instruction' ? 'instruction.txt' : 'request.md'}
              original={shown === 'instruction' ? a.instruction : lastRequest(a)}
              modified={shown === 'instruction' ? b.instruction : lastRequest(b)}
            />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
