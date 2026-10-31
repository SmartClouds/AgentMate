import type { AppSettings, DashboardNewsFilter } from '@runova/core';
import { isCategoryShown, newsSettingsOf } from '@shared/newsSettings';
import {
  type AffectedMatch,
  NEWS_CATEGORIES,
  NEWS_SEVERITIES,
  type NewsCategory,
  type NewsItemView,
  type NewsListQuery,
  type NewsSeverity,
} from '@shared/newsTypes';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ComponentType, type KeyboardEvent, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  Archive,
  Burst,
  CalendarX,
  ChevronDown,
  CircleAlert,
  CircleInfo,
  type IconProps,
  Newspaper,
  Shield,
  ShieldSolid,
  Sparkles,
  Tag,
  TriangleAlert,
  Wrench,
} from '@/components/icons';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { queryKeys } from '@/lib/queryKeys';
import { timeAgo } from '@/lib/time';
import { cn } from '@/lib/utils';

/**
 * The pieces the News card, its View all dialog and its detail sheet share: labels, badges, the
 * saved filters and the keyboard-friendly list of rows.
 */

interface SeverityMeta {
  label: string;
  icon: ComponentType<IconProps>;
  /** Text and icon in the level's color on a 12% tint, edged at 30% (docs/website/design.md). */
  className: string;
}

/** Each level has its own icon and its label in words, so none is told apart by color alone. */
export const SEVERITY_META: Record<NewsSeverity, SeverityMeta> = {
  info: {
    label: 'Info',
    icon: CircleInfo,
    className: 'bg-severity-info/12 text-severity-info ring-severity-info/30',
  },
  low: {
    label: 'Low',
    icon: ShieldSolid,
    className: 'bg-severity-low/12 text-severity-low ring-severity-low/30',
  },
  medium: {
    label: 'Medium',
    icon: CircleAlert,
    className: 'bg-severity-medium/12 text-severity-medium ring-severity-medium/30',
  },
  high: {
    label: 'High',
    icon: TriangleAlert,
    className: 'bg-severity-high/12 text-severity-high ring-severity-high/30',
  },
  critical: {
    label: 'Critical',
    icon: Burst,
    className: 'bg-severity-critical/12 text-severity-critical ring-severity-critical/30',
  },
};

export const CATEGORY_META: Record<
  NewsCategory,
  { label: string; icon: ComponentType<IconProps> }
> = {
  security: { label: 'Security', icon: Shield },
  release: { label: 'Release', icon: Tag },
  deprecation: { label: 'Deprecation', icon: Archive },
  'end-of-life': { label: 'End of life', icon: CalendarX },
  ai: { label: 'AI', icon: Sparkles },
  tooling: { label: 'Tooling', icon: Wrench },
  industry: { label: 'Industry', icon: Newspaper },
};

/** The long form of a time, for tooltips and the offline note. */
export function formatNewsTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function SeverityBadge({ severity }: { severity: NewsSeverity }): React.JSX.Element {
  const meta = SEVERITY_META[severity];
  const Icon = meta.icon;
  return (
    <span
      data-severity={severity}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset',
        meta.className,
      )}
    >
      <Icon className="size-3" />
      {meta.label}
    </span>
  );
}

export function CategoryChip({ category }: { category: NewsCategory }): React.JSX.Element {
  const meta = CATEGORY_META[category];
  const Icon = meta.icon;
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-[11px] font-medium text-secondary-foreground">
      <Icon className="size-3 text-muted-foreground" />
      {meta.label}
    </span>
  );
}

/** "Affects your system", naming the tool and the version installed here. */
export function AffectedBadge({
  match,
  severity,
}: {
  match: AffectedMatch;
  severity: NewsSeverity;
}): React.JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex max-w-full items-center gap-1 self-start rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset',
        SEVERITY_META[severity].className,
      )}
    >
      <TriangleAlert className="size-3 shrink-0" />
      <span className="truncate">
        Affects your system: {match.label} {match.version}
      </span>
    </span>
  );
}

export interface NewsFilter {
  categories: NewsCategory[];
  minSeverity: NewsSeverity;
}

