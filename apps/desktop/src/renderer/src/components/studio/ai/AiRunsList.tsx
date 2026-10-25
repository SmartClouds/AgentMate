import type { GenerationView } from '@agentmat/studio';
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
}

const RETRYABLE = new Set<GenerationView['status']>(['failed', 'interrupted', 'cancelled']);

/** Every AI run on the video, the ones that changed nothing included, newest first. */
export function AiRunsList({
  generations,
  loading,
  onDetails,
  onRetry,
  onSaveRecipe,
}: AiRunsListProps): React.JSX.Element {
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
            </div>
          </li>
        );
      })}
    </ol>
  );
}
