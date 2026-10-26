import type { VersionFileChange, VersionHunk, VersionLineEdit } from '@shared/apiTypes';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Check, ChevronDown, Spinner, Undo } from '@/components/icons';
import { SEGMENT_TRACK } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';

/** What the user said about one changed file, or one changed line inside it. */
export type VersionFileDecision = 'keep' | 'revert';

type Choices = (VersionFileDecision | undefined)[];

/**
 * The review of one changed file. `choices` has an entry per changed line for a file split
 * into lines, or a single entry for a file reviewed whole; a missing entry is still to review,
 * and its edit stays on disk until then. `diskId` is the blob the file holds now, once a revert
 * has moved it off the run's result.
 */
export interface VersionFileReview {
  choices: Choices;
  diskId?: string | null;
}

export type VersionReviews = Record<string, VersionFileReview>;

/** A file reviewed whole counts as one change. */
function choiceCount(change: VersionFileChange): number {
  return change.hunks?.reduce((sum, hunk) => sum + hunk.edits.length, 0) ?? 1;
}

function choicesOf(change: VersionFileChange, review: VersionFileReview | undefined): Choices {
  return Array.from({ length: choiceCount(change) }, (_, index) => review?.choices[index]);
}

/** The single choice a run of lines shares, or undefined when they differ or some are open. */
function sharedChoice(choices: Choices): VersionFileDecision | undefined {
  const first = choices[0];
  return choices.every((choice) => choice === first) ? first : undefined;
}

/**
 * Where a file stands: undefined while any of its lines is undecided, and 'partial' once some
 * are kept and the rest reverted. Keep and partial files both go into the commit.
 */
export function fileDecision(
  change: VersionFileChange,
  review: VersionFileReview | undefined,
): VersionFileDecision | 'partial' | undefined {
  const choices = choicesOf(change, review);
  if (choices.some((choice) => !choice)) return undefined;
  return sharedChoice(choices) ?? 'partial';
}

/** Diffs this short open on their own; anything longer waits for a click. */
const AUTO_EXPAND_LINES = 40;

const KIND_BADGE = {
  added: { letter: 'A', label: 'Added', className: 'bg-success/15 text-success' },
  modified: { letter: 'M', label: 'Modified', className: 'bg-warning/15 text-warning' },
  deleted: { letter: 'D', label: 'Deleted', className: 'bg-destructive/15 text-destructive' },
} as const;

function splitPath(path: string): { dir: string; name: string } {
  const index = path.lastIndexOf('/');
  return index < 0
    ? { dir: '', name: path }
    : { dir: path.slice(0, index + 1), name: path.slice(index + 1) };
}

function diffLineClass(line: string): string {
  if (line.startsWith('@@')) return 'bg-primary/5 text-primary/80';
  if (line.startsWith('+')) return 'bg-success/10 text-success';
  if (line.startsWith('-')) return 'bg-destructive/10 text-destructive';
  return 'text-muted-foreground';
}

function DiffLines({ lines }: { lines: string[] }): React.JSX.Element {
  // Keys come from the line's place in the diff, which never reorders.
  const keyed = lines.map((text, index) => ({ id: `${index}`, text }));
  return (
    <pre className="min-w-max py-1 font-mono text-[11px] leading-5">
      {keyed.map((line) => (
        <div key={line.id} className={cn('px-3', diffLineClass(line.text))}>
          {line.text || ' '}
        </div>
      ))}
    </pre>
  );
}

function DiffBlock({ change }: { change: VersionFileChange }): React.JSX.Element {
  if (!change.diff) {
    return (
      <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
        {change.binary ? 'Binary file, no preview.' : 'No text changes to show.'}
      </p>
    );
  }
  return (
    <div className="border-t border-border bg-background/40">
      <div className="max-h-72 overflow-auto overscroll-contain">
        <DiffLines lines={change.diff.split('\n')} />
      </div>
      {change.diffTruncated && (
        <p className="border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground">
          Long diff, only the start is shown.
        </p>
      )}
    </div>
  );
}

