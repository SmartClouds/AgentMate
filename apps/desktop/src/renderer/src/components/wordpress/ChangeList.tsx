import type { WpChange, WpItemRef, WpPlannedChange } from '@runova/core';
import { wpItemKey, wpMirrorPath } from '@runova/core';
import { wordPressErrorMessage } from '@shared/wordpressErrors';
import { useQuery } from '@tanstack/react-query';
import { MonacoDiffEditor } from '@/components/editor/MonacoDiffEditor';
import { EyeOff, FileCode, X } from '@/components/icons';
import { ITEM_KIND_LABEL, joinFolder } from '@/components/projects/wordpress/wordpressCopy';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { formatBytes } from '@/lib/format';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { type IgnoreChoice, ignoreChoicesFor } from './ignoreChoices';

/**
 * The files a pull or deploy would change, grouped by theme or plugin (E21). Clicking one shows
 * this computer's copy against the site's.
 */

export type SyncDirection = 'deploy' | 'pull';

/** One path of one item: `theme:twentytwentyfive/style.css`. Also the key pull resolutions use. */
export function changeKey(change: { item: WpItemRef; path: string }): string {
  return `${wpItemKey(change.item)}/${change.path}`;
}

/** The kind of change that matters in this direction: ours for a deploy, the site's for a pull. */
export function changeKind(change: WpPlannedChange, direction: SyncDirection): WpChange {
  const side = direction === 'deploy' ? change.local : change.remote;
  if (side) return side;
  if (change.action === 'deleteRemote' || change.action === 'deleteLocal') return 'deleted';
  return 'modified';
}

const KIND_STYLE: Record<WpChange, string> = {
  added: 'bg-success/12 text-success',
  modified: 'bg-primary/12 text-primary',
  deleted: 'bg-destructive/12 text-destructive',
};

const KIND_LABEL: Record<WpChange, string> = {
  added: 'Added',
  modified: 'Modified',
  deleted: 'Deleted',
};

export function ChangeKindChip({ kind }: { kind: WpChange }): React.JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex h-5 w-[4.5rem] shrink-0 items-center justify-center rounded-full text-[10px] font-semibold uppercase tracking-wide',
        KIND_STYLE[kind],
      )}
    >
      {KIND_LABEL[kind]}
    </span>
  );
}

/** Groups changes by item, keeping the order the plan gave them. */
export function groupByItem<T extends { item: WpItemRef }>(
  entries: readonly T[],
): { item: WpItemRef; entries: T[] }[] {
  const groups = new Map<string, { item: WpItemRef; entries: T[] }>();
  for (const entry of entries) {
    const key = wpItemKey(entry.item);
    const group = groups.get(key);
    if (group) group.entries.push(entry);
    else groups.set(key, { item: entry.item, entries: [entry] });
  }
  return [...groups.values()];
}

export function ItemHeading({
  item,
  count,
}: {
  item: WpItemRef;
  count?: number;
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 px-1 text-xs">
      <span className="font-medium text-muted-foreground">{ITEM_KIND_LABEL[item.kind]}</span>
      <span className="truncate font-mono text-foreground">{item.slug}</span>
      {count !== undefined ? (
        <span className="rounded-full bg-foreground/[0.06] px-1.5 text-[10px] leading-4 tabular-nums text-muted-foreground">
          {count}
        </span>
      ) : null}
    </div>
  );
}

/** Turns on picking files to leave out of the sync (E21). */
export interface ChangeListIgnore {
  /** The ticked rows, by `changeKey`. */
  picked: ReadonlySet<string>;
  onPickedChange: (next: Set<string>) => void;
  /** A choice made from a row's menu. */
  onIgnore: (choice: IgnoreChoice) => void;
  /** Locks the boxes and menus, while the list is being worked out again. */
  disabled?: boolean;
}

export interface ChangeListProps {
  /** The plan's changes; conflicts are left to the ConflictResolver. */
  changes: readonly WpPlannedChange[];
  direction: SyncDirection;
  selectedKey?: string | null;
  onSelect?: (change: WpPlannedChange) => void;
  /** When given, each row has a box to tick and a menu to leave the file out. */
  ignore?: ChangeListIgnore;
}

/** Groups the choices of one file: the file, its folders, its ending. */
function choiceGroups(choices: readonly IgnoreChoice[]): IgnoreChoice[][] {
  const groups = [
    choices.filter((choice) => choice.id === 'file'),
    choices.filter((choice) => choice.id.startsWith('folder:')),
    choices.filter((choice) => choice.id.startsWith('extension')),
  ];
  return groups.filter((group) => group.length > 0);
}

