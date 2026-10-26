import type { RemoteObservation } from '@runova/core';
import type { FilesConflictChoice, FilesPlanChange } from '@shared/deployFilesTypes';
import { useRef, useState } from 'react';
import { TriangleAlert } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { formatBytes } from '@/lib/format';
import { cn } from '@/lib/utils';
import { conflictStory, plural, relativeTimeText } from './copy';

/**
 * Files that changed on the server since the last deploy (E23). Nothing is sent over them until
 * the user says, file by file or all at once, whether this computer's copy goes or the server's
 * stays.
 */

/** Rows of a review list drawn at once; the rest wait behind "Show more", a page at a time. */
export const REVIEW_PAGE = 50;

/**
 * Keyboard behaviour for a radio group drawn as buttons: one tab stop (the chosen option, or the
 * first when none is), and the arrow keys move to the next or previous option and choose it.
 */
export function rovingRadio<T extends string>({
  order,
  index,
  value,
  onChange,
  focus,
}: {
  order: readonly T[];
  index: number;
  value: T | null;
  onChange: (value: T) => void;
  focus: (value: T) => void;
}): { tabIndex: number; onKeyDown: (event: React.KeyboardEvent) => void } {
  return {
    tabIndex: value === order[index] || (value === null && index === 0) ? 0 : -1,
    onKeyDown: (event) => {
      const step =
        event.key === 'ArrowRight' || event.key === 'ArrowDown'
          ? 1
          : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
            ? -1
            : 0;
      if (step === 0) return;
      event.preventDefault();
      const next = order[(index + step + order.length) % order.length];
      onChange(next);
      focus(next);
    },
  };
}

/** The two options for one conflict, named after what they do to that file. */
export function choiceLabels(change: FilesPlanChange): Record<FilesConflictChoice, string> {
  if (change.conflict === 'deletedOnServer') return { overwrite: 'Upload', skip: 'Skip' };
  if (change.local === 'deleted') return { overwrite: 'Delete', skip: 'Keep' };
  return { overwrite: 'Overwrite', skip: 'Skip' };
}

function observation(label: string, seen: RemoteObservation | null): string | null {
  if (!seen) return null;
  const when = seen.mtimeMs !== null ? `, ${relativeTimeText(seen.mtimeMs)}` : '';
  return `${label}: ${formatBytes(seen.size)}${when}`;
}

function facts(change: FilesPlanChange): string[] {
  return [
    change.local !== 'deleted' ? `This computer: ${formatBytes(change.size)}` : null,
    observation('On the server now', change.server),
    observation('At your last deploy', change.base),
    change.unverified ? 'Judged by size, since the times could not be compared' : null,
  ].filter((fact): fact is string => fact !== null);
}

export function ConflictsCard({
  conflicts,
  choices,
  onChoose,
  disabled = false,
}: {
  conflicts: readonly FilesPlanChange[];
  choices: Readonly<Record<string, FilesConflictChoice>>;
  onChoose: (choices: Record<string, FilesConflictChoice>) => void;
  disabled?: boolean;
}): React.JSX.Element | null {
  const [limit, setLimit] = useState(REVIEW_PAGE);
  if (conflicts.length === 0) return null;
  const shown = conflicts.slice(0, limit);
  const hidden = conflicts.length - shown.length;
  const all = (choice: FilesConflictChoice) =>
    onChoose(Object.fromEntries(conflicts.map((change) => [change.path, choice])));

  return (
    <section
      aria-label="Conflicts"
      className="space-y-3 rounded-xl bg-warning/[0.06] p-3 ring-1 ring-inset ring-warning/25"
    >
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
        <div className="min-w-0 flex-1 space-y-0.5">
          <h3 className="text-sm font-medium">
            {plural(conflicts.length, 'file')} changed on the server
          </h3>
          <p className="text-xs text-muted-foreground">
            Someone changed these on the server after your last deploy. Choose for each one whether
            your copy replaces it or the server's stays.
          </p>
        </div>
        <div className="flex shrink-0 gap-1.5">
          <Button size="sm" variant="soft" disabled={disabled} onClick={() => all('overwrite')}>
            Overwrite all
          </Button>
          <Button size="sm" variant="soft" disabled={disabled} onClick={() => all('skip')}>
            Skip all
          </Button>
        </div>
      </div>
      <ul aria-label="Conflicting files" className="space-y-1">
        {shown.map((change) => (
          <li
            key={change.path}
            className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg bg-background/45 px-2.5 py-2"
          >
            <div className="min-w-0 flex-1 space-y-0.5">
              <p className="truncate font-mono text-xs">{change.path}</p>
              <p className="text-[11px] text-foreground/85">{conflictStory(change)}</p>
              <p className="flex flex-wrap gap-x-3 text-[11px] tabular-nums text-muted-foreground">
                {facts(change).map((fact) => (
                  <span key={fact}>{fact}</span>
                ))}
              </p>
            </div>
            <ChoiceToggle
              label={`What to do with ${change.path}`}
              labels={choiceLabels(change)}
              value={choices[change.path] ?? null}
              onChange={(choice) => onChoose({ [change.path]: choice })}
              disabled={disabled}
            />
          </li>
        ))}
      </ul>
      {hidden > 0 && (
        <Button
          size="sm"
          variant="soft"
          className="w-full"
          onClick={() => setLimit((current) => current + REVIEW_PAGE)}
        >
          Show {Math.min(hidden, REVIEW_PAGE)} more
        </Button>
      )}
    </section>
  );
}

const ORDER: FilesConflictChoice[] = ['overwrite', 'skip'];

/** A two-option radio group drawn as a segmented pill; arrow keys move between the options. */
function ChoiceToggle({
  label,
  labels,
  value,
  onChange,
  disabled,
}: {
  label: string;
  labels: Record<FilesConflictChoice, string>;
  value: FilesConflictChoice | null;
  onChange: (value: FilesConflictChoice) => void;
  disabled: boolean;
}): React.JSX.Element {
  const refs = useRef<Record<FilesConflictChoice, HTMLButtonElement | null>>({
    overwrite: null,
    skip: null,
  });
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn(
        'flex shrink-0 items-center gap-0.5 rounded-full bg-foreground/[0.07] p-0.5',
        value === null && 'ring-1 ring-inset ring-warning/40',
      )}
    >
      {ORDER.map((option, index) => {
        const active = value === option;
        return (
          <button
            key={option}
            ref={(node) => {
              refs.current[option] = node;
            }}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            // One stop in the tab order, and the arrow keys move between the two.
            {...rovingRadio({
              order: ORDER,
              index,
              value,
              onChange,
              focus: (next) => refs.current[next]?.focus(),
            })}
            onClick={() => onChange(option)}
            className={cn(
              'h-6 cursor-pointer rounded-full px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
              active
                ? option === 'overwrite'
                  ? 'bg-primary/15 text-primary'
                  : 'bg-background/80 text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {labels[option]}
          </button>
        );
      })}
    </div>
  );
}
