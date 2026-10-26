import type { ApiTreeNode } from '@runova/core';
import type { ApiCollectionSummary } from '@shared/apiClientTypes';
import { LayoutGroup, motion, useReducedMotion } from 'framer-motion';
import { useMemo, useState } from 'react';
import {
  ChevronRight,
  CollapseAll,
  EllipsisVertical,
  FilePlus,
  Folder,
  FolderOpen,
  FolderPlus,
  FolderTree,
  Pencil,
  Plus,
  Search,
  Trash2,
  TriangleAlert,
  X,
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
import { Skeleton } from '@/components/ui/skeleton';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { methodLabel } from './format';
import { MethodBadge } from './MethodBadge';

interface CollectionsSidebarProps {
  collections: ApiCollectionSummary[];
  loading: boolean;
  activeItem: { collectionId: string; itemId: string } | null;
  onOpenRequest: (collectionId: string, itemId: string) => void;
  onNewCollection: () => void;
  onNewRequest: (collectionId: string, parentId: string | null) => void;
  onNewFolder: (collectionId: string, parentId: string | null) => void;
  onRenameCollection: (collection: ApiCollectionSummary) => void;
  onDeleteCollection: (collection: ApiCollectionSummary) => void;
  onDeleteItem: (collectionId: string, node: ApiTreeNode) => void;
}

/** Keeps matching nodes and the folders that lead to them. */
function filterTree(nodes: ApiTreeNode[], query: string): ApiTreeNode[] {
  const out: ApiTreeNode[] = [];
  for (const node of nodes) {
    const selfMatch = node.name.toLowerCase().includes(query);
    if (node.kind === 'folder') {
      const children = selfMatch ? (node.children ?? []) : filterTree(node.children ?? [], query);
      if (selfMatch || children.length > 0) out.push({ ...node, children });
    } else if (selfMatch) {
      out.push(node);
    }
  }
  return out;
}

const INDENT_REM = 0.8;

/** A small square icon button for the sidebar header, with the main menu's hover wash. */
export function CollectionsSidebar(props: CollectionsSidebarProps): React.JSX.Element {
  const { collections, loading, onNewCollection } = props;
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const reduceMotion = useReducedMotion();

  const needle = query.trim().toLowerCase();
  const visible = useMemo(() => {
    if (!needle) return collections.map((c) => ({ collection: c, tree: c.tree }));
    return collections.flatMap((c) => {
      const tree = c.name.toLowerCase().includes(needle) ? c.tree : filterTree(c.tree, needle);
      return tree.length > 0 || c.name.toLowerCase().includes(needle)
        ? [{ collection: c, tree }]
        : [];
    });
  }, [collections, needle]);

  function toggle(key: string): void {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  // While filtering, everything that is shown is open, so matches are never hidden in a fold.
  const isOpen = (key: string): boolean => needle.length > 0 || expanded.has(key);

  const empty = !loading && collections.length === 0;
  const pillTransition = reduceMotion
    ? { duration: 0 }
    : { type: 'spring' as const, stiffness: 420, damping: 32 };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-0.5 pl-3.5 pr-2">
        <h2 className={cn(SECTION_HEADING, 'min-w-0 flex-1 truncate')}>Collections</h2>
        {expanded.size > 0 && !needle && (
          <SimpleTooltip label="Collapse all">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Collapse all"
              onClick={() => setExpanded(new Set())}
            >
              <CollapseAll />
            </Button>
          </SimpleTooltip>
        )}
        <SimpleTooltip label="New collection">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="New collection"
            onClick={onNewCollection}
          >
            <Plus />
          </Button>
        </SimpleTooltip>
      </div>

      {/* Nothing to filter until there is a collection, so the empty state stands on its own. */}
      {!empty && (
        <div className="shrink-0 px-2 pb-2">
          <div className="search-pill flex h-7 items-center gap-1.5 rounded-full pl-2.5 pr-1 transition-colors">
            <Search className="h-3 w-3 shrink-0 text-muted-foreground" />
            <input
              type="search"
              aria-label="Filter collections"
              placeholder="Filter requests"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && query) {
                  event.preventDefault();
                  event.stopPropagation();
                  setQuery('');
                }
              }}
              spellCheck={false}
              className="h-full min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/70 [&::-webkit-search-cancel-button]:appearance-none"
            />
            {query && (
              <button
                type="button"
                aria-label="Clear filter"
                onClick={() => setQuery('')}
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X className="h-2.5 w-2.5" />
              </button>
            )}
          </div>
        </div>
      )}

      <div className="rail-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {loading ? (
          <div
            role="status"
            aria-label="Loading collections"
            className="flex flex-col gap-1 py-0.5"
          >
            <Skeleton className="h-7 w-full rounded-lg" />
            <Skeleton className="ml-4 h-7 w-[85%] rounded-lg" />
            <Skeleton className="ml-4 h-7 w-[70%] rounded-lg" />
            <Skeleton className="h-7 w-[90%] rounded-lg" />
          </div>
        ) : empty ? (
          <div className="flex flex-col items-center gap-3 px-3 pb-6 pt-10 text-center">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-primary/12 text-primary shadow-[0_0_40px_-12px_hsl(var(--primary)/0.7)]">
              <FolderTree className="h-5 w-5" />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium">No collections yet</p>
              <p className="text-xs leading-relaxed text-muted-foreground">
                Collections keep your saved requests together, organised in folders.
              </p>
            </div>
            <Button size="sm" onClick={onNewCollection}>
              <Plus /> Create a collection
            </Button>
          </div>
        ) : visible.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-3 py-8 text-center">
            <Search className="h-4 w-4 text-muted-foreground/60" />
            <p className="text-xs text-muted-foreground">Nothing matches “{query}”.</p>
          </div>
        ) : (
          <LayoutGroup id="api-collections">
            <div role="tree" aria-label="Collections" className="flex flex-col gap-px">
              {visible.map(({ collection, tree }) => (
                <CollectionRow
                  key={collection.id}
                  {...props}
                  collection={collection}
                  tree={tree}
                  isOpen={isOpen}
                  toggle={toggle}
                  pillTransition={pillTransition}
                />
              ))}
            </div>
          </LayoutGroup>
        )}
      </div>
    </div>
  );
}

