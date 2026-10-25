import type { GitChangeEntry, Project } from '@agentmat/core';
import { baseName, findGroup, parseScopeId } from '@agentmat/core';
import type { GitDiffSide, GitOpResult, WorkspaceGitState } from '@shared/apiTypes';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { vscodeMark } from '@/components/brandMarks';
import {
  AnglesLeft,
  AnglesRight,
  ArrowDown,
  ArrowUp,
  ChartSimple,
  ChevronRight,
  CircleCheck,
  CollapseAll,
  Expand,
  FilePlus,
  Flask,
  FolderPlus,
  FolderTree,
  GitBranch,
  History,
  ListTodo,
  Minus,
  Plus,
  RefreshCw,
  Spinner,
  Trash2,
  Undo,
} from '@/components/icons';
import { EmptyState, Notice, SECTION_HEADING } from '@/components/pageKit';
import { RelayTrack } from '@/components/relay/RelayTrack';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { useWorktrees } from '@/hooks/useWorktrees';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { confirmDialog } from '@/stores/confirmStore';
import { useShortcutLabel } from '@/stores/shortcutStore';
import { ensureTestRunSubscription } from '@/stores/testsStore';
import {
  GIT_PANEL_DEFAULT_WIDTH,
  GIT_PANEL_MAX_WIDTH,
  GIT_PANEL_MIN_WIDTH,
  type GitPanelSection,
  SOURCE_CONTROL_SECTIONS,
  type SourceControlSection,
  useWorkspaceStore,
} from '@/stores/workspaceStore';
import { useWorktreeDialogStore } from '@/stores/worktreeDialogStore';
import { TestsSection, TestsTabActions, useTestsFailedCount } from '../tests/TestsSection';
import { WorktreeFinishSlot } from '../worktrees/WorktreeFinishCard';
import { WorktreesSection } from '../worktrees/WorktreesSection';
import { BranchesSection } from './BranchesSection';
import { ChangesSummary } from './ChangesSummary';
import { CommitBox } from './CommitBox';
import { CommitsSection } from './CommitsSection';
import { ExplorerSection } from './ExplorerSection';
import { collapseAll, startCreateAtFocus } from './explorer/actions';
import { ExplorerSearchToggle } from './explorer/ExplorerSearchToggle';
import { FixConflictsButton } from './FixConflictsDialog';
import { GitFileRow } from './GitFileRow';
import { HistorySection } from './HistorySection';
import { PanelNotice } from './PanelNotice';
import { HAIRLINE_BELOW, PanelIconButton, type PanelTabDef, PanelTabs } from './PanelTabs';
import { PipelinesDialog } from './PipelinesDialog';
import { PipelinesSection } from './PipelinesSection';
import { BranchPrPill, pullRequestAttention } from './pr/BranchPrPill';
import { PullRequestDialog } from './pr/PullRequestDialog';
import { PullRequestSection } from './pr/PullRequestSection';
import { announcePublishedBranch, usePullRequest } from './pr/usePullRequest';
import { SectionCount, SourceSection, SourceSectionSplitter } from './SourceSection';
import { StashesSection, StashMenu, useStashes } from './StashesSection';
import { usePipelineStatus } from './usePipelineStatus';
import {
  type GitActions,
  openChangedFile,
  useAiResolvingPaths,
  useGitActions,
  useWorkspaceGitState,
} from './useWorkspaceGit';

function HeaderButton({
  label,
  onClick,
  children,
  disabled,
  active,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  disabled?: boolean;
  /** For a button that turns something on and off, so its state reads at a glance. */
  active?: boolean;
}): React.JSX.Element {
  return (
    <SimpleTooltip label={label} wrapTrigger={disabled}>
      <Button
        type="button"
        variant={active ? 'tint' : 'ghost'}
        size="icon-xs"
        aria-label={label}
        {...(active === undefined ? {} : { 'aria-pressed': active })}
        onClick={onClick}
        disabled={disabled}
      >
        {children}
      </Button>
    </SimpleTooltip>
  );
}

type SyncKind = 'sync' | 'push' | 'pull' | 'publish' | 'fetch';

