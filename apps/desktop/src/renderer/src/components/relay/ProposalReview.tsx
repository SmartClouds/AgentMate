import {
  budgetLevel,
  formatTokenCount,
  type ProposalEntry,
  parseTokenCount,
  type RelayProposal,
  TIGHT_ESTIMATE_SHARE,
} from '@agentmat/core';
import { useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  Minus,
  Pencil,
  Plus,
  SplitView,
  TriangleAlert,
  Undo,
} from '@/components/icons';
import { Button } from '@/components/ui/button';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/**
 * What a planner proposes for the board, laid out for a decision: every new task with its
 * estimate read against the session budget, every change field by field, and a way to leave any
 * of it out or fix a new task's title and estimate before anything is written.
 */
export interface ProposalReviewProps {
  proposal: RelayProposal;
  /** The same proposal as `diffProposal` describes it, with the ids the tasks will get. */
  entries: ProposalEntry[];
  /** Context tokens one session may use, which every estimate is read against. */
  budget: number;
  /** Parts of the proposal that will be left out on apply, and why. */
  warnings?: string[];
  /** The proposal with the user's edits, after every change. */
  onChange: (next: RelayProposal) => void;
  /** Show the proposal without the controls to leave out or edit entries. */
  readOnly?: boolean;
  className?: string;
}

interface AddEdit {
  title?: string;
  estimate?: number | null;
}

type EntryKey = string;

function keyOf(entry: ProposalEntry, addIndex: number): EntryKey {
  return entry.kind === 'add' ? `add:${addIndex}` : `${entry.kind}:${entry.id}`;
}

/** The proposal with the dropped entries taken out and the new tasks' edits applied. */
function edited(
  proposal: RelayProposal,
  dropped: ReadonlySet<EntryKey>,
  edits: Record<number, AddEdit>,
): RelayProposal {
  return {
    summary: proposal.summary,
    add: proposal.add
      .map((task, index) => ({ task, index }))
      .filter(({ index }) => !dropped.has(`add:${index}`))
      .map(({ task, index }) => {
        const edit = edits[index];
        return {
          ...task,
          title: edit?.title?.trim() ? edit.title.trim() : task.title,
          estimate: edit && 'estimate' in edit ? edit.estimate : task.estimate,
        };
      }),
    change: proposal.change.filter((change) => !dropped.has(`change:${change.id}`)),
    split: proposal.split.filter((split) => !dropped.has(`split:${split.id}`)),
    remove: proposal.remove.filter((removal) => !dropped.has(`remove:${removal.id}`)),
  };
}

const KINDS = {
  add: { word: 'New task', eyebrow: 'New', Icon: Plus, rail: 'bg-primary', tint: 'text-primary' },
  change: {
    word: 'Change',
    eyebrow: 'Change',
    Icon: Pencil,
    rail: 'bg-foreground/35',
    tint: 'text-muted-foreground',
  },
  split: {
    word: 'Split',
    eyebrow: 'Split',
    Icon: SplitView,
    rail: 'bg-warning',
    tint: 'text-warning',
  },
  remove: {
    word: 'Remove',
    eyebrow: 'Remove',
    Icon: Minus,
    rail: 'bg-destructive',
    tint: 'text-destructive',
  },
} as const;

const FIELD_NAMES: Record<string, string> = {
  title: 'Title',
  epic: 'Epic',
  depends: 'Depends on',
  estimate: 'Estimate',
  budget: 'Budget',
  goal: 'Goal',
  scope: 'Scope',
  acceptance: 'Acceptance',
  testPlan: 'Test plan',
};

const LEVEL_WORDS = { ok: 'Fits', tight: 'Tight', over: 'Over budget' } as const;
const LEVEL_TONES = {
  ok: { fill: 'bg-primary', text: 'text-muted-foreground' },
  tight: { fill: 'bg-warning', text: 'text-warning' },
  over: { fill: 'bg-destructive', text: 'text-destructive' },
} as const;

/**
 * A slim gauge of one task's estimate against the session budget. The tick marks where a task
 * starts to be tight, the share past which a session has little room left for tool output.
 */
