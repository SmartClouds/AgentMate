import type { GitChangeEntry, Project } from '@runova/core';
import type { WorkspaceGitState } from '@shared/apiTypes';
import { isImagePath } from '@shared/imageFiles';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  type DiffLineAction,
  MonacoDiffEditor,
  type MonacoDiffEditorHandle,
} from '@/components/editor/MonacoDiffEditor';
import {
  ArrowDown,
  ArrowUp,
  File,
  FileCode,
  Minus,
  Pin,
  Plus,
  Save,
  Sparkles,
  Spinner,
  SplitView,
  Undo,
} from '@/components/icons';
import { Chip, EmptyState } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { splitGitPath } from '@/lib/git';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { DIFF_CHANGE_EVENT } from '@/lib/workspace/commands';
import { useShortcutLabel } from '@/stores/shortcutStore';
import { useWorkspaceStore, type WorkspaceDiffTab } from '@/stores/workspaceStore';
import { ImageDiffView } from './ImageDiffView';
import { HAIRLINE_BELOW } from './PanelTabs';
import { StatusLetter } from './StatusLetter';
import { openChangedFile, useAiResolving, useGitActions } from './useWorkspaceGit';

function ToolbarButton({
  label,
  onClick,
  active,
  children,
}: {
  label: string;
  onClick: () => void;
  active?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <SimpleTooltip label={label}>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        aria-label={label}
        aria-pressed={active}
        onClick={onClick}
        // Narrower than a text pill, since most of these hold only an icon.
        className={cn(
          'min-w-6 px-1 font-normal text-muted-foreground hover:bg-foreground/[0.06]',
          active && 'bg-primary/12 text-primary hover:bg-primary/20 hover:text-primary',
        )}
      >
        {children}
      </Button>
    </SimpleTooltip>
  );
}

function entryFor(
  state: WorkspaceGitState | undefined,
  tab: WorkspaceDiffTab,
): GitChangeEntry | null {
  if (!state) return null;
  const list =
    tab.side === 'staged'
      ? state.staged
      : tab.side === 'unstaged'
        ? state.unstaged
        : tab.side === 'untracked'
          ? state.untracked
          : state.conflicts;
  return list.find((entry) => entry.path === tab.path) ?? null;
}

const SIDE_LABEL: Record<WorkspaceDiffTab['side'], string> = {
  staged: 'Staged',
  unstaged: 'Working tree',
  untracked: 'New file',
  conflict: 'Conflict',
};

