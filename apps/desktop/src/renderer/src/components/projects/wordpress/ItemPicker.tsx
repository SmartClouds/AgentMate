import type { WpItem, WpItemRef } from '@agentmat/core';
import { wpItemKey } from '@agentmat/core';
import { wordPressErrorCode, wordPressErrorMessage } from '@shared/wordpressErrors';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import { RunError } from './FlowParts';
import { ITEM_KIND_GROUP_LABEL, ITEM_KIND_ORDER } from './wordpressCopy';

/**
 * A site's themes, plugins and must-use plugins to tick (E21). The connector's own files are
 * never offered. Names and versions come from the site and show as plain text.
 */

/** The items a new project starts with: the theme the site is using right now. */
export function defaultItemKeys(items: readonly WpItem[]): Set<string> {
  return new Set(
    items
      .filter((item) => item.kind === 'theme' && item.active && !item.protected)
      .map((item) => wpItemKey(item)),
  );
}

/** The keys of the starting items the site still has, leaving out ones the picker never offers. */
export function startingItemKeys(
  items: readonly WpItem[],
  wanted: readonly WpItemRef[],
): Set<string> {
  const keys = new Set(wanted.map(wpItemKey));
  return new Set(
    items
      .filter((item) => !item.protected && keys.has(wpItemKey(item)))
      .map((item) => wpItemKey(item)),
  );
}

export function toItemRef(item: WpItemRef): WpItemRef {
  return { kind: item.kind, slug: item.slug };
}

export function ItemPicker({
  items,
  loading,
  error,
  selected,
  onChange,
  exclude,
}: {
  items: readonly WpItem[] | undefined;
  loading: boolean;
  error: unknown;
  selected: ReadonlySet<string>;
  onChange: (next: Set<string>) => void;
  /** Keys not to offer, like the items a project already has. */
  exclude?: ReadonlySet<string>;
}): React.JSX.Element {
  if (loading) {
    return (
      <div role="status" aria-label="Loading the site's themes and plugins" className="space-y-1.5">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-10 w-full rounded-lg" />
        <Skeleton className="h-10 w-full rounded-lg" />
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-10 w-full rounded-lg" />
      </div>
    );
  }
  if (error) {
    return <RunError message={wordPressErrorMessage(error)} code={wordPressErrorCode(error)} />;
  }
  const offered = (items ?? []).filter(
    (item) => !item.protected && !(exclude?.has(wpItemKey(item)) ?? false),
  );
  if (offered.length === 0) {
    return (
      <p className="rounded-lg bg-foreground/[0.03] px-3 py-6 text-center text-sm text-muted-foreground ring-1 ring-inset ring-foreground/[0.07]">
        {exclude && exclude.size > 0
          ? 'This project already has every theme and plugin the site offers.'
          : 'The site has no themes or plugins AgentMate can sync.'}
      </p>
    );
  }

  function toggle(key: string, checked: boolean): void {
    const next = new Set(selected);
    if (checked) next.add(key);
    else next.delete(key);
    onChange(next);
  }

  return (
    <div className="space-y-4">
      {ITEM_KIND_ORDER.map((kind) => {
        const group = offered.filter((item) => item.kind === kind);
        if (group.length === 0) return null;
        return (
          <section key={kind} className="space-y-1.5">
            <h3 className="select-none px-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/70">
              {ITEM_KIND_GROUP_LABEL[kind]}
            </h3>
            <ul className="overflow-hidden rounded-lg bg-foreground/[0.03] ring-1 ring-inset ring-foreground/[0.07]">
              {group.map((item) => {
                const key = wpItemKey(item);
                const checkboxId = `wp-item-${key.replace(/[^A-Za-z0-9_-]/g, '_')}`;
                return (
                  <li key={key} className="flex items-center gap-3 px-3 py-2">
                    <Checkbox
                      id={checkboxId}
                      checked={selected.has(key)}
                      onCheckedChange={(checked) => toggle(key, checked === true)}
                    />
                    <label htmlFor={checkboxId} className="min-w-0 flex-1 cursor-pointer">
                      <span className="block truncate text-sm font-medium">{item.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        <span className="font-mono">{item.slug}</span>
                        {item.version ? ` · version ${item.version}` : ''}
                        {item.parentTheme ? ` · child of ${item.parentTheme}` : ''}
                        {item.writable ? '' : " · the site can't write to it"}
                      </span>
                    </label>
                    {item.networkActive ? (
                      <ActiveChip>Network active</ActiveChip>
                    ) : item.active ? (
                      <ActiveChip>Active</ActiveChip>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function ActiveChip({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <span className="shrink-0 rounded-full bg-success/12 px-2 py-0.5 text-[10px] font-medium text-success">
      {children}
    </span>
  );
}