export function BudgetGauge({
  taskId,
  estimate,
  budget,
}: {
  taskId: string;
  estimate: number | null;
  budget: number;
}): React.JSX.Element {
  const level = budgetLevel(estimate, budget);
  const share = estimate === null ? 0 : Math.min(estimate / budget, 1);
  const tone = level ? LEVEL_TONES[level] : null;
  return (
    <div className="flex min-w-0 items-center gap-2">
      <div
        role="meter"
        aria-label={`${taskId} estimate`}
        aria-valuemin={0}
        aria-valuemax={budget}
        aria-valuenow={estimate ?? 0}
        aria-valuetext={
          estimate === null
            ? 'No estimate'
            : `${formatTokenCount(estimate)} of ${formatTokenCount(budget)}`
        }
        className="relative h-1.5 min-w-16 flex-1 overflow-hidden rounded-full bg-foreground/[0.08]"
      >
        <div
          className={cn('h-full rounded-full transition-[width] duration-300', tone?.fill)}
          style={{ width: `${share * 100}%` }}
        />
        <span
          aria-hidden
          className="absolute inset-y-0 w-px bg-foreground/40"
          style={{ left: `${TIGHT_ESTIMATE_SHARE * 100}%` }}
        />
      </div>
      <span
        className={cn('shrink-0 text-[11px] font-medium', tone?.text ?? 'text-muted-foreground')}
      >
        {level ? LEVEL_WORDS[level] : 'No estimate'}
      </span>
    </div>
  );
}

function EstimateField({
  taskId,
  value,
  onCommit,
}: {
  taskId: string;
  value: number | null;
  onCommit: (next: number | null) => void;
}): React.JSX.Element {
  const shown = value === null ? '' : formatTokenCount(value);
  const [draft, setDraft] = useState(shown);
  useEffect(() => setDraft(shown), [shown]);

  function commit(): void {
    if (!draft.trim()) {
      onCommit(null);
      return;
    }
    const parsed = parseTokenCount(draft);
    if (parsed === null) setDraft(shown);
    else onCommit(parsed);
  }

  return (
    <SimpleTooltip label="Context one session needs, like 90k">
      <input
        aria-label={`Estimate of ${taskId}`}
        value={draft}
        placeholder="None"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit();
        }}
        className="field-surface h-7 w-16 rounded-md px-2 text-right font-mono text-xs tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
    </SimpleTooltip>
  );
}

