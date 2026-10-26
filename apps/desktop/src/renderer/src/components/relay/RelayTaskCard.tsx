import { budgetLevel, formatTokenCount } from '@runova/core';
import type { RelayTaskCard as Card, RelayProjectSettings, RelayRunView } from '@shared/relayTypes';
import { motion, useReducedMotion } from 'framer-motion';
import { CliLogo } from '@/components/cliLogos';
import { CircleCheck, CircleX, Flask, TriangleAlert } from '@/components/icons';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { FuelRing } from './FuelRing';
import { choiceFor, choiceLabel, epicHue, legPhaseLabel } from './relayView';
import { tokensUsedLabel } from './TokensUsed';
import { useRelayContext } from './useRelay';

/** The drag payload's type, so a drop elsewhere in the app ignores a card. */
export const CARD_DRAG_TYPE = 'application/x-runova-relay-task';

export type CardMove = { kind: 'column'; step: -1 | 1 } | { kind: 'order'; step: -1 | 1 };

function TestsBadge({ card }: { card: Card }): React.JSX.Element | null {
  const tests = card.handoff?.tests;
  if (!tests || tests === 'not-run') return null;
  const passed = tests === 'passed';
  return (
    <SimpleTooltip label={passed ? 'Its tests pass' : 'Its tests fail'}>
      <span
        aria-label={passed ? 'Tests pass' : 'Tests fail'}
        className={cn(
          'inline-flex items-center gap-1 rounded-full px-1.5 py-px text-[10px] font-medium',
          passed
            ? 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300'
            : 'bg-rose-500/12 text-rose-700 dark:text-rose-300',
        )}
      >
        <Flask aria-hidden className="h-2.5 w-2.5" />
        {passed ? (
          <CircleCheck aria-hidden className="h-2.5 w-2.5" />
        ) : (
          <CircleX aria-hidden className="h-2.5 w-2.5" />
        )}
      </span>
    </SimpleTooltip>
  );
}

/**
 * One task on the glass board. The epic paints the stripe on its edge; the bar under the title
 * is the planner's estimate against the session budget, so an oversized task shows before it runs.
 */