/** The Keep / Revert pair, used for a whole file and for a block of lines inside one. */
function ChoiceButtons({
  choice,
  label,
  disabled,
  busy,
  small,
  onChoose,
}: {
  choice: VersionFileDecision | undefined;
  label: string;
  disabled: boolean;
  busy?: boolean;
  small?: boolean;
  onChoose: (next: VersionFileDecision) => void;
}): React.JSX.Element {
  // Drawn as the app's segmented pill (see SEGMENT_TRACK), with the chosen side tinted green or
  // red instead of the neutral raised chip, so the decision reads at a glance down the list.
  const buttonClass = cn(
    'inline-flex cursor-pointer items-center justify-center rounded-full font-medium transition-[color,background-color,box-shadow] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60',
    small ? 'h-5 gap-1 px-2 text-[10px]' : 'h-6 gap-1.5 px-2.5 text-[11px]',
  );
  const iconClass = small ? 'h-2.5 w-2.5' : 'h-3 w-3';
  const idleClass = 'text-muted-foreground enabled:hover:text-foreground';
  return (
    <div role="group" aria-label={label} className={cn(SEGMENT_TRACK, 'shrink-0 gap-0.5')}>
      <button
        type="button"
        aria-pressed={choice === 'keep'}
        disabled={disabled}
        onClick={() => onChoose('keep')}
        className={cn(
          buttonClass,
          choice === 'keep'
            ? 'bg-success/15 text-success shadow-sm ring-1 ring-inset ring-success/30'
            : idleClass,
        )}
      >
        <Check className={iconClass} />
        {choice === 'keep' ? 'Kept' : 'Keep'}
      </button>
      <button
        type="button"
        aria-pressed={choice === 'revert'}
        disabled={disabled}
        onClick={() => onChoose('revert')}
        className={cn(
          buttonClass,
          choice === 'revert'
            ? 'bg-destructive/15 text-destructive shadow-sm ring-1 ring-inset ring-destructive/30'
            : idleClass,
        )}
      >
        {busy ? (
          <Spinner className={cn(iconClass, 'animate-spin')} />
        ) : (
          <Undo className={iconClass} />
        )}
        {choice === 'revert' ? 'Reverted' : 'Revert'}
      </button>
    </div>
  );
}

/**
 * Where two versions of a line stop matching, as the length of the shared start and end. The
 * middle is what gets highlighted, so "1.41.0" to "1.42.0" lights up the one digit that moved.
 */
function changedRange(before: string, after: string): { start: number; end: number } {
  const limit = Math.min(before.length, after.length);
  let start = 0;
  while (start < limit && before[start] === after[start]) start += 1;
  let end = 0;
  while (end < limit - start && before[before.length - 1 - end] === after[after.length - 1 - end]) {
    end += 1;
  }
  return { start, end };
}

function LineText({
  text,
  range,
  markClass,
}: {
  text: string;
  range: { start: number; end: number } | null;
  markClass: string;
}): React.JSX.Element {
  // A line that shares nothing with its partner is all change, and marking all of it adds nothing.
  if (!range || range.start + range.end === 0 || text.length === 0) return <>{text || ' '}</>;
  return (
    <>
      {text.slice(0, range.start)}
      <mark className={cn('rounded-[2px] text-inherit', markClass)}>
        {text.slice(range.start, text.length - range.end)}
      </mark>
      {text.slice(text.length - range.end)}
    </>
  );
}

type LineKind = 'context' | 'removed' | 'added';

