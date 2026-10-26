import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { toast } from 'sonner';
import {
  Copy,
  Eye,
  Folder,
  History,
  Languages,
  Plus,
  Search,
  Sparkles,
  Trash2,
  TriangleAlert,
  X,
} from '@/components/icons';
import { SECTION_HEADING } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { queryKeys } from '@/lib/queryKeys';
import { persianTextProps } from '@/lib/rtl';
import { cn } from '@/lib/utils';
import { confirmDialog } from '@/stores/confirmStore';
import { usePageHeader } from '@/stores/pageHeaderStore';
import type { PromptHistoryEntry } from '../../../shared/apiTypes';

/** The glass card each entry sits on, rounded like the Settings and API Client cards. */
const CARD = 'glass rounded-[calc(var(--radius)+2px)]';

type ChipTone = 'primary' | 'success' | 'neutral';

/** A small rounded label, tinted with a theme colour so it reads on every theme. */
function Chip({
  tone = 'neutral',
  children,
}: {
  tone?: ChipTone;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex h-5 items-center gap-1 rounded-full px-2 text-[11px] font-medium [&_svg]:h-3 [&_svg]:w-3 [&_svg]:shrink-0',
        tone === 'primary' && 'bg-primary/12 text-primary',
        tone === 'success' && 'bg-success/12 text-success',
        tone === 'neutral' && 'bg-foreground/[0.06] text-foreground/80',
      )}
    >
      {children}
    </span>
  );
}

/** What kind of entry this is: the chips next to its title, the same on the card and in the dialog. */
function EntryChips({
  entry,
  projectName,
}: {
  entry: PromptHistoryEntry;
  projectName: string | null;
}): React.JSX.Element {
  return (
    <>
      {entry.source === 'translate' ? (
        <Chip tone="success">
          <Languages /> Translated
        </Chip>
      ) : (
        <>
          <Chip>{entry.targetAI}</Chip>
          <Chip tone="primary">
            <Sparkles /> Generated
          </Chip>
        </>
      )}
      {projectName ? (
        <Chip>
          <Folder /> {projectName}
        </Chip>
      ) : null}
    </>
  );
}

/** The tinted square that starts each card, so translations and generated prompts tell apart at a glance. */
function EntryIcon({ entry }: { entry: PromptHistoryEntry }): React.JSX.Element {
  const translated = entry.source === 'translate';
  return (
    <div
      aria-hidden
      className={cn(
        'flex h-9 w-9 shrink-0 items-center justify-center rounded-xl',
        translated ? 'bg-success/12 text-success' : 'bg-primary/12 text-primary',
      )}
    >
      {translated ? <Languages className="h-4 w-4" /> : <Sparkles className="h-4 w-4" />}
    </div>
  );
}

function TagEditor({ entry }: { entry: PromptHistoryEntry }): React.JSX.Element {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const queryClient = useQueryClient();

  const setTagsMutation = useMutation({
    mutationFn: (tags: string[]) => window.runova.promptHistory.setTags(entry.id, tags),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['prompt-history'] });
    },
    onError: () => toast.error('Could not update tags.'),
  });

  function commitTag(): void {
    const value = draft.trim();
    setDraft('');
    setAdding(false);
    if (!value || entry.tags.includes(value)) return;
    setTagsMutation.mutate([...entry.tags, value]);
  }

  function removeTag(tag: string): void {
    setTagsMutation.mutate(entry.tags.filter((t) => t !== tag));
  }

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      {entry.tags.map((tag) => (
        <span
          key={tag}
          className="inline-flex h-6 items-center gap-0.5 rounded-full bg-foreground/[0.06] pl-2.5 pr-0.5 text-[11px] font-medium text-foreground/80"
        >
          {tag}
          <button
            type="button"
            onClick={() => removeTag(tag)}
            className="flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={`Remove tag ${tag}`}
          >
            <X className="h-2.5 w-2.5" />
          </button>
        </span>
      ))}
      {adding ? (
        <input
          autoFocus
          className="field-surface h-6 w-28 rounded-full px-2.5 text-[11px] outline-none"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitTag();
            if (e.key === 'Escape') {
              setDraft('');
              setAdding(false);
            }
          }}
          onBlur={commitTag}
          placeholder="Tag name…"
        />
      ) : (
        <button
          type="button"
          className="inline-flex h-6 cursor-pointer items-center gap-1 rounded-full px-2 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => setAdding(true)}
        >
          <Plus className="h-3 w-3" /> Add tag
        </button>
      )}
    </div>
  );
}

