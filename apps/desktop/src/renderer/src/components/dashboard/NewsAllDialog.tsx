import type { NewsItemView } from '@shared/newsTypes';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { ChevronLeft, ChevronRight } from '@/components/icons';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { queryKeys } from '@/lib/queryKeys';
import { isFiltered, type NewsFilter, NewsFilters, NewsList, newsQuery } from './newsParts';

const PAGE_SIZE = 20;

function AllNews({
  filter,
  onFilterChange,
  onOpenItem,
}: {
  filter: NewsFilter;
  onFilterChange: (next: NewsFilter) => void;
  onOpenItem: (item: NewsItemView) => void;
}): React.JSX.Element {
  const [page, setPage] = useState(1);
  const query = newsQuery(filter, page, PAGE_SIZE);
  const list = useQuery({
    queryKey: queryKeys.newsList(query),
    queryFn: () => window.runova.news.list(query),
    placeholderData: keepPreviousData,
    meta: { silentLoading: true },
  });
  const data = list.data;
  const totalPages = Math.max(data?.totalPages ?? 1, 1);

  let body: React.ReactNode;
  if (!data && list.isError) {
    body = (
      <p className="py-6 text-center text-sm text-muted-foreground">News could not be loaded</p>
    );
  } else if (data && data.items.length === 0) {
    body = (
      <p className="py-6 text-center text-sm text-muted-foreground">
        {isFiltered(filter) ? 'Nothing matches these filters.' : 'No news yet.'}
      </p>
    );
  } else {
    body = (
      <NewsList
        label="All news"
        items={data?.items ?? []}
        loading={!data}
        placeholderRows={8}
        onOpen={onOpenItem}
      />
    );
  }

  return (
    <>
      <DialogHeader className="pr-8">
        <DialogTitle>News</DialogTitle>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <DialogDescription>
            Items that affect this machine come first, then the newest.
          </DialogDescription>
          <div className="flex items-center gap-1">
            <NewsFilters
              filter={filter}
              onChange={(next) => {
                setPage(1);
                onFilterChange(next);
              }}
            />
          </div>
        </div>
      </DialogHeader>
      <div className="min-h-0 overflow-y-auto">{body}</div>
      <div className="flex items-center justify-end gap-2">
        <span className="text-xs tabular-nums text-muted-foreground">
          Page {Math.min(page, totalPages)} of {totalPages}
        </span>
        <SimpleTooltip label="Previous page">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Previous page"
            disabled={page <= 1}
            onClick={() => setPage((current) => Math.max(current - 1, 1))}
          >
            <ChevronLeft />
          </Button>
        </SimpleTooltip>
        <SimpleTooltip label="Next page">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Next page"
            disabled={page >= totalPages}
            onClick={() => setPage((current) => Math.min(current + 1, totalPages))}
          >
            <ChevronRight />
          </Button>
        </SimpleTooltip>
      </div>
    </>
  );
}

/** Every item under the card's filters, 20 to a page. */
export function NewsAllDialog({
  open,
  onOpenChange,
  filter,
  onFilterChange,
  onOpenItem,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  filter: NewsFilter;
  onFilterChange: (next: NewsFilter) => void;
  onOpenItem: (item: NewsItemView) => void;
}): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <AllNews filter={filter} onFilterChange={onFilterChange} onOpenItem={onOpenItem} />
      </DialogContent>
    </Dialog>
  );
}
