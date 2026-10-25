import type { AgentHistorySession } from '@agentmat/core';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import type { SshAgentHistoryRun, SshSavedServer } from '@shared/apiTypes';
import { sshErrorCode, sshErrorMessage } from '@shared/sshErrors';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  BackgroundToggle,
  HistoryDayGroups,
  HistorySkeleton,
  HistoryToolbar,
} from '@/components/agentHistory/AgentHistoryList';
import {
  backgroundCount,
  countByProvider,
  displayPath,
  type FolderGroup,
  filterSessions,
  groupByFolder,
  type HistoryProvider,
  type ProviderFilter,
} from '@/components/agentHistory/historyFilters';
import {
  ChevronRight,
  Folder,
  FolderOpen,
  History,
  Lock,
  LockOpen,
  RefreshCw,
  Robot,
  Server,
  Spinner,
  Trash2,
  TriangleAlert,
  X,
} from '@/components/icons';
import { SshAgentHistoryDialog } from '@/components/terminal/SshAgentHistoryDialog';
import { serverContinuation } from '@/components/terminal/useTerminalContinuation';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { TruncatedText } from '@/components/ui/truncated-text';
import { queryKeys } from '@/lib/queryKeys';
import { withHostKeyTrust } from '@/lib/ssh/hostKeyTrust';
import { timeAgo } from '@/lib/time';
import { cn } from '@/lib/utils';
import { openRemoteResume } from '@/lib/workspace/launch';
import { confirmDialog } from '@/stores/confirmStore';
import {
  isSshAgentWaitingOnUser,
  type SshAgentSessionState,
  useSshAgentSession,
  useSshAgentStore,
} from '@/stores/sshAgentStore';
import { useTerminalStore } from '@/stores/terminalStore';

/**
 * A side sheet with every supported CLI conversation stored on a saved server, by the
 * folder it ran in. Resuming one opens an SSH tab in the terminal drawer that `cd`s there and
 * runs the CLI's resume command. The server is asked only on open and on Refresh: each ask is
 * an SSH round trip, so there is no polling.
 *
 * Above them sit the Ask AI tasks run in this server's SSH tabs. Those live in this app, not on
 * the server, so they show even while the server can't be reached.
 */

/** The command each agent runs as on the server. */
const CLI_COMMAND: Record<HistoryProvider, string> = {
  'claude-code': 'claude',
  openclaude: 'openclaude',
  codex: 'codex',
  'gemini-cli': 'gemini',
  'qwen-cli': 'qwen',
  'cursor-cli': 'cursor-agent',
  'continue-cli': 'cn',
  'grok-cli': 'grok',
  'cline-cli': 'cline',
  opencode: 'opencode',
  'freebuff-cli': 'freebuff',
};

const UNKNOWN_FOLDER = 'Unknown folder';

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * A path split so its last segment can stay visible while the rest truncates:
 * `~/code/app` becomes `~/code` and `/app`, so a squeezed header reads `~/co…/app`.
 */
function splitPath(path: string): { parent: string; name: string } {
  const cut = path.lastIndexOf('/');
  if (cut <= 0 || cut === path.length - 1) return { parent: '', name: path };
  return { parent: path.slice(0, cut), name: path.slice(cut) };
}

/** The drawer tabs already running one of this server's conversations, by conversation id. */
function useOpenConversations(serverId: string): Map<string, string> {
  const sessions = useTerminalStore((s) => s.sessions);
  return useMemo(() => {
    const open = new Map<string, string>();
    for (const tab of sessions) {
      if (tab.kind === 'ssh' && tab.sshServerId === serverId && tab.conversationId) {
        if (!open.has(tab.conversationId)) open.set(tab.conversationId, tab.id);
      }
    }
    return open;
  }, [sessions, serverId]);
}

export interface SshHistoryPanelProps {
  /** The server whose history shows. Null closes the panel. */
  server: SshSavedServer | null;
  onOpenChange: (open: boolean) => void;
  /** Asks for the vault passkey after the vault got locked. The caller refetches once unlocked. */
  onRequestUnlock: () => void;
}

