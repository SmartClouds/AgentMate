import { getHelpArticle, HELP_ARTICLES, helpArticlesByCategory } from '@shared/help/articles';
import type { HelpArticle } from '@shared/help/parse';
import { useQuery } from '@tanstack/react-query';
import { motion, useReducedMotion } from 'framer-motion';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { HelpChat, providerReady } from '@/components/help/HelpChat';
import { HelpMarkdown } from '@/components/help/HelpMarkdown';
import { HelpSearchBox, type HelpSearchBoxHandle } from '@/components/help/HelpSearchBox';
import type { IconProps } from '@/components/icons';
import {
  ArrowLeft,
  ArrowRight,
  Bug,
  ChevronRight,
  CircleQuestion,
  Rocket,
  SettingsIcon,
  Sparkles,
  Workspace,
} from '@/components/icons';
import { NAV_ITEMS, type NavItem } from '@/components/layout/mainNav';
import { EmptyState, GLASS_CARD, SECTION_HEADING } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { queryKeys } from '@/lib/queryKeys';
import { scrollContainerToTop, scrollToInContainer } from '@/lib/scrollContainer';
import { cn } from '@/lib/utils';
import { useAskAiStore } from '@/stores/askAiStore';
import { useHelpStore } from '@/stores/helpStore';
import { usePageHeader } from '@/stores/pageHeaderStore';

type Icon = React.ForwardRefExoticComponent<IconProps>;

/** Icons for the categories that are not a single menu page of their own. */
const CATEGORY_ICON: Record<string, Icon> = {
  'Getting started': Sparkles,
  Workspace,
  Deploy: Rocket,
  Settings: SettingsIcon,
  Troubleshooting: Bug,
};

/** The menu entry an article is about, matched on its route's path. */
function navItemFor(article: HelpArticle): NavItem | undefined {
  if (!article.route) return undefined;
  const path = article.route.split(/[?#]/)[0];
  return NAV_ITEMS.find((item) => item.to === path);
}

/** Each article's icon: the menu icon of the page it covers, or its category's. */
function iconFor(article: HelpArticle): Icon {
  return navItemFor(article)?.icon ?? CATEGORY_ICON[article.category] ?? Sparkles;
}

/** Every article in reading order: categories as the Help home lists them, then by order. */
const READING_ORDER = helpArticlesByCategory().flatMap((g) => g.articles);

const QUICK_SEARCHES = [
  'Add an API key',
  'Split a pane',
  'Install the server core',
  'Unlock the vault',
  'Restore a backup',
];

/** A hash can carry a stray percent sign; fall back to the raw text instead of throwing. */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function useGuideAvailable(): boolean {
  const provider = useAskAiStore((s) => s.provider);
  const ollamaModel = useAskAiStore((s) => s.ollamaModel);
  const { data } = useQuery({
    queryKey: queryKeys.settings,
    queryFn: () => window.runova.settings.get(),
  });
  return (['openai', 'gemini', 'ollama'] as const).some((p) =>
    providerReady(p, data, p === provider ? ollamaModel : ''),
  );
}

export default function HelpPage(): React.JSX.Element {
  const { pathname, hash } = useLocation();
  const slug = /^\/help\/([^/]+)/.exec(pathname)?.[1];
  const article = slug ? getHelpArticle(slug) : undefined;
  const chatOpen = useHelpStore((s) => s.chatOpen);
  const setChatOpen = useHelpStore((s) => s.setChatOpen);
  const rootRef = useRef<HTMLDivElement>(null);
  // The article last scrolled to, so a fresh open jumps and a jump within it glides.
  const shownSlug = useRef<string | undefined>(undefined);
  const searchRef = useRef<HelpSearchBoxHandle>(null);

  usePageHeader('Help', 'Guides for every part of Runova, with search and a guide you can ask.');

  // Land on the heading a link points at, or at the top of a newly opened article.
  useEffect(() => {
    // A frame later, because the shell resets the scroll to the top on every route change and its
    // effect runs after this one; scrolling now would be undone straight away.
    const frame = requestAnimationFrame(() => {
      // Only the page's own scroller moves. scrollIntoView would also scroll the shell's
      // overflow-hidden wrappers and push the page header out of sight.
      const justOpened = shownSlug.current !== slug;
      shownSlug.current = slug;
      const id = safeDecode(hash.slice(1));
      const target = id ? document.getElementById(id) : null;
      if (target) scrollToInContainer(target, { smooth: !justOpened });
      else if (rootRef.current) scrollContainerToTop(rootRef.current);
    });
    return () => cancelAnimationFrame(frame);
  }, [slug, hash]);

  // Each view docks the guide itself, since the article view has a sticky bar to keep clear of.
  const chat = chatOpen ? <HelpChat onClose={() => setChatOpen(false)} /> : null;

  return (
    <div ref={rootRef} className="help-page @container/help relative flex-1 p-2 pb-10">
      {slug && !article ? (
        <NotFound />
      ) : article ? (
        <ArticleView
          article={article}
          searchRef={searchRef}
          chat={chat}
          chatOpen={chatOpen}
          onOpenChat={() => setChatOpen(true)}
        />
      ) : (
        <HelpHome
          searchRef={searchRef}
          chat={chat}
          chatOpen={chatOpen}
          onOpenChat={() => setChatOpen(true)}
        />
      )}
    </div>
  );
}

interface ViewProps {
  searchRef: React.RefObject<HelpSearchBoxHandle | null>;
  chat: React.ReactNode;
  chatOpen: boolean;
  onOpenChat: () => void;
}

/** The glowing tile the guide wears everywhere it shows up. */
function GuideMark({ className }: { className?: string }): React.JSX.Element {
  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center rounded-xl bg-primary/12 text-primary shadow-[0_0_28px_-10px_hsl(var(--primary)/0.8)]',
        className,
      )}
    >
      <Sparkles className="h-4 w-4" />
    </span>
  );
}

