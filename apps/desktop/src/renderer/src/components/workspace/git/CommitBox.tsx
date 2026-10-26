import type { WorkspaceGitState } from '@shared/apiTypes';
import { useLayoutEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { create } from 'zustand';
import {
  Archive,
  Check,
  ChevronDown,
  CloudUpload,
  Plus,
  Sparkles,
  Spinner,
} from '@/components/icons';
import { Notice } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { sanitizeCommitMessage } from '@/lib/git';
import { cn } from '@/lib/utils';
import { commandForEvent, useShortcutLabel, useShortcutStore } from '@/stores/shortcutStore';
import { HAIRLINE_BELOW } from './PanelTabs';
import type { GitActions } from './useWorkspaceGit';

/**
 * Half-written commit messages and in-flight AI requests, kept per project while the app
 * runs. Living outside the component means switching panel tabs or navigating away and
 * back doesn't lose track of a generation request that's still running.
 */
const useCommitDrafts = create<{
  drafts: Record<string, string>;
  generating: Record<string, string | null>;
}>(() => ({ drafts: {}, generating: {} }));

/** A two-line commit option: what it does on top, what it will touch underneath. */
function CommitMenuItem({
  icon,
  title,
  description,
  shortcut,
  disabled,
  onSelect,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  shortcut: string | null;
  disabled?: boolean;
  onSelect: () => void;
}): React.JSX.Element {
  return (
    <DropdownMenuItem disabled={disabled} onSelect={onSelect} className="group items-start py-2">
      <span className="mt-px flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-foreground/[0.05] text-muted-foreground transition-colors group-focus:bg-foreground/[0.08] group-focus:text-foreground">
        {icon}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        {/* A long title wraps inside the menu rather than running into its border. The shortcut
            wraps under the title. */}
        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="text-[13px] font-medium leading-5">{title}</span>
          {shortcut ? (
            <kbd className="ml-auto shrink-0 font-sans text-[11px] leading-5 tracking-wide text-muted-foreground">
              {shortcut}
            </kbd>
          ) : null}
        </span>
        <span className="text-[11px] leading-snug text-muted-foreground">{description}</span>
      </span>
    </DropdownMenuItem>
  );
}

const MAX_ROWS = 8;
const LINE_HEIGHT = 20;
/** Vertical padding (pt-2.5 plus pb-1.5). The composer pill draws the edge, not the textarea. */
const CHROME_HEIGHT = 10 + 6;

/** Sizes the textarea to its text, between one and MAX_ROWS lines. */
function fitTextarea(el: HTMLTextAreaElement): void {
  // A hidden textarea (the panel is on another tab) measures as zero. Leave the height
  // alone and let the resize observer fit it once it's shown.
  if (el.offsetParent === null) return;
  el.style.height = 'auto';
  const max = MAX_ROWS * LINE_HEIGHT + CHROME_HEIGHT;
  // scrollHeight leaves out the border, but the height is set on the border box.
  const needed = el.scrollHeight + (el.offsetHeight - el.clientHeight);
  el.style.height = `${Math.min(needed, max)}px`;
  el.style.overflowY = needed > max ? 'auto' : 'hidden';
}

export interface CommitBoxProps {
  projectId: string;
  state: WorkspaceGitState;
  actions: GitActions;
  /** Shown next to the "resolve the conflicts" notice, such as a way to hand them to an agent. */
  conflictAction?: React.ReactNode;
}

export function CommitBox({
  projectId,
  state,
  actions,
  conflictAction,
}: CommitBoxProps): React.JSX.Element {
  const message = useCommitDrafts((s) => s.drafts[projectId] ?? '');
  const setMessage = (value: string): void =>
    useCommitDrafts.setState((s) => ({ drafts: { ...s.drafts, [projectId]: value } }));
  const [busy, setBusy] = useState<'commit' | 'push' | 'stash' | null>(null);
  const generating = useCommitDrafts((s) => s.generating[projectId] ?? null);
  const setGenerating = (value: string | null): void =>
    useCommitDrafts.setState((s) => ({ generating: { ...s.generating, [projectId]: value } }));
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const stagedCount = state.staged.length;
  const pendingCount = state.unstaged.length + state.untracked.length;
  const stageAllFirst = stagedCount === 0 && pendingCount > 0;
  const nothingToCommit = stagedCount === 0 && pendingCount === 0;
  const blockedByConflicts = state.conflicts.length > 0;
  const canCommit =
    message.trim().length > 0 && !nothingToCommit && !blockedByConflicts && busy === null;
  const canPush = state.hasRemote && !state.detached && state.branch !== null;
  // Stashing needs no message, but like committing it waits for conflicts and any
  // merge/rebase/cherry-pick/revert to finish first.
  const stashBlocked = blockedByConflicts || state.operation !== null;
  const canStash = !nothingToCommit && !stashBlocked && busy === null;
  // Keeping the staged changes in place needs something staged. With nothing staged, that
  // is just a stash of everything, so the item waits for a staged file.
  const canKeepStaged = canStash && stagedCount > 0;

  const commitLabel = useShortcutLabel('commit.commit');
  const pushLabel = useShortcutLabel('commit.commitAndPush');

  // Grow with the message, one to eight lines. Only a longer message scrolls, and even then
  // without a visible scrollbar squeezing the text.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the height follows the text
  useLayoutEffect(() => {
    if (textareaRef.current) fitTextarea(textareaRef.current);
  }, [message]);

  // An AI message can land while the panel is hidden, where the textarea measures as zero
  // tall, and a narrower panel re-wraps the text. Measure again whenever the width changes
  // (including going from hidden to shown). Height changes are ignored so fitting doesn't
  // trigger itself.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    let lastWidth = -1;
    const observer = new ResizeObserver(([entry]) => {
      const width = entry?.contentRect.width ?? 0;
      if (width === lastWidth) return;
      lastWidth = width;
      fitTextarea(el);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  async function commit(push: boolean): Promise<void> {
    // Pushing without a remote or branch would leave a commit behind and then fail.
    if (!canCommit || (push && !canPush)) return;
    setBusy(push ? 'push' : 'commit');
    try {
      if (stageAllFirst) {
        await actions.stage([...state.unstaged, ...state.untracked].map((entry) => entry.path));
      }
      const ok = await actions.commit(message, push);
      if (ok) setMessage('');
    } finally {
      setBusy(null);
    }
  }

  async function stash(mode: 'all' | 'keep-staged'): Promise<void> {
    if (!canStash) return;
    setBusy('stash');
    try {
      await actions.stash(mode);
    } finally {
      setBusy(null);
    }
  }

  async function generate(): Promise<void> {
    if (generating) {
      void window.runova.git.cancelSuggestCommitMessage(generating);
      setGenerating(null);
      return;
    }
    const requestId = crypto.randomUUID();
    setGenerating(requestId);
    try {
      const result = await window.runova.git.suggestCommitMessage(
        projectId,
        requestId,
        stagedCount > 0 ? 'staged' : 'all',
      );
      if (result.cancelled) return;
      if (result.ok && result.text) {
        setMessage(sanitizeCommitMessage(result.text));
        textareaRef.current?.focus();
      } else {
        toast.error('Could not write a commit message', { description: result.error });
      }
    } finally {
      // Only clears the flag if this is still the request that set it: a cancel followed
      // by a fresh generate() shouldn't have the stale request's finally block wipe it out.
      useCommitDrafts.setState((s) =>
        s.generating[projectId] === requestId
          ? { generating: { ...s.generating, [projectId]: null } }
          : s,
      );
    }
  }

  const primaryLabel = stageAllFirst ? 'Stage all & commit' : 'Commit';

  const changesLabel = `${pendingCount} ${pendingCount === 1 ? 'change' : 'changes'}`;
  const stagedLabel = `${stagedCount} staged ${stagedCount === 1 ? 'file' : 'files'}`;
  const totalCount = stagedCount + pendingCount;
  const totalLabel = `${totalCount} ${totalCount === 1 ? 'change' : 'changes'}`;
  const stashWhyBlocked = blockedByConflicts
    ? 'Resolve the conflicts below first'
    : state.operation
      ? `Finish or abort the ${state.operation} first`
      : null;
  const stashAllDescription =
    stashWhyBlocked ??
    (nothingToCommit
      ? 'There are no changes to stash'
      : `Stash all ${totalLabel}, untracked files included`);
  const keepStagedDescription =
    stashWhyBlocked ??
    (stagedCount === 0
      ? 'Stage something first, or use Stash All'
      : `Stash everything but keep ${stagedLabel} in place`);
  // Why Commit can't run, or null when there is no such reason to show.
  const commitWhyBlocked = blockedByConflicts
    ? 'Resolve the conflicts below first'
    : message.trim().length === 0
      ? 'Write a commit message first'
      : null;
  const commitDescription =
    commitWhyBlocked ??
    (stageAllFirst
      ? `Stage all ${changesLabel}, then commit locally`
      : `Commit ${stagedLabel} locally`);
  const pushTarget = state.upstream ? `push to ${state.upstream}` : `publish ${state.branch}`;
  const pushDescription = !state.hasRemote
    ? 'Add a remote to push this repository'
    : !canPush
      ? 'Check out a branch to push'
      : (commitWhyBlocked ??
        (stageAllFirst
          ? `Stage all ${changesLabel}, commit, then ${pushTarget}`
          : `Commit ${stagedLabel}, then ${pushTarget}`));

  return (
    <div className={cn('@container/commit space-y-2 px-2.5 pb-2.5 pt-2', HAIRLINE_BELOW)}>
      {/* The message and its actions are one composed field, like the commit composer on the
          Project detail Git tab: write at the top, suggest and commit from the bottom row. */}
      <div className="search-pill flex flex-col rounded-[1.25rem] transition-colors">
        {/* Only this half sweeps, so the light never passes over the Stop button. It is the
            sweep alone: a filled shimmer here tinted the top half differently from the row below,
            splitting the pill into two backgrounds. A textarea can't draw the sweep itself. */}
        <div className={cn('rounded-t-[1.25rem]', generating && 'shimmer-sweep')}>
          <textarea
            ref={textareaRef}
            value={message}
            rows={1}
            spellCheck
            disabled={busy !== null}
            aria-label="Commit message"
            placeholder={commitLabel ? `Message (${commitLabel} to commit)` : 'Commit message'}
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={(event) => {
              const id = commandForEvent(
                event.nativeEvent,
                useShortcutStore.getState().overrides,
                true,
                'commit',
              );
              if (!id) return;
              // Stops the Workspace shortcuts from also acting on the same keys.
              event.preventDefault();
              void commit(id === 'commit.commitAndPush');
            }}
            style={{ lineHeight: `${LINE_HEIGHT}px`, minHeight: LINE_HEIGHT + CHROME_HEIGHT }}
            className="block w-full resize-none overflow-hidden rounded-t-[1.25rem] bg-transparent px-3.5 pb-1.5 pt-2.5 text-[13px] outline-none placeholder:text-muted-foreground/70 [scrollbar-width:none] disabled:opacity-60 [&::-webkit-scrollbar]:hidden"
          />
        </div>
        <div className="flex items-center gap-1.5 p-1.5 pt-0">
          <SimpleTooltip
            label={generating ? 'Stop writing, click to cancel' : 'Write a message with AI'}
          >
            <Button
              type="button"
              variant={generating ? 'danger' : 'soft'}
              size="xs"
              aria-label={
                generating ? 'Stop writing the commit message' : 'Write a commit message with AI'
              }
              onClick={() => void generate()}
              disabled={nothingToCommit && !generating}
              className="shrink-0"
            >
              {generating ? (
                <Spinner className="animate-spin motion-reduce:animate-none" />
              ) : (
                <Sparkles />
              )}
              {/* A narrow panel keeps just the icon, so the commit button keeps its label. */}
              <span className="hidden @[17rem]/commit:inline">
                {generating ? 'Writing…' : 'Suggest'}
              </span>
            </Button>
          </SimpleTooltip>

          {/* One split pill: the commit itself, then a chevron for the other ways to commit. */}
          <div className="ml-auto flex min-w-0">
            <Button
              size="xs"
              onClick={() => void commit(false)}
              disabled={!canCommit}
              className="min-w-0 rounded-r-none pl-2.5 pr-2"
            >
              {busy === 'commit' ? (
                <Spinner className="animate-spin motion-reduce:animate-none" />
              ) : stageAllFirst ? (
                <Plus />
              ) : (
                <Check />
              )}
              <span className="truncate">{primaryLabel}</span>
              {stagedCount > 0 ? (
                <span className="rounded-full bg-primary-foreground/15 px-1.5 text-[10px] tabular-nums">
                  {stagedCount}
                </span>
              ) : null}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="xs"
                  aria-label="More commit options"
                  // Stashing needs no message, so the menu stays open for that alone.
                  disabled={!canCommit && !canStash}
                  // The divider is an inset shadow: the app's global border colour would repaint
                  // a border here.
                  className="w-6 rounded-l-none px-0 shadow-[inset_1px_0_0_hsl(var(--primary-foreground)/0.25)]"
                >
                  <ChevronDown />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" collisionPadding={8} className="w-[19rem]">
                <CommitMenuItem
                  icon={<Check className="h-3.5 w-3.5" />}
                  title="Commit"
                  description={commitDescription}
                  shortcut={commitLabel}
                  disabled={!canCommit}
                  onSelect={() => void commit(false)}
                />
                <CommitMenuItem
                  icon={<CloudUpload className="h-3.5 w-3.5" />}
                  title="Commit & push"
                  description={pushDescription}
                  shortcut={pushLabel}
                  disabled={!canCommit || !canPush}
                  onSelect={() => void commit(true)}
                />
                <DropdownMenuSeparator />
                <CommitMenuItem
                  icon={<Archive className="h-3.5 w-3.5" />}
                  title="Stash All (--include-untracked)"
                  description={stashAllDescription}
                  shortcut={null}
                  disabled={!canStash}
                  onSelect={() => void stash('all')}
                />
                <CommitMenuItem
                  icon={<Archive className="h-3.5 w-3.5" />}
                  title="Stash All and Keep Staged (--keep-index)"
                  description={keepStagedDescription}
                  shortcut={null}
                  disabled={!canKeepStaged}
                  onSelect={() => void stash('keep-staged')}
                />
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>

      {blockedByConflicts ? (
        <Notice
          tone="destructive"
          size="sm"
          className="items-center text-[11px] leading-snug"
          action={conflictAction}
        >
          Resolve the conflicts below before committing.
        </Notice>
      ) : null}
      {busy === 'push' ? (
        <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Spinner className="h-2.5 w-2.5 animate-spin motion-reduce:animate-none" /> Committing and
          pushing…
        </p>
      ) : null}
      {busy === 'stash' ? (
        <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Spinner className="h-2.5 w-2.5 animate-spin motion-reduce:animate-none" /> Stashing…
        </p>
      ) : null}
    </div>
  );
}