function SyncControls({
  projectId,
  state,
}: {
  projectId: string;
  state: WorkspaceGitState;
}): React.JSX.Element | null {
  const queryClient = useQueryClient();
  const [running, setRunning] = useState<SyncKind | null>(null);

  async function run(kind: SyncKind): Promise<void> {
    if (running) return;
    setRunning(kind);
    const git = window.agentmat.git;
    let result: GitOpResult;
    try {
      result =
        kind === 'fetch'
          ? await git.fetch(projectId)
          : kind === 'pull'
            ? await git.pull(projectId)
            : kind === 'sync'
              ? await git.sync(projectId)
              : await git.push(projectId);
    } finally {
      setRunning(null);
    }
    void queryClient.invalidateQueries({ queryKey: queryKeys.gitWorkspaceState(projectId) });
    const outcome: Record<SyncKind, [done: string, failed: string]> = {
      fetch: ['Fetched', 'Fetch failed'],
      pull: ['Pulled', 'Pull failed'],
      push: ['Pushed', 'Push failed'],
      publish: ['Branch published', 'Could not publish the branch'],
      sync: ['Synced', 'Sync failed'],
    };
    if (!result.ok) toast.error(outcome[kind][1], { description: result.message });
    else if (kind === 'publish') announcePublishedBranch(queryClient, projectId, state.branch);
    else toast.success(outcome[kind][0]);
  }

  if (!state.hasRemote) return null;

  const kind: Exclude<SyncKind, 'fetch'> | null = !state.upstream
    ? state.branch
      ? 'publish'
      : null
    : state.ahead > 0 && state.behind > 0
      ? 'sync'
      : state.ahead > 0
        ? 'push'
        : state.behind > 0
          ? 'pull'
          : null;

  const label: Record<Exclude<SyncKind, 'fetch'>, string> = {
    sync: 'Sync',
    push: 'Push',
    pull: 'Pull',
    publish: 'Publish',
  };
  const hint: Record<Exclude<SyncKind, 'fetch'>, string> = {
    sync: `Pull ${state.behind} and push ${state.ahead} commit${state.ahead === 1 ? '' : 's'}`,
    push: `Push ${state.ahead} commit${state.ahead === 1 ? '' : 's'} to ${state.upstream}`,
    pull: `Pull ${state.behind} commit${state.behind === 1 ? '' : 's'} from ${state.upstream}`,
    publish: `Push ${state.branch} and start tracking it`,
  };

  return (
    <div className="flex items-center gap-0.5">
      {kind ? (
        <SimpleTooltip label={hint[kind]}>
          <Button
            type="button"
            variant="tint"
            size="xs"
            onClick={() => void run(kind)}
            disabled={running !== null}
            className="mr-0.5 [&_svg]:size-2.5"
          >
            {running === kind ? (
              <Spinner className="h-2.5 w-2.5 animate-spin motion-reduce:animate-none" />
            ) : null}
            {label[kind]}
            {state.behind > 0 ? (
              <span className="inline-flex items-center tabular-nums">
                <ArrowDown className="h-2 w-2" />
                {state.behind}
              </span>
            ) : null}
            {state.ahead > 0 ? (
              <span className="inline-flex items-center tabular-nums">
                <ArrowUp className="h-2 w-2" />
                {state.ahead}
              </span>
            ) : null}
          </Button>
        </SimpleTooltip>
      ) : null}
      <HeaderButton
        label={running === 'fetch' ? 'Fetching…' : 'Fetch from remote'}
        onClick={() => void run('fetch')}
        disabled={running !== null}
      >
        <RefreshCw
          className={cn(
            'h-3 w-3',
            running === 'fetch' && 'animate-spin motion-reduce:animate-none',
          )}
        />
      </HeaderButton>
    </div>
  );
}

/**
 * Fetches once per project when its panel first shows, so the ahead and behind counts mean
 * something before the user asks for anything.
 */
function useInitialFetch(projectId: string, hasRemote: boolean | undefined): void {
  const queryClient = useQueryClient();
  const fetchedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!hasRemote || fetchedFor.current === projectId) return;
    fetchedFor.current = projectId;
    void window.agentmat.git.fetch(projectId).then(() => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.gitWorkspaceState(projectId) });
    });
  }, [projectId, hasRemote, queryClient]);
}

