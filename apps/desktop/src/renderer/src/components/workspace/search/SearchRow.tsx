import type { GitChangeStatus } from '@runova/core';
import { isImagePath } from '@shared/imageFiles';
import type { SymbolKind } from '@shared/symbolKinds';
import { memo } from 'react';
import { ChevronRight, Clock, File, ImageIcon } from '@/components/icons';
import { SECTION_HEADING } from '@/components/pageKit';
import { changeStatusMeta } from '@/lib/git';
import { cn } from '@/lib/utils';
import type { Row } from '@/lib/workspaceSearch/rows';
import { Highlighted } from './Highlighted';

/** Every row is this tall, so the list can be drawn a screenful at a time. */
export const ROW_HEIGHT = 28;

/** A letter per kind, coloured by family, in the spirit of an editor's outline icons. */
const KIND_BADGE: Record<SymbolKind, { label: string; className: string; title: string }> = {
  class: {
    label: 'C',
    className: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
    title: 'Class',
  },
  interface: {
    label: 'I',
    className: 'bg-sky-500/15 text-sky-600 dark:text-sky-400',
    title: 'Interface',
  },
  struct: {
    label: 'S',
    className: 'bg-teal-500/15 text-teal-600 dark:text-teal-400',
    title: 'Struct',
  },
  enum: {
    label: 'E',
    className: 'bg-orange-500/15 text-orange-600 dark:text-orange-400',
    title: 'Enum',
  },
  type: { label: 'T', className: 'bg-sky-500/15 text-sky-600 dark:text-sky-400', title: 'Type' },
  record: {
    label: 'R',
    className: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
    title: 'Record',
  },
  trait: {
    label: 'Tr',
    className: 'bg-teal-500/15 text-teal-600 dark:text-teal-400',
    title: 'Trait',
  },
  namespace: {
    label: 'N',
    className: 'bg-foreground/10 text-muted-foreground',
    title: 'Namespace',
  },
  function: {
    label: 'ƒ',
    className: 'bg-violet-500/15 text-violet-600 dark:text-violet-400',
    title: 'Function',
  },
  method: {
    label: 'M',
    className: 'bg-violet-500/15 text-violet-600 dark:text-violet-400',
    title: 'Method',
  },
  constructor: {
    label: 'new',
    className: 'bg-violet-500/15 text-violet-600 dark:text-violet-400',
    title: 'Constructor',
  },
  property: {
    label: 'P',
    className: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
    title: 'Property',
  },
  field: {
    label: 'F',
    className: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
    title: 'Field',
  },
  const: {
    label: 'K',
    className: 'bg-rose-500/15 text-rose-600 dark:text-rose-400',
    title: 'Constant',
  },
};

function KindBadge({ kind }: { kind: SymbolKind }): React.JSX.Element {
  const badge = KIND_BADGE[kind];
  return (
    <span
      aria-label={badge.title}
      className={cn(
        'flex h-4 min-w-4 shrink-0 items-center justify-center rounded px-0.5 text-[9px] font-semibold leading-none',
        badge.className,
      )}
    >
      {badge.label}
    </span>
  );
}

function splitPath(path: string): { name: string; dir: string; nameStart: number } {
  const nameStart = path.lastIndexOf('/') + 1;
  return { name: path.slice(nameStart), dir: path.slice(0, Math.max(0, nameStart - 1)), nameStart };
}

function FileIcon({ path }: { path: string }): React.JSX.Element {
  return isImagePath(path) ? (
    <ImageIcon className="h-3 w-3 shrink-0 text-muted-foreground" />
  ) : (
    <File className="h-3 w-3 shrink-0 text-muted-foreground" />
  );
}

function StatusLetter({
  status,
}: {
  status: GitChangeStatus | undefined;
}): React.JSX.Element | null {
  if (!status) return null;
  const meta = changeStatusMeta(status);
  return (
    <span className={cn('shrink-0 font-mono text-[10px] font-semibold', meta.className)}>
      {meta.letter}
    </span>
  );
}

interface RowProps {
  row: Row;
  index: number;
  id: string;
  active: boolean;
  status: GitChangeStatus | undefined;
  /** Stable across renders, so the memo holds; they take the row index. */
  onHover: (index: number) => void;
  onOpen: (index: number) => void;
}