function FieldChanges({ entry }: { entry: ProposalEntry }): React.JSX.Element | null {
  if (entry.fields.length === 0) return null;
  return (
    <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
      {entry.fields.map((change) => (
        <div key={change.field} className="contents">
          <dt className="text-muted-foreground">{FIELD_NAMES[change.field] ?? change.field}</dt>
          <dd className="flex min-w-0 flex-wrap items-center gap-1.5">
            {change.before ? (
              <span className="min-w-0 truncate text-muted-foreground line-through decoration-foreground/30">
                {change.before}
              </span>
            ) : (
              <span className="text-muted-foreground/70">none</span>
            )}
            <ArrowRight aria-hidden className="h-3 w-3 shrink-0 text-muted-foreground/70" />
            <span className="min-w-0 truncate font-medium">{change.after || 'none'}</span>
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function ProposalReview({
  proposal,
  entries,
  budget,
  warnings = [],
  onChange,
  readOnly = false,
  className,
}: ProposalReviewProps): React.JSX.Element {
  const [dropped, setDropped] = useState<ReadonlySet<EntryKey>>(new Set());
  const [edits, setEdits] = useState<Record<number, AddEdit>>({});

  const keyed = useMemo(() => {
    let addIndex = -1;
    return entries.map((entry) => {
      if (entry.kind === 'add') addIndex += 1;
      return { entry, key: keyOf(entry, addIndex), addIndex: entry.kind === 'add' ? addIndex : -1 };
    });
  }, [entries]);

  function update(nextDropped: ReadonlySet<EntryKey>, nextEdits: Record<number, AddEdit>): void {
    setDropped(nextDropped);
    setEdits(nextEdits);
    onChange(edited(proposal, nextDropped, nextEdits));
  }

  function toggle(key: EntryKey): void {
    const next = new Set(dropped);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    update(next, edits);
  }

  function editAdd(index: number, patch: AddEdit): void {
    update(dropped, { ...edits, [index]: { ...edits[index], ...patch } });
  }

  const kept = keyed.filter(({ key }) => !dropped.has(key)).length;

  return (
    <div className={cn('space-y-3', className)}>
      {proposal.summary ? (
        <p className="text-sm leading-relaxed text-foreground/90">{proposal.summary}</p>
      ) : null}

      <ul aria-label="Proposed changes" className="space-y-1.5">
        {keyed.map(({ entry, key, addIndex }) => {
          const kind = KINDS[entry.kind];
          if (dropped.has(key)) {
            return (
              <li
                key={key}
                aria-label={`Left out: ${entry.id}`}
                className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs text-muted-foreground"
              >
                <span className="font-mono">{entry.id}</span>
                <span className="min-w-0 flex-1 truncate line-through">{entry.title}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  aria-label={`Undo leaving out ${entry.id}`}
                  onClick={() => toggle(key)}
                >
                  <Undo /> Undo
                </Button>
              </li>
            );
          }
          const task = entry.kind === 'add' ? proposal.add[addIndex] : null;
          const edit = entry.kind === 'add' ? edits[addIndex] : undefined;
          const estimate =
            task && edit && 'estimate' in edit ? (edit.estimate ?? null) : (task?.estimate ?? null);
          return (
            <li
              key={key}
              aria-label={`${kind.word} ${entry.id} ${entry.title}`}
              className="group relative overflow-hidden rounded-xl bg-foreground/[0.03] py-2.5 pr-2 pl-4 ring-1 ring-foreground/[0.07] ring-inset"
            >
              <span
                aria-hidden
                className={cn('absolute inset-y-2 left-1.5 w-0.5 rounded-full', kind.rail)}
              />
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 text-[10px] font-semibold tracking-[0.08em] uppercase">
                    <kind.Icon aria-hidden className={cn('h-3 w-3', kind.tint)} />
                    <span className={kind.tint}>{kind.eyebrow}</span>
                    <span className="font-mono tracking-normal text-muted-foreground normal-case">
                      {entry.id}
                    </span>
                  </div>
                  {task ? (
                    <div className="mt-1.5 space-y-1.5">
                      {readOnly ? (
                        <p className="truncate text-sm font-medium">{task.title}</p>
                      ) : (
                        <input
                          aria-label={`Title of ${entry.id}`}
                          value={edit?.title ?? task.title}
                          onChange={(event) => editAdd(addIndex, { title: event.target.value })}
                          className="w-full rounded-md bg-transparent px-1 py-0.5 -ml-1 text-sm font-medium outline-none hover:bg-foreground/[0.04] focus-visible:bg-background/60 focus-visible:ring-2 focus-visible:ring-ring"
                        />
                      )}
                      <div className="flex items-center gap-2">
                        <BudgetGauge taskId={entry.id} estimate={estimate} budget={budget} />
                        {readOnly ? (
                          <span className="w-12 text-right font-mono text-xs text-muted-foreground tabular-nums">
                            {estimate === null ? '' : formatTokenCount(estimate)}
                          </span>
                        ) : (
                          <EstimateField
                            taskId={entry.id}
                            value={estimate}
                            onCommit={(next) => editAdd(addIndex, { estimate: next })}
                          />
                        )}
                      </div>
                      {task.depends && task.depends.length > 0 ? (
                        <p className="text-[11px] text-muted-foreground">
                          After {task.depends.join(', ')}
                        </p>
                      ) : null}
                    </div>
                  ) : (
                    <p className="mt-1 truncate text-sm font-medium">{entry.title}</p>
                  )}
                  <FieldChanges entry={entry} />
                  {entry.parts?.length ? (
                    <ul className="mt-1.5 space-y-0.5 text-xs">
                      {entry.parts.map((part) => (
                        <li key={part.id || part.title} className="flex gap-2">
                          <span className="font-mono text-muted-foreground">{part.id}</span>
                          <span className="min-w-0 truncate">{part.title}</span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {entry.reason ? (
                    <p className="mt-1 text-xs text-muted-foreground">{entry.reason}</p>
                  ) : null}
                </div>
                {readOnly ? null : (
                  <SimpleTooltip label="Leave this out">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Leave out ${entry.id}`}
                      onClick={() => toggle(key)}
                      className="opacity-60 group-hover:opacity-100 focus-visible:opacity-100"
                    >
                      <Minus />
                    </Button>
                  </SimpleTooltip>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {kept === 0 ? (
        <p className="text-xs text-muted-foreground">
          Everything is left out, so nothing will change.
        </p>
      ) : null}

      {warnings.length > 0 ? (
        <ul className="space-y-1">
          {warnings.map((warning) => (
            <li key={warning} className="flex items-start gap-1.5 text-xs text-warning">
              <TriangleAlert aria-hidden className="mt-0.5 h-3 w-3 shrink-0" />
              <span>{warning}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** How many entries a proposal would apply, for button labels. */
export function proposalSize(proposal: RelayProposal): number {
  return (
    proposal.add.length + proposal.change.length + proposal.split.length + proposal.remove.length
  );
}
