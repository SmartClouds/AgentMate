import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { AskAiModal } from '@/components/askAi/AskAiModal';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { AnglesLeft, AnglesRight, Bell, MessageSquare, TerminalSquare } from '@/components/icons';
import { CommandPalette } from '@/components/search/CommandPalette';
import { RunningClisDialog } from '@/components/terminal/RunningClisDialog';
import { TerminalDrawer } from '@/components/terminal/TerminalDrawer';
import { ToastHistoryPanel } from '@/components/toast/ToastHistoryPanel';
import { UpdateStatusChip } from '@/components/UpdateManager';
import { Button } from '@/components/ui/button';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { WorkspaceHeaderActions } from '@/components/workspace/WorkspaceHeaderActions';
import { WorkspaceHost } from '@/components/workspace/WorkspaceHost';
import { useStartupLoading } from '@/hooks/useAppLoadingOverlay';
import { useAppNotificationMessages } from '@/hooks/useAppNotificationMessages';
import { useAutoPauseRuns } from '@/hooks/useAutoPauseRuns';
import { useGlobalShortcuts } from '@/hooks/useGlobalShortcuts';
import { usePetDragGuard } from '@/hooks/usePetDragGuard';
import { useRememberRoute } from '@/hooks/useRememberRoute';
import { useScheduledTaskRunner } from '@/hooks/useScheduledTaskRunner';
import { useVaultEvents } from '@/hooks/useVaultEvents';
import { queryKeys } from '@/lib/queryKeys';
import { startRunSessionFeed } from '@/lib/terminal/runSessionFeed';
import { cn } from '@/lib/utils';
import { isWorkspacePath } from '@/lib/workspace/commands';
import { initAgentStatus } from '@/stores/agentStatusStore';
import { useAskAiStore } from '@/stores/askAiStore';
import { usePageHeaderStore } from '@/stores/pageHeaderStore';
import { initRunPauses } from '@/stores/runPauseStore';
import { useShortcutLabel } from '@/stores/shortcutStore';
import {
  initSshAgentStatus,
  isSshAgentWaitingOnUser,
  useSshAgentStore,
} from '@/stores/sshAgentStore';
import { useTerminalStore } from '@/stores/terminalStore';
import { useToastHistoryStore } from '@/stores/toastHistoryStore';
import { useUiStore } from '@/stores/uiStore';
import { AboutDialog } from './AboutDialog';
import { LoadingOverlay } from './LoadingOverlay';
import { Sidebar } from './Sidebar';
import { StatusBar } from './StatusBar';
import { TitleBar } from './TitleBar';
import { TopMenu } from './TopMenu';