interface RowContext extends CollectionsSidebarProps {
  isOpen: (key: string) => boolean;
  toggle: (key: string) => void;
  pillTransition: React.ComponentProps<typeof motion.span>['transition'];
}

function CollectionRow({
  collection,
  tree,
  ...ctx
}: RowContext & { collection: ApiCollectionSummary; tree: ApiTreeNode[] }): React.JSX.Element {
  const open = ctx.isOpen(collection.id);
  const broken = collection.error !== null;

  return (
    <div>
      <TreeRow
        depth={0}
        label={collection.name}
        strong
        expanded={broken ? undefined : open}
        broken={broken}
        onActivate={() => !broken && ctx.toggle(collection.id)}
        pillTransition={ctx.pillTransition}
        icon={
          broken ? (
            <SimpleTooltip label={collection.error}>
              <TriangleAlert className="h-3.5 w-3.5 shrink-0 text-warning" />
            </SimpleTooltip>
          ) : (
            <FolderTree className="h-3.5 w-3.5 shrink-0 text-primary" />
          )
        }
        trailing={
          <span className="rounded-full bg-foreground/[0.06] px-1.5 text-[10px] leading-4 tabular-nums text-muted-foreground group-hover:hidden group-has-[[data-state=open]]:hidden">
            {collection.requestCount}
          </span>
        }
        menu={
          <>
            {!broken && (
              <>
                <DropdownMenuItem onSelect={() => ctx.onNewRequest(collection.id, null)}>
                  <FilePlus className="h-3.5 w-3.5" /> Add request
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => ctx.onNewFolder(collection.id, null)}>
                  <FolderPlus className="h-3.5 w-3.5" /> Add folder
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => ctx.onRenameCollection(collection)}>
                  <Pencil className="h-3.5 w-3.5" /> Rename
                </DropdownMenuItem>
                <DropdownMenuSeparator />
              </>
            )}
            <DropdownMenuItem onSelect={() => ctx.onDeleteCollection(collection)} tone="danger">
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </DropdownMenuItem>
          </>
        }
      />
      {open && !broken && (
        <div role="group" className="flex flex-col gap-px pt-px">
          {tree.length === 0 ? (
            <button
              type="button"
              onClick={() => ctx.onNewRequest(collection.id, null)}
              style={{ paddingLeft: `${0.35 + INDENT_REM + 0.95}rem` }}
              className="flex h-7 w-full items-center gap-1.5 rounded-lg pr-2 text-left text-xs text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <FilePlus className="h-3 w-3 shrink-0" />
              Add a request
            </button>
          ) : (
            tree.map((node) => (
              <NodeRow key={node.id} {...ctx} collectionId={collection.id} node={node} depth={1} />
            ))
          )}
        </div>
      )}
    </div>
  );
}