/** One row of code: old and new line numbers, the +/- sign and the text. */
function CodeLine({
  kind,
  oldNumber,
  newNumber,
  dropped,
  children,
}: {
  kind: LineKind;
  oldNumber?: number;
  newNumber?: number;
  /** The line will not be in the file with the current choice. */
  dropped?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex transition-colors duration-150',
        kind === 'removed' && 'bg-destructive/10 text-destructive',
        kind === 'added' && 'bg-success/10 text-success',
        kind === 'context' && 'text-muted-foreground',
        dropped && 'bg-transparent text-muted-foreground/60',
      )}
    >
      <span className="w-9 shrink-0 pr-1.5 text-right text-muted-foreground/50 tabular-nums select-none">
        {oldNumber ?? ''}
      </span>
      <span className="w-9 shrink-0 pr-1.5 text-right text-muted-foreground/50 tabular-nums select-none">
        {newNumber ?? ''}
      </span>
      <span className="w-4 shrink-0 text-center select-none" aria-hidden>
        {kind === 'removed' ? '-' : kind === 'added' ? '+' : ' '}
      </span>
      <span
        className={cn(
          'pr-3 whitespace-pre',
          dropped && 'line-through decoration-muted-foreground/40',
        )}
      >
        {children}
      </span>
    </div>
  );
}

/** The width of the sticky column that holds each line's Keep and Revert buttons. */
const PICKER_CELL = 'sticky left-0 z-10 w-[52px] shrink-0 border-r border-border bg-card';

/** Keep and Revert for one changed line, as two small icon buttons. */
function LinePicker({
  choice,
  lineLabel,
  disabled,
  onChoose,
}: {
  choice: VersionFileDecision | undefined;
  lineLabel: string;
  disabled: boolean;
  onChoose: (next: VersionFileDecision, range: boolean) => void;
}): React.JSX.Element {
  const options = [
    {
      value: 'keep' as const,
      icon: Check,
      label: `Keep ${lineLabel}`,
      active: 'bg-success/20 text-success',
    },
    {
      value: 'revert' as const,
      icon: Undo,
      label: `Revert ${lineLabel}`,
      active: 'bg-destructive/20 text-destructive',
    },
  ];
  return (
    <div className="flex items-center justify-center gap-0.5">
      {options.map((option) => {
        const Icon = option.icon;
        const selected = choice === option.value;
        return (
          <SimpleTooltip key={option.value} label={option.label} delayDuration={500}>
            <button
              type="button"
              aria-label={option.label}
              aria-pressed={selected}
              disabled={disabled}
              onClick={(event) => onChoose(option.value, event.shiftKey)}
              className={cn(
                'flex h-[18px] w-[18px] cursor-pointer items-center justify-center rounded-full transition-[color,background-color,opacity] duration-150 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed',
                selected
                  ? option.active
                  : 'text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground',
                // Once a line is decided the other option steps back until the row is hovered.
                !selected &&
                  choice &&
                  'opacity-30 group-hover/edit:opacity-100 group-focus-within/edit:opacity-100',
              )}
            >
              <Icon className="h-2.5 w-2.5" />
            </button>
          </SimpleTooltip>
        );
      })}
    </div>
  );
}

function EditRows({
  edit,
  choice,
  oldNumber,
  newNumber,
  disabled,
  onChoose,
}: {
  edit: VersionLineEdit;
  choice: VersionFileDecision | undefined;
  oldNumber: number;
  newNumber: number;
  disabled: boolean;
  onChoose: (next: VersionFileDecision, range: boolean) => void;
}): React.JSX.Element {
  const { removed, added } = edit;
  const range = removed !== undefined && added !== undefined ? changedRange(removed, added) : null;
  const lineLabel =
    added !== undefined
      ? removed !== undefined
        ? `the change to line ${newNumber}`
        : `added line ${newNumber}`
      : `removed line ${oldNumber}`;
  return (
    <div role="group" aria-label={lineLabel} className="group/edit flex">
      <div className={cn(PICKER_CELL, 'flex items-center')}>
        <LinePicker choice={choice} lineLabel={lineLabel} disabled={disabled} onChoose={onChoose} />
      </div>
      <div className="min-w-0 flex-1">
        {removed !== undefined && (
          <CodeLine kind="removed" oldNumber={oldNumber} dropped={choice === 'keep'}>
            <LineText text={removed} range={range} markClass="bg-destructive/25" />
          </CodeLine>
        )}
        {added !== undefined && (
          <CodeLine kind="added" newNumber={newNumber} dropped={choice === 'revert'}>
            <LineText text={added} range={range} markClass="bg-success/25" />
          </CodeLine>
        )}
      </div>
    </div>
  );
}