/** One line of the results list. Memoised: arrowing down re-renders two rows, not the screen. */
export const SearchRow = memo(function SearchRow({
  row,
  index,
  id,
  active,
  status,
  onHover,
  onOpen,
}: RowProps): React.JSX.Element {
  if (row.kind === 'section') {
    return (
      <div
        role="presentation"
        style={{ height: ROW_HEIGHT }}
        className={cn(SECTION_HEADING, 'flex items-end gap-1.5 px-4 pb-1')}
      >
        {row.label}
        <span className="font-normal normal-case tabular-nums tracking-normal">
          {row.count.toLocaleString()}
        </span>
      </div>
    );
  }

  if (row.kind === 'hint') {
    return (
      <div
        role="presentation"
        style={{ height: ROW_HEIGHT }}
        className="px-4 text-xs text-muted-foreground"
      >
        {row.text}
      </div>
    );
  }

  if (row.kind === 'textFile') {
    const { name, dir } = splitPath(row.path);
    return (
      <div
        role="presentation"
        style={{ height: ROW_HEIGHT }}
        onClick={() => onOpen(index)}
        className="mx-2 flex cursor-pointer select-none items-center gap-1.5 rounded-lg px-2 text-[12px] transition-colors hover:bg-foreground/[0.05]"
      >
        <FileIcon path={row.path} />
        <span className="shrink-0 font-medium">{name}</span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">{dir}</span>
        <StatusLetter status={status} />
        <span className="shrink-0 rounded-full bg-foreground/[0.07] px-1.5 text-[10px] tabular-nums text-muted-foreground">
          {row.count}
        </span>
      </div>
    );
  }

  let content: React.ReactNode;
  switch (row.kind) {
    case 'file':
    case 'recent': {
      const path = row.kind === 'file' ? row.hit.path : row.path;
      const ranges = row.kind === 'file' ? row.hit.ranges : [];
      const { name, dir, nameStart } = splitPath(path);
      content = (
        <>
          {row.kind === 'recent' ? (
            <Clock className="h-3 w-3 shrink-0 text-muted-foreground" />
          ) : (
            <FileIcon path={path} />
          )}
          <span className={cn('shrink-0', status === 'D' && 'line-through')}>
            <Highlighted text={name} offset={nameStart} ranges={ranges} />
          </span>
          <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
            <Highlighted text={dir} ranges={ranges} />
          </span>
          <StatusLetter status={status} />
        </>
      );
      break;
    }
    case 'symbol': {
      const { hit } = row;
      const { name } = splitPath(hit.path);
      content = (
        <>
          <KindBadge kind={hit.kind} />
          <span className="shrink-0">
            <Highlighted text={hit.label} ranges={hit.ranges} />
          </span>
          {hit.container && hit.label === hit.name ? (
            <span className="shrink-0 text-[11px] text-muted-foreground">in {hit.container}</span>
          ) : null}
          <span className="min-w-0 flex-1 truncate text-right text-[11px] text-muted-foreground [direction:rtl]">
            <bdi>
              {name}:{hit.line}
            </bdi>
          </span>
        </>
      );
      break;
    }
    case 'textLine': {
      const { match } = row;
      content = (
        <>
          <span className="w-9 shrink-0 text-right font-mono text-[10px] tabular-nums text-muted-foreground">
            {match.line}
          </span>
          <span className="min-w-0 flex-1 truncate whitespace-pre font-mono text-[11.5px]">
            {match.clipped ? <span className="text-muted-foreground">…</span> : null}
            <Highlighted text={match.text} ranges={match.ranges} />
          </span>
        </>
      );
      break;
    }
    case 'more':
      content = (
        <span className="flex items-center gap-1 text-[11px] font-medium text-primary">
          {row.label}
          <ChevronRight className="h-2 w-2" />
        </span>
      );
      break;
  }

  return (
    <div
      id={id}
      role="option"
      aria-selected={active}
      style={{ height: ROW_HEIGHT }}
      onMouseMove={active ? undefined : () => onHover(index)}
      onClick={() => onOpen(index)}
      className={cn(
        // Rows like the command palette's: a soft wash marks the selected one.
        'mx-2 flex cursor-pointer select-none items-center gap-2 rounded-lg px-2 text-[12px] transition-colors',
        row.kind === 'textLine' && 'pl-4',
        active ? 'bg-foreground/[0.07] text-foreground' : 'hover:bg-foreground/[0.04]',
      )}
    >
      {content}
    </div>
  );
});