function NodeRow({
  collectionId,
  node,
  depth,
  ...ctx
}: RowContext & { collectionId: string; node: ApiTreeNode; depth: number }): React.JSX.Element {
  const key = `${collectionId}/${node.id}`;

  if (node.kind === 'request') {
    const active =
      ctx.activeItem?.collectionId === collectionId && ctx.activeItem.itemId === node.id;
    const method = node.method ?? 'GET';
    return (
      <TreeRow
        depth={depth}
        label={node.name}
        ariaLabel={`${methodLabel(method)} ${node.name}`}
        selected={active}
        onActivate={() => ctx.onOpenRequest(collectionId, node.id)}
        pillTransition={ctx.pillTransition}
        icon={<MethodBadge method={method} />}
        menu={
          <DropdownMenuItem onSelect={() => ctx.onDeleteItem(collectionId, node)} tone="danger">
            <Trash2 className="h-3.5 w-3.5" /> Delete
          </DropdownMenuItem>
        }
      />
    );
  }

  const open = ctx.isOpen(key);
  return (
    <div>
      <TreeRow
        depth={depth}
        label={node.name}
        expanded={open}
        onActivate={() => ctx.toggle(key)}
        pillTransition={ctx.pillTransition}
        icon={
          open ? (
            <FolderOpen className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          )
        }
        menu={
          <>
            <DropdownMenuItem onSelect={() => ctx.onNewRequest(collectionId, node.id)}>
              <FilePlus className="h-3.5 w-3.5" /> Add request
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => ctx.onNewFolder(collectionId, node.id)}>
              <FolderPlus className="h-3.5 w-3.5" /> Add folder
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => ctx.onDeleteItem(collectionId, node)} tone="danger">
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </DropdownMenuItem>
          </>
        }
      />
      {open && (
        <div role="group" className="flex flex-col gap-px pt-px">
          {(node.children ?? []).map((child) => (
            <NodeRow
              key={child.id}
              {...ctx}
              collectionId={collectionId}
              node={child}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface TreeRowProps {
  depth: number;
  label: string;
  /** What screen readers announce, when it should say more than the label. */
  ariaLabel?: string;
  icon: React.ReactNode;
  /** undefined for leaves, which get no chevron. */
  expanded?: boolean;
  selected?: boolean;
  broken?: boolean;
  /** A collection's own row, which reads a little heavier than what is inside it. */
  strong?: boolean;
  trailing?: React.ReactNode;
  menu: React.ReactNode;
  onActivate: () => void;
  pillTransition: RowContext['pillTransition'];
}

function TreeRow({
  depth,
  label,
  ariaLabel,
  icon,
  expanded,
  selected = false,
  broken = false,
  strong = false,
  trailing,
  menu,
  onActivate,
  pillTransition,
}: TreeRowProps): React.JSX.Element {
  return (
    <div
      role="treeitem"
      aria-label={ariaLabel ?? label}
      tabIndex={0}
      aria-expanded={expanded}
      aria-selected={selected}
      data-broken={broken || undefined}
      onClick={onActivate}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onActivate();
        }
      }}
      style={{ paddingLeft: `${0.35 + depth * INDENT_REM}rem` }}
      className={cn(
        // `isolate` keeps the active pill behind the row's text without lifting every child.
        'group relative isolate flex h-7 shrink-0 cursor-pointer select-none items-center gap-1.5 rounded-lg pr-1 text-[13px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
        selected
          ? 'font-medium text-primary'
          : 'text-foreground/85 hover:bg-foreground/[0.06] hover:text-foreground',
        strong && !selected && 'font-medium text-foreground',
        broken && 'text-muted-foreground',
      )}
    >
      {selected && (
        <motion.span
          aria-hidden
          layoutId="api-collections-active"
          transition={pillTransition}
          className="absolute inset-0 -z-10 rounded-lg bg-primary/12"
        >
          <span className="absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-full bg-primary shadow-[0_0_8px_hsl(var(--primary)/0.7)]" />
        </motion.span>
      )}
      <span className="flex w-3 shrink-0 justify-center text-muted-foreground">
        {expanded !== undefined && (
          <ChevronRight
            className={cn('h-2.5 w-2.5 transition-transform', expanded && 'rotate-90')}
          />
        )}
      </span>
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {trailing}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`Actions for ${label}`}
            onClick={(event) => event.stopPropagation()}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-foreground/10 hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100 data-[state=open]:opacity-100"
          >
            <EllipsisVertical className="h-3 w-3" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" onClick={(event) => event.stopPropagation()}>
          {menu}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
