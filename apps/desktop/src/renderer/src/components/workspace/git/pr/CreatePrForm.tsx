import type { Project } from '@runova/core';
import type { PullRequestStatus } from '@shared/apiTypes';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { create } from 'zustand';
import { GitPullRequest, Sparkles, Spinner } from '@/components/icons';
import { GLASS_CARD, Notice } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Combobox } from '@/components/ui/combobox';
import { MULTILINE_FIELD_RADIUS } from '@/components/ui/textarea';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { useRevealInPanel } from './PrCard';

/** The shared field surface (see index.css); the title adds the pill, the body the box corner. */
const FIELD = 'field-surface block w-full px-3 py-1.5 text-[13px] outline-none';

interface PrDraft {
  title: string;
  body: string;
}

const EMPTY_DRAFT: PrDraft = { title: '', body: '' };

/**
 * The title and description being written for a PR, per project. The panel and the large view
 * each mount their own CreatePrForm, so this is what keeps them showing the same text instead of
 * losing it when one opens or closes.
 */
export const useCreatePrDraft = create<{
  byProject: Record<string, PrDraft>;
  setTitle: (projectId: string, title: string) => void;
  setBody: (projectId: string, body: string) => void;
  reset: (projectId: string) => void;
}>((set) => ({
  byProject: {},
  setTitle: (projectId, title) =>
    set((state) => ({
      byProject: {
        ...state.byProject,
        [projectId]: { ...(state.byProject[projectId] ?? EMPTY_DRAFT), title },
      },
    })),
  setBody: (projectId, body) =>
    set((state) => ({
      byProject: {
        ...state.byProject,
        [projectId]: { ...(state.byProject[projectId] ?? EMPTY_DRAFT), body },
      },
    })),
  reset: (projectId) =>
    set((state) => {
      const { [projectId]: _gone, ...rest } = state.byProject;
      return { byProject: rest };
    }),
}));

