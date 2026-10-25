import type { GenerationView } from '@agentmat/studio';
import { useEffect, useState } from 'react';
import {
  Button,
  ChevronDown,
  ChevronUp,
  cn,
  FileText,
  GLASS_CARD,
  Notice,
  RefreshCw,
  Spinner,
  StopCircle,
  X,
} from '../kit';
import { runLabel } from './runSettings';

const WORKING: Record<GenerationView['stage'], string> = {
  scenario: 'Writing the scenario',
  edit: 'Working on your change',
  scene: 'Animating the scene',
};

const FAILED: Record<GenerationView['stage'], string> = {
  scenario: 'The scenario was not written.',
  edit: 'The change was not made.',
  scene: 'The scene was not animated.',
};

function elapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** A clock that ticks once a second while `running`. */
function useNow(running: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  return now;
}

export interface GenerationCardProps {
  generation: GenerationView;
  output: string[];
  onCancel: () => void;
  onRetry: () => void;
  onDetails: () => void;
  onDismiss: () => void;
}

/**
 * The AI run working on the video, or the one that just failed. While it runs it shows which CLI
 * and model, how long so far, and what the CLI is printing, with Cancel; after a failure or an
 * interruption it says what happened and offers to run it again.
 */
export function GenerationCard({
  generation: g,
  output,
  onCancel,
  onRetry,
  onDetails,
  onDismiss,
}: GenerationCardProps): React.JSX.Element | null {
  const running = g.status === 'running';
  const now = useNow(running);
  const [showAll, setShowAll] = useState(false);
  const label = runLabel(g);

  if (running) {
    const round = g.attempts.length - 1;
    const lines = showAll ? output : output.slice(-4);
    return (
      <section className={cn(GLASS_CARD, 'space-y-2 p-3')} aria-label="AI run" aria-busy="true">
        <div className="flex flex-wrap items-center gap-2">
          <Spinner className="h-4 w-4 animate-spin text-primary" aria-hidden />
          <p className="text-sm font-medium">{WORKING[g.stage]}</p>
          <span className="text-xs text-muted-foreground">{label}</span>
          <span className="text-xs tabular-nums text-muted-foreground" aria-label="Time so far">
            {elapsed(now - g.startedAt)}
          </span>
          <Button size="sm" variant="ghost" className="ml-auto" onClick={onCancel}>
            <StopCircle /> Cancel
          </Button>
        </div>
        {round > 0 && (
          <p className="text-xs text-muted-foreground">
            The first answer did not fit, so it was sent back with the problems (round {round} of
            2).
          </p>
        )}
        {output.length > 0 && (
          <div className="rounded-lg bg-foreground/[0.04] px-2.5 py-2">
            <ol
              className="max-h-48 space-y-0.5 overflow-y-auto font-mono text-[11px] leading-relaxed text-muted-foreground"
              aria-label="CLI output"
            >
              {lines.map((line, i) => (
                <li key={`${output.length - lines.length + i}`} dir="auto" className="break-words">
                  {line}
                </li>
              ))}
            </ol>
            {output.length > 4 && (
              <Button
                size="xs"
                variant="ghost"
                className="mt-1"
                onClick={() => setShowAll((v) => !v)}
              >
                {showAll ? <ChevronUp /> : <ChevronDown />}
                {showAll ? 'Show less' : `Show all ${output.length} lines`}
              </Button>
            )}
          </div>
        )}
      </section>
    );
  }

  const actions = (
    <div className="flex items-center gap-1">
      <Button size="xs" variant="ghost" onClick={onDetails}>
        <FileText /> Details
      </Button>
      <Button size="xs" variant="outline" onClick={onRetry}>
        <RefreshCw /> Try again
      </Button>
      <Button size="icon-xs" variant="ghost" aria-label="Dismiss" onClick={onDismiss}>
        <X />
      </Button>
    </div>
  );

  if (g.status === 'failed') {
    return (
      <Notice tone="destructive" action={actions} aria-label="AI run failed">
        <p className="font-medium">{FAILED[g.stage]}</p>
        <p className="mt-0.5 text-xs" dir="auto">
          {g.error ?? 'The CLI did not answer.'}
        </p>
      </Notice>
    );
  }
  if (g.status === 'interrupted') {
    return (
      <Notice tone="warning" action={actions} aria-label="AI run interrupted">
        <p className="font-medium">AgentMate closed while {label} was working on this.</p>
        <p className="mt-0.5 text-xs">
          A CLI run cannot pick up where it stopped. Try again to run it anew.
        </p>
      </Notice>
    );
  }
  return null;
}
