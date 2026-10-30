import type { VaultCategory } from '@runova/core';
import { LayoutGroup, motion, useReducedMotion } from 'framer-motion';
import { useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  EllipsisVertical,
  FolderPlus,
  Inbox,
  Layers,
  Pencil,
  Plus,
  Trash2,
} from '@/components/icons';
import { SECTION_HEADING } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ReorderableGroup, type ReorderMotion } from '@/components/ui/ReorderableGroup';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { VaultCategoryCounts, VaultCategoryFilter } from '@/lib/vault/categories';
import { CategoryTile } from './CategoryTile';
import { CATEGORY_COLORS } from './categoryMeta';
import { VAULT_ENTRY_DRAG_TYPE } from './VaultEntryRow';

export interface VaultCategoryRailProps {
  /** `rail` is the column on a wide window, `strip` the row of pills above the list otherwise. */
  variant: 'rail' | 'strip';
  categories: VaultCategory[];
  counts: VaultCategoryCounts;
  active: VaultCategoryFilter;
  onSelect: (filter: VaultCategoryFilter) => void;
  onNew: () => void;
  onEdit: (category: VaultCategory) => void;
  onDelete: (category: VaultCategory) => void;
  onReorder: (ids: string[]) => void;
  /** Entries dragged from the list onto a category, or onto Uncategorized (null). */
  onDropEntries: (ids: string[], categoryId: string | null) => void;
  className?: string;
}

/** Where a dragged entry may land: a category or Uncategorized, never All items. */
type DropTarget = string | null | undefined;

function draggedEntry(event: React.DragEvent): boolean {
  return Array.from(event.dataTransfer.types).includes(VAULT_ENTRY_DRAG_TYPE);
}

/** Drop handlers for one rail row or pill. `target` undefined means it takes no drops. */
function useDropZone(target: DropTarget, onDropEntries: VaultCategoryRailProps['onDropEntries']) {
  const [over, setOver] = useState(false);
  if (target === undefined) return { over: false, props: {} };
  const accept = (event: React.DragEvent): boolean => {
    if (!draggedEntry(event)) return false;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    return true;
  };
  return {
    over,
    props: {
      'data-drop-target': over ? 'true' : undefined,
      onDragEnter: (event: React.DragEvent) => accept(event) && setOver(true),
      onDragOver: (event: React.DragEvent) => accept(event) && !over && setOver(true),
      onDragLeave: () => setOver(false),
      onDrop: (event: React.DragEvent) => {
        setOver(false);
        if (!draggedEntry(event)) return;
        event.preventDefault();
        const id = event.dataTransfer.getData(VAULT_ENTRY_DRAG_TYPE);
        if (id) onDropEntries([id], target);
      },
    },
  };
}

function ActivePill({ layoutId }: { layoutId: string }): React.JSX.Element {
  const reduceMotion = useReducedMotion();
  return (
    <motion.span
      aria-hidden
      layoutId={layoutId}
      transition={reduceMotion ? { duration: 0 } : { type: 'spring', stiffness: 420, damping: 34 }}
      className="absolute inset-0 -z-10 rounded-lg bg-primary/12 ring-1 ring-inset ring-primary/15"
    />
  );
}

function Count({ value, active }: { value: number; active: boolean }): React.JSX.Element {
  return (
    <span
      aria-hidden
      className={cn(
        'ml-auto shrink-0 rounded-full px-1.5 text-[10.5px] font-medium tabular-nums',
        active ? 'text-primary/80' : 'text-muted-foreground/80',
      )}
    >
      {value}
    </span>
  );
}

const ROW =
  'relative isolate flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 text-left text-[13px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring';

function FixedRow({
  label,
  icon,
  count,
  active,
  dropTarget,
  onSelect,
  onDropEntries,
}: {
  label: string;
  icon: React.ReactNode;
  count: number;
  active: boolean;
  dropTarget: DropTarget;
  onSelect: () => void;
  onDropEntries: VaultCategoryRailProps['onDropEntries'];
}): React.JSX.Element {
  const drop = useDropZone(dropTarget, onDropEntries);
  return (
    <button
      type="button"
      aria-label={`${label} (${count})`}
      aria-current={active ? 'true' : undefined}
      onClick={onSelect}
      {...drop.props}
      className={cn(
        ROW,
        active ? 'font-medium text-primary' : 'text-foreground/85 hover:bg-foreground/[0.06]',
        drop.over && 'bg-primary/10 ring-2 ring-inset ring-primary/40',
      )}
    >
      {active && <ActivePill layoutId="vault-category-active" />}
      <span
        aria-hidden
        className={cn(
          'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ring-1 ring-inset [&>svg]:h-3.5 [&>svg]:w-3.5',
          active
            ? 'bg-primary/15 text-primary ring-primary/25'
            : 'bg-foreground/[0.04] text-muted-foreground ring-foreground/[0.08]',
        )}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <Count value={count} active={active} />
    </button>
  );
}