/** Branch, tracking state and the one button that matters right now (sync, push, publish). */
function BranchBar({
  projectId,
  state,
}: {
  projectId: string;
  state: WorkspaceGitState;
}): React.JSX.Element {
  const setGitPanel = useWorkspaceStore((s) => s.setGitPanel);
  const revealPanelSection = useWorkspaceStore((s) => s.revealPanelSection);
  const showLineStats = useWorkspaceStore((s) => s.gitPanel.showLineStats);
  return (
    <div className={cn('flex h-9 shrink-0 items-center gap-1 pl-1.5 pr-1.5', HAIRLINE_BELOW)}>
      <SimpleTooltip
        label={
          state.detached
            ? `Detached at ${state.head}`
            : state.upstream
              ? `Tracking ${state.upstream}. Click to switch branch`
              : state.hasRemote
                ? 'This branch is not published yet. Click to switch branch'
                : 'No remote configured. Click to switch branch'
        }
      >
        <button
          type="button"
          onClick={() => revealPanelSection('branches')}
          className="flex h-6 min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-full px-2 text-left text-xs outline-none transition-colors hover:bg-foreground/[0.06] focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          <GitBranch className="h-3 w-3 shrink-0 text-primary" />
          <span className="truncate font-mono font-medium">
            {state.detached ? `detached ${state.head ?? ''}` : (state.branch ?? 'no branch')}
          </span>
        </button>
      </SimpleTooltip>
      <BranchPrPill projectId={projectId} />
      <SyncControls projectId={projectId} state={state} />
      <HeaderButton
        label={showLineStats ? 'Hide line totals' : 'Show line totals'}
        active={showLineStats}
        onClick={() => setGitPanel({ showLineStats: !showLineStats })}
      >
        <ChartSimple className="h-3 w-3" />
      </HeaderButton>
    </div>
  );
}

interface SectionConfig {
  id: GitPanelSection;
  title: string;
  side: GitDiffSide;
  entries: GitChangeEntry[];
}

function SectionHeader({
  section,
  collapsed,
  onToggle,
  actions,
}: {
  section: SectionConfig;
  collapsed: boolean;
  onToggle: () => void;
  actions: React.ReactNode;
}): React.JSX.Element {
  return (
    // The island is the theme's background, so the sticky header uses it too and doesn't show
    // as a stripe of card colour over the rows.
    <div className="group/section sticky top-0 z-10 flex h-7 items-center gap-1 bg-background/90 pl-2 pr-2 backdrop-blur-sm">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        className="flex h-6 min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-full px-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
      >
        <ChevronRight
          className={cn(
            'h-2.5 w-2.5 shrink-0 text-muted-foreground/60 transition-transform duration-150 group-hover/section:text-muted-foreground',
            !collapsed && 'rotate-90',
          )}
        />
        <span
          className={cn(
            SECTION_HEADING,
            'truncate transition-colors group-hover/section:text-foreground/80',
            section.id === 'conflicts' && 'text-destructive group-hover/section:text-destructive',
          )}
        >
          {section.title}
        </span>
        <SectionCount tone={section.id === 'conflicts' ? 'destructive' : 'neutral'}>
          {section.entries.length}
        </SectionCount>
      </button>
      <span className="flex items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover/section:opacity-100">
        {actions}
      </span>
    </div>
  );
}

