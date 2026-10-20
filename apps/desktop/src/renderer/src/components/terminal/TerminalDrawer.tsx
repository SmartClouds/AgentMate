import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  ArrowRight,
  Folder,
  FolderOpen,
  History,
  Pause,
  Plus,
  Robot,
  Server,
  TerminalSquare,
  WindowMaximize,
  WindowRestore,
  X,
} from '@/components/icons';
import { Button } from '@/components/ui/button';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useRunPauseStore } from '@/stores/runPauseStore';
import { closeTerminalTab } from '@/stores/runSessionStore';
import { useShortcutLabel } from '@/stores/shortcutStore';
import { isSshAgentWaitingOnUser, useSshAgentStore } from '@/stores/sshAgentStore';
import {
  defaultNewSession,
  TERMINAL_MIN_HEIGHT,
  type TerminalSessionMeta,
  useTerminalStore,
} from '@/stores/terminalStore';
import { PausedRunBanner } from './PausedRunBanner';
import { SshAgentHistoryDialog } from './SshAgentHistoryDialog';
import { SshAgentStatusBar } from './SshAgentStatusBar';
import { SshAskAiDialog } from './SshAskAiDialog';
import { TerminalPane } from './TerminalPane';

function shellDisplayName(shell?: string): string {
  if (!shell) return defaultNewSession().title;
  const base = shell.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? shell;
  if (base === 'powershell.exe' || base === 'pwsh.exe' || base === 'pwsh') return 'PowerShell';
  if (base === 'cmd.exe' || base === 'cmd') return 'Command Prompt';
  return base.replace(/\.exe$/, '');
}

function shortPath(path: string): string {
  const sep = path.includes('\\') ? '\\' : '/';
  const parts = path.split(/[/\\]/).filter(Boolean);
  if (parts.length <= 2) return path;
  return `…${sep}${parts.slice(-2).join(sep)}`;
}

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <SimpleTooltip label={label}>
      <Button variant="ghost" size="icon-sm" aria-label={label} onClick={onClick}>
        {children}
      </Button>
    </SimpleTooltip>
  );
}

function SessionTab({
  session,
  active,
  onSelect,
  onClose,
}: {
  session: TerminalSessionMeta;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
}): React.JSX.Element {
  const aiWaiting = useSshAgentStore((s) => isSshAgentWaitingOnUser(s.sessions[session.id]));
  const paused = useRunPauseStore((s) => s.paused[session.id] !== undefined);
  const where = session.cwd ? `${session.title}\n${session.cwd}` : session.title;
  const label = paused ? `${where}\nPaused, using no CPU` : where;
  // The whole highlighted box is the tab. With only the label inside it clickable, a click on
  // the padding or beside the close button did nothing, and the user had to click again.
  return (
    <SimpleTooltip label={aiWaiting ? `${label}\nThe AI task here is waiting for you` : label}>
      <div
        role="tab"
        aria-selected={active}
        tabIndex={0}
        onClick={onSelect}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onSelect();
          }
        }}
        onMouseDown={(e) => {
          if (e.button === 1) e.preventDefault();
        }}
        onAuxClick={(e) => {
          if (e.button === 1) {
            e.preventDefault();
            onClose();
          }
        }}
        // A pill with a glowing underline, like a Workspace pane's tabs and the API Client's.
        className={cn(
          'group relative flex h-7 max-w-[14rem] shrink-0 cursor-pointer select-none items-center gap-1.5 rounded-md px-2.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
          active
            ? 'bg-foreground/[0.08] text-foreground'
            : 'text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground',
        )}
      >
        {active ? (
          <span
            aria-hidden
            className="absolute inset-x-2 -bottom-[6px] h-[2px] rounded-full bg-primary shadow-[0_0_8px_hsl(var(--primary)/0.7)]"
          />
        ) : null}
        <span className="flex min-w-0 flex-1 items-center gap-2">
          {paused ? (
            <Pause data-paused className="h-2 w-2 shrink-0 text-warning" />
          ) : (
            <span
              className={cn(
                'h-1.5 w-1.5 shrink-0 rounded-full',
                aiWaiting
                  ? 'animate-pulse bg-warning shadow-[0_0_6px_hsl(var(--warning))]'
                  : active
                    ? 'terminal-live-dot bg-primary shadow-[0_0_6px_hsl(var(--primary))]'
                    : 'bg-foreground/25',
              )}
            />
          )}
          {session.kind === 'ssh' && <Server className="h-3 w-3 shrink-0 opacity-70" />}
          <span className="truncate">{session.title}</span>
          {paused ? <span className="sr-only">, paused</span> : null}
        </span>
        <button
          type="button"
          aria-label={`Close ${session.title}`}
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          className={cn(
            'flex h-4 w-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-opacity hover:bg-foreground/15 hover:text-foreground',
            active
              ? 'opacity-70'
              : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100',
          )}
        >
          <X className="h-2.5 w-2.5" />
        </button>
      </div>
    </SimpleTooltip>
  );
}