/** Where a terminal AI task notification points; see notifySshTaskWaiting() in main. */
const TERMINAL_SESSION_ROUTE = /^\/terminal-session\/([^/?#]+)/;

function TopBar({ showSidebarToggle }: { showSidebarToggle: boolean }): React.JSX.Element {
  const isTerminalOpen = useTerminalStore((s) => s.isOpen);
  const toggleDrawer = useTerminalStore((s) => s.toggleDrawer);
  const sessions = useTerminalStore((s) => s.sessions);
  const activeSessionId = useTerminalStore((s) => s.activeSessionId);
  const sidebarMode = useUiStore((s) => s.sidebarMode);
  const cycleSidebarMode = useUiStore((s) => s.cycleSidebarMode);
  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const pageTitle = usePageHeaderStore((s) => s.title);
  const pageSubtitle = usePageHeaderStore((s) => s.subtitle);
  const openAskAi = useAskAiStore((s) => s.openModal);
  const toastHistoryOpen = useToastHistoryStore((s) => s.open);
  const openToastHistory = useToastHistoryStore((s) => s.setOpen);
  const toastUnread = useToastHistoryStore((s) => s.items.filter((item) => !item.read).length);
  const toastUnreadError = useToastHistoryStore((s) =>
    s.items.some((item) => !item.read && item.kind === 'error'),
  );
  const terminalShortcut = useShortcutLabel('terminal.toggle');
  const onWorkspace = isWorkspacePath(useLocation().pathname);
  const aiWaiting = useSshAgentStore((s) =>
    Object.values(s.sessions).some((session) => isSshAgentWaitingOnUser(session)),
  );

  const sidebarLabel =
    sidebarMode === 'expanded'
      ? 'Collapse sidebar'
      : sidebarMode === 'collapsed'
        ? 'Hide sidebar'
        : 'Show sidebar';
  return (
    <div className="flex h-14 shrink-0 items-center justify-between gap-3 px-4">
      <div className="flex min-w-0 items-center gap-3">
        {/* With the menu along the top there is no sidebar to fold away. */}
        {showSidebarToggle ? (
          <SimpleTooltip label={sidebarLabel}>
            <Button
              variant="ghost"
              size="icon"
              aria-label={sidebarLabel}
              onClick={cycleSidebarMode}
            >
              {sidebarMode === 'hidden' ? (
                <AnglesRight className="h-4 w-4" />
              ) : (
                <AnglesLeft className="h-4 w-4" />
              )}
            </Button>
          </SimpleTooltip>
        ) : null}
        <div className="flex min-w-0 flex-col justify-center">
          {pageTitle && <span className="truncate text-base font-semibold">{pageTitle}</span>}
          {pageSubtitle && (
            <span className="truncate text-xs text-muted-foreground">{pageSubtitle}</span>
          )}
        </div>
      </div>

      <div className="flex shrink-0 items-center justify-end gap-2">
        {activeSession && (
          <span className="hidden max-w-[16rem] truncate text-xs text-muted-foreground sm:inline">
            {activeSession.title}
          </span>
        )}
        <UpdateStatusChip />
        {onWorkspace ? <WorkspaceHeaderActions /> : null}
        {/* The general terminal (for running the app, installs and so on) stays available on
            every page, the Workspace included, where it opens under the panes. */}
        <SimpleTooltip
          label={
            aiWaiting
              ? 'An AI task in the terminal is waiting for you'
              : terminalShortcut
                ? `Toggle terminal (${terminalShortcut})`
                : 'Toggle terminal'
          }
        >
          <Button
            variant={isTerminalOpen ? 'soft' : 'ghost'}
            size="icon"
            aria-pressed={isTerminalOpen}
            aria-label="Toggle terminal"
            onClick={toggleDrawer}
            className="relative"
          >
            <TerminalSquare className="h-4 w-4" />
            {aiWaiting ? (
              <span className="absolute right-1 top-1 h-2 w-2 animate-pulse rounded-full bg-amber-400 shadow-[0_0_6px_var(--color-amber-400)]" />
            ) : (
              sessions.length > 0 && (
                <span
                  className={cn(
                    'absolute right-1 top-1 h-1.5 w-1.5 rounded-full',
                    isTerminalOpen
                      ? 'bg-primary shadow-[0_0_6px_hsl(var(--primary))]'
                      : 'bg-primary/70',
                  )}
                />
              )
            )}
          </Button>
        </SimpleTooltip>
        <SimpleTooltip label="Recent messages">
          <Button
            variant={toastHistoryOpen ? 'soft' : 'ghost'}
            size="icon"
            aria-pressed={toastHistoryOpen}
            aria-label="Recent messages"
            onClick={() => openToastHistory(!toastHistoryOpen)}
            className="relative"
          >
            <Bell className="h-4 w-4" />
            {toastUnread > 0 && (
              <span
                className={cn(
                  'absolute right-1 top-1 h-1.5 w-1.5 rounded-full',
                  toastUnreadError
                    ? 'bg-destructive shadow-[0_0_6px_hsl(var(--destructive))]'
                    : 'bg-primary shadow-[0_0_6px_hsl(var(--primary))]',
                )}
              />
            )}
          </Button>
        </SimpleTooltip>
        <SimpleTooltip label="Ask AI">
          <Button variant="ghost" size="icon" aria-label="Ask AI" onClick={openAskAi}>
            <MessageSquare className="h-4 w-4" />
          </Button>
        </SimpleTooltip>
      </div>
    </div>
  );
}

/** How long the first page gets to paint its data before the splash hands over. */
const READY_SETTLE_MS = 120;

export function AppShell(): React.JSX.Element {
  const location = useLocation();
  const navigate = useNavigate();
  // Only the cold start gets the full-page overlay. Every later load shimmers
  // in place on the card that's waiting. See the hook for why.
  const { showOverlay: showLoading, booted } = useStartupLoading();
  const scrollRef = useRef<HTMLDivElement>(null);
  const onWorkspace = isWorkspacePath(location.pathname);
  // Read like any other setting, so a change saved in Settings swaps the menu straight away. It
  // is part of the cold start's first batch, so the window stays behind the splash until it is in.
  const settingsQuery = useQuery({
    queryKey: queryKeys.settings,
    queryFn: () => window.agentmat.settings.get(),
  });
  const menuOnTop = settingsQuery.data?.menuPosition === 'top';
  // The workspace mounts on first visit and then stays, so its terminals survive navigation.
  const [workspaceVisited, setWorkspaceVisited] = useState(onWorkspace);
  if (onWorkspace && !workspaceVisited) setWorkspaceVisited(true);
  // A maximized drawer covers the page area but sits inside its gutters, where the Workspace's
  // rail and pane edges would show. The page is only made invisible, so it keeps its size and
  // its terminals keep running.
  const terminalCoversPage = useTerminalStore((s) => s.isOpen && s.isMaximized);

  useGlobalShortcuts();
  useVaultEvents();
  // Pipeline results and CLI updates surface as messages, and stay in Recent messages.
  useAppNotificationMessages();
  // Agent status is followed app-wide, so a workspace agent can notify from any page.
  useEffect(() => initAgentStatus(), []);
  // Ditto for AI-driven SSH tasks: progress must keep updating even off the Workspace page.
  useEffect(() => initSshAgentStatus(), []);
  // Project runs are followed from their first line, whichever page is open, for the status bar.
  useEffect(() => startRunSessionFeed(), []);
  // Which runs are paused comes from main, which also hears about pauses made in other windows.
  useEffect(() => initRunPauses(), []);
  // Pauses a project's runs while an agent works in the same folder, when that is switched on.
  useAutoPauseRuns();
  // The desktop companion would otherwise swallow every drop in the app window.
  usePetDragGuard();
  // Main keeps the page this window is on, so the next launch can open there.
  useRememberRoute();
  useScheduledTaskRunner();

  // The window is still hidden behind the startup splash. Once the first page has its data, give
  // React a beat to commit it and tell main to swap them. A timer, not requestAnimationFrame: a
  // window that has never been shown only gets frames now and then. Later calls are ignored.
  const reportedReady = useRef(false);
  useEffect(() => {
    if (!booted || showLoading || reportedReady.current) return undefined;
    const timer = setTimeout(() => {
      reportedReady.current = true;
      window.agentmat.app.notifyReady();
    }, READY_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [booted, showLoading]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: every route change starts the page at the top
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [location.pathname]);

  // Deep links from outside the window: clicking the desktop pet after it
  // announced a failed pipeline lands on that run in Pipelines. A click that
  // started the window gets its route from the pending slot instead, since the
  // push would have gone out before this listener existed.
  useEffect(() => {
    // A terminal AI task notification opens its terminal where the user already is.
    function go(route: string): void {
      const terminalSession = TERMINAL_SESSION_ROUTE.exec(route);
      if (!terminalSession) {
        navigate(route);
        return;
      }
      const terminal = useTerminalStore.getState();
      const id = decodeURIComponent(terminalSession[1] ?? '');
      if (terminal.sessions.some((s) => s.id === id)) terminal.setActiveSession(id);
      terminal.openDrawer();
    }
    const stop = window.agentmat.app.onNavigate(go);
    void window.agentmat.app.pendingNavigate().then((route) => {
      if (route) go(route);
    });
    return stop;
  }, [navigate]);

  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden bg-background text-foreground glass:bg-transparent">
      <TitleBar />
      <CommandPalette />
      <AskAiModal />
      <ToastHistoryPanel />
      <RunningClisDialog />
      <AboutDialog />
      {menuOnTop && <TopMenu />}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {!menuOnTop && <Sidebar />}
        <div className="relative flex min-w-0 flex-1 flex-col">
          <TopBar showSidebarToggle={!menuOnTop} />
          {/* The page area: the page and, when it's open, the terminal drawer stacked under it
              as a second island. It has no fill, so on glass the gaps show the window material. */}
          <div className="relative flex min-h-0 flex-1 flex-col">
            {/* Pages sit in a rounded island inset from the window edge. The Workspace draws
                its own islands (the panes and the project panel), so there this is a plain box. */}
            <div
              data-page-island={onWorkspace ? undefined : ''}
              className={cn(
                'relative flex min-h-0 flex-1 flex-col',
                !onWorkspace && 'chrome-island mx-2 mb-1.5',
                terminalCoversPage && 'invisible',
              )}
            >
              <div
                ref={scrollRef}
                className={cn(
                  'flex min-h-0 flex-1 flex-col overflow-y-auto',
                  onWorkspace && 'hidden',
                )}
              >
                {/* Keyed on the path so React remounts the wrapper per route and
                    the CSS enter animation replays. No exit animation and no
                    AnimatePresence gate: the incoming page renders immediately
                    instead of waiting on the outgoing one's animation to report
                    back, which is what used to strand the content area empty. */}
                <div key={location.pathname} className="page-enter flex min-h-full flex-1 flex-col">
                  {/* A page that throws must not take the shell down with it,
                      the sidebar stays usable and the error is readable. */}
                  <ErrorBoundary resetKey={location.pathname}>
                    <Outlet />
                  </ErrorBoundary>
                </div>
              </div>
              {workspaceVisited && (
                <ErrorBoundary resetKey="workspace">
                  <WorkspaceHost visible={onWorkspace} />
                </ErrorBoundary>
              )}
              {/* The Workspace has no island around it, so here the sheet is sized like one: it
                  keeps the same 6px gutter its panes and project panel keep from the window edge,
                  and draws the island's hairline as an inset ring (a border colour utility loses
                  to the global border rule). Other pages are already clipped to their island. */}
              <LoadingOverlay
                show={showLoading}
                className={onWorkspace ? 'inset-1.5 ring-1 ring-inset ring-border/60' : undefined}
              />
            </div>
            {/* A sibling of the page, so the page island makes room for it instead of clipping
                it. It stays mounted while closed, so its shells keep running. */}
            <TerminalDrawer placement={onWorkspace ? 'workspace' : 'page'} />
          </div>
        </div>
      </div>
      <ErrorBoundary resetKey="status-bar">
        <StatusBar />
      </ErrorBoundary>
    </div>
  );
}