/** The saved filter with anything this version does not know dropped, in the list's order. */
export function normalizeNewsFilter(saved: DashboardNewsFilter | undefined): NewsFilter {
  const categories = Array.isArray(saved?.categories) ? saved.categories : [];
  const minSeverity = NEWS_SEVERITIES.find((one) => one === saved?.minSeverity) ?? 'info';
  return {
    categories: NEWS_CATEGORIES.filter((one) => categories.includes(one)),
    minSeverity,
  };
}

export function isFiltered(filter: NewsFilter): boolean {
  return filter.categories.length > 0 || filter.minSeverity !== 'info';
}

/** What main is asked for. An empty category list means all of them, so it is left out. */
export function newsQuery(filter: NewsFilter, page: number, pageSize: number): NewsListQuery {
  return {
    ...(filter.categories.length > 0 ? { category: filter.categories } : {}),
    minSeverity: filter.minSeverity,
    page,
    pageSize,
  };
}

function useSettings() {
  return useQuery({
    queryKey: queryKeys.settings,
    queryFn: () => window.runova.settings.get(),
    meta: { silentLoading: true },
  });
}

/**
 * Whether news is on in Settings. Off hides the card and the palette commands. Unknown counts as
 * off so nothing flashes in, except when settings cannot be read, which leaves the default (on).
 */
export function useNewsEnabled(): boolean {
  const settings = useSettings();
  if (settings.isError) return true;
  return settings.data ? newsSettingsOf(settings.data).enabled : false;
}

/** The categories Settings shows, which are all the card's menu offers. */
function shownCategories(settings: AppSettings | undefined): NewsCategory[] {
  const chosen = newsSettingsOf(settings ?? {}).categories;
  return NEWS_CATEGORIES.filter((one) => isCategoryShown(chosen, one));
}

/** The card's filters, kept in settings so they survive a restart. */
export function useNewsFilter(): {
  loaded: boolean;
  filter: NewsFilter;
  setFilter: (next: NewsFilter) => void;
} {
  const queryClient = useQueryClient();
  const settings = useSettings();
  const mutation = useMutation({
    mutationFn: (next: NewsFilter) => window.runova.settings.update({ dashboardNewsFilter: next }),
    meta: { silentLoading: true },
    onSuccess: (saved) => queryClient.setQueryData(queryKeys.settings, saved),
    onError: () => toast.error('Could not save the news filters.'),
  });

  // While a save is in flight the menus show the choice being saved, so they do not jump back.
  const pending = mutation.isPending ? mutation.variables : undefined;
  const saved = normalizeNewsFilter(settings.data?.dashboardNewsFilter);
  // A category Settings has since hidden drops out, rather than leaving the card empty.
  const shown = shownCategories(settings.data);
  return {
    loaded: settings.data !== undefined || settings.isError,
    filter: pending ?? {
      ...saved,
      categories: saved.categories.filter((one) => shown.includes(one)),
    },
    setFilter: (next) => mutation.mutate(next),
  };
}

function categoriesLabel(categories: NewsCategory[]): string {
  if (categories.length === 0) return 'All categories';
  if (categories.length === 1) return CATEGORY_META[categories[0]].label;
  return `${categories.length} categories`;
}

function severityLabel(severity: NewsSeverity): string {
  if (severity === 'info') return 'Any severity';
  if (severity === 'critical') return 'Critical only';
  return `${SEVERITY_META[severity].label} and up`;
}