export function SshHistoryPanel({
  server,
  onOpenChange,
  onRequestUnlock,
}: SshHistoryPanelProps): React.JSX.Element {
  // The last server stays rendered while the sheet slides out, so it never empties mid-animation.
  const [shown, setShown] = useState(server);
  if (server && server !== shown) setShown(server);
  const current = server ?? shown;
  // Each opening starts fresh (no leftover search or folds), so the sheet remounts per opening.
  const open = server !== null;
  const [wasOpen, setWasOpen] = useState(open);
  const [openings, setOpenings] = useState(0);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setOpenings((n) => n + 1);
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      {current ? (
        <HistorySheet
          key={`${current.id}:${openings}`}
          server={current}
          open={open}
          onClose={() => onOpenChange(false)}
          onRequestUnlock={onRequestUnlock}
        />
      ) : null}
    </DialogPrimitive.Root>
  );
}

function HistorySheet({
  server,
  open,
  onClose,
  onRequestUnlock,
}: {
  server: SshSavedServer;
  open: boolean;
  onClose: () => void;
  onRequestUnlock: () => void;
}): React.JSX.Element {
  const contentRef = useRef<HTMLDivElement>(null);
  // After a resume, focus belongs to the new terminal tab, not the row button that opened us.
  const resumedRef = useRef(false);
  const [query, setQuery] = useState('');
  const [provider, setProvider] = useState<ProviderFilter>('all');
  const [showBackground, setShowBackground] = useState(false);
  // What the user folded or unfolded, kept apart for browsing and for a search, so clearing a
  // search brings back the folders as they were.
  const [browseFolds, setBrowseFolds] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [searchFolds, setSearchFolds] = useState<ReadonlyMap<string, boolean>>(new Map());
  const openIds = useOpenConversations(server.id);

  const history = useQuery({
    queryKey: queryKeys.sshConversations(server.id),
    queryFn: () => withHostKeyTrust(server.id, () => window.agentmat.ssh.conversations(server.id)),
    enabled: open,
    staleTime: 60_000,
    retry: false,
    refetchOnWindowFocus: false,
    meta: { silentLoading: true },
  });
  const { data, isPending, isError, isFetching, error, refetch } = history;

  // Ask AI tasks are kept by this app, so reading them is cheap and never waits on the server.
  const askAi = useQuery({
    queryKey: queryKeys.sshServerAgentHistory(server.id),
    queryFn: () => window.agentmat.sshAgent.serverHistory(server.id),
    enabled: open,
    meta: { silentLoading: true },
  });
  const refetchAskAi = askAi.refetch;
  // Every progress event from any tab may be a task on this server moving on.
  const agentProgress = useSshAgentStore((s) => s.sessions);
  // Opening already reads them once, so only later progress asks again.
  const seenProgress = useRef(agentProgress);
  useEffect(() => {
    if (!open || seenProgress.current === agentProgress) return;
    seenProgress.current = agentProgress;
    void refetchAskAi();
  }, [open, agentProgress, refetchAskAi]);
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  const openRun = askAi.data?.find((run) => run.id === openRunId) ?? null;
  const openRunLive = useSshAgentSession(openRun?.sessionId ?? null);

  const sessions = data?.sessions ?? [];
  const home = data?.home ?? null;
  const searching = query.trim() !== '';
  const providers = new Set(sessions.map((s) => s.provider));
  const counts = countByProvider(sessions);
  const browsable = filterSessions(sessions, { query: '', provider: 'all', showBackground });
  const visible = filterSessions(sessions, { query, provider, showBackground });
  const groups = groupByFolder(visible);
  const hiddenCount = backgroundCount(sessions, provider);
  const needle = query.trim().toLowerCase();
  // They are not one of the CLIs the filter picks, so a CLI filter hides them.
  const askAiRuns =
    provider === 'all'
      ? (askAi.data ?? []).filter((run) => !needle || run.prompt.toLowerCase().includes(needle))
      : [];
  const hasAskAiRuns = (askAi.data?.length ?? 0) > 0;
  // The probe runs in a login shell, so a CLI on a PATH set only in .bashrc reads as missing
  // while the interactive resume shell would still find it. Warn, never block.
  const CLI_PRESENT: Record<HistoryProvider, (clis: NonNullable<typeof data>['clis']) => boolean> =
    {
      'claude-code': (clis) => clis.claude,
      openclaude: () => true,
      codex: (clis) => clis.codex,
      'gemini-cli': (clis) => clis.gemini,
      'qwen-cli': (clis) => clis.qwen,
      'cursor-cli': (clis) => clis.cursor,
      'continue-cli': (clis) => clis.continue,
      'grok-cli': (clis) => clis.grok,
      'cline-cli': (clis) => clis.cline,
      opencode: (clis) => clis.opencode,
      'freebuff-cli': (clis) => clis.freebuff,
    };
  const missingClis = data ? [...providers].filter((p) => !CLI_PRESENT[p](data.clis)) : [];
  const summary =
    data && sessions.length > 0
      ? [
          plural(browsable.length, 'conversation'),
          plural(groupByFolder(browsable).length, 'folder'),
        ].join(' · ')
      : null;
  const askAiSummary = hasAskAiRuns ? plural(askAi.data?.length ?? 0, 'Ask AI task') : null;

  function changeQuery(next: string): void {
    setQuery(next);
    setSearchFolds(new Map());
  }

  function isExpanded(key: string, index: number): boolean {
    return searching ? (searchFolds.get(key) ?? true) : (browseFolds.get(key) ?? index === 0);
  }

  function toggle(key: string, index: number): void {
    const next = !isExpanded(key, index);
    const update = (folds: ReadonlyMap<string, boolean>) => new Map(folds).set(key, next);
    if (searching) setSearchFolds(update);
    else setBrowseFolds(update);
  }

  async function clearAskAi(): Promise<void> {
    const agreed = await confirmDialog({
      title: `Clear the AI task history of ${server.nickname}?`,
      description:
        'Every finished Ask AI task on this server is removed, here and from the saved history. A task still running stays.',
      confirmLabel: 'Clear',
      variant: 'destructive',
    });
    if (!agreed) return;
    try {
      await window.agentmat.sshAgent.clearServerHistory(server.id);
      void refetchAskAi();
    } catch {
      toast.error('Could not clear the AI task history.');
    }
  }

  // Picking a task back up happens in a terminal tab on the server, so this sheet steps aside.
  const continuation = serverContinuation(server, () => {
    setOpenRunId(null);
    resumedRef.current = true;
    onClose();
  });

  function resume(session: AgentHistorySession): void {
    const wasOpen = openIds.has(session.id);
    const tabId = openRemoteResume(server, session);
    if (!tabId) return;
    if (!wasOpen) toast.success('Resuming in a new SSH tab');
    resumedRef.current = true;
    onClose();
  }

  const showToolbar = isPending || sessions.length > 0;
  const vaultLocked = isError && sshErrorCode(error) === 'vault-locked';

  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/30 backdrop-blur-[2px] data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 motion-reduce:animate-none" />
      <DialogPrimitive.Content
        ref={contentRef}
        onOpenAutoFocus={(event) => {
          const search = contentRef.current?.querySelector<HTMLInputElement>(
            'input[aria-label="Search conversations"]',
          );
          if (!search) return;
          event.preventDefault();
          search.focus();
        }}
        onCloseAutoFocus={(event) => {
          if (!resumedRef.current) return;
          event.preventDefault();
          resumedRef.current = false;
        }}
        className={cn(
          // z-50 like every dialog, so the host key prompt a connect can raise opens above it.
          'fixed inset-y-0 right-0 z-50 flex h-full w-[min(560px,100vw)] flex-col border-l border-border bg-popover text-popover-foreground shadow-2xl shadow-black/30 outline-none',
          'duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
          'data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right motion-reduce:animate-none',
        )}
      >
        <header className="flex items-start gap-3 border-b border-border/70 px-5 py-4">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
            <Server className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1 space-y-0.5 pt-0.5">
            <DialogPrimitive.Title className="truncate text-sm font-semibold leading-5">
              {server.nickname}
            </DialogPrimitive.Title>
            <DialogPrimitive.Description className="truncate text-xs text-muted-foreground">
              <span className="sr-only">Agent conversations on </span>
              <span className="font-mono">
                {server.username}@{server.host}
                {server.port === 22 ? '' : `:${server.port}`}
              </span>
              {summary ? <span className="tabular-nums"> · {summary}</span> : null}
              {askAiSummary ? <span className="tabular-nums"> · {askAiSummary}</span> : null}
            </DialogPrimitive.Description>
          </div>
          <div className="-mr-1.5 flex shrink-0 items-center gap-0.5">
            <SimpleTooltip label="Refresh">
              <Button
                size="icon"
                variant="ghost"
                aria-label="Refresh"
                aria-busy={isFetching || undefined}
                onClick={() => void refetch()}
              >
                <RefreshCw
                  className={cn(
                    'h-3.5 w-3.5',
                    isFetching && 'animate-spin motion-reduce:animate-none',
                  )}
                />
              </Button>
            </SimpleTooltip>
            <SimpleTooltip label="Close">
              <DialogPrimitive.Close asChild>
                <Button size="icon" variant="ghost" aria-label="Close">
                  <X className="h-4 w-4" />
                </Button>
              </DialogPrimitive.Close>
            </SimpleTooltip>
          </div>
        </header>

        {showToolbar ? (
          <div className="space-y-2 border-b border-border/70 px-4 py-2.5">
            <div className="rounded-lg bg-foreground/[0.04] ring-1 ring-inset ring-border/60 transition-shadow focus-within:ring-ring/60">
              <HistoryToolbar
                query={query}
                onQueryChange={changeQuery}
                provider={provider}
                onProviderChange={setProvider}
                providers={providers}
                counts={counts}
              />
            </div>
            {missingClis.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {missingClis.map((p) => (
                  <SimpleTooltip
                    key={p}
                    label={`AgentMate couldn't find the ${CLI_COMMAND[p]} command in a login shell on this server. Resume may fail if it isn't installed.`}
                  >
                    {/* Focusable so the explanation is reachable from the keyboard too. */}
                    <span
                      tabIndex={0}
                      className="inline-flex cursor-default items-center gap-1.5 rounded-full bg-warning/10 px-2 py-0.5 text-[10px] font-medium text-warning focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    >
                      <TriangleAlert className="h-2.5 w-2.5" />
                      <span className="font-mono">{CLI_COMMAND[p]}</span> not found on PATH
                    </span>
                  </SimpleTooltip>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        {/* Radix renders the viewport child as display:table, which lets a long unbroken
            prompt stretch rows past the sheet edge. Force it back to block. */}
        <ScrollArea className="min-h-0 flex-1 [&_[data-radix-scroll-area-viewport]>div]:!block">
          {askAiRuns.length > 0 ? (
            <AskAiSection
              runs={askAiRuns}
              live={agentProgress}
              onOpen={(run) => setOpenRunId(run.id)}
              onClear={() => void clearAskAi()}
            />
          ) : null}

          {vaultLocked ? (
            <VaultLockedCard nickname={server.nickname} onUnlock={onRequestUnlock} />
          ) : isError ? (
            <ErrorCard
              nickname={server.nickname}
              message={sshErrorMessage(error)}
              retrying={isFetching}
              onRetry={() => void refetch()}
            />
          ) : null}

          {isPending ? (
            <LoadingState nickname={server.nickname} />
          ) : data && sessions.length === 0 ? (
            hasAskAiRuns ? null : (
              <EmptyState />
            )
          ) : data ? (
            <div className="pb-4 pt-1.5">
              {groups.map((group, index) => {
                const key = group.folder ?? '';
                return (
                  <FolderSection
                    key={key}
                    group={group}
                    home={home}
                    expanded={isExpanded(key, index)}
                    onToggle={() => toggle(key, index)}
                  >
                    <HistoryDayGroups sessions={group.items} openIds={openIds} onResume={resume} />
                  </FolderSection>
                );
              })}
              {visible.length === 0 ? (
                <p className="px-5 py-10 text-center text-sm text-muted-foreground">
                  {searching || provider !== 'all'
                    ? 'No conversation matches.'
                    : 'Only runs started by tools so far.'}
                </p>
              ) : null}
              <div className="px-2">
                <BackgroundToggle
                  count={hiddenCount}
                  shown={showBackground}
                  onToggle={() => setShowBackground((show) => !show)}
                />
              </div>
            </div>
          ) : null}
        </ScrollArea>

        <SshAgentHistoryDialog
          sessionId={openRun?.sessionId ?? ''}
          sessionTitle={server.nickname}
          open={openRun !== null}
          onOpenChange={(next) => {
            if (!next) setOpenRunId(null);
          }}
          initialRunId={openRunId}
          continuation={continuation}
          source={{
            kind: 'ssh',
            queryKey: queryKeys.sshServerAgentHistory(server.id),
            load: () => window.agentmat.sshAgent.serverHistory(server.id),
            live: openRunLive,
          }}
        />
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

function FolderSection({
  group,
  home,
  expanded,
  onToggle,
  children,
}: {
  group: FolderGroup;
  home: string | null;
  expanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  const regionId = useId();
  const path = group.folder ? displayPath(group.folder, home) : null;
  const { parent, name } = splitPath(path ?? UNKNOWN_FOLDER);
  const count = group.items.length;
  const when = timeAgo(new Date(group.latest).toISOString());
  const FolderIcon = expanded ? FolderOpen : Folder;

  return (
    <section className="px-2">
      <div className="sticky top-0 z-10 bg-popover pt-1">
        <SimpleTooltip
          label={group.folder ?? 'The CLI did not record where these ran'}
          align="start"
        >
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={expanded ? regionId : undefined}
            aria-label={`${path ?? UNKNOWN_FOLDER}, ${plural(count, 'conversation')}, last active ${when}`}
            onClick={onToggle}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-foreground/[0.05] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <ChevronRight
              className={cn(
                'h-2.5 w-2.5 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none',
                expanded && 'rotate-90',
              )}
            />
            <FolderIcon
              className={cn(
                'h-3.5 w-3.5 shrink-0',
                path ? 'text-primary/80' : 'text-muted-foreground',
              )}
            />
            <span
              className={cn(
                'flex min-w-0 flex-1 text-[12px] leading-4',
                path ? 'font-mono' : 'italic text-muted-foreground',
              )}
            >
              {parent ? (
                <span className="min-w-0 truncate text-muted-foreground">{parent}</span>
              ) : null}
              <span
                className={cn(
                  'max-w-full shrink-0 truncate',
                  path && 'font-medium text-foreground',
                )}
              >
                {name}
              </span>
            </span>
            <span className="shrink-0 rounded-full bg-foreground/[0.06] px-1.5 py-px text-[10px] font-medium tabular-nums text-muted-foreground">
              {count}
            </span>
            <span className="w-16 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground">
              {when}
            </span>
          </button>
        </SimpleTooltip>
      </div>
      {expanded ? (
        <div
          id={regionId}
          role="group"
          aria-label={path ?? UNKNOWN_FOLDER}
          className="ml-[13px] border-l border-border/60 pb-1.5 pl-1 duration-150 animate-in fade-in-0 slide-in-from-top-1 motion-reduce:animate-none"
        >
          {children}
        </div>
      ) : null}
    </section>
  );
}

const RUN_STATUS: Record<SshAgentHistoryRun['status'], { label: string; dot: string }> = {
  running: { label: 'Running', dot: 'animate-pulse bg-primary motion-reduce:animate-none' },
  paused: { label: 'Paused', dot: 'bg-amber-400' },
  finished: { label: 'Done', dot: 'bg-success' },
  error: { label: 'Failed', dot: 'bg-destructive' },
  stopped: { label: 'Stopped', dot: 'bg-muted-foreground/50' },
};

/** The Ask AI tasks run in this server's SSH tabs, newest first. Each opens its full timeline. */
/** What a task still going waits for, for its row in the list. Null when it waits for nothing. */
function waitingLabel(
  run: SshAgentHistoryRun,
  state: SshAgentSessionState | undefined,
): string | null {
  if ((run.status !== 'running' && run.status !== 'paused') || !isSshAgentWaitingOnUser(state)) {
    return null;
  }
  return state?.phase === 'needs-input' ? 'Needs your answer' : 'Waiting for you';
}

function AskAiSection({
  runs,
  live,
  onOpen,
  onClear,
}: {
  runs: SshAgentHistoryRun[];
  /** Every terminal's live AI task state, to mark a task that waits on the user. */
  live: Record<string, SshAgentSessionState>;
  onOpen: (run: SshAgentHistoryRun) => void;
  onClear: () => void;
}): React.JSX.Element {
  const regionId = useId();
  const [expanded, setExpanded] = useState(true);

  return (
    <section className="px-2 pt-1.5">
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={expanded ? regionId : undefined}
          onClick={() => setExpanded((value) => !value)}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-foreground/[0.05] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <ChevronRight
            className={cn(
              'h-2.5 w-2.5 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none',
              expanded && 'rotate-90',
            )}
          />
          <Robot className="h-3.5 w-3.5 shrink-0 text-primary/80" />
          <span className="min-w-0 flex-1 text-[12px] font-medium leading-4">Ask AI tasks</span>
          <span className="shrink-0 rounded-full bg-foreground/[0.06] px-1.5 py-px text-[10px] font-medium tabular-nums text-muted-foreground">
            {runs.length}
          </span>
        </button>
        <SimpleTooltip label="Clear AI task history">
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label="Clear AI task history"
            onClick={onClear}
            className="shrink-0 text-muted-foreground hover:text-destructive"
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        </SimpleTooltip>
      </div>
      {expanded ? (
        <ul
          id={regionId}
          aria-label="Ask AI tasks"
          className="ml-[13px] border-l border-border/60 pb-1.5 pl-1"
        >
          {runs.map((run) => {
            const status = RUN_STATUS[run.status];
            const commands = run.entries.filter((entry) => entry.kind === 'command').length;
            const waiting = waitingLabel(run, live[run.sessionId]);
            return (
              <li key={run.id} className="mx-1">
                <button
                  type="button"
                  onClick={() => onOpen(run)}
                  className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-foreground/[0.05] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  <span className={cn('mt-[5px] h-2 w-2 shrink-0 rounded-full', status.dot)} />
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <TruncatedText
                        text={run.prompt}
                        side="right"
                        focusable={false}
                        className="flex-1 text-[12px] leading-4 text-foreground/90"
                      />
                      {waiting ? (
                        <span className="shrink-0 rounded-full bg-warning/15 px-1.5 py-px text-[10px] font-medium text-warning">
                          {waiting}
                        </span>
                      ) : null}
                    </span>
                    <span className="mt-0.5 block truncate text-[10px] leading-3 text-muted-foreground">
                      {[
                        status.label,
                        timeAgo(new Date(run.startedAt).toISOString()),
                        run.aiLabel || null,
                        plural(commands, 'command'),
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}

function LoadingState({ nickname }: { nickname: string }): React.JSX.Element {
  return (
    <div className="pt-3">
      <p role="status" className="flex items-center gap-2 px-5 text-xs text-muted-foreground">
        <Spinner className="h-3 w-3 animate-spin motion-reduce:animate-none" />
        Connecting to {nickname}…
      </p>
      <div className="flex items-center gap-2 px-5 pb-0.5 pt-4">
        <Skeleton className="h-3.5 w-3.5 rounded" />
        <Skeleton className="h-3 w-44 rounded" />
      </div>
      <div className="pl-3">
        <HistorySkeleton rows={6} />
      </div>
    </div>
  );
}

function EmptyState(): React.JSX.Element {
  return (
    <div className="flex flex-col items-center gap-3 px-8 py-16 text-center">
      <div className="flex h-11 w-11 items-center justify-center rounded-full bg-primary/10 text-primary">
        <History className="h-5 w-5" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium">No agent conversations on this server yet.</p>
        <p className="mx-auto max-w-xs text-xs leading-relaxed text-muted-foreground">
          They show up here after you use Ask AI in an SSH tab on it, or run an agent CLI there.
        </p>
      </div>
    </div>
  );
}

function VaultLockedCard({
  nickname,
  onUnlock,
}: {
  nickname: string;
  onUnlock: () => void;
}): React.JSX.Element {
  return (
    <div
      role="alert"
      className="mx-4 mt-4 flex gap-3 rounded-lg border border-primary/25 bg-primary/[0.06] p-3.5"
    >
      <Lock className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
      <div className="min-w-0 flex-1 space-y-2.5">
        <div className="space-y-0.5">
          <p className="text-sm font-medium">The servers vault is locked</p>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Unlock it with your passkey to read the conversations on {nickname}.
          </p>
        </div>
        <Button size="sm" onClick={onUnlock}>
          <LockOpen className="h-3.5 w-3.5" />
          Unlock
        </Button>
      </div>
    </div>
  );
}

function ErrorCard({
  nickname,
  message,
  retrying,
  onRetry,
}: {
  nickname: string;
  message: string;
  retrying: boolean;
  onRetry: () => void;
}): React.JSX.Element {
  return (
    <div
      role="alert"
      className="mx-4 mt-4 flex gap-3 rounded-lg border border-destructive/25 bg-destructive/[0.06] p-3.5"
    >
      <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
      <div className="min-w-0 flex-1 space-y-2.5">
        <div className="space-y-0.5">
          <p className="text-sm font-medium">Couldn't read the conversations on {nickname}</p>
          <p className="break-words text-xs leading-relaxed text-muted-foreground">{message}</p>
        </div>
        <Button size="sm" variant="soft" onClick={onRetry} disabled={retrying}>
          {retrying ? (
            <Spinner className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          Retry
        </Button>
      </div>
    </div>
  );
}
