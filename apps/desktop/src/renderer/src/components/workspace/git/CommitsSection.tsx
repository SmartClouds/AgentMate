import type { Project } from '@runova/core';
import type { GitCommitInfo, WorkspaceGitState } from '@shared/apiTypes';
import { useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { ChevronRight, Copy, GitCommit, Tag } from '@/components/icons';
import { Chip } from '@/components/pageKit';
import { Skeleton } from '@/components/ui/skeleton';
import { SimpleTooltip, Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { splitGitPath } from '@/lib/git';
import { queryKeys } from '@/lib/queryKeys';
import { timeAgo } from '@/lib/time';
import { cn } from '@/lib/utils';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { StatusLetter } from './StatusLetter';

function CommitFiles({
  project,
  commit,
}: {
  project: Project;
  commit: GitCommitInfo;
}): React.JSX.Element {
  const openDiff = useWorkspaceStore((s) => s.openDiff);
  const files = useQuery({
    queryKey: ['git-commit-files', project.id, commit.hash],
    queryFn: () => window.runova.git.commitFiles(project.id, commit.hash),
    staleTime: Number.POSITIVE_INFINITY,
    meta: { silentLoading: true },
  });

  if (files.isPending) {
    return (
      <div className="space-y-1 py-1 pl-8 pr-3">
        <Skeleton className="h-6 w-3/4 rounded-lg" />
        <Skeleton className="h-6 w-1/2 rounded-lg" />
      </div>
    );
  }
  if (!files.data?.length) {
    return <p className="py-1.5 pl-8 text-[11px] text-muted-foreground">No file changes.</p>;
  }
  return (
    <div className="space-y-px pb-1">
      {files.data.map((entry) => {
        const { dir, name } = splitGitPath(entry.path);
        return (
          <button
            key={entry.path}
            type="button"
            onClick={() =>
              openDiff(project.id, {
                path: entry.path,
                origPath: entry.origPath,
                side: 'staged',
                commit: commit.hash,
              })
            }
            onDoubleClick={() =>
              openDiff(
                project.id,
                { path: entry.path, origPath: entry.origPath, side: 'staged', commit: commit.hash },
                { pin: true },
              )
            }
            className="mx-1.5 flex h-6 w-[calc(100%-0.75rem)] cursor-pointer items-center gap-2 rounded-lg pl-7 pr-1.5 text-left text-[12px] text-foreground/85 outline-none transition-colors hover:bg-foreground/[0.06] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            <span className="min-w-0 shrink truncate">{name}</span>
            {dir ? (
              <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground/80 [direction:rtl]">
                <bdi>{dir.replace(/\/$/, '')}</bdi>
              </span>
            ) : (
              <span className="flex-1" />
            )}
            {!entry.binary && (entry.additions || entry.deletions) ? (
              <span className="font-mono text-[10px] tabular-nums">
                <span className="text-success">+{entry.additions ?? 0}</span>{' '}
                <span className="text-destructive">−{entry.deletions ?? 0}</span>
              </span>
            ) : null}
            <StatusLetter status={entry.status} />
          </button>
        );
      })}
    </div>
  );
}

/** The commit's subject, with a tooltip for the full text only when the row cut it short. */
function CommitSubject({ subject }: { subject: string }): React.JSX.Element {
  const ref = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <Tooltip
      open={open}
      delayDuration={300}
      onOpenChange={(next) => {
        const node = ref.current;
        setOpen(next && node !== null && node.scrollWidth > node.clientWidth);
      }}
    >
      <TooltipTrigger asChild>
        <span ref={ref} className="truncate text-[12px] font-medium">
          {subject}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="start">
        {subject}
      </TooltipContent>
    </Tooltip>
  );
}

/** The branch's recent history. Expanding a commit lists its files; a file opens its diff. */
export function CommitsSection({
  project,
  state,
}: {
  project: Project;
  state: WorkspaceGitState | undefined;
}): React.JSX.Element {
  const branch = state?.branch ?? null;
  const [expanded, setExpanded] = useState<string | null>(null);
  const history = useQuery({
    // HEAD in the key refreshes the list the moment a commit, pull or checkout lands.
    queryKey: [...queryKeys.gitBranchHistory(project.id, branch ?? 'HEAD'), state?.head ?? ''],
    queryFn: () => window.runova.git.branchHistory(project.id, branch ?? 'HEAD'),
    enabled: Boolean(state?.isRepo && state.head),
    meta: { silentLoading: true },
    placeholderData: (previous) => previous,
  });

  if (!state?.isRepo) {
    return <p className="p-3 text-xs text-muted-foreground">Not a git repository.</p>;
  }
  if (!state.head) {
    return <p className="p-3 text-xs text-muted-foreground">No commits yet on this branch.</p>;
  }
  if (history.isPending) {
    return (
      <div className="space-y-1 px-2 py-1.5">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="h-10 rounded-lg" style={{ width: `${96 - i * 8}%` }} />
        ))}
      </div>
    );
  }

  const commits = history.data?.commits ?? [];
  return (
    <div className="min-h-0 flex-1 space-y-px overflow-y-auto py-1">
      {commits.map((commit, index) => {
        const open = expanded === commit.hash;
        const unpushed = index < state.ahead;
        return (
          <div key={commit.hash}>
            <button
              type="button"
              aria-expanded={open}
              onClick={() => setExpanded(open ? null : commit.hash)}
              className={cn(
                'group/commit relative mx-1.5 flex w-[calc(100%-0.75rem)] cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/60',
                open ? 'bg-foreground/[0.05]' : 'hover:bg-foreground/[0.06]',
              )}
            >
              <span className="relative mt-1 flex w-3 shrink-0 justify-center">
                {/* The line of history, with a hollow dot for commits not pushed yet. The dot's
                    edge is a ring, since the global border colour would repaint a border. */}
                <span
                  className={cn(
                    'relative z-[1] h-2 w-2 rounded-full',
                    unpushed
                      ? 'bg-background ring-2 ring-inset ring-primary'
                      : 'bg-primary/70 shadow-[0_0_6px_hsl(var(--primary)/0.5)]',
                  )}
                />
                {index < commits.length - 1 ? (
                  <span className="absolute top-3 h-[calc(100%+0.5rem)] w-px bg-foreground/10" />
                ) : null}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <ChevronRight
                    className={cn(
                      'h-2 w-2 shrink-0 text-muted-foreground transition-transform',
                      open && 'rotate-90',
                    )}
                  />
                  <CommitSubject subject={commit.subject} />
                </span>
                <span className="mt-0.5 flex items-center gap-1.5 pl-3.5 text-[10px] text-muted-foreground">
                  <span className="font-mono">{commit.shortHash}</span>
                  <span>·</span>
                  <span className="truncate">{commit.author}</span>
                  <span>·</span>
                  <span className="shrink-0">{timeAgo(commit.date)}</span>
                  {unpushed ? (
                    <Chip tone="primary" className="h-4 px-1.5 text-[10px]">
                      not pushed
                    </Chip>
                  ) : null}
                </span>
                {commit.tags.length > 0 ? (
                  <span className="mt-1 flex flex-wrap gap-1 pl-3.5">
                    {commit.tags.map((tag) => (
                      <Chip
                        key={tag}
                        tone="primary"
                        className="h-4 px-1.5 font-mono text-[10px] [&_svg]:size-2.5"
                      >
                        <Tag />
                        {tag}
                      </Chip>
                    ))}
                  </span>
                ) : null}
              </span>
              <SimpleTooltip label="Copy commit id">
                <span
                  role="button"
                  tabIndex={-1}
                  aria-label="Copy commit id"
                  onClick={(event) => {
                    event.stopPropagation();
                    void navigator.clipboard.writeText(commit.hash);
                  }}
                  className="mt-0.5 hidden h-5 w-5 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/[0.08] hover:text-foreground group-hover/commit:flex"
                >
                  <Copy className="h-2.5 w-2.5" />
                </span>
              </SimpleTooltip>
            </button>
            {open ? <CommitFiles project={project} commit={commit} /> : null}
          </div>
        );
      })}
      {commits.length >= 100 ? (
        <p className="flex items-center gap-1.5 px-3 py-2 text-[10px] text-muted-foreground">
          <GitCommit className="h-2.5 w-2.5" /> Showing the latest 100 commits.
        </p>
      ) : null}
    </div>
  );
}
