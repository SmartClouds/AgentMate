import type { WpChange, WpPlannedChange } from '@runova/core';
import { wpItemKey } from '@runova/core';
import { TriangleAlert } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';
import { changeKey, groupByItem, ItemHeading } from './ChangeList';

/**
 * Files that changed both here and on the site since the last sync (E21). A deploy stops at them
 * unless the user chooses to overwrite the site's version; a pull asks, file by file, which copy
 * to keep.
 */

export type ConflictResolution = 'keepLocal' | 'takeRemote';

const WORD: Record<WpChange, string> = {
  added: 'added',
  modified: 'changed',
  deleted: 'deleted',
};

/** What happened on each side, in a sentence. */
export function conflictStory(change: WpPlannedChange): string {
  const local = change.local;
  const remote = change.remote;
  if (local === 'added' && remote === 'added') {
    return 'Added here and on the site, with different contents.';
  }
  if (local && remote && local === remote)
    return `${capitalize(WORD[local])} here and on the site.`;
  const here = local ? `${capitalize(WORD[local])} here` : 'Unchanged here';
  const there = remote ? `${WORD[remote]} on the site` : 'unchanged on the site';
  return `${here}, ${there}.`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Every conflict set to keep this computer's copy, so an untouched review sends a full map. */
export function defaultResolutions(
  conflicts: readonly WpPlannedChange[],
): Record<string, ConflictResolution> {
  return Object.fromEntries(conflicts.map((change) => [changeKey(change), 'keepLocal' as const]));
}

type ConflictResolverProps =
  | {
      mode: 'deploy';
      conflicts: readonly WpPlannedChange[];
      overwrite: boolean;
      onOverwriteChange: (overwrite: boolean) => void;
      disabled?: boolean;
    }
  | {
      mode: 'pull';
      conflicts: readonly WpPlannedChange[];
      resolutions: Record<string, ConflictResolution>;
      onResolutionsChange: (resolutions: Record<string, ConflictResolution>) => void;
    };

export function ConflictResolver(props: ConflictResolverProps): React.JSX.Element | null {
  const { conflicts } = props;
  if (conflicts.length === 0) return null;
  const groups = groupByItem(conflicts);

  return (
    <section
      aria-label="Conflicts"
      className="space-y-3 rounded-xl bg-warning/[0.06] p-3 ring-1 ring-inset ring-warning/25"
    >
      <div className="flex items-start gap-2">
        <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
        <div className="space-y-0.5">
          <p className="text-sm font-medium">
            {conflicts.length === 1
              ? '1 file changed both here and on the site'
              : `${conflicts.length} files changed both here and on the site`}
          </p>
          <p className="text-xs text-muted-foreground">
            {props.mode === 'deploy'
              ? "Someone edited these on the site since the last sync. The deploy stops here unless you choose to overwrite the site's version."
              : "Pick which copy to keep for each one. Your copy stays as it is unless you take the site's."}
          </p>
        </div>
      </div>

      {props.mode === 'pull' ? (
        <div className="flex flex-wrap gap-1.5">
          <Button
            variant="soft"
            size="sm"
            onClick={() => props.onResolutionsChange(defaultResolutions(conflicts))}
          >
            Keep all of mine
          </Button>
          <Button
            variant="soft"
            size="sm"
            onClick={() =>
              props.onResolutionsChange(
                Object.fromEntries(conflicts.map((change) => [changeKey(change), 'takeRemote'])),
              )
            }
          >
            Take all from the site
          </Button>
        </div>
      ) : null}

      {groups.map((group) => (
        <div key={wpItemKey(group.item)} className="space-y-1">
          <ItemHeading item={group.item} />
          <ul className="space-y-1">
            {group.entries.map((change) => {
              const key = changeKey(change);
              return (
                <li
                  key={key}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-background/40 px-2.5 py-1.5"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-mono text-xs">{change.path}</p>
                    <p className="text-[11px] text-muted-foreground">{conflictStory(change)}</p>
                  </div>
                  {props.mode === 'pull' ? (
                    <ResolutionToggle
                      path={change.path}
                      value={props.resolutions[key] ?? 'keepLocal'}
                      onChange={(value) =>
                        props.onResolutionsChange({ ...props.resolutions, [key]: value })
                      }
                    />
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ))}

      {props.mode === 'deploy' ? (
        <label className="flex cursor-pointer items-start gap-2 text-sm">
          <Checkbox
            className="mt-0.5"
            checked={props.overwrite}
            disabled={props.disabled}
            onCheckedChange={(checked) => props.onOverwriteChange(checked === true)}
          />
          <span>
            <span className="font-medium">Overwrite the site's version</span>
            <span className="block text-xs text-muted-foreground">
              This computer's copy replaces what's on the site now, and the site's edits are lost
              unless you roll the deploy back.
            </span>
          </span>
        </label>
      ) : null}
    </section>
  );
}

function ResolutionToggle({
  path,
  value,
  onChange,
}: {
  path: string;
  value: ConflictResolution;
  onChange: (value: ConflictResolution) => void;
}): React.JSX.Element {
  const options: { value: ConflictResolution; label: string }[] = [
    { value: 'keepLocal', label: 'Keep mine' },
    { value: 'takeRemote', label: "Take the site's" },
  ];
  return (
    <div
      role="group"
      aria-label={`Which copy of ${path} to keep`}
      className="flex shrink-0 items-center gap-0.5 rounded-full bg-foreground/[0.06] p-0.5"
    >
      {options.map((option) => {
        const active = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            className={cn(
              'h-6 cursor-pointer rounded-full px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              active ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