function ChangeSections({
  project,
  state,
  actions,
}: {
  project: Project;
  state: WorkspaceGitState;
  actions: GitActions;
}): React.JSX.Element {
  const projectId = project.id;
  const collapsedSections = useWorkspaceStore((s) => s.gitPanel.collapsedSections);
  const setGitPanel = useWorkspaceStore((s) => s.setGitPanel);
  const openDiff = useWorkspaceStore((s) => s.openDiff);
  const activeDiff = useWorkspaceStore((s) => {
    const ws = s.workspaces[projectId];
    if (!ws) return null;
    const group = findGroup(ws.root, ws.focusedGroupId);
    const tab = group?.activeTabId ? ws.tabs[group.activeTabId] : undefined;
    return tab?.kind === 'diff' ? `${tab.side}:${tab.path}` : null;
  });
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const aiResolving = useAiResolvingPaths(projectId);

  const sections: SectionConfig[] = [
    { id: 'conflicts', title: 'Conflicts', side: 'conflict', entries: state.conflicts },
    { id: 'staged', title: 'Staged changes', side: 'staged', entries: state.staged },
    { id: 'unstaged', title: 'Unstaged changes', side: 'unstaged', entries: state.unstaged },
    { id: 'untracked', title: 'Untracked', side: 'untracked', entries: state.untracked },
  ].filter((section) => section.entries.length > 0) as SectionConfig[];

  const firstKey = sections[0]?.entries[0]
    ? `${sections[0].side}:${sections[0].entries[0].path}`
    : null;

  async function discardAll(
    side: 'unstaged' | 'untracked',
    entries: GitChangeEntry[],
  ): Promise<void> {
    const count = entries.length;
    const ok = await confirmDialog({
      title:
        side === 'untracked'
          ? `Delete ${count} untracked file${count === 1 ? '' : 's'}?`
          : `Discard changes in ${count} file${count === 1 ? '' : 's'}?`,
      description:
        side === 'untracked'
          ? 'They go to the trash, and you can undo right after.'
          : 'The files go back to their last staged or committed version. You can undo right after.',
      confirmLabel: side === 'untracked' ? 'Delete files' : 'Discard changes',
      variant: 'destructive',
    });
    if (ok)
      await actions.discard(
        entries.map((entry) => entry.path),
        side,
      );
  }

  function openFile(entry: GitChangeEntry): void {
    openChangedFile(project, state.projectPrefix, entry.path, entry.binary);
  }

  return (
    <div role="listbox" aria-label="Changed files" className="pb-3">
      {state.untrackedTruncated ? (
        <Notice tone="warning" size="sm" className="mx-2 mb-1 mt-2 text-[11px] leading-snug">
          Showing the first 2,000 untracked files. A missing .gitignore entry may be letting build
          output in.
        </Notice>
      ) : null}
      {sections.map((section) => {
        const collapsed = collapsedSections[section.id] === true;
        const paths = section.entries.map((entry) => entry.path);
        let bulk: React.ReactNode = null;
        if (section.id === 'staged') {
          bulk = (
            <HeaderButton label="Unstage all" onClick={() => void actions.unstage(paths)}>
              <Minus className="h-2.5 w-2.5" />
            </HeaderButton>
          );
        } else if (section.id === 'unstaged' || section.id === 'untracked') {
          const side = section.id;
          bulk = (
            <>
              <HeaderButton
                label={side === 'untracked' ? 'Delete all untracked files' : 'Discard all changes'}
                onClick={() => void discardAll(side, section.entries)}
              >
                {side === 'untracked' ? (
                  <Trash2 className="h-2.5 w-2.5" />
                ) : (
                  <Undo className="h-2.5 w-2.5" />
                )}
              </HeaderButton>
              <HeaderButton label="Stage all" onClick={() => void actions.stage(paths)}>
                <Plus className="h-2.5 w-2.5" />
              </HeaderButton>
            </>
          );
        }
        return (
          <div key={section.id} className="mt-1 space-y-px">
            <SectionHeader
              section={section}
              collapsed={collapsed}
              onToggle={() =>
                setGitPanel({
                  collapsedSections: { ...collapsedSections, [section.id]: !collapsed },
                })
              }
              actions={bulk}
            />
            {collapsed
              ? null
              : section.entries.map((entry) => {
                  const key = `${section.side}:${entry.path}`;
                  const conflict = section.side === 'conflict';
                  // Marking it resolved while the AI is still writing would stage a half edit.
                  const resolving = conflict && aiResolving(entry.path);
                  return (
                    <GitFileRow
                      key={key}
                      project={project}
                      projectPrefix={state.projectPrefix}
                      entry={entry}
                      side={section.side}
                      selected={activeDiff === key}
                      focusable={(focusKey ?? firstKey) === key}
                      onFocusRow={() => setFocusKey(key)}
                      onOpen={(pin) =>
                        openDiff(
                          projectId,
                          { path: entry.path, side: section.side, origPath: entry.origPath },
                          { pin },
                        )
                      }
                      onOpenFile={() => openFile(entry)}
                      onStage={
                        section.side === 'staged' || resolving
                          ? undefined
                          : () => void actions.stage([entry.path])
                      }
                      onUnstage={
                        section.side === 'staged'
                          ? () => void actions.unstage([entry.path])
                          : undefined
                      }
                      onDiscard={
                        section.side === 'unstaged' || section.side === 'untracked'
                          ? () => {
                              const side = section.side as 'unstaged' | 'untracked';
                              void actions.discard([entry.path], side);
                            }
                          : undefined
                      }
                      onResolve={
                        conflict ? (pick) => void actions.resolve(entry.path, pick) : undefined
                      }
                      onResolveWithAi={
                        conflict ? () => void actions.resolveWithAi(entry.path) : undefined
                      }
                      aiResolving={resolving}
                    />
                  );
                })}
          </div>
        );
      })}
    </div>
  );
}

type PullRequestQuery = ReturnType<typeof usePullRequest>;

/** Stage, commit and every changed file, live. */
function ChangesBody({
  project,
  state,
  actions,
}: {
  project: Project;
  state: WorkspaceGitState;
  actions: GitActions;
}): React.JSX.Element {
  const showLineStats = useWorkspaceStore((s) => s.gitPanel.showLineStats);
  const total =
    state.staged.length + state.unstaged.length + state.untracked.length + state.conflicts.length;
  return (
    <>
      {total > 0 ? (
        <CommitBox
          projectId={project.id}
          state={state}
          actions={actions}
          // With an operation pending the banner above already offers it.
          conflictAction={
            state.operation ? null : <FixConflictsButton project={project} state={state} />
          }
        />
      ) : null}
      {showLineStats ? <ChangesSummary state={state} /> : null}
      <div className="min-h-0 flex-1 overflow-y-auto" data-git-panel>
        {total === 0 ? (
          <EmptyState
            size="sm"
            icon={CircleCheck}
            title="Working tree clean"
            description={
              <span className="block max-w-[15rem] text-xs">
                Files your agents change show up here the moment they are written.
              </span>
            }
            className="min-h-full"
          />
        ) : (
          <ChangeSections project={project} state={state} actions={actions} />
        )}
      </div>
    </>
  );
}