/** The category (several at once) and minimum severity menus. */
export function NewsFilters({
  filter,
  onChange,
}: {
  filter: NewsFilter;
  onChange: (next: NewsFilter) => void;
}): React.JSX.Element {
  const offered = shownCategories(useSettings().data);
  const toggle = (category: NewsCategory, on: boolean) => {
    const chosen = new Set(filter.categories);
    if (on) chosen.add(category);
    else chosen.delete(category);
    onChange({ ...filter, categories: NEWS_CATEGORIES.filter((one) => chosen.has(one)) });
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="xs" className="text-muted-foreground">
            {categoriesLabel(filter.categories)}
            <ChevronDown />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {offered.map((category) => {
            const meta = CATEGORY_META[category];
            const Icon = meta.icon;
            return (
              <DropdownMenuCheckboxItem
                key={category}
                checked={filter.categories.includes(category)}
                onCheckedChange={(on) => toggle(category, on === true)}
                // Stays open, so several categories can be picked in one go.
                onSelect={(event) => event.preventDefault()}
              >
                <Icon className="size-3.5 text-muted-foreground" />
                {meta.label}
              </DropdownMenuCheckboxItem>
            );
          })}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={filter.categories.length === 0}
            onSelect={() => onChange({ ...filter, categories: [] })}
          >
            Show all categories
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="xs" className="text-muted-foreground">
            {severityLabel(filter.minSeverity)}
            <ChevronDown />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuRadioGroup
            value={filter.minSeverity}
            onValueChange={(value) => {
              const minSeverity = NEWS_SEVERITIES.find((one) => one === value);
              if (minSeverity) onChange({ ...filter, minSeverity });
            }}
          >
            {NEWS_SEVERITIES.map((severity) => (
              <DropdownMenuRadioItem key={severity} value={severity}>
                {severityLabel(severity)}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

function NewsRow({
  item,
  tabIndex,
  onFocus,
  onOpen,
  buttonRef,
}: {
  item: NewsItemView;
  tabIndex: number;
  onFocus: () => void;
  onOpen: () => void;
  buttonRef: (element: HTMLButtonElement | null) => void;
}): React.JSX.Element {
  return (
    <li>
      <button
        ref={buttonRef}
        type="button"
        tabIndex={tabIndex}
        onFocus={onFocus}
        onClick={onOpen}
        className="flex w-full cursor-pointer flex-col gap-1 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
      >
        {item.affected ? <AffectedBadge match={item.affected} severity={item.severity} /> : null}
        <span className="flex w-full min-w-0 items-center gap-2">
          <SeverityBadge severity={item.severity} />
          <CategoryChip category={item.category} />
          <span className={cn('min-w-0 flex-1 truncate text-sm', !item.read && 'font-medium')}>
            {item.title}
          </span>
          <SimpleTooltip label={formatNewsTime(item.publishedAt)}>
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
              {timeAgo(item.publishedAt)}
            </span>
          </SimpleTooltip>
          <span className="flex w-2 shrink-0 justify-center">
            {item.read ? null : (
              <span role="img" aria-label="Unread" className="size-2 rounded-full bg-primary" />
            )}
          </span>
        </span>
      </button>
    </li>
  );
}

const MOVES: Record<string, (index: number, last: number) => number> = {
  ArrowDown: (index, last) => Math.min(index + 1, last),
  ArrowUp: (index) => Math.max(index - 1, 0),
  Home: () => 0,
  End: (_index, last) => last,
};

/**
 * The rows, as one tab stop: the arrow keys (and Home and End) move between items and Enter or
 * Space opens the one in focus. While loading it shows shimmer rows in the same spot.
 */
export function NewsList({
  label,
  items,
  loading,
  placeholderRows,
  onOpen,
}: {
  label: string;
  items: NewsItemView[];
  loading: boolean;
  placeholderRows: number;
  onOpen: (item: NewsItemView) => void;
}): React.JSX.Element {
  const [active, setActive] = useState(0);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const current = Math.min(active, Math.max(items.length - 1, 0));

  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    const move = MOVES[event.key];
    if (!move || items.length === 0) return;
    event.preventDefault();
    const next = move(current, items.length - 1);
    setActive(next);
    buttons.current[next]?.focus();
  };

  return (
    <ul aria-label={label} aria-busy={loading} className="space-y-0.5" onKeyDown={onKeyDown}>
      {loading
        ? Array.from({ length: placeholderRows }, (_, slot) => (
            <li key={slot} className="flex h-8 items-center px-2">
              <Skeleton className="h-4 w-full" />
            </li>
          ))
        : items.map((item, index) => (
            <NewsRow
              key={item.id}
              item={item}
              tabIndex={index === current ? 0 : -1}
              onFocus={() => setActive(index)}
              onOpen={() => onOpen(item)}
              buttonRef={(element) => {
                buttons.current[index] = element;
              }}
            />
          ))}
    </ul>
  );
}