function RowIgnoreMenu({
  change,
  choices,
  disabled,
  onIgnore,
}: {
  change: WpPlannedChange;
  choices: readonly IgnoreChoice[];
  disabled?: boolean;
  onIgnore: (choice: IgnoreChoice) => void;
}): React.JSX.Element {
  return (
    <DropdownMenu>
      <SimpleTooltip label="Leave out of the sync…">
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="mr-1 shrink-0 text-muted-foreground opacity-60 hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
            aria-label={`Ignore options for ${change.path}`}
            disabled={disabled}
          >
            <EyeOff className="h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
      </SimpleTooltip>
      <DropdownMenuContent align="end" className="max-w-sm">
        {choiceGroups(choices).map((group, index) => (
          <div key={group[0].id}>
            {index > 0 ? <DropdownMenuSeparator /> : null}
            {group.map((choice) => (
              <DropdownMenuItem key={choice.id} onSelect={() => onIgnore(choice)}>
                {choice.label}
              </DropdownMenuItem>
            ))}
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Checked when all of a group's rows are ticked, mixed when some are. */
function groupState(
  keys: readonly string[],
  picked: ReadonlySet<string>,
): boolean | 'indeterminate' {
  const count = keys.filter((key) => picked.has(key)).length;
  if (count === 0) return false;
  return count === keys.length ? true : 'indeterminate';
}

export function ChangeList({
  changes,
  direction,
  selectedKey,
  onSelect,
  ignore,
}: ChangeListProps): React.JSX.Element {
  const shown = changes.filter(
    (change) => change.action !== 'conflict' && change.action !== 'none',
  );
  if (shown.length === 0) {
    return (
      <p className="px-1 text-sm text-muted-foreground">
        {direction === 'deploy'
          ? 'No files to send. The site already has what this folder has.'
          : 'Nothing new on the site since the last sync.'}
      </p>
    );
  }

  function toggle(keys: readonly string[], on: boolean): void {
    if (!ignore) return;
    const next = new Set(ignore.picked);
    for (const key of keys) {
      if (on) next.add(key);
      else next.delete(key);
    }
    ignore.onPickedChange(next);
  }

  return (
    <div className="space-y-3">
      {groupByItem(shown).map((group) => {
        const keys = group.entries.map(changeKey);
        return (
          <section key={wpItemKey(group.item)} className="space-y-1">
            {ignore ? (
              <div className="flex items-center gap-2 pl-2.5">
                <Checkbox
                  aria-label={`Select all changes in ${group.item.slug}`}
                  checked={groupState(keys, ignore.picked)}
                  disabled={ignore.disabled}
                  onCheckedChange={(checked) => toggle(keys, checked === true)}
                />
                <ItemHeading item={group.item} count={group.entries.length} />
              </div>
            ) : (
              <ItemHeading item={group.item} count={group.entries.length} />
            )}
            <ul className="overflow-hidden rounded-lg bg-foreground/[0.03] ring-1 ring-inset ring-foreground/[0.07]">
              {group.entries.map((change) => {
                const key = changeKey(change);
                const kind = changeKind(change, direction);
                const selected = selectedKey === key;
                const body = (
                  <>
                    <ChangeKindChip kind={kind} />
                    <span className="min-w-0 flex-1 truncate font-mono text-xs">{change.path}</span>
                    {change.size > 0 ? (
                      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                        {formatBytes(change.size)}
                      </span>
                    ) : null}
                  </>
                );
                const rowClass = cn(
                  'flex w-full cursor-pointer items-center gap-2.5 px-2.5 py-1.5 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                  selected ? 'bg-primary/10' : 'hover:bg-foreground/[0.05]',
                );
                if (!ignore) {
                  return (
                    <li key={key}>
                      <button
                        type="button"
                        aria-pressed={selected}
                        onClick={() => onSelect?.(change)}
                        className={rowClass}
                      >
                        {body}
                      </button>
                    </li>
                  );
                }
                const choices = ignoreChoicesFor(change.item, change.path);
                const ticked = ignore.picked.has(key);
                return (
                  <li
                    key={key}
                    className={cn('flex items-center', ticked ? 'bg-primary/[0.07]' : '')}
                  >
                    <Checkbox
                      className="ml-2.5 shrink-0"
                      aria-label={`Select ${change.path}`}
                      checked={ticked}
                      disabled={ignore.disabled}
                      onCheckedChange={(checked) => toggle([key], checked === true)}
                    />
                    <button
                      type="button"
                      aria-pressed={selected}
                      onClick={() => onSelect?.(change)}
                      className={cn(rowClass, 'min-w-0 flex-1')}
                    >
                      {body}
                    </button>
                    {choices.length > 0 ? (
                      <RowIgnoreMenu
                        change={change}
                        choices={choices}
                        disabled={ignore.disabled}
                        onIgnore={ignore.onIgnore}
                      />
                    ) : (
                      <span className="mr-1 h-7 w-7 shrink-0" aria-hidden="true" />
                    )}
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

const BINARY_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'avif',
  'ico',
  'bmp',
  'woff',
  'woff2',
  'ttf',
  'otf',
  'eot',
  'zip',
  'gz',
  'pdf',
  'mp3',
  'mp4',
  'webm',
  'ogg',
  'wav',
  'mo',
]);

function looksBinary(path: string): boolean {
  const name = path.split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  return dot > 0 && BINARY_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

/** A single-file plugin or mu-plugin has one path, its own name. */
export function isSingleFilePath(item: WpItemRef, path: string): boolean {
  return item.kind !== 'theme' && path === item.slug && /\.php$/i.test(item.slug);
}

/** Where a change's file lives on this computer. */
export function localFilePath(folderPath: string, item: WpItemRef, path: string): string {
  const relative = wpMirrorPath(item, isSingleFilePath(item, path), path);
  const separator = folderPath.includes('\\') ? '\\' : '/';
  return joinFolder(folderPath, relative.split('/').join(separator));
}

export interface ChangeDiffProps {
  projectId: string;
  /** The project folder, for reading this computer's copy. */
  folderPath: string;
  change: WpPlannedChange;
  direction: SyncDirection;
  onClose?: () => void;
}

/** This computer's copy of a file against the site's, the side being changed on the right. */
export function ChangeDiff({
  projectId,
  folderPath,
  change,
  direction,
  onClose,
}: ChangeDiffProps): React.JSX.Element {
  const binary = looksBinary(change.path);
  // Deleted here (a deploy that removes it from the site) or never here (new on the site).
  const localGone =
    change.local === 'deleted' || (direction === 'pull' && change.remote === 'added');
  const localPath = localFilePath(folderPath, change.item, change.path);

  const remoteQuery = useQuery({
    queryKey: queryKeys.projectWordPressRemoteFile(projectId, wpItemKey(change.item), change.path),
    queryFn: () =>
      window.runova.deployWordPress.remoteFile({
        projectId,
        item: change.item,
        path: change.path,
      }),
    enabled: !binary,
    meta: { silentLoading: true },
  });
  const localQuery = useQuery({
    queryKey: queryKeys.workspaceFile(localPath),
    queryFn: () => window.runova.fs.readFile(localPath),
    enabled: !binary && !localGone,
    meta: { silentLoading: true },
  });

  const remote = remoteQuery.data;
  let body: React.ReactNode;
  if (binary || remote?.binary) {
    body = <DiffNote>This file isn't text, so there's nothing to compare line by line.</DiffNote>;
  } else if (remote?.tooLarge) {
    body = <DiffNote>The site's copy is too large to show here.</DiffNote>;
  } else if (remoteQuery.isError) {
    body = (
      <DiffNote tone="error">
        Couldn't read the site's copy. {wordPressErrorMessage(remoteQuery.error)}
      </DiffNote>
    );
  } else if (remoteQuery.isPending || (!localGone && localQuery.isPending)) {
    body = <Skeleton className="h-72 w-full rounded-lg" />;
  } else {
    const local = localGone || localQuery.isError ? '' : (localQuery.data ?? '');
    const site = remote?.text ?? '';
    body = (
      <MonacoDiffEditor
        path={change.path}
        original={direction === 'deploy' ? site : local}
        modified={direction === 'deploy' ? local : site}
        sideBySide
        ignoreWhitespace={false}
        className="h-72 overflow-hidden rounded-lg"
      />
    );
  }

  return (
    <section aria-label={`Changes in ${change.path}`} className="space-y-2">
      <div className="flex items-center gap-2">
        <FileCode className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-mono text-xs">{change.path}</span>
        <span className="hidden shrink-0 text-[11px] text-muted-foreground sm:inline">
          {direction === 'deploy'
            ? 'Left: on the site. Right: on this computer.'
            : 'Left: on this computer. Right: on the site.'}
        </span>
        {onClose ? (
          <Button
            variant="ghost"
            size="icon-sm"
            className="shrink-0"
            aria-label="Close the comparison"
            onClick={onClose}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        ) : null}
      </div>
      {body}
    </section>
  );
}

function DiffNote({
  children,
  tone = 'muted',
}: {
  children: React.ReactNode;
  tone?: 'muted' | 'error';
}): React.JSX.Element {
  return (
    <p
      className={cn(
        'rounded-lg bg-foreground/[0.03] px-3 py-6 text-center text-sm ring-1 ring-inset ring-foreground/[0.07]',
        tone === 'error' ? 'text-destructive' : 'text-muted-foreground',
      )}
    >
      {children}
    </p>
  );
}