export function RelayTaskCard({
  card,
  settings,
  run,
  selected,
  onOpen,
  onMove,
  onDropBefore,
}: {
  card: Card;
  settings: RelayProjectSettings;
  run: RelayRunView | null;
  selected: boolean;
  onOpen: () => void;
  onMove: (move: CardMove) => void;
  /** Another card was dropped onto this one: it goes just before it. */
  onDropBefore: (taskId: string) => void;
}): React.JSX.Element {
  const reduceMotion = useReducedMotion();
  const hue = epicHue(card.epic);
  const budget = card.budget ?? settings.options.defaultBudget;
  const level = budgetLevel(card.estimate, budget);
  const share = card.estimate === null ? 0 : Math.min(1, card.estimate / budget);
  const choice = choiceFor(settings, card.id);
  const leg = run?.current?.taskId === card.id ? run.current : null;
  const context = useRelayContext(leg?.tabId);

  function onKeyDown(event: React.KeyboardEvent): void {
    if (!event.altKey) return;
    const moves: Record<string, CardMove> = {
      ArrowLeft: { kind: 'column', step: -1 },
      ArrowRight: { kind: 'column', step: 1 },
      ArrowUp: { kind: 'order', step: -1 },
      ArrowDown: { kind: 'order', step: 1 },
    };
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    onMove(move);
  }

  return (
    <motion.div
      layout={reduceMotion ? false : 'position'}
      layoutId={reduceMotion ? undefined : `relay-card-${card.id}`}
      transition={{ type: 'spring', stiffness: 420, damping: 36 }}
    >
      <article
        data-card={card.id}
        aria-label={`${card.id} ${card.title}`}
        draggable
        onDragStart={(event) => {
          event.dataTransfer.setData(CARD_DRAG_TYPE, card.id);
          event.dataTransfer.effectAllowed = 'move';
        }}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes(CARD_DRAG_TYPE)) event.preventDefault();
        }}
        onDrop={(event) => {
          const id = event.dataTransfer.getData(CARD_DRAG_TYPE);
          if (!id || id === card.id) return;
          event.preventDefault();
          event.stopPropagation();
          onDropBefore(id);
        }}
        className={cn(
          'group relative cursor-grab overflow-hidden rounded-xl border bg-card/70 shadow-sm backdrop-blur-sm transition-[border-color,box-shadow] active:cursor-grabbing glass:bg-card/45',
          selected
            ? 'border-primary/60 ring-2 ring-primary/25'
            : 'border-border/70 hover:border-foreground/20',
          leg &&
            'shadow-[0_0_0_1px_hsl(var(--primary)/0.35),0_8px_24px_-12px_hsl(var(--primary)/0.6)]',
        )}
      >
        <span
          aria-hidden
          className="absolute inset-y-0 left-0 w-[3px]"
          style={{ background: hue !== null ? `hsl(${hue} 70% 55%)` : 'hsl(var(--border))' }}
        />
        <button
          type="button"
          onClick={onOpen}
          onKeyDown={onKeyDown}
          aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight Alt+ArrowUp Alt+ArrowDown"
          className="block w-full cursor-pointer px-3 pt-2 pb-2.5 text-left outline-none focus-visible:bg-foreground/[0.03] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60"
        >
          <div className="flex items-center gap-1.5">
            <span
              className="font-mono text-[10.5px] font-semibold tracking-tight"
              style={{ color: hue !== null ? `hsl(${hue} 60% 50%)` : undefined }}
            >
              {card.id}
            </span>
            {card.epic ? (
              <span className="truncate text-[10px] text-muted-foreground">{card.epic}</span>
            ) : null}
            <span className="ml-auto flex items-center gap-1">
              {card.issues.length > 0 ? (
                <SimpleTooltip label={card.issues.map((issue) => issue.message).join(' ')}>
                  <TriangleAlert
                    aria-label="This task file has problems"
                    className="h-3 w-3 text-amber-500"
                  />
                </SimpleTooltip>
              ) : null}
              <TestsBadge card={card} />
            </span>
          </div>
          <p className="mt-1 line-clamp-2 text-[13px] leading-snug font-medium">{card.title}</p>

          {leg ? (
            <div className="mt-2 flex items-center gap-2 rounded-lg bg-primary/[0.07] px-2 py-1">
              <FuelRing
                used={context?.tokens ?? leg.contextTokens}
                budget={leg.budget}
                guardAt={context?.guardAt ?? leg.guardAt}
                size={20}
              />
              <span className="truncate text-[11px]">
                {legPhaseLabel(leg.phase, leg.awaiting)} · session {leg.legNo}
              </span>
            </div>
          ) : card.handoff?.next && card.status !== 'todo' && card.status !== 'done' ? (
            <p className="mt-1.5 line-clamp-2 border-l-2 border-foreground/15 pl-2 text-[11px] text-muted-foreground">
              {card.handoff.next}
            </p>
          ) : null}

          <div className="mt-2 flex items-center gap-2">
            <SimpleTooltip
              label={
                (card.status === 'done' ? tokensUsedLabel(card) : null) ??
                (card.estimate === null
                  ? 'No estimate yet'
                  : `About ${formatTokenCount(card.estimate)} of a ${formatTokenCount(budget)} session`)
              }
              className={
                card.status === 'done' && card.legPeaks.length > 0
                  ? 'max-w-none px-3 py-2.5'
                  : undefined
              }
            >
              <span
                role="img"
                aria-label={
                  card.estimate === null
                    ? 'No estimate'
                    : `Estimate ${formatTokenCount(card.estimate)} of ${formatTokenCount(budget)}`
                }
                className="relative h-1 flex-1 overflow-hidden rounded-full bg-foreground/[0.08]"
              >
                <span
                  className={cn(
                    'absolute inset-y-0 left-0 rounded-full',
                    level === 'over'
                      ? 'bg-rose-500'
                      : level === 'tight'
                        ? 'bg-amber-500'
                        : 'bg-emerald-500/80',
                  )}
                  style={{ width: `${Math.round(share * 100)}%` }}
                />
              </span>
            </SimpleTooltip>
            <span className="inline-flex max-w-[55%] items-center gap-1 rounded-full bg-foreground/[0.05] px-1.5 py-px text-[10px] text-muted-foreground">
              <CliLogo cliId={choice.cliId} className="h-2.5 w-2.5" />
              <span className="truncate">{choiceLabel(choice)}</span>
            </span>
            {card.legCount > 0 ? (
              <SimpleTooltip
                label={`${card.legCount} session${card.legCount === 1 ? '' : 's'} so far`}
              >
                <span className="text-[10px] tabular-nums text-muted-foreground">
                  ×{card.legCount}
                </span>
              </SimpleTooltip>
            ) : null}
          </div>
        </button>
      </article>
    </motion.div>
  );
}