/** Opens a PR for the current branch; pushes it first, and can have the CLI write the text. */
export function CreatePrForm({
  project,
  status,
  roomy = false,
}: {
  project: Project;
  status: PullRequestStatus;
  /** Larger fields for the large PR view, where there's space to write a real description. */
  roomy?: boolean;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const revealPanelSection = useRevealInPanel();
  const textDraft = useCreatePrDraft((s) => s.byProject[project.id]) ?? EMPTY_DRAFT;
  const setDraftTitle = useCreatePrDraft((s) => s.setTitle);
  const setDraftBody = useCreatePrDraft((s) => s.setBody);
  const resetDraft = useCreatePrDraft((s) => s.reset);
  const { title, body } = textDraft;
  const [base, setBase] = useState(status.defaultBranch ?? 'main');
  const [draft, setDraft] = useState(false);
  const [creating, setCreating] = useState(false);
  const [writing, setWriting] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  const branches = useQuery({
    queryKey: queryKeys.gitStatus(project.id),
    queryFn: () => window.runova.git.status(project.id),
    meta: { silentLoading: true },
  });
  const baseOptions = (branches.data?.branches ?? [])
    .map((branch) => branch.name)
    .filter((name) => name !== status.branch)
    .map((name) => ({ value: name, label: name }));

  async function write(): Promise<void> {
    if (writing) {
      void window.runova.pullRequests.cancelAi(writing);
      setWriting(null);
      return;
    }
    const requestId = crypto.randomUUID();
    setWriting(requestId);
    try {
      const result = await window.runova.pullRequests.suggestText(project.id, requestId, base);
      if (result.cancelled) return;
      if (result.ok) {
        if (result.title) setDraftTitle(project.id, result.title);
        if (result.body) setDraftBody(project.id, result.body);
        titleRef.current?.focus();
      } else {
        toast.error('Could not write the pull request', { description: result.error });
      }
    } finally {
      setWriting((current) => (current === requestId ? null : current));
    }
  }

  async function create(): Promise<void> {
    setCreating(true);
    try {
      const result = await window.runova.git.createPullRequest({
        projectId: project.id,
        title: title.trim(),
        body,
        base,
        draft,
      });
      if (!result.ok) {
        toast.error('Could not create the pull request', { description: result.error });
        return;
      }
      if (result.usedFallback && result.url) {
        void window.runova.shell.openExternal(result.url);
        toast.success('Opened the pull request page on GitHub', {
          description: 'Install the GitHub CLI to create pull requests from here.',
        });
      } else {
        const url = result.url;
        toast.success(draft ? 'Draft pull request created' : 'Pull request created', {
          action: url
            ? {
                label: 'Open on GitHub',
                onClick: () => void window.runova.shell.openExternal(url),
              }
            : undefined,
        });
      }
      resetDraft(project.id);
      void queryClient.invalidateQueries({ queryKey: queryKeys.pullRequest(project.id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.gitWorkspaceState(project.id) });
    } finally {
      setCreating(false);
    }
  }

  const pushNote = !status.hasUpstream
    ? 'The branch will be published to GitHub first.'
    : status.ahead > 0
      ? `${status.ahead} ${status.ahead === 1 ? 'commit' : 'commits'} will be pushed first.`
      : null;

  return (
    <section
      aria-label="New pull request"
      className={cn(GLASS_CARD, 'space-y-2.5', roomy ? 'p-4' : 'mx-2 p-3')}
    >
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-primary/12 text-primary">
          <GitPullRequest className="h-3 w-3" />
        </span>
        <span className="truncate font-mono text-foreground/85">{status.branch}</span>
        <span aria-hidden="true">→</span>
        {baseOptions.length > 0 ? (
          <Combobox
            options={baseOptions}
            value={base}
            onChange={setBase}
            placeholder={status.defaultBranch ?? 'main'}
            searchPlaceholder="Search branches…"
            emptyText="No branches found."
            className="h-6 min-w-0 flex-1 font-mono text-[11px]"
          />
        ) : (
          <span className="truncate font-mono text-foreground/85">{base}</span>
        )}
      </div>

      {status.dirty ? (
        <Notice
          tone="warning"
          size="sm"
          className="px-2.5 text-[11px] leading-snug"
          action={
            <Button
              type="button"
              variant="soft"
              size="xs"
              onClick={() => revealPanelSection('changes')}
              className="h-5 px-2"
            >
              Review changes
            </Button>
          }
        >
          You have uncommitted changes. They are not part of the pull request until you commit them.
        </Notice>
      ) : null}

      <div className="relative">
        <input
          ref={titleRef}
          value={title}
          aria-label="Pull request title"
          placeholder="Title"
          disabled={creating}
          onChange={(event) => setDraftTitle(project.id, event.target.value)}
          className={cn(
            FIELD,
            'rounded-full pr-9',
            roomy && 'py-2 text-sm font-medium',
            writing && 'shimmer',
          )}
        />
        <SimpleTooltip label={writing ? 'Stop writing' : 'Write the title and description with AI'}>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={writing ? 'Stop writing' : 'Write the title and description with AI'}
            onClick={() => void write()}
            disabled={creating}
            className={cn(
              'absolute right-1 hover:bg-primary/10 hover:text-primary',
              roomy ? 'top-1.5' : 'top-1',
            )}
          >
            {writing ? (
              <Spinner className="h-3.5 w-3.5 animate-spin text-primary motion-reduce:animate-none" />
            ) : (
              <Sparkles className="h-3.5 w-3.5" />
            )}
          </Button>
        </SimpleTooltip>
      </div>

      <textarea
        value={body}
        rows={roomy ? 14 : 5}
        aria-label="Pull request description"
        placeholder="What changed and why (optional)"
        disabled={creating}
        onChange={(event) => setDraftBody(project.id, event.target.value)}
        className={cn(
          FIELD,
          MULTILINE_FIELD_RADIUS,
          'resize-y text-[12px] leading-relaxed',
          writing && 'shimmer',
        )}
      />

      <label className="flex cursor-pointer items-center gap-2 text-[11.5px]">
        <Checkbox
          checked={draft}
          onCheckedChange={(value) => setDraft(value === true)}
          className="h-4 w-4"
          aria-label="Open as a draft"
        />
        Open as a draft
      </label>

      {pushNote ? <p className="text-[11px] text-muted-foreground">{pushNote}</p> : null}

      <Button
        onClick={() => void create()}
        disabled={!title.trim() || creating || writing !== null}
        className="w-full gap-1.5"
      >
        {creating ? (
          <Spinner className="h-3 w-3 animate-spin motion-reduce:animate-none" />
        ) : (
          <GitPullRequest className="h-3 w-3" />
        )}
        {creating ? 'Pushing and creating…' : 'Create pull request'}
      </Button>
    </section>
  );
}