/**
 * The Source control tab: the branch bar on top, then changes, branches, commits, the pull
 * request and pipelines as sections that fold away.
 */
function SourceControlBody({
  project,
  state,
  pullRequest,
  creatingBranch,
  onCreatingBranchChange,
}: {
  project: Project;
  state: WorkspaceGitState | undefined;
  pullRequest: PullRequestQuery;
  creatingBranch: boolean;
  onCreatingBranchChange: (creating: boolean) => void;
}): React.JSX.Element {
  const navigate = useNavigate();
  const actions = useGitActions(project.id);
  const openSections = useWorkspaceStore((s) => s.gitPanel.openSourceSections);
  const setSectionOpen = useWorkspaceStore((s) => s.setSourceSectionOpen);
  const sectionHeights = useWorkspaceStore((s) => s.gitPanel.sourceSectionHeights);
  const setSectionHeights = useWorkspaceStore((s) => s.setSourceSectionHeights);
  const sectionsRef = useRef<HTMLDivElement>(null);
  const revealPanelSection = useWorkspaceStore((s) => s.revealPanelSection);
  const [prDialogOpen, setPrDialogOpen] = useState(false);
  // The section and its larger view read one shared status, so a failed refresh can't leave them
  // disagreeing. It only reads while one of them is on screen: a folded section renders nothing.
  const [pipelinesDialog, setPipelinesDialog] = useState<{
    open: boolean;
    workflowId: number | null;
  }>({ open: false, workflowId: null });
  const pipelines = usePipelineStatus(project.id, {
    enabled: state?.isRepo === true && (openSections.pipelines || pipelinesDialog.open),
  });
  const openCreateWorktree = useWorktreeDialogStore((s) => s.openCreate);
  const worktreeCount = useWorktrees(parseScopeId(project.id).projectId).data?.length ?? 0;
  // Cheap (`git stash list`), so the Stashes header can carry its count like Commits does.
  const stashCount = useStashes(project.id, state?.isRepo === true).data?.length ?? 0;

  if (!state) {
    return (
      <div className="space-y-1 p-2.5" aria-busy>
        <Skeleton className="mb-2 h-[4.5rem] w-full rounded-[1.25rem]" />
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-6 rounded-lg" style={{ width: `${92 - i * 7}%` }} />
        ))}
      </div>
    );
  }

  if (!state.isRepo) {
    return (
      <EmptyState
        size="sm"
        icon={GitBranch}
        title="Not a git repository"
        description={
          <span className="block text-xs">
            Initialize one from the project's Git tab to see changes here.
          </span>
        }
        action={
          <Button
            type="button"
            variant="soft"
            size="xs"
            onClick={() => navigate(`/projects/${parseScopeId(project.id).projectId}?tab=git`)}
          >
            Open the Git tab
          </Button>
        }
        className="flex-1 px-6"
      />
    );
  }

  const total =
    state.staged.length + state.unstaged.length + state.untracked.length + state.conflicts.length;
  const prAttention = pullRequestAttention(pullRequest.data?.pr);
  // The changes always take what is left, so only the other sections keep a dragged height.
  const sized = (section: SourceControlSection, height: number | undefined) =>
    section === 'changes' ? {} : { [section]: height };
  const resized = SOURCE_CONTROL_SECTIONS.some(
    (section) =>
      section !== 'changes' && openSections[section] && sectionHeights[section] !== undefined,
  );
  const fold = (section: SourceControlSection) => {
    const index = SOURCE_CONTROL_SECTIONS.indexOf(section);
    const upper = SOURCE_CONTROL_SECTIONS.slice(0, index)
      .reverse()
      .find((other) => openSections[other]);
    const lower = SOURCE_CONTROL_SECTIONS.slice(index).find((other) => openSections[other]);
    return {
      id: section,
      open: openSections[section],
      onToggle: () => setSectionOpen(section, !openSections[section]),
      height: sectionHeights[section],
      resized,
      splitter:
        upper && lower ? (
          <SourceSectionSplitter
            containerRef={sectionsRef}
            upper={upper}
            lower={lower}
            onResize={(above, below) =>
              setSectionHeights({ ...sized(upper, above), ...sized(lower, below) })
            }
            onReset={() =>
              setSectionHeights({ ...sized(upper, undefined), ...sized(lower, undefined) })
            }
          />
        ) : undefined,
    };
  };

  return (
    <>
      <BranchBar projectId={project.id} state={state} />
      {state.operation ? (
        <Notice
          role="group"
          aria-label={`${state.operation} in progress`}
          tone="warning"
          size="sm"
          className="mx-2 mt-2 items-center"
          action={
            <>
              <FixConflictsButton project={project} state={state} />
              <Button
                type="button"
                variant="soft"
                size="xs"
                onClick={async () => {
                  const ok = await confirmDialog({
                    title: `Abort the ${state.operation}?`,
                    description: 'The repository goes back to how it was before it started.',
                    confirmLabel: 'Abort',
                    variant: 'destructive',
                  });
                  if (ok) void actions.abort();
                }}
              >
                Abort
              </Button>
            </>
          }
        >
          <span className="block truncate font-medium capitalize">
            {state.operation} in progress
          </span>
        </Notice>
      ) : null}
      <WorktreeFinishSlot project={project} />
      <div ref={sectionsRef} className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <SourceSection
          {...fold('changes')}
          primary
          title="Changes"
          count={total}
          countLabel={`${total} changed file${total === 1 ? '' : 's'}`}
          countTone={state.conflicts.length > 0 ? 'destructive' : 'default'}
          actions={<StashMenu project={project} state={state} actions={actions} />}
        >
          <ChangesBody project={project} state={state} actions={actions} />
        </SourceSection>
        <SourceSection
          {...fold('stashes')}
          title="Stashes"
          count={stashCount}
          countLabel={`${stashCount} ${stashCount === 1 ? 'stash' : 'stashes'}`}
        >
          <StashesSection project={project} />
        </SourceSection>
        <SourceSection
          {...fold('branches')}
          title="Branches"
          actions={
            <PanelIconButton label="New branch" onClick={() => onCreatingBranchChange(true)}>
              <Plus className="h-2.5 w-2.5" />
            </PanelIconButton>
          }
        >
          <BranchesSection
            project={project}
            state={state}
            creating={creatingBranch}
            onCreatingChange={onCreatingBranchChange}
          />
        </SourceSection>
        <SourceSection
          {...fold('worktrees')}
          title="Worktrees"
          count={worktreeCount}
          countLabel={`${worktreeCount} worktree${worktreeCount === 1 ? '' : 's'}`}
          actions={
            <PanelIconButton
              label="New worktree"
              onClick={() => openCreateWorktree({ projectId: parseScopeId(project.id).projectId })}
            >
              <Plus className="h-2.5 w-2.5" />
            </PanelIconButton>
          }
        >
          <WorktreesSection project={project} />
        </SourceSection>
        <SourceSection
          {...fold('commits')}
          title="Commits"
          count={state.ahead}
          countLabel={`${state.ahead} unpushed commit${state.ahead === 1 ? '' : 's'}`}
        >
          <CommitsSection project={project} state={state} />
        </SourceSection>
        <SourceSection
          {...fold('pullRequest')}
          title="Pull request"
          count={prAttention.count}
          countLabel={prAttention.failing ? 'Checks failing' : 'Needs attention'}
          countTone={prAttention.failing ? 'destructive' : 'default'}
          actions={
            state.hasRemote ? (
              <>
                <PanelIconButton
                  label="Refresh pull request"
                  onClick={() => void pullRequest.refetch()}
                >
                  <RefreshCw
                    className={cn(
                      'h-2.5 w-2.5',
                      pullRequest.isFetching && 'animate-spin motion-reduce:animate-none',
                    )}
                  />
                </PanelIconButton>
                <PanelIconButton
                  label="Open in a larger view"
                  onClick={() => setPrDialogOpen(true)}
                >
                  <Expand className="h-2.5 w-2.5" />
                </PanelIconButton>
              </>
            ) : null
          }
        >
          {state.hasRemote ? (
            <PullRequestSection
              project={project}
              status={pullRequest.data}
              loading={pullRequest.isPending}
              onRetry={() => void pullRequest.refetch()}
              onNewBranch={() => {
                revealPanelSection('branches');
                onCreatingBranchChange(true);
              }}
            />
          ) : (
            // The pull request is never read without a remote, so it would load forever.
            <PanelNotice
              title="No remote"
              body="Add a GitHub remote and publish the branch to open a pull request."
            />
          )}
        </SourceSection>
        <SourceSection
          {...fold('pipelines')}
          title="Pipelines"
          actions={
            state.hasRemote ? (
              <PanelIconButton
                label="Open pipelines in a larger view"
                onClick={() => setPipelinesDialog({ open: true, workflowId: null })}
              >
                <Expand className="h-2.5 w-2.5" />
              </PanelIconButton>
            ) : null
          }
        >
          <PipelinesSection
            project={project}
            view={pipelines.view}
            retrying={pipelines.retrying}
            onRetry={pipelines.retry}
            onOpenDetails={(workflowId) => setPipelinesDialog({ open: true, workflowId })}
          />
        </SourceSection>
      </div>
      <PipelinesDialog
        project={project}
        open={pipelinesDialog.open}
        onOpenChange={(open) => setPipelinesDialog((current) => ({ ...current, open }))}
        state={pipelines}
        workflowId={pipelinesDialog.workflowId}
      />
      {state.hasRemote ? (
        <PullRequestDialog
          project={project}
          open={prDialogOpen}
          onOpenChange={setPrDialogOpen}
          status={pullRequest.data}
          loading={pullRequest.isPending}
          fetching={pullRequest.isFetching}
          onRetry={() => void pullRequest.refetch()}
          onNewBranch={() => {
            revealPanelSection('branches');
            onCreatingBranchChange(true);
          }}
        />
      ) : null}
    </>
  );
}