function HelpHome({ searchRef, chat, chatOpen, onOpenChat }: ViewProps): React.JSX.Element {
  const groups = helpArticlesByCategory();
  const guide = useGuideAvailable();
  const words = useMemo(
    () => HELP_ARTICLES.reduce((n, a) => n + a.body.split(/\s+/).length, 0),
    [],
  );

  return (
    <div
      className={cn(
        'mx-auto grid max-w-[1400px] items-start gap-2',
        chatOpen && '@5xl/help:grid-cols-[minmax(0,1fr)_380px]',
      )}
    >
      <div className="min-w-0 space-y-2">
        {/* The front door: a glass card with a faint wash of the theme colour from one corner. */}
        <section
          className={cn(
            GLASS_CARD,
            'relative overflow-hidden px-6 pb-8 pt-9 @3xl/help:px-10 @3xl/help:pb-9 @3xl/help:pt-10',
          )}
        >
          {/* The wash is its own layer, because the unlayered .glass fill covers a bg utility. */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 bg-[radial-gradient(120%_140%_at_100%_0%,hsl(var(--primary)/0.14),transparent_55%),radial-gradient(90%_120%_at_0%_100%,hsl(var(--primary)/0.05),transparent_60%)]"
          />
          <div className="relative max-w-2xl">
            <p className={SECTION_HEADING}>Runova Help</p>
            <h1 className="mt-3 text-[2rem] font-semibold leading-[1.1] tracking-[-0.02em] text-foreground @3xl/help:text-[2.5rem]">
              Find your way around Runova
            </h1>
            <p className="mt-3 max-w-xl text-[0.95rem] leading-7 text-muted-foreground">
              {HELP_ARTICLES.length} guides cover every page, button and setting. Search them,
              browse by the same groups as the menu, or ask the guide in your own words.
            </p>
            <HelpSearchBox ref={searchRef} variant="hero" className="mt-7" />
            <div className="mt-3.5 flex flex-wrap items-center gap-1.5">
              <span className="mr-1 text-xs text-muted-foreground">Try</span>
              {QUICK_SEARCHES.map((q) => (
                <Button
                  key={q}
                  variant="soft"
                  size="sm"
                  onClick={() => searchRef.current?.setQuery(q)}
                >
                  {q}
                </Button>
              ))}
            </div>
          </div>
          {!chatOpen && (
            <button
              type="button"
              onClick={onOpenChat}
              className="group relative mt-8 flex w-full max-w-2xl cursor-pointer items-center gap-4 rounded-2xl bg-background/40 p-4 text-left ring-1 ring-inset ring-foreground/[0.08] transition-[box-shadow,transform] hover:-translate-y-px hover:ring-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:hover:translate-y-0 @5xl/help:absolute @5xl/help:bottom-9 @5xl/help:right-10 @5xl/help:mt-0 @5xl/help:w-72 @5xl/help:flex-col @5xl/help:items-start @5xl/help:gap-3"
            >
              <GuideMark className="h-9 w-9" />
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-foreground">Ask the guide</span>
                <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
                  {guide
                    ? 'Ask a question in plain words. Answers come from these articles, with links to the sections used.'
                    : 'Connect an AI provider in Settings and ask questions in plain words.'}
                </span>
              </span>
              <ArrowRight className="ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 @5xl/help:hidden" />
            </button>
          )}
        </section>

        <div className="flex items-baseline justify-between gap-4 px-2 pt-4">
          <h2 className={SECTION_HEADING}>Browse by area</h2>
          <p className="text-xs text-muted-foreground">
            {groups.length} areas, about {Math.round(words / 1000)}k words
          </p>
        </div>
        <div className="columns-1 gap-2 @2xl/help:columns-2 @6xl/help:columns-3">
          {groups.map((group) => {
            const GroupIcon = CATEGORY_ICON[group.category] ?? iconFor(group.articles[0]!);
            const headingId = `help-cat-${group.category.toLowerCase().replace(/\W+/g, '-')}`;
            return (
              <section
                key={group.category}
                aria-labelledby={headingId}
                className={cn(GLASS_CARD, 'mb-2 break-inside-avoid p-1.5')}
              >
                <div className="flex items-center gap-2 px-2.5 pb-1 pt-2">
                  <GroupIcon className="h-3 w-3 text-muted-foreground/70" />
                  <h3 id={headingId} className={SECTION_HEADING}>
                    {group.category}
                  </h3>
                  <span className="ml-auto rounded-full bg-foreground/[0.06] px-1.5 text-[10px] leading-4 tabular-nums text-muted-foreground">
                    {group.articles.length}
                  </span>
                </div>
                <ul>
                  {group.articles.map((article) => {
                    const ArticleIcon = iconFor(article);
                    return (
                      <li key={article.slug}>
                        <Link
                          to={`/help/${article.slug}`}
                          className="group flex items-start gap-3 rounded-xl px-2.5 py-2 transition-colors hover:bg-foreground/[0.06] focus-visible:bg-foreground/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-foreground/[0.05] text-muted-foreground transition-colors group-hover:bg-primary/12 group-hover:text-primary">
                            <ArticleIcon className="h-3.5 w-3.5" />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block text-sm font-medium text-foreground">
                              {article.title}
                            </span>
                            <span className="mt-0.5 line-clamp-2 block text-xs leading-5 text-muted-foreground">
                              {article.summary}
                            </span>
                          </span>
                          <ChevronRight className="mt-2 h-3 w-3 shrink-0 text-muted-foreground/0 transition-colors group-hover:text-muted-foreground" />
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
        </div>
      </div>
      {chat && (
        // Docked beside the page, it stays in view while the topics scroll under it.
        <div className="sticky top-2 h-[calc(100vh-9.5rem)] min-h-[420px] w-full">{chat}</div>
      )}
    </div>
  );
}

/** One article in the topic list: the main menu's row, as a link with its sliding pill. */
function TopicLink({ article, current }: { article: HelpArticle; current: boolean }) {
  const reduceMotion = useReducedMotion();
  return (
    <Link
      to={`/help/${article.slug}`}
      aria-current={current ? 'page' : undefined}
      className={cn(
        // `isolate` keeps the pill behind the text without lifting every child.
        'relative isolate flex h-7 items-center rounded-lg pl-2.5 pr-2 text-[13px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
        current
          ? 'font-medium text-primary'
          : 'text-foreground/75 hover:bg-foreground/[0.06] hover:text-foreground',
      )}
    >
      {current && (
        <motion.span
          aria-hidden
          layoutId="help-topic-active"
          transition={
            reduceMotion ? { duration: 0 } : { type: 'spring', stiffness: 420, damping: 32 }
          }
          className="absolute inset-0 -z-10 rounded-lg bg-primary/12"
        >
          <span className="absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-full bg-primary shadow-[0_0_8px_hsl(var(--primary)/0.7)]" />
        </motion.span>
      )}
      <span className="min-w-0 truncate">{article.title}</span>
    </Link>
  );
}

function ArticleView({
  article,
  searchRef,
  chat,
  chatOpen,
  onOpenChat,
}: ViewProps & { article: HelpArticle }): React.JSX.Element {
  const navigate = useNavigate();
  const nav = navItemFor(article);
  const outline = article.sections.filter((s) => s.level > 0);
  const activeId = useScrollSpy(
    outline.map((s) => s.id),
    article.slug,
  );
  const index = READING_ORDER.findIndex((a) => a.slug === article.slug);
  const prev = index > 0 ? READING_ORDER[index - 1] : undefined;
  const next = index >= 0 ? READING_ORDER[index + 1] : undefined;
  const ArticleIcon = iconFor(article);
  const openLabel = nav?.label ?? article.title;
  const canOpen = article.route && !article.route.startsWith('/help');

  return (
    <div
      className={cn(
        'mx-auto grid max-w-[1400px] items-start gap-2',
        chatOpen
          ? '@4xl/help:grid-cols-[minmax(0,1fr)_340px] @7xl/help:grid-cols-[240px_minmax(0,1fr)_360px]'
          : '@4xl/help:grid-cols-[240px_minmax(0,1fr)] @6xl/help:grid-cols-[240px_minmax(0,1fr)_200px]',
      )}
    >
      {/* The topic list, like the Settings categories: a glass card beside the article on a wide
          island, and a sticky bar with the search over the article on a narrow one. */}
      <aside
        aria-label="Help navigation"
        className={cn(
          GLASS_CARD,
          'sticky top-2 z-20 flex flex-col gap-1 p-1.5',
          chatOpen
            ? '@4xl/help:col-span-2 @7xl/help:col-span-1 @7xl/help:max-h-[calc(100vh-9.5rem)] @7xl/help:p-2'
            : '@4xl/help:max-h-[calc(100vh-9.5rem)] @4xl/help:p-2',
        )}
      >
        <div
          className={cn(
            'flex items-center gap-1.5',
            chatOpen
              ? '@7xl/help:flex-col @7xl/help:items-stretch @7xl/help:gap-2'
              : '@4xl/help:flex-col @4xl/help:items-stretch @4xl/help:gap-2',
          )}
        >
          <Button asChild variant="ghost" size="sm" className="shrink-0 justify-start">
            <Link to="/help">
              <ArrowLeft className="h-3 w-3" /> All help topics
            </Link>
          </Button>
          <HelpSearchBox ref={searchRef} className="min-w-0 flex-1" />
        </div>
        <nav
          aria-label="Help topics"
          className={cn(
            'rail-scroll hidden min-h-0 overflow-y-auto pb-1 pt-2',
            chatOpen ? '@7xl/help:block' : '@4xl/help:block',
          )}
        >
          {helpArticlesByCategory().map((group) => (
            <div key={group.category} className="mb-3 flex flex-col gap-px">
              <p className={cn(SECTION_HEADING, 'px-2.5 pb-1')}>{group.category}</p>
              {group.articles.map((a) => (
                <TopicLink key={a.slug} article={a} current={a.slug === article.slug} />
              ))}
            </div>
          ))}
        </nav>
      </aside>

      <article className={cn(GLASS_CARD, 'min-w-0 px-5 py-7 @3xl/help:px-10 @3xl/help:py-9')}>
        <div className="mx-auto max-w-[72ch]">
          <header className="pb-7 shadow-[inset_0_-1px_0_hsl(var(--foreground)/0.08)]">
            <p className={cn(SECTION_HEADING, 'flex items-center gap-2')}>
              <ArticleIcon className="h-3 w-3" />
              {article.category}
            </p>
            <h1 className="mt-3 text-[2rem] font-semibold leading-[1.15] tracking-[-0.02em] text-foreground">
              {article.title}
            </h1>
            <p className="mt-2.5 text-[1.02rem] leading-7 text-muted-foreground">
              {article.summary}
            </p>
            <div className="mt-5 flex flex-wrap items-center gap-1.5">
              {canOpen && (
                <Button size="sm" onClick={() => navigate(article.route!)}>
                  Open {openLabel} <ArrowRight className="h-3 w-3" />
                </Button>
              )}
              {!chatOpen && (
                <Button variant="soft" size="sm" onClick={onOpenChat}>
                  <Sparkles className="h-3.5 w-3.5 text-primary" /> Ask the guide
                </Button>
              )}
            </div>
          </header>

          <div className="pt-6">
            <HelpMarkdown slug={article.slug} markdown={article.body} sections={article.sections} />
          </div>

          <nav
            aria-label="More help"
            className="mt-14 grid gap-2 pt-6 shadow-[inset_0_1px_0_hsl(var(--foreground)/0.08)] @xl/help:grid-cols-2"
          >
            {prev ? (
              <Link to={`/help/${prev.slug}`} className={PAGER}>
                <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                  <ArrowLeft className="h-2.5 w-2.5 transition-transform group-hover:-translate-x-0.5" />{' '}
                  Previous
                </span>
                <span className="mt-1 block text-sm font-medium text-foreground">{prev.title}</span>
              </Link>
            ) : (
              <span />
            )}
            {next && (
              <Link to={`/help/${next.slug}`} className={cn(PAGER, 'text-right')}>
                <span className="flex items-center justify-end gap-1 text-[11px] text-muted-foreground">
                  Next{' '}
                  <ArrowRight className="h-2.5 w-2.5 transition-transform group-hover:translate-x-0.5" />
                </span>
                <span className="mt-1 block text-sm font-medium text-foreground">{next.title}</span>
              </Link>
            )}
          </nav>
        </div>
      </article>

      {chatOpen ? (
        // Until the topic list gets its own column (@7xl) it is a sticky bar across the top, so
        // the docked guide sits below that bar rather than sliding under it.
        <div className="sticky top-[3.75rem] h-[calc(100vh-13rem)] min-h-[420px] w-full @7xl/help:top-2 @7xl/help:h-[calc(100vh-9.5rem)]">
          {chat}
        </div>
      ) : (
        <aside className="hidden @6xl/help:block" aria-label="Article outline">
          <nav
            aria-label="On this page"
            className="rail-scroll sticky top-2 max-h-[calc(100vh-9.5rem)] overflow-y-auto px-1 pt-2"
          >
            <p className={cn(SECTION_HEADING, 'pb-2.5 pl-3')}>On this page</p>
            {/* The track is an inset shadow, since the global border colour would repaint a
                tinted border; the active entry draws its own primary bar over it. */}
            <ul className="shadow-[inset_1px_0_0_hsl(var(--foreground)/0.1)]">
              {outline.map((section) => (
                <li key={section.id}>
                  <a
                    href={`#${section.id}`}
                    onClick={(e) => {
                      e.preventDefault();
                      navigate({ hash: section.id }, { replace: true });
                    }}
                    aria-current={activeId === section.id ? 'location' : undefined}
                    className={cn(
                      'block rounded-r-md py-1 text-[12.5px] leading-5 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
                      section.level === 3 ? 'pl-6' : 'pl-3',
                      activeId === section.id
                        ? 'font-medium text-primary shadow-[inset_2px_0_0_hsl(var(--primary))]'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {section.heading}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        </aside>
      )}
    </div>
  );
}

/** A previous or next article at the foot of the page. */
const PAGER =
  'group rounded-xl bg-foreground/[0.03] p-4 ring-1 ring-inset ring-foreground/[0.08] transition-[box-shadow,background-color] hover:bg-foreground/[0.05] hover:ring-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

/** The heading nearest the top of the view, for highlighting the outline as you read. */
function useScrollSpy(ids: string[], key: string): string | undefined {
  const [active, setActive] = useState<string | undefined>(ids[0]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-observe when the article changes
  useEffect(() => {
    setActive(ids[0]);
    if (typeof IntersectionObserver === 'undefined') return;
    const visible = new Map<string, number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.set(entry.target.id, entry.boundingClientRect.top);
          else visible.delete(entry.target.id);
        }
        const first = ids.find((id) => visible.has(id));
        if (first) setActive(first);
      },
      { rootMargin: '0px 0px -65% 0px' },
    );
    for (const id of ids) {
      const element = document.getElementById(id);
      if (element) observer.observe(element);
    }
    return () => observer.disconnect();
  }, [key]);
  return active;
}

function NotFound(): React.JSX.Element {
  return (
    <div className="mx-auto max-w-xl pt-16">
      <EmptyState
        card
        size="lg"
        icon={CircleQuestion}
        title={<span className="text-xl">We couldn't find that article</span>}
        description="It may have moved. Search for it, or start from the full list."
        action={
          <Button asChild size="sm">
            <Link to="/help">All help topics</Link>
          </Button>
        }
      />
    </div>
  );
}