function CategoryRow({
  category,
  count,
  active,
  index,
  total,
  reorder,
  props,
}: {
  category: VaultCategory;
  count: number;
  active: boolean;
  index: number;
  total: number;
  reorder: ReorderMotion;
  props: VaultCategoryRailProps;
}): React.JSX.Element {
  const drop = useDropZone(category.id, props.onDropEntries);
  const shift = (delta: -1 | 1): void => {
    const ids = props.categories.map((c) => c.id);
    const to = index + delta;
    if (to < 0 || to >= ids.length) return;
    [ids[index], ids[to]] = [ids[to], ids[index]];
    props.onReorder(ids);
  };

  return (
    <li
      {...reorder.itemProps}
      className={cn(
        'group/category relative',
        reorder.dragging
          ? 'z-10 rounded-lg bg-popover shadow-lg ring-1 ring-foreground/10 transition-none'
          : 'transition-transform duration-200 ease-out motion-reduce:transition-none',
      )}
    >
      {/* The whole row is the grip: a click filters, and a press that travels reorders. */}
      <button
        type="button"
        data-drag-grip
        aria-label={`${category.name} (${count})`}
        aria-current={active ? 'true' : undefined}
        aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
        onClick={() => props.onSelect(category.id)}
        onPointerDown={reorder.onGripPointerDown}
        onKeyDown={(event) => {
          if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
          event.preventDefault();
          shift(event.key === 'ArrowUp' ? -1 : 1);
        }}
        {...drop.props}
        className={cn(
          ROW,
          'pr-8',
          active ? 'font-medium text-primary' : 'text-foreground/85 hover:bg-foreground/[0.06]',
          drop.over && ['ring-2 ring-inset', CATEGORY_COLORS[category.color].wash],
        )}
      >
        {active && <ActivePill layoutId="vault-category-active" />}
        <CategoryTile color={category.color} icon={category.icon} />
        <span className="min-w-0 flex-1 truncate">{category.name}</span>
        <span className="transition-opacity group-focus-within/category:opacity-0 group-hover/category:opacity-0">
          <Count value={count} active={active} />
        </span>
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`Options for ${category.name}`}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 opacity-0 transition-opacity focus-visible:opacity-100 group-focus-within/category:opacity-100 group-hover/category:opacity-100 data-[state=open]:opacity-100"
          >
            <EllipsisVertical />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-44">
          <DropdownMenuItem onSelect={() => props.onEdit(category)}>
            <Pencil className="h-3.5 w-3.5" />
            Edit
          </DropdownMenuItem>
          <DropdownMenuItem disabled={index === 0} onSelect={() => shift(-1)}>
            <ArrowUp className="h-3.5 w-3.5" />
            Move up
          </DropdownMenuItem>
          <DropdownMenuItem disabled={index === total - 1} onSelect={() => shift(1)}>
            <ArrowDown className="h-3.5 w-3.5" />
            Move down
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => props.onDelete(category)}
            className="text-destructive focus:text-destructive"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

