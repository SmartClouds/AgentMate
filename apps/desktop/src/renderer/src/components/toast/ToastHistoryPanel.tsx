import type { Project } from '@agentmat/core';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Bell,
  CircleCheck,
  CircleInfo,
  CircleX,
  Search,
  Trash2,
  TriangleAlert,
  X,
} from '@/components/icons';
import { ProjectIcon } from '@/components/projects/ProjectIcon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { openMessageLink } from '@/lib/messageLink';
import { queryKeys } from '@/lib/queryKeys';
import { persianTextProps } from '@/lib/rtl';
import { timeAgo } from '@/lib/time';
import { replayToast } from '@/lib/toastHistory';
import { cn } from '@/lib/utils';
import {
  type ToastHistoryItem,
  type ToastHistoryKind,
  useToastHistoryStore,
} from '@/stores/toastHistoryStore';

type FilterId = 'all' | ToastHistoryKind;

const FILTERS: { id: FilterId; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'error', label: 'Errors' },
  { id: 'warning', label: 'Warnings' },
  { id: 'success', label: 'Success' },
  { id: 'info', label: 'Info' },
];

const KIND_STYLE: Record<
  ToastHistoryKind,
  { icon: typeof CircleCheck; wrap: string; iconColor: string; edge: string }
> = {
  success: {
    icon: CircleCheck,
    wrap: 'bg-success/15',
    iconColor: 'text-success',
    edge: 'bg-success',
  },
  error: {
    icon: CircleX,
    wrap: 'bg-destructive/15',
    iconColor: 'text-destructive',
    edge: 'bg-destructive',
  },
  warning: {
    icon: TriangleAlert,
    wrap: 'bg-warning/15',
    iconColor: 'text-warning',
    edge: 'bg-warning',
  },
  info: {
    icon: CircleInfo,
    wrap: 'bg-foreground/[0.06]',
    iconColor: 'text-muted-foreground',
    edge: 'bg-muted-foreground',
  },
  message: {
    icon: CircleInfo,
    wrap: 'bg-foreground/[0.06]',
    iconColor: 'text-muted-foreground',
    edge: 'bg-border',
  },
};