function StatusPanel({
  icon,
  tone = 'primary',
  title,
  description,
  action,
}: {
  icon: React.ReactNode;
  tone?: 'primary' | 'destructive';
  title: string;
  description: string;
  action?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className={cn(CARD, 'flex flex-col items-center gap-4 px-6 py-14 text-center')}>
      <div
        className={cn(
          'flex h-14 w-14 items-center justify-center rounded-2xl',
          tone === 'destructive'
            ? 'bg-destructive/12 text-destructive shadow-[0_0_40px_-12px_hsl(var(--destructive)/0.7)]'
            : 'bg-primary/12 text-primary shadow-[0_0_40px_-12px_hsl(var(--primary)/0.7)]',
        )}
      >
        {icon}
      </div>
      <div className="max-w-sm space-y-1.5">
        <p className="text-base font-semibold tracking-tight">{title}</p>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      {action}
    </div>
  );
}

export default function PromptHistoryPage(): React.JSX.Element {
  const location = useLocation();
  const [search, setSearch] = useState('');
  const [selectedEntry, setSelectedEntry] = useState<PromptHistoryEntry | null>(null);
  const queryClient = useQueryClient();

  // Only used to turn an entry's projectId into a name; entries outlive the
  // projects they came from, so a missing project just means no badge.
  const projectsQuery = useQuery({
    queryKey: queryKeys.projects,
    queryFn: () => window.runova.projects.list(),
  });

  function projectName(projectId: string | null): string | null {
    if (!projectId) return null;
    return projectsQuery.data?.find((p) => p.id === projectId)?.name ?? null;
  }

  const historyQuery = useQuery({
    queryKey: search.trim()
      ? queryKeys.promptHistorySearch(search.trim())
      : queryKeys.promptHistory,
    queryFn: () =>
      search.trim()
        ? window.runova.promptHistory.search(search.trim())
        : window.runova.promptHistory.list(),
  });

  useEffect(() => {
    const openEntryId = (location.state as { openEntryId?: string } | null)?.openEntryId;
    if (!openEntryId || !historyQuery.data) return;
    const found = historyQuery.data.find((entry) => entry.id === openEntryId);
    if (found) setSelectedEntry(found);
  }, [location.state, historyQuery.data]);

  const deleteMutation = useMutation({
    mutationFn: (id: string) => window.runova.promptHistory.remove(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['prompt-history'] });
    },
    onError: () => toast.error('Could not delete this entry.'),
  });

  async function handleCopy(content: string): Promise<void> {
    await navigator.clipboard.writeText(content);
    toast.success('Copied to clipboard.');
  }

  usePageHeader('Prompt History', "Every prompt you've generated or translated, searchable.");

  const entries = historyQuery.data ?? [];

  return (
    // w-full: the page wrapper is a flex column, so without it the column shrinks to its content.
    <div className="mx-auto w-full max-w-5xl space-y-4 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="search-pill flex h-9 w-full items-center gap-2 rounded-full pl-3.5 pr-1.5 transition-colors sm:w-80">
          <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <input
            className="h-full min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground/70"
            placeholder="Search prompt history…"
            aria-label="Search prompt history"
            spellCheck={false}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && search) {
                e.preventDefault();
                setSearch('');
              }
            }}
          />
          {search ? (
            <button
              type="button"
              aria-label="Clear search"
              className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/[0.08] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => setSearch('')}
            >
              <X className="h-3 w-3" />
            </button>
          ) : null}
        </div>
        {historyQuery.isSuccess && entries.length > 0 ? (
          <span className="rounded-full bg-foreground/[0.06] px-2.5 py-1 text-[11px] font-medium tabular-nums text-muted-foreground">
            {entries.length} {entries.length === 1 ? 'prompt' : 'prompts'}
          </span>
        ) : null}
      </div>

      {historyQuery.isLoading ? (
        <div role="status" aria-label="Loading prompt history" className="space-y-2">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className={cn(CARD, 'space-y-3 p-4')}>
              <div className="flex items-center gap-3">
                <Skeleton className="h-9 w-9 shrink-0 rounded-xl" />
                <Skeleton className="h-4 w-28" />
                <Skeleton className="h-5 w-20 rounded-full" />
                <Skeleton className="ml-auto h-3 w-24" />
              </div>
              <div className="space-y-2">
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-4/5" />
              </div>
              <div className="flex items-center gap-2 pt-1">
                <Skeleton className="h-6 w-16 rounded-full" />
                <Skeleton className="ml-auto h-7 w-24 rounded-full" />
                <Skeleton className="h-7 w-16 rounded-full" />
              </div>
            </div>
          ))}
        </div>
      ) : historyQuery.isError ? (
        <StatusPanel
          tone="destructive"
          icon={<TriangleAlert className="h-6 w-6" />}
          title="Couldn't load prompt history."
          description={
            historyQuery.error instanceof Error
              ? historyQuery.error.message
              : 'An unexpected error occurred.'
          }
          action={<Button onClick={() => void historyQuery.refetch()}>Try again</Button>}
        />
      ) : entries.length === 0 ? (
        <StatusPanel
          icon={search.trim() ? <Search className="h-6 w-6" /> : <History className="h-6 w-6" />}
          title={search.trim() ? 'No matching prompts found.' : 'Nothing here yet'}
          description={
            search.trim()
              ? `No prompts match "${search.trim()}".`
              : 'Generate or translate a prompt in Prompt Builder and it will show up here.'
          }
        />
      ) : (
        <div className="space-y-2">
          {entries.map((entry) => {
            const contentPersian = persianTextProps(entry.content);
            return (
              <Card key={entry.id} className={cn(CARD, 'overflow-hidden')}>
                <div className="space-y-3 p-4">
                  <div className="flex items-start gap-3">
                    <EntryIcon entry={entry} />
                    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 pt-1.5">
                      <CardTitle className="text-sm">
                        {entry.source === 'translate' ? 'Translation' : entry.promptType}
                      </CardTitle>
                      <EntryChips entry={entry} projectName={projectName(entry.projectId)} />
                    </div>
                    <span className="shrink-0 pt-2 text-[11px] tabular-nums text-muted-foreground">
                      {new Date(entry.createdAt).toLocaleString()}
                    </span>
                  </div>
                  <CardDescription
                    dir={contentPersian.dir}
                    className={cn(
                      'line-clamp-3 whitespace-pre-wrap text-[13px] leading-relaxed',
                      contentPersian.className,
                    )}
                  >
                    {entry.content}
                  </CardDescription>
                </div>
                <div className="flex flex-wrap items-center gap-2 px-4 py-2 shadow-[inset_0_1px_0_hsl(var(--foreground)/0.08)]">
                  <TagEditor entry={entry} />
                  <div className="ml-auto flex items-center gap-0.5">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-muted-foreground hover:text-foreground"
                      onClick={() => setSelectedEntry(entry)}
                    >
                      <Eye /> View details
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-muted-foreground hover:text-foreground"
                      onClick={() => void handleCopy(entry.content)}
                    >
                      <Copy /> Copy
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                      onClick={() => {
                        void confirmDialog({
                          title: 'Delete this prompt history entry?',
                          description: 'This cannot be undone.',
                          confirmLabel: 'Delete',
                          variant: 'destructive',
                        }).then((confirmed) => {
                          if (confirmed) deleteMutation.mutate(entry.id);
                        });
                      }}
                      disabled={deleteMutation.isPending}
                    >
                      <Trash2 /> Delete
                    </Button>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <Dialog
        open={selectedEntry !== null}
        onOpenChange={(open) => !open && setSelectedEntry(null)}
      >
        <DialogContent className="max-w-2xl">
          {selectedEntry ? (
            <>
              <DialogHeader>
                <div className="flex flex-wrap items-center gap-2">
                  <DialogTitle>
                    {selectedEntry.source === 'translate'
                      ? 'Translation'
                      : selectedEntry.promptType}
                  </DialogTitle>
                  <EntryChips
                    entry={selectedEntry}
                    projectName={projectName(selectedEntry.projectId)}
                  />
                </div>
                <DialogDescription>
                  {new Date(selectedEntry.createdAt).toLocaleString()}
                </DialogDescription>
              </DialogHeader>
              <SelectedEntryBody entry={selectedEntry} />
              <div className="flex items-center gap-2">
                <Button onClick={() => void handleCopy(selectedEntry.content)}>
                  <Copy /> Copy
                </Button>
              </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SelectedEntryBody({ entry }: { entry: PromptHistoryEntry }): React.JSX.Element {
  const rawPersian = persianTextProps(entry.rawInput);
  const contentPersian = persianTextProps(entry.content);
  // A soft inset well rather than a bordered box, so the two texts read as part of the dialog.
  const well =
    'whitespace-pre-wrap rounded-xl bg-foreground/[0.04] p-3 text-sm leading-relaxed ring-1 ring-inset ring-foreground/[0.06]';
  return (
    <div className="max-h-[60vh] space-y-4 overflow-y-auto">
      {entry.tags.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {entry.tags.map((tag) => (
            <Chip key={tag}>{tag}</Chip>
          ))}
        </div>
      ) : null}
      <div className="space-y-1.5">
        <p className={SECTION_HEADING}>Original input</p>
        <p dir={rawPersian.dir} className={cn(well, rawPersian.className)}>
          {entry.rawInput}
        </p>
      </div>
      <div className="space-y-1.5">
        <p className={SECTION_HEADING}>
          {entry.source === 'translate' ? 'Translated prompt' : 'Generated prompt'}
        </p>
        <p dir={contentPersian.dir} className={cn(well, contentPersian.className)}>
          {entry.content}
        </p>
      </div>
    </div>
  );
}