/** A file's changes, shown in a pane next to the terminals. */
export default function DiffTab({
  project,
  tab,
  focused,
}: {
  project: Project;
  tab: WorkspaceDiffTab;
  /** In the focused pane, so the next and previous change shortcuts drive this diff. */
  focused: boolean;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const editorRef = useRef<MonacoDiffEditorHandle>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const nextChangeLabel = useShortcutLabel('workspace.nextChange');
  const prevChangeLabel = useShortcutLabel('workspace.prevChange');

  useEffect(() => {
    if (!focused) return;
    const onChange = (event: Event): void => {
      const direction = (event as CustomEvent<'next' | 'previous'>).detail;
      editorRef.current?.goToChange(direction);
    };
    window.addEventListener(DIFF_CHANGE_EVENT, onChange);
    return () => window.removeEventListener(DIFF_CHANGE_EVENT, onChange);
  }, [focused]);
  const sideBySide = useWorkspaceStore((s) => s.gitPanel.diffSideBySide);
  const ignoreWhitespace = useWorkspaceStore((s) => s.gitPanel.diffIgnoreWhitespace);
  const setGitPanel = useWorkspaceStore((s) => s.setGitPanel);
  const openDiff = useWorkspaceStore((s) => s.openDiff);
  const actions = useGitActions(project.id);
  const { data: state } = useQuery<WorkspaceGitState>({
    queryKey: queryKeys.gitWorkspaceState(project.id),
    queryFn: () => window.runova.git.workspaceState(project.id),
    staleTime: Number.POSITIVE_INFINITY,
    meta: { silentLoading: true },
  });
  const diff = useQuery({
    // A past commit's diff never changes; a working tree diff follows the live state.
    queryKey: tab.commit
      ? queryKeys.gitFileDiff(project.id, `commit:${tab.commit}`, tab.path)
      : queryKeys.gitFileDiff(project.id, tab.side, tab.path),
    queryFn: () =>
      tab.commit
        ? window.runova.git.commitFileDiff(project.id, tab.commit, tab.path, tab.origPath)
        : window.runova.git.fileDiff(project.id, tab.path, tab.side, tab.origPath),
    staleTime: tab.commit ? Number.POSITIVE_INFINITY : undefined,
    meta: { silentLoading: true },
    // While a refreshed diff loads, keep showing the old one, but never another file's.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[3] === tab.path ? previous : undefined,
  });

  // A commit's file has nothing to stage or discard, so it gets no working tree entry.
  const entry = tab.commit ? null : entryFor(state, tab);
  const stagedToo = state?.staged.some((e) => e.path === tab.path) ?? false;
  const unstagedToo = state?.unstaged.some((e) => e.path === tab.path) ?? false;
  const { dir, name } = splitGitPath(tab.path);

  const gone = !tab.commit && state !== undefined && entry === null;
  const aiResolving = useAiResolving(project.id, tab.path) && tab.side === 'conflict';

  // The right side of a working tree diff is the file on disk, so it can be edited and saved
  // right here. Staged content and past commits aren't files, so those stay read-only.
  const editable =
    !!entry &&
    tab.side !== 'staged' &&
    entry.status !== 'D' &&
    !!diff.data &&
    !diff.data.binary &&
    !diff.data.tooLarge;
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const dirty = editable && draft !== null && draft !== diff.data?.modified;

  // Stage, unstage or discard single blocks and selected lines, the way VS Code does. A past
  // commit and a conflict only take whole-file actions.
  const originalId = diff.data?.originalId;
  const modifiedId = diff.data?.modifiedId;
  const lineSide = tab.side === 'conflict' ? null : tab.side;
  let lineActions: DiffLineAction[] | undefined;
  if (entry && !tab.commit && lineSide && originalId && modifiedId) {
    const run =
      (action: 'stage' | 'unstage' | 'discard') =>
      (ranges: { original: [number, number][]; modified: [number, number][] }): void =>
        void actions.applyLines({
          path: tab.path,
          origPath: tab.origPath,
          side: lineSide,
          action,
          ranges,
          originalId,
          modifiedId,
        });
    lineActions =
      lineSide === 'staged'
        ? [
            {
              id: 'unstage',
              label: 'Unstage',
              menuLabel: 'Unstage Selected Lines',
              icon: Minus,
              run: run('unstage'),
            },
          ]
        : [
            {
              id: 'discard',
              label: 'Discard',
              menuLabel: 'Discard Selected Lines',
              icon: Undo,
              tone: 'danger',
              run: run('discard'),
            },
            {
              id: 'stage',
              label: 'Stage',
              menuLabel: 'Stage Selected Lines',
              icon: Plus,
              run: run('stage'),
            },
          ];
  }

  // A draft belongs to one file; switching what this tab shows starts clean.
  // biome-ignore lint/correctness/useExhaustiveDependencies: resets on the tab's identity only
  useEffect(() => {
    setDraft(null);
  }, [tab.path, tab.side, tab.commit]);

  function handleEdit(value: string): void {
    setDraft(value);
    // Editing a preview tab keeps it, so the edit isn't lost to the next file clicked.
    if (tab.preview) openDiff(project.id, tab, { pin: true });
  }

  async function save(): Promise<void> {
    if (!dirty || draft === null || saving) return;
    setSaving(true);
    try {
      await window.runova.git.writeWorkingFile(project.id, tab.path, draft);
      queryClient.setQueryData(queryKeys.gitFileDiff(project.id, tab.side, tab.path), {
        ...diff.data,
        modified: draft,
      });
      setDraft(null);
      void queryClient.invalidateQueries({
        queryKey: queryKeys.gitFileDiff(project.id, tab.side, tab.path),
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.gitWorkspaceState(project.id) });
    } catch (error) {
      toast.error('Could not save the file', {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setSaving(false);
    }
  }

  // Ctrl/Cmd+S saves while focus is anywhere in this tab.
  // biome-ignore lint/correctness/useExhaustiveDependencies: save reads the latest draft
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.code === 'KeyS') {
        event.preventDefault();
        event.stopPropagation();
        void save();
      }
    };
    el.addEventListener('keydown', onKeyDown, true);
    return () => el.removeEventListener('keydown', onKeyDown, true);
  }, [draft, diff.data, saving, editable]);

  return (
    // A container, so the toolbar can drop its extras when the pane is narrow.
    <div ref={containerRef} className="@container flex h-full min-h-0 flex-col">
      <div className={cn('flex h-9 shrink-0 items-center gap-2 pl-3 pr-2', HAIRLINE_BELOW)}>
        <File className="h-3 w-3 shrink-0 text-muted-foreground" />
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="min-w-[3rem] shrink truncate text-xs font-medium">{name}</span>
          {dir ? (
            <span className="hidden min-w-0 truncate text-[11px] text-muted-foreground [direction:rtl] @2xl:inline">
              <bdi>{dir.replace(/\/$/, '')}</bdi>
            </span>
          ) : null}
          <Chip
            tone={tab.side === 'conflict' ? 'destructive' : 'neutral'}
            className="hidden h-[18px] px-2 text-[10px] @lg:inline-flex"
          >
            {tab.commit ? `Commit ${tab.commit.slice(0, 7)}` : SIDE_LABEL[tab.side]}
          </Chip>
          {entry ? <StatusLetter status={entry.status} className="self-center" /> : null}
          {entry && !entry.binary && (entry.additions || entry.deletions) ? (
            <span className="hidden shrink-0 font-mono text-[10px] tabular-nums @md:inline">
              <span className="text-success">+{entry.additions ?? 0}</span>{' '}
              <span className="text-destructive">−{entry.deletions ?? 0}</span>
            </span>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          {dirty ? (
            <span className="mr-1 flex shrink-0 items-center gap-1 text-[11px] text-warning">
              <span className="h-1.5 w-1.5 rounded-full bg-warning" />
              <span className="hidden @md:inline">Unsaved</span>
            </span>
          ) : null}
          {editable ? (
            <Button
              type="button"
              size="xs"
              onClick={() => void save()}
              disabled={!dirty || saving}
              className="mr-1"
            >
              {saving ? <Spinner className="animate-spin" /> : <Save />}
              Save
            </Button>
          ) : null}
          <ToolbarButton
            label={prevChangeLabel ? `Previous change (${prevChangeLabel})` : 'Previous change'}
            onClick={() => editorRef.current?.goToChange('previous')}
          >
            <ArrowUp className="h-2.5 w-2.5" />
          </ToolbarButton>
          <ToolbarButton
            label={nextChangeLabel ? `Next change (${nextChangeLabel})` : 'Next change'}
            onClick={() => editorRef.current?.goToChange('next')}
          >
            <ArrowDown className="h-2.5 w-2.5" />
          </ToolbarButton>
          <span className="hidden items-center gap-0.5 @lg:flex">
            <span className="mx-1 h-4 w-px bg-foreground/10" />
            <ToolbarButton
              label={sideBySide ? 'Show inline' : 'Show side by side'}
              active={sideBySide}
              onClick={() => setGitPanel({ diffSideBySide: !sideBySide })}
            >
              <SplitView className="h-3 w-3" />
            </ToolbarButton>
            <ToolbarButton
              label={ignoreWhitespace ? 'Show whitespace changes' : 'Hide whitespace changes'}
              active={ignoreWhitespace}
              onClick={() => setGitPanel({ diffIgnoreWhitespace: !ignoreWhitespace })}
            >
              <span className="font-mono text-[10px] font-semibold">¶</span>
            </ToolbarButton>
            {tab.preview ? (
              <ToolbarButton
                label="Keep this tab open"
                onClick={() => openDiff(project.id, tab, { pin: true })}
              >
                <Pin className="h-2.5 w-2.5" />
              </ToolbarButton>
            ) : null}
            {entry && tab.side !== 'staged' && entry.status !== 'D' ? (
              <ToolbarButton
                label="Open file"
                onClick={() =>
                  openChangedFile(project, state?.projectPrefix ?? '', tab.path, entry.binary)
                }
              >
                <FileCode className="h-2.5 w-2.5" />
              </ToolbarButton>
            ) : null}
          </span>
          {entry && (tab.side === 'unstaged' || tab.side === 'untracked') ? (
            <>
              <span className="mx-1 h-4 w-px bg-foreground/10" />
              <ToolbarButton
                label={tab.side === 'untracked' ? 'Delete file' : 'Discard changes'}
                onClick={() =>
                  void actions.discard([tab.path], tab.side as 'unstaged' | 'untracked')
                }
              >
                <Undo className="h-2.5 w-2.5" />
              </ToolbarButton>
            </>
          ) : null}
          {entry && tab.side === 'conflict' ? (
            <SimpleTooltip
              label={
                aiResolving
                  ? 'Stop the AI and put the file back'
                  : 'Have your AI CLI merge both sides. Nothing is staged.'
              }
            >
              <Button
                type="button"
                variant="soft"
                size="xs"
                onClick={() => void actions.resolveWithAi(tab.path)}
                aria-label={aiResolving ? 'Stop resolving with AI' : 'Resolve with AI'}
                className="ml-1 hover:text-primary"
              >
                {aiResolving ? (
                  <Spinner className="animate-spin text-primary motion-reduce:animate-none" />
                ) : (
                  <Sparkles />
                )}
                {/* A narrow pane keeps just the icon. */}
                <span className="hidden @md:inline">
                  {aiResolving ? 'Stop' : 'Resolve with AI'}
                </span>
              </Button>
            </SimpleTooltip>
          ) : null}
          {entry ? (
            tab.side === 'staged' ? (
              <Button
                type="button"
                variant="soft"
                size="xs"
                onClick={() => void actions.unstage([tab.path])}
                className="ml-1"
              >
                <Minus /> Unstage
              </Button>
            ) : (
              <Button
                type="button"
                size="xs"
                onClick={() => void actions.stage([tab.path])}
                // Staging while the AI is still writing the file would take a half edit.
                disabled={aiResolving}
                className="ml-1"
              >
                <Plus /> {tab.side === 'conflict' ? 'Mark resolved' : 'Stage'}
              </Button>
            )
          ) : null}
        </div>
      </div>

      {gone ? (
        <div
          className={cn(
            'flex shrink-0 items-center gap-2 bg-foreground/[0.03] px-3 py-1.5 text-[11px] text-muted-foreground',
            HAIRLINE_BELOW,
          )}
        >
          <span className="flex-1">
            {tab.side === 'staged'
              ? 'Nothing about this file is staged anymore.'
              : 'This file has no unstaged changes anymore.'}
          </span>
          {tab.side !== 'staged' && stagedToo ? (
            <button
              type="button"
              onClick={() => openDiff(project.id, { path: tab.path, side: 'staged' })}
              className="font-medium text-primary hover:underline"
            >
              Show staged
            </button>
          ) : null}
          {tab.side === 'staged' && unstagedToo ? (
            <button
              type="button"
              onClick={() => openDiff(project.id, { path: tab.path, side: 'unstaged' })}
              className="font-medium text-primary hover:underline"
            >
              Show working tree
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="relative min-h-0 flex-1">
        {!diff.data ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 10 }, (_, i) => (
              <Skeleton
                key={i}
                className="h-3.5 rounded-full"
                style={{ width: `${40 + ((i * 37) % 55)}%` }}
              />
            ))}
          </div>
        ) : (diff.data.binary || diff.data.tooLarge) && isImagePath(tab.path) ? (
          <ImageDiffView project={project} tab={tab} />
        ) : diff.data.binary || diff.data.tooLarge ? (
          <EmptyState
            size="sm"
            icon={File}
            title={diff.data.binary ? 'Binary file' : 'This file is too large to diff here'}
            description={
              <span className="block text-xs">Open it in your editor to see what changed.</span>
            }
            className="h-full"
          />
        ) : (
          <MonacoDiffEditor
            ref={editorRef}
            path={tab.path}
            original={diff.data.original}
            modified={dirty && draft !== null ? draft : diff.data.modified}
            sideBySide={sideBySide}
            ignoreWhitespace={ignoreWhitespace}
            editable={editable}
            onModifiedChange={handleEdit}
            lineActions={lineActions}
            lineActionsBlocked={dirty ? 'Save your edits first' : undefined}
          />
        )}
      </div>
    </div>
  );
}
