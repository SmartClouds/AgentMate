import type { Project } from '@runova/core';
import { WP_IGNORE_ALL, wpItemKey } from '@runova/core';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { File, Filter, Folder, Spinner, X } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { Input } from '@/components/ui/input';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { type IgnoreAddition, type IgnoreRow, ignoreSummary } from './ignoreChoices';
import { useProjectIgnore } from './useProjectIgnore';

/**
 * What a WordPress project leaves out of its pulls and deploys (E21): the saved list, each line
 * with the way to stop ignoring it, and a field to add a pattern by hand. The choices made while
 * reviewing a deploy land here too, so they are kept for the next one.
 */

const SCOPE_ALL = 'Every theme and plugin';

const ROW_ICON = { folder: Folder, file: File, pattern: Filter } as const;

const KIND_NOUN = { theme: 'theme', plugin: 'plugin', 'mu-plugin': 'must-use plugin' } as const;

function rowScope(row: IgnoreRow): string {
  return row.item ? row.item.slug : SCOPE_ALL;
}

/** Where a line applies, as part of a sentence. */
function rowWhere(row: IgnoreRow): string {
  return row.item ? row.item.slug : 'every theme and plugin';
}

export function IgnoredFilesPanel({
  project,
  className,
  onChanged,
  context = 'section',
}: {
  project: Project;
  className?: string;
  /** Called after the saved list changed, so a screen showing its effect can look again. */
  onChanged?: () => void;
  /** Where it is shown, so the empty list can say where to start from there. */
  context?: 'review' | 'section';
}): React.JSX.Element {
  const fieldId = useId();
  const errorId = useId();
  const { rows, saving, add, remove, restore, ignore } = useProjectIgnore(project);
  const [text, setText] = useState('');
  const [scope, setScope] = useState<string>(WP_IGNORE_ALL);
  const [problem, setProblem] = useState<string | null>(null);

  const items = project.wordpress?.items ?? [];
  const scopes = [
    { value: WP_IGNORE_ALL, label: SCOPE_ALL },
    ...items.map((item) => ({
      value: wpItemKey(item),
      label: `${item.slug} (${KIND_NOUN[item.kind]})`,
    })),
  ];

  async function stop(row: IgnoreRow): Promise<void> {
    setProblem(null);
    const result = await remove(row);
    if (result.ok) onChanged?.();
    else toast.error(result.error);
  }

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const pattern = text.trim();
    if (pattern === '' || saving) return;
    if (rows.some((row) => row.key === scope && row.pattern === pattern)) {
      setProblem(`${pattern} is already ignored there.`);
      return;
    }
    const additions: IgnoreAddition[] = [{ key: scope, patterns: [pattern] }];
    const before = ignore;
    setProblem(null);
    const result = await add(additions);
    if (!result.ok) {
      setProblem(result.error);
      return;
    }
    setText('');
    onChanged?.();
    toast.success(ignoreSummary(additions), {
      action: {
        label: 'Undo',
        onClick: () => {
          void restore(before).then((undone) => {
            if (undone.ok) onChanged?.();
            else toast.error(undone.error);
          });
        },
      },
    });
  }

  return (
    <div className={cn('space-y-3', className)}>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {context === 'review'
            ? 'Nothing is ignored yet. Use the eye button on a file, or tick files and press Ignore.'
            : 'Nothing is ignored yet. Add a pattern below, or ignore files while you review a deploy.'}
        </p>
      ) : (
        <ul
          aria-label="Ignored files and folders"
          className="overflow-hidden rounded-lg bg-foreground/[0.03] ring-1 ring-inset ring-foreground/[0.07]"
        >
          {rows.map((row) => {
            const Icon = ROW_ICON[row.kind];
            return (
              <li
                key={`${row.key}\u0000${row.pattern}`}
                className="flex items-center gap-2.5 px-3 py-1.5"
              >
                <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{row.label}</span>
                <span className="shrink-0 rounded-full bg-foreground/[0.06] px-2 py-px text-[11px] text-muted-foreground">
                  {rowScope(row)}
                </span>
                <SimpleTooltip label="Stop ignoring">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="shrink-0"
                    aria-label={`Stop ignoring ${row.label} in ${rowWhere(row)}`}
                    disabled={saving}
                    onClick={() => void stop(row)}
                  >
                    {saving ? (
                      <Spinner className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <X className="h-3.5 w-3.5" />
                    )}
                  </Button>
                </SimpleTooltip>
              </li>
            );
          })}
        </ul>
      )}

      <form onSubmit={(event) => void submit(event)} className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            id={fieldId}
            aria-label="File, folder or pattern to ignore"
            aria-invalid={problem ? true : undefined}
            aria-describedby={problem ? errorId : undefined}
            className="min-w-[12rem] flex-1 font-mono text-xs"
            placeholder="vendor/   or   *.map"
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              setProblem(null);
            }}
            autoComplete="off"
            spellCheck={false}
          />
          <Combobox
            ariaLabel="Where it applies"
            className="w-56"
            options={scopes}
            value={scope}
            onChange={setScope}
            searchable={false}
          />
          <Button type="submit" size="sm" disabled={text.trim() === '' || saving}>
            {saving ? <Spinner className="h-3.5 w-3.5 animate-spin" /> : null}
            Ignore
          </Button>
        </div>
        {problem ? (
          <p id={errorId} role="alert" className="text-xs text-destructive">
            {problem}
          </p>
        ) : (
          <p className="text-[11px] text-muted-foreground">
            Written like a .gitignore: <span className="font-mono">vendor/</span> ignores any folder
            of that name, <span className="font-mono">/vendor/</span> only the one at the top, and a
            line starting with <span className="font-mono">!</span> brings something back.
          </p>
        )}
      </form>

      <p className="text-[11px] text-muted-foreground">
        Left out on their own: whatever a .gitignore names, folders that start with .claude or
        .runova, secrets, and build clutter like node_modules.
      </p>
    </div>
  );
}
