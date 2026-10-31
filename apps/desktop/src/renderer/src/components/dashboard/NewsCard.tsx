import type { NewsItemView } from '@shared/newsTypes';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { NewsAllDialog } from '@/components/dashboard/NewsAllDialog';
import { NewsDetailSheet } from '@/components/dashboard/NewsDetailSheet';
import {
  formatNewsTime,
  isFiltered,
  NewsFilters,
  NewsList,
  newsQuery,
  useNewsFilter,
} from '@/components/dashboard/newsParts';
import { Clock, Newspaper, RefreshCw, X } from '@/components/icons';
import { TileHeader } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';

/** How many items the card lists; View all has the rest. */
const CARD_ITEMS = 5;

/** The search param a notification opens the Dashboard with: `/?news=<slug>`. */
const NEWS_PARAM = 'news';

/** The search param the palette's Open news uses for the full list: `/?newsAll=1`. */
export const NEWS_ALL_PARAM = 'newsAll';

function Message({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <div className="flex min-h-32 flex-col items-center justify-center gap-2 px-2 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

/**
 * Technology news from runovahq.com (E42), read from the main process's cache, so it works
 * offline. Main sends the items already in order (what affects this machine first), and pushes a
 * change event after each poll, which reloads every news query.
 */
export function NewsCard({
  className,
  dragHandle,
  onRemove,
}: {
  className?: string;
  dragHandle?: ReactNode;
  onRemove?: () => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const { loaded, filter, setFilter } = useNewsFilter();
  const query = newsQuery(filter, 1, CARD_ITEMS);
  const list = useQuery({
    queryKey: queryKeys.newsList(query),
    queryFn: () => window.runova.news.list(query),
    // Waits for the saved filters, so the first fetch is already the right one.
    enabled: loaded,
    placeholderData: keepPreviousData,
    meta: { silentLoading: true },
  });

  useEffect(
    () =>
      window.runova.news.onChanged(() => {
        void queryClient.invalidateQueries({ queryKey: queryKeys.news });
      }),
    [queryClient],
  );

  const refresh = useMutation({
    mutationFn: () => window.runova.news.refresh(),
    meta: { silentLoading: true },
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.newsLists }),
    onError: () => toast.error('Could not check for news.'),
  });

  const [params, setParams] = useSearchParams();
  const openSlug = params.get(NEWS_PARAM);
  // The open item and the full list live in the URL, so a notification or the palette can open them.
  const setParam = (name: string, value: string | null) =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (value) next.set(name, value);
        else next.delete(name);
        return next;
      },
      { replace: true },
    );
  const setOpenSlug = (slug: string | null) => setParam(NEWS_PARAM, slug);
  const allOpen = params.has(NEWS_ALL_PARAM);
  const setAllOpen = (open: boolean) => setParam(NEWS_ALL_PARAM, open ? '1' : null);
  const [opened, setOpened] = useState<NewsItemView | undefined>();
  const openItem = (item: NewsItemView) => {
    setOpened(item);
    setOpenSlug(item.slug);
  };

  const data = list.data;
  const items = data?.items ?? [];
  // Offline (or an error from main) with nothing cached: there is nothing to show at all.
  const failed = data ? data.stale && data.checkedAt === null && items.length === 0 : list.isError;

  let body: ReactNode;
  if (failed) {
    body = (
      <Message>
        <span>News could not be loaded</span>
        <Button
          size="sm"
          variant="soft"
          disabled={refresh.isPending}
          onClick={() => refresh.mutate()}
        >
          <RefreshCw
            className={cn(refresh.isPending && 'animate-spin motion-reduce:animate-none')}
          />
          Try again
        </Button>
      </Message>
    );
  } else if (data && items.length === 0) {
    body = (
      <Message>{isFiltered(filter) ? 'Nothing matches these filters.' : 'No news yet.'}</Message>
    );
  } else {
    body = (
      <NewsList
        label="News"
        items={items.slice(0, CARD_ITEMS)}
        loading={!data}
        placeholderRows={CARD_ITEMS}
        onOpen={openItem}
      />
    );
  }

  return (
    <div className={className}>
      <div className="flex h-full flex-col p-4">
        <TileHeader
          className="mb-2"
          icon={<Newspaper />}
          title="News"
          actions={
            <>
              <NewsFilters filter={filter} onChange={setFilter} />
              <SimpleTooltip label="Check for news now">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Check for news now"
                  disabled={refresh.isPending}
                  onClick={() => refresh.mutate()}
                >
                  <RefreshCw
                    className={cn(
                      'h-3.5 w-3.5',
                      refresh.isPending && 'animate-spin motion-reduce:animate-none',
                    )}
                  />
                </Button>
              </SimpleTooltip>
              {dragHandle}
              {onRemove && (
                <SimpleTooltip label="Remove from dashboard">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Remove from dashboard"
                    onClick={onRemove}
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </SimpleTooltip>
              )}
            </>
          }
        />
        {data?.stale && data.checkedAt && !failed ? (
          <p className="mb-1 flex items-center gap-1.5 px-2 text-xs text-muted-foreground">
            <Clock className="size-3 shrink-0" />
            <span>Offline, showing news from {formatNewsTime(data.checkedAt)}</span>
          </p>
        ) : null}
        <div className="min-h-0 flex-1">{body}</div>
        {data && data.total > CARD_ITEMS ? (
          <div className="mt-1 flex justify-end">
            <Button variant="ghost" size="xs" onClick={() => setAllOpen(true)}>
              View all ({data.total})
            </Button>
          </div>
        ) : null}
      </div>
      <NewsAllDialog
        open={allOpen}
        onOpenChange={setAllOpen}
        filter={filter}
        onFilterChange={setFilter}
        onOpenItem={openItem}
      />
      <NewsDetailSheet
        slug={openSlug}
        preview={opened?.slug === openSlug ? opened : items.find((item) => item.slug === openSlug)}
        onClose={() => setOpenSlug(null)}
      />
    </div>
  );
}
