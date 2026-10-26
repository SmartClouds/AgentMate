import type { GenerationView } from '@runova/studio';
import { useState } from 'react';
import { formatWhen, scriptClass } from '../format';
import {
  Bookmark,
  Button,
  Chip,
  cn,
  EmptyState,
  FileText,
  RefreshCw,
  Skeleton,
  Sparkles,
} from '../kit';
import { STAGE_LABELS, STATUS_LABELS } from './GenerationDetailsDialog';
import { runLabel } from './runSettings';

export interface AiRunsListProps {
  generations: GenerationView[];
  loading: boolean;
  onDetails: (generationId: string) => void;
  onRetry: (generationId: string) => void;
  onSaveRecipe: (generation: GenerationView) => void;
  /** Two runs picked to compare, older first (E39). */
  onCompare?: (ids: [string, string]) => void;
}

const RETRYABLE = new Set<GenerationView['status']>(['failed', 'interrupted', 'cancelled']);

/** Every AI run on the video, the ones that changed nothing included, newest first. */
export function AiRunsList({
  generations,
  loading,
  onDetails,
  onRetry,
  onSaveRecipe,
  onCompare,
}: AiRunsListProps): React.JSX.Element {
  const [picked, setPicked] = useState<string | null>(null);
  const pick = (id: string) => {
    if (!onCompare) return;
    if (picked === null || picked === id) {
      setPicked(picked === id ? null : id);
      return;
    }
    const first = generations.find((g) => g.id === picked);
    const second = generations.find((g) => g.id === id);
    setPicked(null);
    if (!first || !second) return;
    onCompare(first.startedAt <= second.startedAt ? [first.id, second.id] : [second.id, first.id]);
  };
  if (loading) {
    return (
      <div className="space-y-2 p-1" aria-busy="true">
        {Array.from({ length: 3 }, (_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    );
  }
  if (generations.length === 0) {
    return (
      <EmptyState
        size="sm"
        icon={Sparkles}
        title="No AI runs yet"
        description="Scenarios and edits the AI writes are recorded here, with the CLI, model and prompt used."
      />
    );
  }
  return (
    <ol className="space-y-0.5" aria-label="AI runs">
      {generations.map((g) => {
        const status = STATUS_LABELS[g.status];
        return (
          <li key={g.id} className="group rounded-lg px-2 py-1.5 hover:bg-foreground/[0.04]">
            <p
              className={cn('line-clamp-2 text-xs font-medium', scriptClass(g.instruction))}
              dir="auto"
            >
              {g.instruction}
            </p>
            <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
              <Chip tone={status.tone}>{status.label}</Chip>
              <span>{STAGE_LABELS[g.stage]}</span>
              <span className="truncate">{runLabel(g)}</span>
              <span>{formatWhen(g.startedAt)}</span>
            </p>
            <div className="mt-1 flex flex-wrap gap-1">
              <Button size="xs" variant="ghost" onClick={() => onDetails(g.id)}>
                <FileText /> Details
              </Button>
              {RETRYABLE.has(g.status) && (
                <Button size="xs" variant="ghost" onClick={() => onRetry(g.id)}>
                  <RefreshCw /> Try again
                </Button>
              )}
              {g.stage === 'scenario' && g.status === 'done' && (
                <Button size="xs" variant="ghost" onClick={() => onSaveRecipe(g)}>
                  <Bookmark /> Save as recipe
                </Button>
              )}
              {onCompare && generations.length > 1 && (
                <Button
                  size="xs"
                  variant={picked === g.id ? 'tint' : 'ghost'}
                  aria-pressed={picked === g.id}
                  onClick={() => pick(g.id)}
                >
                  {picked === null || picked === g.id ? 'Compare' : 'Compare with this'}
                </Button>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