/** The right-hand panel: source control, files, agent sessions and tests. */
export function GitPanel({
  project,
  visible,
}: {
  project: Project;
  visible: boolean;
}): React.JSX.Element {
  const width = useWorkspaceStore((s) => s.gitPanel.width);
  const collapsed = useWorkspaceStore((s) => s.gitPanel.collapsed);
  const setGitPanel = useWorkspaceStore((s) => s.setGitPanel);
  const toggleLabel = useShortcutLabel('workspace.toggleGitPanel');
  const activeSection = useWorkspaceStore((s) => s.gitPanel.activeSection);
  const queryClient = useQueryClient();
  const [creatingBranch, setCreatingBranch] = useState(false);
  const query = useWorkspaceGitState(project.id, visible);
  const state = query.data;
  useInitialFetch(project.id, state?.isRepo && state.hasRemote);
  const [resizing, setResizing] = useState(false);
  const failedTests = useTestsFailedCount(project.id);
  // Runs keep reporting while the Tests tab is closed, so the badge stays true.
  useEffect(() => ensureTestRunSubscription(), []);
  const count = state
    ? state.staged.length + state.unstaged.length + state.untracked.length + state.conflicts.length
    : 0;
  // Read while the panel shows, not just the tab, so its badge and the branch pill stay current.
  const pullRequest = usePullRequest(project.id, {
    visible: visible && !collapsed && Boolean(state?.isRepo && state.hasRemote),
    branch: state?.branch,
    head: state?.head,
    ahead: state?.ahead,
    upstream: state?.upstream,
  });
  const prAttention = pullRequestAttention(pullRequest.data?.pr);

  function startResize(event: React.PointerEvent<HTMLDivElement>): void {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = width;
    setResizing(true);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    const onMove = (move: PointerEvent): void => {
      const next = Math.round(startWidth + (startX - move.clientX));
      setGitPanel({ width: Math.min(GIT_PANEL_MAX_WIDTH, Math.max(GIT_PANEL_MIN_WIDTH, next)) });
    };
    const onUp = (up: PointerEvent): void => {
      handle.releasePointerCapture(up.pointerId);
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      setResizing(false);
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  }

  const tabs: PanelTabDef[] = [
    {
      id: 'sourceControl',
      title: 'Source control',
      icon: GitBranch,
      // A failing pull request outranks the changed-file count.
      count: prAttention.failing ? prAttention.count : count,
      countTone: prAttention.failing ? 'destructive' : 'default',
      render: () => (
        <SourceControlBody
          project={project}
          state={state}
          pullRequest={pullRequest}
          creatingBranch={creatingBranch}
          onCreatingBranchChange={setCreatingBranch}
        />
      ),
    },
    {
      id: 'explorer',
      title: 'Explorer',
      icon: FolderTree,
      toolbarTitle: baseName(project.folderPath) || project.name,
      actions: (
        <>
          <ExplorerSearchToggle projectId={project.id} />
          <PanelIconButton label="New File…" onClick={() => startCreateAtFocus(project, 'newFile')}>
            <FilePlus className="h-2.5 w-2.5" />
          </PanelIconButton>
          <PanelIconButton
            label="New Folder…"
            onClick={() => startCreateAtFocus(project, 'newFolder')}
          >
            <FolderPlus className="h-2.5 w-2.5" />
          </PanelIconButton>
          <PanelIconButton
            label="Open in VS Code"
            onClick={() =>
              void window.agentmat.shell
                .openInEditor(project.folderPath)
                .catch((error: Error) => toast.error(error.message))
            }
          >
            <svg role="img" viewBox="0 0 24 24" fill="currentColor" className="h-2.5 w-2.5">
              <path d={vscodeMark.path} />
            </svg>
          </PanelIconButton>
          <PanelIconButton
            label="Refresh files"
            onClick={() =>
              void queryClient.invalidateQueries({ queryKey: ['workspace-explorer', project.id] })
            }
          >
            <RefreshCw className="h-2.5 w-2.5" />
          </PanelIconButton>
          <PanelIconButton label="Collapse Folders" onClick={() => collapseAll(project.id)}>
            <CollapseAll className="h-2.5 w-2.5" />
          </PanelIconButton>
        </>
      ),
      render: () => <ExplorerSection project={project} state={state} />,
    },
    {
      id: 'history',
      title: 'Agent sessions',
      icon: History,
      actions: (
        <PanelIconButton
          label="Refresh sessions"
          onClick={() =>
            void queryClient.invalidateQueries({ queryKey: queryKeys.agentHistory(project.id) })
          }
        >
          <RefreshCw className="h-2.5 w-2.5" />
        </PanelIconButton>
      ),
      render: () => <HistorySection project={project} />,
    },
    {
      id: 'tests',
      title: 'Tests',
      icon: Flask,
      count: failedTests || undefined,
      // Its own row under the tab icons, so the run buttons are not crowded in with them.
      toolbarTitle: 'Tests',
      actions: <TestsTabActions project={project} />,
      render: () => <TestsSection project={project} />,
    },
    {
      id: 'tasks',
      title: 'Tasks',
      icon: ListTodo,
      render: () => <RelayTrack project={project} />,
    },
  ];

  if (collapsed) {
    return (
      <aside className="chrome-island my-1.5 mr-1.5 flex w-10 shrink-0 flex-col items-center gap-0.5 py-2">
        <SimpleTooltip
          label={toggleLabel ? `Show the panel (${toggleLabel})` : 'Show the panel'}
          side="left"
        >
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Show the panel"
            onClick={() => setGitPanel({ collapsed: false })}
            className="mb-1"
          >
            <AnglesLeft />
          </Button>
        </SimpleTooltip>
        {tabs.map((tab) => (
          <SimpleTooltip key={tab.id} label={tab.title} side="left">
            <button
              type="button"
              aria-label={tab.title}
              onClick={() => setGitPanel({ collapsed: false, activeSection: tab.id })}
              className={cn(
                'relative flex h-8 w-8 cursor-pointer items-center justify-center rounded-full outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/60',
                tab.id === activeSection
                  ? 'bg-primary/12 text-primary'
                  : 'text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground',
              )}
            >
              <tab.icon className="h-3.5 w-3.5" />
              {tab.count ? (
                <span
                  className={cn(
                    'absolute -right-0.5 -top-0.5 min-w-4 rounded-full px-1 text-center text-[9px] font-bold leading-4 tabular-nums',
                    tab.countTone === 'destructive'
                      ? 'bg-destructive text-destructive-foreground'
                      : 'bg-primary text-primary-foreground',
                  )}
                >
                  {tab.count > 99 ? '99+' : tab.count}
                </span>
              ) : null}
            </button>
          </SimpleTooltip>
        ))}
      </aside>
    );
  }

  return (
    <aside
      aria-label="Project panel"
      style={{ width }}
      className="relative my-1.5 mr-1.5 flex shrink-0 flex-col"
    >
      {/* The island is an inner box so its clipping doesn't cut off the resize handle,
          which straddles the island's left edge. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize changes panel"
        onPointerDown={startResize}
        onDoubleClick={() => setGitPanel({ width: GIT_PANEL_DEFAULT_WIDTH })}
        className="group absolute inset-y-0 -left-1 z-20 flex w-2 cursor-col-resize justify-center"
      >
        <span
          className={cn(
            'h-full w-px transition-colors',
            resizing ? 'bg-primary' : 'bg-transparent group-hover:bg-primary/60',
          )}
        />
      </div>

      <div className="chrome-island flex min-h-0 flex-1 flex-col">
        <PanelTabs
          tabs={tabs}
          trailing={
            <PanelIconButton
              label={toggleLabel ? `Hide the panel (${toggleLabel})` : 'Hide the panel'}
              onClick={() => setGitPanel({ collapsed: true })}
            >
              <AnglesRight className="h-3 w-3" />
            </PanelIconButton>
          }
        />
      </div>
    </aside>
  );
}
