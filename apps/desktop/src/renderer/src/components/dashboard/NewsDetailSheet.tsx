import type { NewsItemDetailView, NewsItemView } from '@shared/newsTypes';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type MouseEvent, useEffect, useMemo, useRef } from 'react';
import { toast } from 'sonner';
import { Check, ExternalLink, ShieldSolid } from '@/components/icons';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { queryKeys } from '@/lib/queryKeys';
import { AffectedBadge, CategoryChip, formatNewsTime, SeverityBadge } from './newsParts';
import { isWebUrl, sanitizeNewsHtml } from './sanitizeNewsHtml';

function openOutside(url: string): void {
  if (isWebUrl(url)) void window.runova.shell.openExternal(url);
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-1.5">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
  );
}

/** One line per affected tool: what to update to, and what this machine has now. */
function whatToDo(detail: NewsItemDetailView): string[] {
  if (detail.affectedAll.length === 0) {
    return ['None of the tools Runova found on this machine are affected.'];
  }
  return detail.affectedAll.map((match) =>
    match.fixedIn
      ? `Update ${match.label} to ${match.fixedIn} or later. This machine has ${match.version}.`
      : `No fixed version of ${match.label} is listed yet. This machine has ${match.version}. Watch the sources below.`,
  );
}

function DetailBody({ detail }: { detail: NewsItemDetailView }): React.JSX.Element {
  const html = useMemo(() => sanitizeNewsHtml(detail.bodyHtml), [detail.bodyHtml]);

  // A link in the body would otherwise navigate this window. Web links open in the browser.
  const onBodyClick = (event: MouseEvent<HTMLDivElement>) => {
    const link = (event.target as Element).closest('a');
    if (!link) return;
    event.preventDefault();
    openOutside(link.getAttribute('href') ?? '');
  };

  return (
    <div className="min-h-0 space-y-4 overflow-y-auto pr-1">
      {detail.category === 'security' ? (
        <div className="space-y-1 rounded-lg bg-severity-high/[0.06] px-3 py-2.5 ring-1 ring-inset ring-severity-high/25">
          <p className="flex items-center gap-1.5 text-sm font-semibold">
            <ShieldSolid className="size-3.5 text-severity-high" />
            What to do
          </p>
          {whatToDo(detail).map((line) => (
            <p key={line} className="text-sm">
              {line}
            </p>
          ))}
        </div>
      ) : null}
      <div
        data-testid="news-body"
        className="space-y-2 text-sm leading-relaxed [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2 [&_code]:font-mono [&_code]:text-[0.85em] [&_h2]:mt-3 [&_h2]:font-semibold [&_h3]:mt-3 [&_h3]:font-semibold [&_img]:max-w-full [&_img]:rounded-md [&_ol]:list-decimal [&_ol]:pl-5 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-2 [&_ul]:list-disc [&_ul]:pl-5"
        onClick={onBodyClick}
        // Cleaned by DOMPurify just above, whatever the API did on its side.
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {detail.technologies.length > 0 ? (
        <Section title="Affected versions">
          <ul className="space-y-1 text-sm">
            {detail.technologies.map((technology) => {
              const match = detail.affectedAll.find((one) => one.slug === technology.technology);
              return (
                <li key={technology.technology} className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{technology.name}</span>
                  <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                    {technology.versionRange === '*' ? 'all versions' : technology.versionRange}
                  </code>
                  {technology.fixedIn ? (
                    <span className="text-xs text-muted-foreground">
                      fixed in {technology.fixedIn}
                    </span>
                  ) : null}
                  {match ? (
                    <span className="text-xs font-medium text-severity-high">
                      This machine has {match.version}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </Section>
      ) : null}
      {detail.cveIds.length > 0 ? (
        <Section title="CVE">
          <ul className="flex flex-wrap gap-1.5">
            {detail.cveIds.map((cve) => (
              <li key={cve}>
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{cve}</code>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      {detail.sourceLinks.length > 0 ? (
        <Section title="Sources">
          <ul className="space-y-0.5">
            {detail.sourceLinks.map((link) => (
              <li key={link.url}>
                <Button
                  variant="link"
                  size="xs"
                  className="h-auto px-0"
                  onClick={() => openOutside(link.url)}
                >
                  {link.title}
                  <ExternalLink />
                </Button>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </div>
  );
}

function SheetContent({
  slug,
  preview,
}: {
  slug: string;
  preview: NewsItemView | undefined;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: queryKeys.newsItem(slug),
    queryFn: () => window.runova.news.get(slug),
    meta: { silentLoading: true },
  });
  const markRead = useMutation({
    mutationFn: (id: number) => window.runova.news.markRead(id),
    meta: { silentLoading: true },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.newsLists }),
  });

  const detail = query.data;
  // Opening an item reads it. Once per item, so a failed save leaves Mark as read to try again.
  const triedOnOpen = useRef<number | null>(null);
  useEffect(() => {
    if (!detail || detail.read || triedOnOpen.current === detail.id) return;
    triedOnOpen.current = detail.id;
    markRead.mutate(detail.id);
  }, [detail, markRead.mutate]);

  const shown = detail ?? preview;
  const read = (detail?.read ?? false) || markRead.isSuccess;
  const updated = shown && shown.updatedAt !== shown.publishedAt ? shown.updatedAt : null;

  return (
    <>
      <DialogHeader className="pr-8">
        {shown ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <SeverityBadge severity={shown.severity} />
            <CategoryChip category={shown.category} />
            {shown.affected ? (
              <AffectedBadge match={shown.affected} severity={shown.severity} />
            ) : null}
          </div>
        ) : null}
        <DialogTitle className="leading-snug">{shown?.title ?? 'News item'}</DialogTitle>
        <DialogDescription>
          {shown ? `Published ${formatNewsTime(shown.publishedAt)}` : 'Loading'}
          {updated ? `, updated ${formatNewsTime(updated)}` : ''}
        </DialogDescription>
      </DialogHeader>
      {detail ? (
        <DetailBody detail={detail} />
      ) : query.isPending ? (
        <div aria-busy="true" className="space-y-2">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-11/12" />
          <Skeleton className="h-4 w-3/4" />
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          {query.isError
            ? 'This item could not be loaded.'
            : 'This item is no longer on runovahq.com.'}
        </p>
      )}
      <DialogFooter>
        {shown && isWebUrl(shown.url) ? (
          <Button variant="soft" onClick={() => openOutside(shown.url)}>
            <ExternalLink />
            Open on website
          </Button>
        ) : null}
        {detail ? (
          read ? (
            <Button variant="soft" disabled>
              <Check />
              Read
            </Button>
          ) : (
            <Button
              disabled={markRead.isPending}
              onClick={() =>
                markRead.mutate(detail.id, {
                  onError: () => toast.error('Could not mark it as read.'),
                })
              }
            >
              Mark as read
            </Button>
          )
        ) : null}
      </DialogFooter>
    </>
  );
}

/**
 * One news item in full. The body is the API's HTML cleaned again here, and every link in it, the
 * sources and the website open in the browser rather than in this window.
 */
export function NewsDetailSheet({
  slug,
  preview,
  onClose,
}: {
  /** The item to show, or null when the sheet is closed. */
  slug: string | null;
  /** The row the sheet was opened from, so the title shows before the body arrives. */
  preview?: NewsItemView;
  onClose: () => void;
}): React.JSX.Element {
  return (
    <Dialog open={slug !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      {slug ? (
        <DialogContent className="max-w-2xl">
          <SheetContent key={slug} slug={slug} preview={preview} />
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