function ContextRows({
  lines,
  oldFrom,
  newFrom,
}: {
  lines: string[];
  oldFrom: number;
  newFrom: number;
}): React.JSX.Element {
  // Keys come from the line numbers, which are fixed for a given hunk.
  return (
    <>
      {lines.map((line, index) => (
        <div key={`${oldFrom + index}`} className="flex">
          <div className={PICKER_CELL} />
          <div className="min-w-0 flex-1">
            <CodeLine kind="context" oldNumber={oldFrom + index} newNumber={newFrom + index}>
              {line || ' '}
            </CodeLine>
          </div>
        </div>
      ))}
    </>
  );
}

/** "Line 12" or "Lines 12-14", naming the hunk by where its lines end up. */
function hunkLabel(hunk: VersionHunk): string {
  const added = hunk.edits.filter((edit) => edit.added !== undefined).length;
  const first = added > 0 ? hunk.newLine + hunk.lead.length : hunk.oldLine + hunk.lead.length;
  const count = added > 0 ? added : hunk.edits.length;
  return count > 1 ? `Lines ${first}-${first + count - 1}` : `Line ${first}`;
}

function LineReview({
  change,
  hunks,
  choices,
  disabled,
  onChoose,
}: {
  change: VersionFileChange;
  hunks: VersionHunk[];
  choices: Choices;
  disabled: boolean;
  /** Sets every line from `from` up to (not including) `to`. */
  onChoose: (from: number, to: number, next: VersionFileDecision) => void;
}): React.JSX.Element {
  // Shift-click fills everything between this line and the last one clicked in the file.
  const lastClicked = useRef<number | null>(null);
  let editBase = 0;

  return (
    <div className="border-t border-border bg-background/40">
      {!disabled && (
        <p className="border-b border-border px-3 py-1 text-[10px] text-muted-foreground">
          Keep or revert each line on its own. Shift-click to do the same for every line in between.
        </p>
      )}
      <div className="max-h-96 overflow-y-auto overscroll-contain">
        {hunks.map((hunk, hunkIndex) => {
          const base = editBase;
          editBase += hunk.edits.length;
          const hunkChoices = choices.slice(base, base + hunk.edits.length);
          let oldNumber = hunk.oldLine + hunk.lead.length;
          let newNumber = hunk.newLine + hunk.lead.length;
          const rows = hunk.edits.map((edit, offset) => {
            const index = base + offset;
            const row = (
              <EditRows
                key={index}
                edit={edit}
                choice={choices[index]}
                oldNumber={oldNumber}
                newNumber={newNumber}
                disabled={disabled}
                onChoose={(next, range) => {
                  const anchor = lastClicked.current;
                  lastClicked.current = index;
                  if (range && anchor !== null && anchor !== index) {
                    onChoose(Math.min(anchor, index), Math.max(anchor, index) + 1, next);
                  } else {
                    onChoose(index, index + 1, next);
                  }
                }}
              />
            );
            if (edit.removed !== undefined) oldNumber += 1;
            if (edit.added !== undefined) newNumber += 1;
            return row;
          });
          return (
            <div key={hunk.header} className={cn(hunkIndex > 0 && 'border-t border-border')}>
              <div className="flex min-h-7 items-center gap-2 bg-muted/40 py-1 pr-2 pl-3">
                <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-muted-foreground">
                  {hunkLabel(hunk)}
                  {hunks.length > 1 && (
                    <span className="font-normal text-muted-foreground/70">
                      {' '}
                      · block {hunkIndex + 1} of {hunks.length}
                    </span>
                  )}
                </span>
                {hunks.length > 1 && hunk.edits.length > 1 && (
                  <ChoiceButtons
                    small
                    choice={sharedChoice(hunkChoices)}
                    label={`${hunkLabel(hunk)} in ${change.path}`}
                    disabled={disabled}
                    onChoose={(next) => onChoose(base, base + hunk.edits.length, next)}
                  />
                )}
              </div>
              {/* Each block scrolls sideways on its own, with the line buttons pinned left. */}
              <div className="overflow-x-auto">
                <div className="min-w-max font-mono text-[11px] leading-5">
                  <ContextRows lines={hunk.lead} oldFrom={hunk.oldLine} newFrom={hunk.newLine} />
                  {rows}
                  <ContextRows lines={hunk.trail} oldFrom={oldNumber} newFrom={newNumber} />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** The revert set a list of choices puts on disk, as a comparable key. */
function revertKey(choices: Choices): string {
  return choices.flatMap((choice, index) => (choice === 'revert' ? [index] : [])).join();
}

interface DiskState {
  /** The blob on disk, or undefined while it is still the run's result. */
  id: string | null | undefined;
  choices: Choices;
}

/**
 * The version bump's edits, one file at a time, each with its diff and a Keep or Revert
 * choice. The CLI is free to edit anything (and other tools can write during the run), so the
 * user decides which files belong to the release instead of the app guessing up front. A file
 * can also be picked apart line by line, keeping some lines and reverting the others.
 *
 * A choice shows straight away and is written to disk behind it, one write per file at a time,
 * so clicking through lines quickly never waits on git. Revert can be taken back with Keep,
 * since both versions of the file are held in git's object store.
 */
export function VersionChangeReview({
  projectId,
  changes,
  reviews,
  onReviewsChange,
  onSavingChange,
  locked,
}: {
  projectId: string;
  changes: VersionFileChange[];
  reviews: VersionReviews;
  onReviewsChange: (update: (prev: VersionReviews) => VersionReviews) => void;
  /** True while choices are still being written to disk, when committing would miss them. */
  onSavingChange?: (saving: boolean) => void;
  /** Set once the kept files are committed, when changing a decision no longer means anything. */
  locked: boolean;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const [savingPaths, setSavingPaths] = useState<ReadonlySet<string>>(new Set());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () =>
      new Set(
        changes
          .filter((change) => change.diff && change.diff.split('\n').length <= AUTO_EXPAND_LINES)
          .map((change) => change.path),
      ),
  );

  // What each file holds on disk, what the user last asked for, and the queue of writes that
  // turns one into the other. All per path, and all about this run's files only.
  const disk = useRef(new Map<string, DiskState>());
  const wanted = useRef(new Map<string, Choices>());
  const queues = useRef(new Map<string, Promise<void>>());
  const pending = useRef(new Map<string, number>());
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new file list is a new run.
  useEffect(() => {
    disk.current.clear();
    wanted.current.clear();
  }, [changes]);

  useEffect(() => {
    onSavingChange?.(savingPaths.size > 0);
  }, [savingPaths, onSavingChange]);

  const decisions = changes.map((change) => fileDecision(change, reviews[change.path]));
  const undecided = changes.filter((_, index) => !decisions[index]);
  const keptCount = decisions.filter((decision) => decision === 'keep').length;
  const partialCount = decisions.filter((decision) => decision === 'partial').length;
  const revertedCount = decisions.filter((decision) => decision === 'revert').length;

  function trackSaving(path: string, delta: number): void {
    const count = (pending.current.get(path) ?? 0) + delta;
    if (count > 0) pending.current.set(path, count);
    else pending.current.delete(path);
    setSavingPaths((prev) => {
      if (prev.has(path) === count > 0) return prev;
      const next = new Set(prev);
      if (count > 0) next.add(path);
      else next.delete(path);
      return next;
    });
  }

  function toggleExpanded(path: string): void {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  /**
   * Brings the file on disk in line with the latest choices asked for. Only lines moving in or
   * out of "revert" touch the file; keeping an undecided line is a mark, since its edit is
   * already there. On failure the choices fall back to what the file really holds.
   */
  async function flush(change: VersionFileChange): Promise<void> {
    const { path } = change;
    const target = wanted.current.get(path);
    const state = disk.current.get(path);
    if (!target || !state) return;
    if (revertKey(target) === revertKey(state.choices)) {
      disk.current.set(path, { ...state, choices: target });
      return;
    }

    const fromId = state.id !== undefined ? state.id : change.afterId;
    const reverted = target.flatMap((choice, index) => (choice === 'revert' ? [index] : []));
    let failure: string | null = null;
    let diskId: string | null | undefined;
    try {
      if (change.hunks && change.beforeId && change.afterId && fromId) {
        const result = await window.runova.git.writeVersionHunks({
          projectId,
          path,
          fromId,
          beforeId: change.beforeId,
          afterId: change.afterId,
          beforeRawId: change.beforeRawId,
          afterRawId: change.afterRawId,
          revertEdits: reverted,
        });
        if (result.ok && result.id) diskId = result.id;
        else failure = result.message;
      } else {
        const toRevert = reverted.length > 0;
        const result = await window.runova.git.swapVersionFile({
          projectId,
          path,
          fromId,
          toId: toRevert ? change.beforeId : change.afterId,
          toRawId: toRevert ? change.beforeRawId : change.afterRawId,
        });
        if (result.ok) diskId = toRevert ? change.beforeId : change.afterId;
        else failure = result.message;
      }
    } catch (error) {
      failure = (error as Error).message;
    } finally {
      void queryClient.invalidateQueries({ queryKey: queryKeys.gitStatus(projectId) });
    }

    if (failure !== null) {
      toast.error(failure);
      wanted.current.set(path, state.choices);
      onReviewsChange((prev) => ({
        ...prev,
        [path]: { choices: state.choices, diskId: state.id },
      }));
      return;
    }
    disk.current.set(path, { id: diskId, choices: target });
    onReviewsChange((prev) => ({
      ...prev,
      [path]: { choices: prev[path]?.choices ?? target, diskId },
    }));
  }

  function setChoices(change: VersionFileChange, next: Choices): void {
    const { path } = change;
    if (!disk.current.has(path)) {
      const review = reviews[path];
      disk.current.set(path, { id: review?.diskId, choices: choicesOf(change, review) });
    }
    wanted.current.set(path, next);
    onReviewsChange((prev) => ({
      ...prev,
      [path]: { ...prev[path], choices: next },
    }));

    trackSaving(path, 1);
    const queued = (queues.current.get(path) ?? Promise.resolve())
      .then(() => flush(change))
      .finally(() => trackSaving(path, -1));
    queues.current.set(path, queued);
  }

  /** The choices to build on: the latest asked for, which may not have reached the render yet. */
  function latestChoices(change: VersionFileChange): Choices {
    const asked = wanted.current.get(change.path);
    return asked ? [...asked] : choicesOf(change, reviews[change.path]);
  }

  function chooseFile(change: VersionFileChange, next: VersionFileDecision): void {
    setChoices(
      change,
      choicesOf(change, undefined).map(() => next),
    );
  }

  function chooseLines(
    change: VersionFileChange,
    from: number,
    to: number,
    next: VersionFileDecision,
  ): void {
    const choices = latestChoices(change);
    for (let index = from; index < to; index += 1) choices[index] = next;
    setChoices(change, choices);
  }

  /** Settles every change still waiting for review, leaving the ones already decided alone. */
  function chooseRest(next: VersionFileDecision): void {
    for (const change of undecided) {
      setChoices(
        change,
        latestChoices(change).map((choice) => choice ?? next),
      );
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <p className="min-w-0 flex-1 text-xs font-medium text-muted-foreground">
          Review changes ({changes.length})
          <span className="font-normal">
            {' · '}
            {keptCount} kept
            {partialCount > 0 ? ` · ${partialCount} partly kept` : ''} · {revertedCount} reverted
            {undecided.length > 0 ? ` · ${undecided.length} to review` : ''}
          </span>
        </p>
        {/* The CLI bumps every version in the repo, so a release for one part usually means
            keeping a couple of files and reverting everything else in one go. */}
        {!locked && undecided.length > 1 && (
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" className="px-2.5" onClick={() => chooseRest('keep')}>
              <Check className="h-3 w-3" /> Keep the rest
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="px-2.5"
              onClick={() => chooseRest('revert')}
            >
              <Undo className="h-3 w-3" /> Revert the rest
            </Button>
          </div>
        )}
      </div>

      <div className="space-y-1.5">
        {changes.map((change, changeIndex) => {
          const { dir, name } = splitPath(change.path);
          const decision = decisions[changeIndex];
          const choices = choicesOf(change, reviews[change.path]);
          const saving = savingPaths.has(change.path);
          const open = expanded.has(change.path);
          const badge = KIND_BADGE[change.kind];
          const hunks = change.hunks;
          const keptLines = choices.filter((choice) => choice === 'keep').length;
          const revertedLines = choices.filter((choice) => choice === 'revert').length;
          return (
            <div
              key={change.path}
              className={cn(
                'overflow-hidden rounded-lg border bg-card/60 transition-colors duration-150',
                decision === 'keep' || decision === 'partial'
                  ? 'border-success/40'
                  : decision === 'revert'
                    ? 'border-border opacity-70'
                    : 'border-border',
              )}
            >
              <div className="flex items-center gap-2 px-2 py-1.5">
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() => toggleExpanded(change.path)}
                  className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <ChevronDown
                    className={cn(
                      'h-3 w-3 shrink-0 text-muted-foreground transition-transform duration-150',
                      !open && '-rotate-90',
                    )}
                  />
                  <SimpleTooltip label={badge.label}>
                    <span
                      className={cn(
                        'flex h-4 w-4 shrink-0 items-center justify-center rounded font-mono text-[10px] font-semibold',
                        badge.className,
                      )}
                    >
                      {badge.letter}
                    </span>
                  </SimpleTooltip>
                  <span
                    className={cn(
                      'min-w-0 truncate font-mono text-xs',
                      decision === 'revert' && 'line-through',
                    )}
                  >
                    {dir ? <span className="text-muted-foreground">{dir}</span> : null}
                    {name}
                  </span>
                  {!change.binary && (
                    <span className="shrink-0 font-mono text-[10px]">
                      <span className="text-success">+{change.additions}</span>{' '}
                      <span className="text-destructive">-{change.deletions}</span>
                    </span>
                  )}
                </button>

                {change.hadLocalEdits && (
                  <SimpleTooltip label="This file already had uncommitted edits before the run. The diff shows only the run's edit, and Revert keeps your earlier edits, but committing it includes them.">
                    <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                      Had edits
                    </span>
                  </SimpleTooltip>
                )}

                {hunks && (
                  <SimpleTooltip
                    label={
                      open
                        ? 'Pick lines below, or use Keep and Revert here for the whole file.'
                        : 'Open the file to keep some lines and revert others.'
                    }
                  >
                    <span
                      className={cn(
                        'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium tabular-nums',
                        decision === 'partial'
                          ? 'bg-success/15 text-success'
                          : 'bg-muted text-muted-foreground',
                      )}
                    >
                      {keptLines + revertedLines === 0
                        ? `${choices.length} lines`
                        : decision
                          ? `${keptLines} of ${choices.length} kept`
                          : `${keptLines + revertedLines} of ${choices.length} reviewed`}
                    </span>
                  </SimpleTooltip>
                )}

                <ChoiceButtons
                  choice={decision === 'partial' ? undefined : decision}
                  label={`Decision for ${change.path}`}
                  disabled={locked}
                  busy={saving}
                  onChoose={(next) => chooseFile(change, next)}
                />
              </div>
              {open &&
                (hunks ? (
                  <LineReview
                    change={change}
                    hunks={hunks}
                    choices={choices}
                    disabled={locked}
                    onChoose={(from, to, next) => chooseLines(change, from, to, next)}
                  />
                ) : (
                  <DiffBlock change={change} />
                ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