function dayLabel(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const startOfThatDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const diffDays = Math.round((startOfToday - startOfThatDay) / 86_400_000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function groupedItems(items: ToastHistoryItem[]): { label: string; items: ToastHistoryItem[] }[] {
  const groups: { label: string; items: ToastHistoryItem[] }[] = [];
  for (const item of items) {
    const label = dayLabel(item.createdAt);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(item);
    else groups.push({ label, items: [item] });
  }
  return groups;
}

export function ToastHistoryPanel(): React.JSX.Element {
  const open = useToastHistoryStore((s) => s.open);
  const setOpen = useToastHistoryStore((s) => s.setOpen);
  const items = useToastHistoryStore((s) => s.items);
  const remove = useToastHistoryStore((s) => s.remove);
  const clear = useToastHistoryStore((s) => s.clear);
  const [filter, setFilter] = useState<FilterId>('all');
  const [query, setQuery] = useState('');
  const [confirmingClear, setConfirmingClear] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((item) => {
      if (filter !== 'all' && item.kind !== filter) return false;
      if (!q) return true;
      return `${item.title} ${item.description}`.toLowerCase().includes(q);
    });
  }, [items, filter, query]);

  const groups = useMemo(() => groupedItems(filtered), [filtered]);

  const navigate = useNavigate();
  const projectsQuery = useQuery({
    queryKey: queryKeys.projects,
    queryFn: () => window.agentmat.projects.list(),
  });
  const projectsById = useMemo(
    () => new Map((projectsQuery.data ?? []).map((project) => [project.id, project])),
    [projectsQuery.data],
  );

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setFilter('all');
          setQuery('');
          setConfirmingClear(false);
        }
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[80] bg-black/25 backdrop-blur-[2px] data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          // Radix focuses the first focusable element, which is the close button, so it
          // opened wearing a focus ring. Start in the search box instead.
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            searchRef.current?.focus();
          }}
          className={cn(
            'fixed inset-y-0 right-0 z-[80] flex h-full w-full max-w-[22.5rem] flex-col border-l border-border bg-popover/90 text-popover-foreground shadow-2xl shadow-black/30 backdrop-blur-2xl',
            'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
            'data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right',
          )}
        >
          <div className="flex items-start justify-between gap-3 border-b border-border/70 px-4 py-3.5">
            <div className="min-w-0 space-y-0.5">
              <DialogPrimitive.Title className="text-sm font-semibold">
                Recent messages
              </DialogPrimitive.Title>
              <DialogPrimitive.Description className="text-xs text-muted-foreground">
                Alerts that flashed in the corner, in case you missed one.
              </DialogPrimitive.Description>
            </div>
            <DialogPrimitive.Close className="-mr-1 -mt-0.5 flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full opacity-70 transition-colors hover:bg-accent hover:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <X className="h-4 w-4" />
              <span className="sr-only">Close</span>
            </DialogPrimitive.Close>
          </div>

          <div className="space-y-2.5 border-b border-border/70 px-4 py-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search messages…"
                className="h-8 pl-8 text-xs"
              />
            </div>
            <div className="flex flex-wrap gap-1">
              {FILTERS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setFilter(item.id)}
                  className={cn(
                    'rounded-full px-2.5 py-0.5 text-[11px] font-medium transition-colors',
                    filter === item.id
                      ? 'bg-primary/15 text-primary'
                      : 'text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground',
                  )}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>

          {/* Radix renders the viewport child as display:table, which lets long unbroken
              text stretch every card past the panel edge. Force it back to block. */}
          <ScrollArea className="min-h-0 flex-1 [&_[data-radix-scroll-area-viewport]>div]:!block">
            {items.length === 0 ? (
              <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
                <div className="flex h-11 w-11 items-center justify-center rounded-full bg-primary/10 text-primary">
                  <Bell className="h-5 w-5" />
                </div>
                <div className="space-y-1">
                  <p className="text-sm font-medium">No messages yet</p>
                  <p className="text-xs text-muted-foreground">
                    Success, error, and info alerts land here after they appear in the corner.
                  </p>
                </div>
              </div>
            ) : filtered.length === 0 ? (
              <p className="px-4 py-10 text-center text-sm text-muted-foreground">
                Nothing matches that filter.
              </p>
            ) : (
              <div className="space-y-4 px-3 py-3">
                {groups.map((group) => (
                  <section key={group.label} className="space-y-1.5">
                    <h3 className="sticky top-0 z-10 bg-popover/90 px-1 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground backdrop-blur-sm">
                      {group.label}
                    </h3>
                    <ol className="space-y-1.5">
                      {group.items.map((item) => (
                        <HistoryRow
                          key={item.id}
                          item={item}
                          project={item.projectId ? projectsById.get(item.projectId) : undefined}
                          onOpen={() => {
                            if (!item.link) return;
                            setOpen(false);
                            openMessageLink(item.link, navigate);
                          }}
                          onRemove={() => remove(item.id)}
                        />
                      ))}
                    </ol>
                  </section>
                ))}
              </div>
            )}
          </ScrollArea>

          {items.length > 0 ? (
            <div className="border-t border-border/70 px-4 py-2.5">
              {confirmingClear ? (
                <div className="flex gap-2">
                  <Button
                    variant="destructive"
                    size="sm"
                    className="flex-1"
                    onClick={() => {
                      clear();
                      setConfirmingClear(false);
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" /> Clear all
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setConfirmingClear(false)}>
                    Cancel
                  </Button>
                </div>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full text-muted-foreground"
                  onClick={() => setConfirmingClear(true)}
                >
                  <Trash2 className="h-3.5 w-3.5" /> Clear history
                </Button>
              )}
            </div>
          ) : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function HistoryRow({
  item,
  project,
  onOpen,
  onRemove,
}: {
  item: ToastHistoryItem;
  project: Project | undefined;
  onOpen: () => void;
  onRemove: () => void;
}): React.JSX.Element {
  const style = KIND_STYLE[item.kind];
  const Icon = style.icon;
  const titleProps = persianTextProps(item.title);
  const bodyProps = persianTextProps(item.description);
  const openable = item.link !== undefined;

  return (
    <li>
      {/* A row with a link is a button as a whole; the buttons inside it stop the click
          from bubbling so "Show again" and "Remove" keep their own jobs. */}
      <div
        role={openable ? 'button' : undefined}
        tabIndex={openable ? 0 : undefined}
        aria-label={openable ? `Open: ${item.title}` : undefined}
        onClick={openable ? onOpen : undefined}
        onKeyDown={
          openable
            ? (event) => {
                if (event.target !== event.currentTarget) return;
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onOpen();
                }
              }
            : undefined
        }
        className={cn(
          'group relative overflow-hidden rounded-xl border border-border/70 bg-background/40 p-3 transition-colors hover:bg-background/70',
          openable &&
            'cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        )}
      >
        <span className={cn('absolute inset-y-0 left-0 w-0.5', style.edge)} aria-hidden />
        <div className="flex items-start gap-2.5 pl-1.5">
          {project ? (
            <ProjectIcon
              iconDataUrl={project.iconDataUrl}
              bgColor={project.iconBgColor}
              iconColor={project.iconColor}
              className="mt-0.5 h-7 w-7 rounded-full"
              glyphClassName="h-3.5 w-3.5"
            />
          ) : (
            <span
              className={cn(
                'mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full',
                style.wrap,
                style.iconColor,
              )}
            >
              <Icon className="h-3.5 w-3.5" />
            </span>
          )}
          <div className="min-w-0 flex-1 space-y-0.5">
            <div className="flex items-start justify-between gap-2">
              <p
                className={cn(
                  'min-w-0 text-[13px] font-medium leading-snug [overflow-wrap:anywhere]',
                  titleProps.className,
                )}
                dir={titleProps.dir}
              >
                {item.title}
              </p>
              <span className="shrink-0 pt-0.5 text-[10px] text-muted-foreground">
                {timeAgo(item.createdAt)}
              </span>
            </div>
            {item.description ? (
              <p
                className={cn(
                  'text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]',
                  bodyProps.className,
                )}
                dir={bodyProps.dir}
              >
                {item.description}
              </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-2 pt-1">
              {item.tag ? (
                <span
                  className={cn(
                    'rounded-full px-1.5 py-0.5 text-[10px] font-semibold leading-none',
                    style.wrap,
                    style.iconColor,
                  )}
                >
                  {item.tag}
                </span>
              ) : null}
              {item.projectName ? (
                <span className="truncate text-[11px] font-medium text-muted-foreground/80">
                  {item.projectName}
                </span>
              ) : null}
              {item.count > 1 ? (
                <span className="text-[10px] font-medium text-muted-foreground">×{item.count}</span>
              ) : null}
              <button
                type="button"
                className="text-[11px] font-medium text-muted-foreground hover:text-foreground"
                onClick={(event) => {
                  event.stopPropagation();
                  replayToast(item.kind, item.title, item.description);
                }}
              >
                Show again
              </button>
              <button
                type="button"
                className="ml-auto text-[11px] text-muted-foreground opacity-0 hover:text-destructive group-hover:opacity-100 focus-visible:opacity-100"
                onClick={(event) => {
                  event.stopPropagation();
                  onRemove();
                }}
                aria-label="Remove from history"
              >
                Remove
              </button>
            </div>
          </div>
        </div>
      </div>
    </li>
  );
}