const TAB_SCROLL = 120;

export function SessionTabStrip({
  sessions,
  activeSessionId,
  onSelect,
  onClose,
}: {
  sessions: TerminalSessionMeta[];
  activeSessionId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
}): React.JSX.Element {
  const listRef = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState({ start: false, end: false });

  const syncOverflow = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    setOverflow((prev) => {
      const next = { start: el.scrollLeft > 1, end: el.scrollLeft < max - 1 };
      return prev.start === next.start && prev.end === next.end ? prev : next;
    });
  }, []);

  const scrollActiveIntoView = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    const active = el.querySelector('[aria-selected="true"]');
    if (!(active instanceof HTMLElement)) return;
    const parent = el.getBoundingClientRect();
    const child = active.getBoundingClientRect();
    if (child.left < parent.left) el.scrollLeft += child.left - parent.left;
    else if (child.right > parent.right) el.scrollLeft += child.right - parent.right;
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: tabs were added, removed or switched, so the new children need observing and the active one scrolled into view
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    scrollActiveIntoView();
    syncOverflow();
    const observer = new ResizeObserver(syncOverflow);
    observer.observe(el);
    for (const child of Array.from(el.children)) observer.observe(child);
    return () => observer.disconnect();
  }, [sessions, activeSessionId, scrollActiveIntoView, syncOverflow]);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent): void => {
      if (el.scrollWidth <= el.clientWidth) return;
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      el.scrollLeft += event.deltaY;
      event.preventDefault();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const scrollBy = useCallback((delta: number) => {
    listRef.current?.scrollBy({ left: delta, behavior: 'smooth' });
  }, []);

  const canScroll = overflow.start || overflow.end;

  return (
    <div className="flex min-w-0 flex-1 items-center gap-0.5">
      {canScroll && (
        <button
          type="button"
          tabIndex={-1}
          aria-label="Scroll tabs left"
          disabled={!overflow.start}
          onClick={() => scrollBy(-TAB_SCROLL)}
          className="flex h-7 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
        >
          <ArrowLeft className="h-3 w-3" />
        </button>
      )}
      <div
        ref={listRef}
        role="tablist"
        aria-label="Terminal sessions"
        onScroll={syncOverflow}
        className="flex min-w-0 flex-1 flex-nowrap items-center gap-0.5 self-stretch overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {sessions.map((session) => (
          <SessionTab
            key={session.id}
            session={session}
            active={session.id === activeSessionId}
            onSelect={() => onSelect(session.id)}
            onClose={() => onClose(session.id)}
          />
        ))}
      </div>
      {canScroll && (
        <button
          type="button"
          tabIndex={-1}
          aria-label="Scroll tabs right"
          disabled={!overflow.end}
          onClick={() => scrollBy(TAB_SCROLL)}
          className="flex h-7 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
        >
          <ArrowRight className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

/**
 * Where the drawer sits, which sets its gutters. On a page it lines up with the page island
 * (8px at the sides); on the Workspace it lines up with the panes and the project panel,
 * which are inset 6px all round.
 */
export type TerminalDrawerPlacement = 'page' | 'workspace';

export function TerminalDrawer({
  hidden = false,
  placement = 'page',
}: {
  /** Keeps the drawer mounted but off screen even while open, so its shells keep streaming. */
  hidden?: boolean;
  placement?: TerminalDrawerPlacement;
}): React.JSX.Element {
  const isOpen = useTerminalStore((s) => s.isOpen);
  const drawerHeight = useTerminalStore((s) => s.drawerHeight);
  const setDrawerHeight = useTerminalStore((s) => s.setDrawerHeight);
  const sessions = useTerminalStore((s) => s.sessions);
  const activeSessionId = useTerminalStore((s) => s.activeSessionId);
  const setActiveSession = useTerminalStore((s) => s.setActiveSession);
  const forgetSession = useTerminalStore((s) => s.forgetSession);
  const navigate = useNavigate();
  const openDefaultSession = useTerminalStore((s) => s.openDefaultSession);
  const closeDrawer = useTerminalStore((s) => s.closeDrawer);
  const toggleShortcut = useShortcutLabel('terminal.toggle');
  const newTabShortcut = useShortcutLabel('terminal.new');
  const isMaximized = useTerminalStore((s) => s.isMaximized);
  const setIsMaximized = useTerminalStore((s) => s.setMaximized);
  const [isResizing, setIsResizing] = useState(false);
  const [askAiOpen, setAskAiOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const drawerRef = useRef<HTMLDivElement>(null);
  const shellRef = useRef<HTMLElement>(null);

  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? sessions.at(-1) ?? null;

  function handleCloseDrawer(): void {
    setIsMaximized(false);
    closeDrawer();
  }

  function startResize(event: React.PointerEvent<HTMLDivElement>): void {
    if (isMaximized) return;
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = drawerRef.current?.offsetHeight ?? drawerHeight;
    // The room to share is the page area the drawer stacks under, not the drawer's own frame.
    const parentHeight = shellRef.current?.parentElement?.clientHeight ?? window.innerHeight;
    const maxHeight = Math.max(TERMINAL_MIN_HEIGHT, parentHeight - 240);
    setIsResizing(true);
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';

    function handleMove(move: PointerEvent): void {
      const next = Math.min(
        maxHeight,
        Math.max(TERMINAL_MIN_HEIGHT, startHeight + (startY - move.clientY)),
      );
      setDrawerHeight(next);
    }
    function handleUp(): void {
      setIsResizing(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
    }
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
  }

  // Toggling and opening tabs live in the global shortcut registry (see
  // useGlobalShortcuts). Only Escape stays here, because it is meaningful just
  // while this drawer is maximized.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape' || !isMaximized || !isOpen) return;
      event.preventDefault();
      setIsMaximized(false);
    }
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [isMaximized, isOpen, setIsMaximized]);

  // Closing the drawer only hides it: the panes stay mounted so their output keeps
  // flowing into xterm. Ending a shell is what closing an individual tab is for.
  //
  // The drawer is its own island stacked under the page (or under the Workspace grid), not an
  // overlay inside it. The outer frame holds the gutters and the resize grip, which sits in the
  // gap above the island: the island clips to its rounded corners, so the grip can't live in it.
  const onWorkspace = placement === 'workspace';
  return (
    <section
      ref={shellRef}
      aria-label="Terminal"
      className={cn(
        'relative z-20 flex shrink-0 flex-col',
        isMaximized
          ? cn('absolute z-50', onWorkspace ? 'inset-1.5' : 'inset-x-2 top-0 bottom-1.5')
          : cn(
              // Pulled up over the bottom gutter of whatever sits above, so the grip makes the
              // whole gap: 8px under a page island, 6px like the Workspace's own gaps.
              '-mt-1.5 mb-1.5 max-h-[calc(100%-6rem)]',
              onWorkspace ? 'mx-1.5' : 'mx-2',
            ),
        (!isOpen || hidden) && 'hidden',
      )}
    >
      {!isMaximized && (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize terminal"
          onPointerDown={startResize}
          className={cn(
            'group flex shrink-0 cursor-row-resize items-center justify-center',
            onWorkspace ? 'h-1.5' : 'h-2',
          )}
        >
          {/* Quiet until hovered, like the split handles between Workspace panes. */}
          <span
            className={cn(
              'h-[3px] w-10 rounded-full transition-colors duration-150',
              isResizing
                ? 'bg-primary shadow-[0_0_10px_hsl(var(--primary)/0.7)]'
                : 'bg-transparent group-hover:bg-primary/70',
            )}
          />
        </div>
      )}

      <div
        ref={drawerRef}
        className={cn(
          'chrome-island flex min-h-0 flex-col',
          isMaximized ? 'flex-1' : 'shrink',
          isResizing && 'select-none',
        )}
        style={isMaximized || !isOpen || hidden ? undefined : { height: drawerHeight }}
      >
        {/* The tab row, drawn like a Workspace pane's: pills over a hairline. */}
        <div className="flex h-10 shrink-0 items-stretch gap-1 px-1.5 shadow-[inset_0_-1px_0_hsl(var(--border)/0.6)]">
          {sessions.length === 0 ? (
            <div className="flex items-center gap-2 px-2 text-xs text-muted-foreground">
              <TerminalSquare className="h-3.5 w-3.5" />
              No sessions
            </div>
          ) : (
            <SessionTabStrip
              sessions={sessions}
              activeSessionId={activeSessionId}
              onSelect={setActiveSession}
              onClose={closeTerminalTab}
            />
          )}
          {sessions.length === 0 && <div className="flex-1" />}
          <div className="flex shrink-0 items-center gap-0.5">
            {activeSession?.kind === 'ssh' && activeSession.sshServerId ? (
              <IconButton
                label="Browse files over SFTP"
                onClick={() => navigate(`/ssh-files/${activeSession.sshServerId}`)}
              >
                <FolderOpen className="h-3.5 w-3.5" />
              </IconButton>
            ) : null}
            {activeSession && (
              <IconButton label="Ask AI to run a task here" onClick={() => setAskAiOpen(true)}>
                <Robot className="h-3.5 w-3.5" />
              </IconButton>
            )}
            {activeSession && (
              <IconButton label="AI task history" onClick={() => setHistoryOpen(true)}>
                <History className="h-3.5 w-3.5" />
              </IconButton>
            )}
            <IconButton
              label={
                newTabShortcut
                  ? `New ${defaultNewSession().title} (${newTabShortcut})`
                  : `New ${defaultNewSession().title}`
              }
              onClick={() => void openDefaultSession()}
            >
              <Plus className="h-3.5 w-3.5" />
            </IconButton>
            <IconButton
              label={isMaximized ? 'Restore terminal' : 'Maximize terminal'}
              onClick={() => setIsMaximized(!isMaximized)}
            >
              {isMaximized ? (
                <WindowRestore className="h-3.5 w-3.5" />
              ) : (
                <WindowMaximize className="h-3.5 w-3.5" />
              )}
            </IconButton>
            <IconButton label="Close terminal panel" onClick={handleCloseDrawer}>
              <X className="h-3.5 w-3.5" />
            </IconButton>
          </div>
        </div>

        {activeSession?.run ? <PausedRunBanner sessionId={activeSession.id} /> : null}
        {activeSession && (
          <SshAgentStatusBar
            sessionId={activeSession.id}
            onOpenHistory={() => setHistoryOpen(true)}
          />
        )}

        <div className="terminal-well relative min-h-0 flex-1 overflow-hidden">
          {sessions.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
              {/* The well is always the dark terminal fill here, so the text keeps its light tones. */}
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/15 text-primary shadow-[0_0_40px_-12px_hsl(var(--primary)/0.7)]">
                <TerminalSquare className="h-5 w-5" />
              </div>
              <div className="space-y-1">
                <p className="text-sm font-medium text-zinc-100">Open a terminal</p>
                <p className="max-w-sm text-xs leading-relaxed text-zinc-400">
                  Run installs, project commands, and CLIs here. Sessions keep running if you hide
                  this panel or AgentMate restarts to update.
                </p>
              </div>
              <Button onClick={() => void openDefaultSession()}>
                <Plus className="h-3.5 w-3.5" />
                New {defaultNewSession().title}
              </Button>
            </div>
          ) : (
            sessions.map((session) => (
              <TerminalPane
                key={session.id}
                meta={session}
                active={isOpen && !hidden && session.id === activeSessionId}
                onExit={() => forgetSession(session.id)}
              />
            ))
          )}
        </div>

        <div className="flex h-6 shrink-0 items-center gap-2 px-3 font-mono text-[10px] text-muted-foreground shadow-[inset_0_1px_0_hsl(var(--foreground)/0.08)]">
          <span className="truncate">
            {activeSession?.kind === 'ssh' ? 'SSH' : shellDisplayName(activeSession?.shell)}
          </span>
          {activeSession?.cwd ? (
            <>
              <span className="text-muted-foreground/40">·</span>
              <SimpleTooltip label={activeSession.cwd} side="top">
                <span className="flex min-w-0 items-center gap-1.5 truncate">
                  <Folder className="h-2.5 w-2.5 shrink-0" />
                  {shortPath(activeSession.cwd)}
                </span>
              </SimpleTooltip>
            </>
          ) : null}
          <span className="flex-1" />
          <span>
            {sessions.length} session{sessions.length === 1 ? '' : 's'}
          </span>
          {toggleShortcut ? (
            <>
              <span className="text-muted-foreground/40">·</span>
              <span>{toggleShortcut}</span>
            </>
          ) : null}
        </div>

        {activeSession && (
          <SshAskAiDialog
            sessionId={activeSession.id}
            target={activeSession.kind === 'ssh' ? 'ssh' : 'local'}
            open={askAiOpen}
            onOpenChange={setAskAiOpen}
          />
        )}
        {activeSession && (
          <SshAgentHistoryDialog
            sessionId={activeSession.id}
            sessionTitle={activeSession.title}
            open={historyOpen}
            onOpenChange={setHistoryOpen}
          />
        )}
      </div>
    </section>
  );
}