function Rail(props: VaultCategoryRailProps): React.JSX.Element {
  const { categories, counts, active, onSelect, onNew, onDropEntries } = props;
  return (
    <nav aria-label="Categories" className={cn('flex min-h-0 flex-col', props.className)}>
      <div className="flex h-10 shrink-0 items-center pl-3.5 pr-1.5">
        <h2 className={cn(SECTION_HEADING, 'min-w-0 flex-1 truncate')}>Categories</h2>
        <SimpleTooltip label="New category">
          <Button variant="ghost" size="icon-sm" aria-label="New category" onClick={onNew}>
            <Plus />
          </Button>
        </SimpleTooltip>
      </div>
      <div className="rail-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <LayoutGroup id="vault-categories">
          <FixedRow
            label="All items"
            icon={<Layers />}
            count={counts.all}
            active={active === 'all'}
            dropTarget={undefined}
            onSelect={() => onSelect('all')}
            onDropEntries={onDropEntries}
          />
          {categories.length > 0 ? (
            <ReorderableGroup
              as="ul"
              items={categories}
              getId={(category) => category.id}
              enabled
              className="mt-px flex flex-col gap-px"
              onMove={(from, to) => {
                const ids = categories.map((c) => c.id);
                const [moved] = ids.splice(from, 1);
                ids.splice(to, 0, moved);
                props.onReorder(ids);
              }}
              renderItem={(category, reorder, index) => (
                <CategoryRow
                  category={category}
                  count={counts.byId.get(category.id) ?? 0}
                  active={active === category.id}
                  index={index}
                  total={categories.length}
                  reorder={reorder}
                  props={props}
                />
              )}
            />
          ) : (
            <button
              type="button"
              onClick={onNew}
              aria-label="Create your first category"
              className="my-2 flex w-full cursor-pointer flex-col items-center gap-2 rounded-xl border border-dashed border-foreground/15 px-3 py-4 text-center transition-colors hover:border-primary/40 hover:bg-primary/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-primary/12 text-primary">
                <FolderPlus className="h-3.5 w-3.5" />
              </span>
              <span className="text-xs font-medium">Create your first category</span>
              <span className="text-[11px] leading-relaxed text-muted-foreground">
                Sort entries into folders like Work or Banking.
              </span>
            </button>
          )}
          <div className="mt-px">
            <FixedRow
              label="Uncategorized"
              icon={<Inbox />}
              count={counts.uncategorized}
              active={active === 'uncategorized'}
              dropTarget={null}
              onSelect={() => onSelect('uncategorized')}
              onDropEntries={onDropEntries}
            />
          </div>
        </LayoutGroup>
      </div>
      {categories.length > 0 && (
        <p className="shrink-0 px-4 pb-3 text-[10.5px] leading-relaxed text-muted-foreground/80">
          Drag an entry onto a category to move it.
        </p>
      )}
    </nav>
  );
}

function Pill({
  label,
  count,
  active,
  dot,
  dropTarget,
  onSelect,
  onDropEntries,
}: {
  label: string;
  count: number;
  active: boolean;
  dot?: string;
  dropTarget: DropTarget;
  onSelect: () => void;
  onDropEntries: VaultCategoryRailProps['onDropEntries'];
}): React.JSX.Element {
  const drop = useDropZone(dropTarget, onDropEntries);
  return (
    <button
      type="button"
      aria-label={`${label} (${count})`}
      aria-current={active ? 'true' : undefined}
      onClick={onSelect}
      {...drop.props}
      className={cn(
        'inline-flex h-6 shrink-0 cursor-pointer items-center gap-1.5 rounded-full px-2.5 text-[11px] font-medium ring-1 ring-inset transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        active
          ? 'bg-primary/12 text-primary ring-primary/30'
          : 'text-muted-foreground ring-foreground/[0.1] hover:bg-foreground/[0.06] hover:text-foreground',
        drop.over && 'bg-primary/10 ring-primary/50',
      )}
    >
      {dot && <span aria-hidden className={cn('h-1.5 w-1.5 rounded-full', dot)} />}
      {label}
      <span aria-hidden className="tabular-nums opacity-70">
        {count}
      </span>
    </button>
  );
}

function Strip(props: VaultCategoryRailProps): React.JSX.Element {
  const { categories, counts, active, onSelect, onNew, onDropEntries } = props;
  return (
    <nav
      aria-label="Categories"
      className={cn(
        'flex items-center gap-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
        props.className,
      )}
    >
      <Pill
        label="All items"
        count={counts.all}
        active={active === 'all'}
        dropTarget={undefined}
        onSelect={() => onSelect('all')}
        onDropEntries={onDropEntries}
      />
      {categories.map((category) => (
        <Pill
          key={category.id}
          label={category.name}
          count={counts.byId.get(category.id) ?? 0}
          active={active === category.id}
          dot={CATEGORY_COLORS[category.color].swatch}
          dropTarget={category.id}
          onSelect={() => onSelect(category.id)}
          onDropEntries={onDropEntries}
        />
      ))}
      {categories.length > 0 && (
        <Pill
          label="Uncategorized"
          count={counts.uncategorized}
          active={active === 'uncategorized'}
          dropTarget={null}
          onSelect={() => onSelect('uncategorized')}
          onDropEntries={onDropEntries}
        />
      )}
      <SimpleTooltip label="New category">
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="New category"
          className="shrink-0 rounded-full"
          onClick={onNew}
        >
          <FolderPlus />
        </Button>
      </SimpleTooltip>
    </nav>
  );
}

/** The category filters, with drop targets for moving entries and a menu to manage each one. */
export function VaultCategoryRail(props: VaultCategoryRailProps): React.JSX.Element {
  return props.variant === 'rail' ? <Rail {...props} /> : <Strip {...props} />;
}
