import { agentSessionTitle, type PaneGroupNode, type Project } from '@agentmat/core';
import { isImagePath } from '@shared/imageFiles';
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { CliLogo } from '@/components/cliLogos';
import {
  ArrowLeft,
  ArrowRight,
  CodeCompare,
  Compress,
  Expand,
  File as FileIcon,
  GitCommit,
  Globe,
  ImageIcon,
  Plus,
  RefreshCw,
  SplitView,
  TerminalSquare,
  X,
} from '@/components/icons';
import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { OVERLAY_SURFACE } from '@/components/ui/overlay';
import { Skeleton } from '@/components/ui/skeleton';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { browserRuntime } from '@/lib/browser/browserRuntime';
import { useTerminalSessionStore } from '@/lib/terminal/terminalRuntime';
import { cn } from '@/lib/utils';
import { useLauncherStore } from '@/lib/workspace/commands';
import { resumeInputFor, statusHooksReady } from '@/lib/workspace/launch';
import {
  isSessionBusy,
  tabRunLine,
  useAgentRunInfo,
  useAgentStatus,
  useAutoContinuePending,
  useCliRunLine,
} from '@/stores/agentStatusStore';
import { confirmDialog } from '@/stores/confirmStore';
import { useShortcutLabel } from '@/stores/shortcutStore';
import {
  type ProjectWorkspace,
  terminalTabLabel,
  useWorkspaceStore,
  type WorkspaceBrowserTab,
  type WorkspaceTab,
} from '@/stores/workspaceStore';
import { AgentStatusChip, AgentStatusDot } from './AgentStatusDot';
import { AutoContinueMenu, autoContinuePendingLine } from './AutoContinueMenu';
import { BrowserTabMenu } from './browser/BrowserTabMenu';
import { FileTabMenu } from './FileTabMenu';
import { LauncherMenu } from './LauncherMenu';
import { PaneLauncher } from './PaneLauncher';
import { TerminalSlot } from './TerminalSlot';

/** Monaco is heavy; it loads the first time a diff is opened. */
const DiffTab = lazy(() => import('./git/DiffTab'));
const FileTab = lazy(() => import('./FileTab'));
const BrowserTab = lazy(() => import('./browser/BrowserTab'));

/** Drag payload type for workspace tabs, kept apart from OS file drags. */
const TAB_MIME = 'application/x-agentmate-tab';

interface DraggedTab {
  projectId: string;
  tabId: string;
  groupId: string;
}

/**
 * The tab being dragged right now. A drag only says what it carries on the drop, so this is how
 * a strip knows, while the tab is still over it, how much room to make and whether it's its own.
 */
let liveTabDrag: (DraggedTab & { width: number }) | null = null;

/**
 * Pages of browser tabs sit above the panes in their own layer and would swallow the drag, so
 * they step aside until it ends. The tab that started the drag may be gone by then (a move
 * remounts it), so the end is watched on the window, with the first mouse move after a drop as
 * a backstop.
 */
function beginTabDrag(drag: DraggedTab & { width: number }): void {
  liveTabDrag = drag;
  browserRuntime.setDragging(true);
  const end = (): void => {
    liveTabDrag = null;
    browserRuntime.setDragging(false);
    for (const type of ['dragend', 'drop', 'mousemove'] as const) {
      window.removeEventListener(type, end, true);
    }
  };
  for (const type of ['dragend', 'drop', 'mousemove'] as const) {
    window.addEventListener(type, end, true);
  }
}

/** A tab slot's place in its strip. Offsets ignore transforms, so a slot still sliding reads true. */
interface SlotBox {
  left: number;
  width: number;
}

/** A tab held over a strip, and where the strip makes room for it. */
interface StripDrag {
  /** The slot the tab would land in front of if dropped now. The length means the end. */
  at: number;
  /** The tab's own slot when it comes from this strip, or -1 when it comes from another pane. */
  from: number;
  /** How wide the tab is, so the gap opened for it fits. */
  width: number;
  /** Every slot's place, untouched by the slide. */
  boxes: SlotBox[];
}

function sameStripDrag(a: StripDrag | null, b: StripDrag): boolean {
  return (
    a !== null &&
    a.at === b.at &&
    a.from === b.from &&
    a.width === b.width &&
    a.boxes.length === b.boxes.length &&
    a.boxes.every((box, i) => box.left === b.boxes[i].left && box.width === b.boxes[i].width)
  );
}

function slotGap(boxes: SlotBox[]): number {
  return boxes.length > 1 ? boxes[1].left - boxes[0].left - boxes[0].width : 2;
}

/** Where the tab lands when it comes from another pane: the gap the slots open for it. */
function landingLeft({ at, boxes }: StripDrag): number {
  if (at < boxes.length) return boxes[at].left;
  const last = boxes[boxes.length - 1];
  return last ? last.left + last.width + slotGap(boxes) : 0;
}

/**
 * How far a slot slides while a tab is held over the strip. A tab from another pane pushes the
 * slots from its landing spot on to the right. A tab from this strip moves to where it would land,
 * and the slots it passes step over into the place it left, the way rows and cards reorder.
 */
function slotShift(drag: StripDrag, index: number): number {
  const { at, from, width, boxes } = drag;
  const room = width + slotGap(boxes);
  if (from === -1) return index >= at ? room : 0;
  const to = from < at ? at - 1 : at;
  if (index === from) {
    if (to > from) return boxes[to].left + boxes[to].width - width - boxes[from].left;
    if (to < from) return boxes[to].left - boxes[from].left;
    return 0;
  }
  if (from < to && index > from && index <= to) return -room;
  if (to < from && index >= to && index < from) return room;
  return 0;
}

/** How far a click on an edge arrow scrolls the strip. */
const TAB_SCROLL = 120;
/** How far each dragover on an edge arrow scrolls, so holding a tab there keeps the strip moving. */
const TAB_DRAG_SCROLL = 12;

function StripArrow({
  side,
  disabled,
  onScroll,
}: {
  side: 'left' | 'right';
  disabled: boolean;
  onScroll: (delta: number, behavior: ScrollBehavior) => void;
}): React.JSX.Element {
  const sign = side === 'left' ? -1 : 1;
  const Icon = side === 'left' ? ArrowLeft : ArrowRight;
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-label={`Scroll tabs ${side}`}
      disabled={disabled}
      onClick={() => onScroll(sign * TAB_SCROLL, 'smooth')}
      onDragOver={() => onScroll(sign * TAB_DRAG_SCROLL, 'instant')}
      className="flex h-7 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
    >
      <Icon className="h-3 w-3" />
    </button>
  );
}

function readDraggedTab(event: React.DragEvent): DraggedTab | null {
  try {
    const raw = event.dataTransfer.getData(TAB_MIME);
    return raw ? (JSON.parse(raw) as DraggedTab) : null;
  } catch {
    return null;
  }
}

function isTabDrag(event: React.DragEvent): boolean {
  return event.dataTransfer.types.includes(TAB_MIME);
}

type DropZone = 'center' | 'left' | 'right' | 'top' | 'bottom';

function zoneAt(event: React.DragEvent, el: HTMLElement): DropZone {
  const rect = el.getBoundingClientRect();
  const x = (event.clientX - rect.left) / rect.width;
  const y = (event.clientY - rect.top) / rect.height;
  const edge = 0.22;
  if (x < edge) return 'left';
  if (x > 1 - edge) return 'right';
  if (y < edge) return 'top';
  if (y > 1 - edge) return 'bottom';
  return 'center';
}

const ZONE_PREVIEW: Record<DropZone, string> = {
  center: 'inset-2',
  left: 'inset-y-2 left-2 right-1/2',
  right: 'inset-y-2 right-2 left-1/2',
  top: 'inset-x-2 top-2 bottom-1/2',
  bottom: 'inset-x-2 bottom-2 top-1/2',
};

function PaneIconButton({
  label,
  onClick,
  children,
  active,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  active?: boolean;
}): React.JSX.Element {
  return (
    <SimpleTooltip label={label}>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={label}
        onClick={onClick}
        className={cn(active && 'bg-foreground/10 text-foreground')}
      >
        {children}
      </Button>
    </SimpleTooltip>
  );
}

function BrowserTabIcon({ tab }: { tab: WorkspaceBrowserTab }): React.JSX.Element {
  const [broken, setBroken] = useState<string | null>(null);
  if (tab.faviconUrl && broken !== tab.faviconUrl) {
    return (
      <img
        src={tab.faviconUrl}
        alt=""
        className="h-3.5 w-3.5 shrink-0 rounded-sm"
        onError={() => setBroken(tab.faviconUrl ?? null)}
      />
    );
  }
  return <Globe className="h-3 w-3 text-muted-foreground" />;
}

function TabIcon({ tab }: { tab: WorkspaceTab }): React.JSX.Element {
  if (tab.kind === 'browser') return <BrowserTabIcon tab={tab} />;
  if (tab.kind === 'diff') {
    return tab.commit ? (
      <GitCommit className="h-3 w-3 text-muted-foreground" />
    ) : (
      <CodeCompare className="h-3 w-3 text-muted-foreground" />
    );
  }
  if (tab.kind === 'file') {
    return isImagePath(tab.path) ? (
      <ImageIcon className="h-3 w-3 text-muted-foreground" />
    ) : (
      <FileIcon className="h-3 w-3 text-muted-foreground" />
    );
  }
  if (tab.cliId) return <CliLogo cliId={tab.cliId} className="h-3.5 w-3.5" />;
  return <TerminalSquare className="h-3 w-3 text-muted-foreground" />;
}

function browserTabLabel(tab: WorkspaceBrowserTab): string {
  if (tab.title.trim()) return tab.title;
  try {
    return tab.url ? new URL(tab.url).host : 'New tab';
  } catch {
    return tab.url || 'New tab';
  }
}

function tabLabel(tab: WorkspaceTab, agentTitle: string | null): string {
  if (tab.kind === 'browser') return browserTabLabel(tab);
  if (tab.kind === 'diff') {
    const name = tab.path.split('/').pop() ?? tab.path;
    return tab.commit ? `${name} @ ${tab.commit.slice(0, 7)}` : name;
  }
  if (tab.kind === 'file') return tab.path.split(/[\\/]/).pop() ?? tab.path;
  return tab.userTitle ?? agentTitle ?? terminalTabLabel(tab);
}

interface PaneTabProps {
  project: Project;
  projectId: string;
  groupId: string;
  tab: WorkspaceTab;
  active: boolean;
  groupFocused: boolean;
  onSelect: () => void;
  onClose: () => void;
}

function PaneTab({
  project,
  projectId,
  groupId,
  tab,
  active,
  groupFocused,
  onSelect,
  onClose,
}: PaneTabProps): React.JSX.Element {
  const renameTab = useWorkspaceStore((s) => s.renameTab);
  const setAutoContinue = useWorkspaceStore((s) => s.setAutoContinue);
  const setAgentTitle = useWorkspaceStore((s) => s.setAgentTitle);
  const autoContinuePending = useAutoContinuePending(tab.id);
  const openDiff = useWorkspaceStore((s) => s.openDiff);
  const openFile = useWorkspaceStore((s) => s.openFile);
  const liveTitle = useTerminalSessionStore((s) => s.titles[tab.id]);
  const ended = useTerminalSessionStore((s) => tab.id in s.ended);
  const status = useAgentStatus(tab.id);
  const runInfo = useAgentRunInfo(tab.id);
  const cliRunLine = useCliRunLine(tab.kind === 'terminal' ? tab.cliId : undefined);
  const [editing, setEditing] = useState(false);
  const renameRequested = useRef(false);
  // An agent tab takes the name the agent gave its task, as Orca does, once that task is done:
  // renaming the tab while the agent is still working would make it jump around under the user.
  const agentTitle =
    tab.kind === 'terminal' && tab.cliId ? agentSessionTitle(liveTitle, tab.title) : null;
  const [settledTitle, setSettledTitle] = useState(agentTitle);
  useEffect(() => {
    if (status === 'working') return;
    setSettledTitle(agentTitle);
    // The live title only lives as long as this run of the app, so keep it on the tab too.
    // Without that, a restart (or the CLI clearing its own title) drops the tab back to the
    // CLI's name, and every agent tab ends up called the same thing.
    if (agentTitle) setAgentTitle(projectId, tab.id, agentTitle);
  }, [status, agentTitle, projectId, tab.id, setAgentTitle]);
  const label = tabLabel(tab, settledTitle);
  const attention = tab.kind === 'terminal' && !ended ? status : null;
  // What the agent runs on: the live report when it has hooks (Claude Code),
  // else the launch label, the CLI's last run, or its launch default, so a
  // /model or /effort switch mid-session still shows up for hooked agents and
  // every other agent shows the model it started with.
  const runLine =
    tab.kind !== 'terminal' || !tab.cliId ? null : tabRunLine(runInfo, tab.runLabel, cliRunLine);
  const tooltip =
    tab.kind === 'terminal' ? (
      <span className="flex flex-col gap-0.5">
        <span className="font-semibold">{label}</span>
        {label !== tab.title ? <span>{tab.title}</span> : null}
        {runLine ? <span className="text-primary">{runLine}</span> : null}
        {liveTitle && liveTitle !== label && liveTitle !== tab.title ? (
          <span className="text-muted-foreground">{liveTitle}</span>
        ) : null}
        <AgentStatusChip status={attention} className="mt-0.5 self-start" />
        <span className="font-mono text-[10px] text-muted-foreground">{tab.cwd}</span>
      </span>
    ) : tab.kind === 'browser' ? (
      <span className="flex flex-col gap-0.5">
        <span className="font-semibold">{label}</span>
        {tab.url ? (
          <span className="font-mono text-[10px] text-muted-foreground">{tab.url}</span>
        ) : null}
      </span>
    ) : (
      tab.path
    );

  const tabBody = (
    <div
      role="tab"
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      draggable={!editing}
      data-tab-id={tab.id}
      onDragStart={(event) => {
        const payload: DraggedTab = { projectId, tabId: tab.id, groupId };
        event.dataTransfer.setData(TAB_MIME, JSON.stringify(payload));
        event.dataTransfer.effectAllowed = 'move';
        const slot = event.currentTarget.closest<HTMLElement>('[data-tab-slot]');
        beginTabDrag({ ...payload, width: slot?.offsetWidth ?? event.currentTarget.offsetWidth });
      }}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect();
        }
      }}
      onMouseDown={(event) => {
        if (event.button === 1) event.preventDefault();
      }}
      onAuxClick={(event) => {
        if (event.button === 1) {
          event.preventDefault();
          onClose();
        }
      }}
      onDoubleClick={() => {
        if (tab.kind === 'terminal') setEditing(true);
        else if (tab.kind === 'diff' && tab.preview) openDiff(projectId, tab, { pin: true });
        else if (tab.kind === 'file' && tab.preview) openFile(projectId, tab.path, { pin: true });
      }}
      className={cn(
        'group relative flex h-7 min-w-[4.5rem] max-w-[13rem] shrink cursor-pointer select-none items-center gap-1.5 rounded-md pl-2 pr-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        attention === 'needs-input'
          ? 'bg-warning/12 text-foreground ring-1 ring-inset ring-warning/30'
          : active
            ? 'bg-foreground/[0.08] text-foreground'
            : 'text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground',
      )}
    >
      {active && groupFocused ? (
        <span className="absolute inset-x-2 -bottom-[5px] h-[2px] rounded-full bg-primary shadow-[0_0_8px_hsl(var(--primary)/0.7)]" />
      ) : null}
      <TabIcon tab={tab} />
      {editing && tab.kind === 'terminal' ? (
        <input
          autoFocus
          defaultValue={label}
          aria-label="Tab name"
          onClick={(event) => event.stopPropagation()}
          onBlur={(event) => {
            renameTab(projectId, tab.id, event.currentTarget.value);
            setEditing(false);
          }}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === 'Enter') event.currentTarget.blur();
            if (event.key === 'Escape') setEditing(false);
          }}
          className="field-surface h-5 min-w-0 flex-1 rounded-md px-1.5 text-xs outline-none"
        />
      ) : (
        <span
          className={cn(
            'min-w-0 flex-1 truncate',
            (tab.kind === 'diff' || tab.kind === 'file') && tab.preview && 'italic',
            ended && 'text-muted-foreground line-through decoration-foreground/30',
          )}
        >
          {label}
        </span>
      )}
      <AgentStatusDot status={attention} />
      <button
        type="button"
        aria-label={`Close ${label}`}
        tabIndex={-1}
        onClick={(event) => {
          event.stopPropagation();
          onClose();
        }}
        className={cn(
          'flex h-4 w-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-opacity hover:bg-foreground/15 hover:text-foreground',
          active ? 'opacity-70' : 'opacity-0 group-hover:opacity-70',
        )}
      >
        <X className="h-2.5 w-2.5" />
      </button>
    </div>
  );

  const tabElement = (
    <SimpleTooltip label={editing ? null : tooltip} delayDuration={600}>
      {tab.kind === 'diff' ? tabBody : <ContextMenuTrigger asChild>{tabBody}</ContextMenuTrigger>}
    </SimpleTooltip>
  );

  if (tab.kind === 'diff') return tabElement;
  if (tab.kind === 'file') {
    return (
      <ContextMenu>
        {tabElement}
        <FileTabMenu project={project} path={tab.path} onClose={onClose} />
      </ContextMenu>
    );
  }
  if (tab.kind === 'browser') {
    return (
      <ContextMenu>
        {tabElement}
        <BrowserTabMenu tab={tab} onClose={onClose} />
      </ContextMenu>
    );
  }
  const isAgent = Boolean(tab.cliId) && !ended;
  return (
    <ContextMenu>
      {tabElement}
      <ContextMenuContent
        className="w-64"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          // The menu keeps focus trapped until it has finished closing, which would blur the
          // name field straight away, so Rename only starts once it is fully gone.
          if (renameRequested.current) {
            renameRequested.current = false;
            setEditing(true);
          }
        }}
      >
        <ContextMenuItem
          onSelect={() => {
            renameRequested.current = true;
          }}
        >
          Rename
        </ContextMenuItem>
        {isAgent ? (
          <>
            <ContextMenuSeparator />
            <ContextMenuLabel>Auto-continue</ContextMenuLabel>
            <ContextMenuCheckboxItem
              checked={Boolean(tab.autoContinue?.afterLimitReset)}
              onSelect={(event) => event.preventDefault()}
              onCheckedChange={(checked) =>
                setAutoContinue(projectId, tab.id, { afterLimitReset: checked })
              }
            >
              After the usage limit resets
            </ContextMenuCheckboxItem>
            <ContextMenuCheckboxItem
              checked={Boolean(tab.autoContinue?.afterNetworkError)}
              onSelect={(event) => event.preventDefault()}
              onCheckedChange={(checked) =>
                setAutoContinue(projectId, tab.id, { afterNetworkError: checked })
              }
            >
              After a network error
            </ContextMenuCheckboxItem>
            {autoContinuePending ? (
              <>
                <p className="px-2 py-1 text-[11px] text-muted-foreground">
                  {autoContinuePendingLine(autoContinuePending)}
                </p>
                <ContextMenuItem
                  onSelect={() => void window.agentmat.agents.cancelAutoContinue(tab.id)}
                >
                  Cancel scheduled continue
                </ContextMenuItem>
              </>
            ) : null}
          </>
        ) : null}
        <ContextMenuSeparator />
        <ContextMenuItem tone="danger" onSelect={onClose}>
          Close
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function SessionEndedBar({
  exitCode,
  onRestart,
  onClose,
}: {
  exitCode: number | null;
  onRestart: () => void;
  onClose: () => void;
}): React.JSX.Element {
  const message =
    exitCode === null
      ? 'This session ended while AgentMate was closed.'
      : `Process exited${exitCode === 0 ? '' : ` with code ${exitCode}`}.`;
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-3 z-10 flex justify-center px-3">
      {/* The terminal can have any background the user picked, so the bar is the app's own
          frosted overlay rather than a fixed dark pill. The !-radius beats the overlay's corners. */}
      <div
        className={cn(
          OVERLAY_SURFACE,
          'pointer-events-auto flex items-center gap-3 rounded-full! py-1 pl-4 pr-1 text-xs text-muted-foreground animate-in fade-in-0 slide-in-from-bottom-2',
        )}
      >
        <span>{message}</span>
        <Button size="sm" onClick={onRestart} className="gap-1.5">
          <RefreshCw className="h-3 w-3" /> Restart
        </Button>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
      </div>
    </div>
  );
}

export interface PaneGroupProps {
  project: Project;
  workspace: ProjectWorkspace;
  group: PaneGroupNode;
  /** More than one pane is on screen, so focus and pane actions need to show. */
  multiPane: boolean;
}

export function PaneGroup({
  project,
  workspace,
  group,
  multiPane,
}: PaneGroupProps): React.JSX.Element {
  const projectId = project.id;
  const store = useWorkspaceStore;
  const focusGroup = useWorkspaceStore((s) => s.focusGroup);
  const activateTab = useWorkspaceStore((s) => s.activateTab);
  const closeTab = useWorkspaceStore((s) => s.closeTab);
  const restartTab = useWorkspaceStore((s) => s.restartTab);
  const splitGroup = useWorkspaceStore((s) => s.splitGroup);
  const closeGroup = useWorkspaceStore((s) => s.closeGroup);
  const toggleZoom = useWorkspaceStore((s) => s.toggleZoom);
  const setLauncherFor = useLauncherStore((s) => s.setOpenFor);
  const splitRightLabel = useShortcutLabel('workspace.splitRight');
  const splitDownLabel = useShortcutLabel('workspace.splitDown');
  const zoomLabel = useShortcutLabel('workspace.zoomPane');
  const newTabLabel = useShortcutLabel('workspace.newTab');

  const focused = workspace.focusedGroupId === group.id;
  const zoomed = workspace.zoomedGroupId === group.id;
  const activeTab = group.activeTabId ? workspace.tabs[group.activeTabId] : undefined;
  const exitCode = useTerminalSessionStore((s) =>
    activeTab && activeTab.id in s.ended ? s.ended[activeTab.id] : undefined,
  );
  // An agent tab whose shell did not survive AgentMate closing (a reboot, a crash, or the task
  // being killed) picks its conversation back up, rather than leaving a dead tab to restart.
  const resumeTab =
    exitCode === null &&
    activeTab?.kind === 'terminal' &&
    activeTab.restored &&
    resumeInputFor(activeTab) !== null
      ? activeTab
      : null;
  useEffect(() => {
    if (!resumeTab) return;
    // Built once the status hooks are known, so the resumed agent still reports its status.
    void statusHooksReady(resumeTab.cliId).then(() => {
      const input = resumeInputFor(resumeTab);
      if (input) restartTab(projectId, resumeTab.id, input);
    });
  }, [resumeTab, projectId, restartTab]);
  const workspaceEmpty = Object.keys(workspace.tabs).length === 0;

  const stripRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [dropZone, setDropZone] = useState<DropZone | null>(null);
  const tabs = group.tabIds.flatMap((tabId) => {
    const tab = workspace.tabs[tabId];
    return tab ? [tab] : [];
  });

  // The tab held over the strip. The ref is what the drop reads, since a render can land between
  // the window seeing the drop and the strip handling it.
  const [stripDrag, setStripDragState] = useState<StripDrag | null>(null);
  const stripDragRef = useRef<StripDrag | null>(null);
  const setStripDrag = useCallback((next: StripDrag | null) => {
    stripDragRef.current = next;
    setStripDragState(next);
  }, []);
  // The tab picked up from this strip, drawn faded until the drag ends.
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null);

  useEffect(() => {
    if (!draggingTabId && !stripDrag) return;
    const endDrag = (): void => {
      setDraggingTabId(null);
      setStripDrag(null);
    };
    // A drop that moves the tab to another pane unmounts it here, so no dragend may follow.
    const endPickup = (): void => setDraggingTabId(null);
    window.addEventListener('dragend', endDrag, true);
    window.addEventListener('drop', endPickup, true);
    return () => {
      window.removeEventListener('dragend', endDrag, true);
      window.removeEventListener('drop', endPickup, true);
    };
  }, [draggingTabId, stripDrag, setStripDrag]);

  // Where each slot was last drawn, slide included, so a slot whose place changes can glide there
  // from where the user last saw it. That covers a drop here, a tab moved off to another pane
  // and a tab closed.
  const drawnRef = useRef(new Map<string, number>());
  const orderKey = tabs.map((tab) => tab.id).join('\n');
  const drawnOrderRef = useRef(orderKey);
  useLayoutEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const slots = Array.from(strip.querySelectorAll<HTMLElement>(':scope > [data-tab-slot]'));
    // Mid-drag the slots are placed by the slide itself, so they're left to it.
    if (drawnOrderRef.current !== orderKey && !stripDrag) {
      const drawn = drawnRef.current;
      // Transitions go off before anything is read, so the layout reads below can't start one.
      for (const slot of slots) slot.style.transition = 'none';
      for (const slot of slots) {
        const start = drawn.get(slot.dataset.tabSlot ?? '');
        const gap = start === undefined ? 0 : start - slot.offsetLeft;
        slot.style.transform = gap ? `translateX(${gap}px)` : '';
      }
      // Reading layout applies those starting spots, so the release below is the change that moves.
      strip.getBoundingClientRect();
      for (const slot of slots) {
        slot.style.transition = '';
        slot.style.transform = '';
      }
    }
    drawnOrderRef.current = orderKey;
    drawnRef.current = new Map(
      slots.map((slot, index) => [
        slot.dataset.tabSlot ?? '',
        slot.offsetLeft + (stripDrag ? slotShift(stripDrag, index) : 0),
      ]),
    );
  });

  // Arrows show at either end once the tabs no longer fit, like the terminal drawer's.
  const [overflow, setOverflow] = useState({ start: false, end: false });
  const syncOverflow = useCallback(() => {
    const el = stripRef.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    setOverflow((prev) => {
      const next = { start: el.scrollLeft > 1, end: el.scrollLeft < max - 1 };
      return prev.start === next.start && prev.end === next.end ? prev : next;
    });
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: tabs were added, removed or switched, so the new slots need observing and the active one scrolled into view
  useLayoutEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    // Offsets, not client rects: a slot still gliding to its new place would read off by its slide.
    const active = el
      .querySelector('[aria-selected="true"]')
      ?.closest<HTMLElement>('[data-tab-slot]');
    if (active) {
      const left = active.offsetLeft;
      const right = left + active.offsetWidth;
      if (left < el.scrollLeft) el.scrollLeft = left;
      else if (right > el.scrollLeft + el.clientWidth) el.scrollLeft = right - el.clientWidth;
    }
    syncOverflow();
    const observer = new ResizeObserver(syncOverflow);
    observer.observe(el);
    for (const child of Array.from(el.children)) observer.observe(child);
    return () => observer.disconnect();
  }, [orderKey, group.activeTabId, syncOverflow]);

  const scrollStrip = useCallback((delta: number, behavior: ScrollBehavior) => {
    stripRef.current?.scrollBy({ left: delta, behavior });
  }, []);

  // Wheel scrolls the strip sideways once tabs no longer fit.
  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent): void => {
      if (el.scrollWidth <= el.clientWidth || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) {
        return;
      }
      el.scrollLeft += event.deltaY;
      event.preventDefault();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Only ask before stopping an agent that is busy. One that was just opened, or has already
  // finished its task, closes straight away.
  async function requestCloseTab(tabId: string): Promise<void> {
    const tab = workspace.tabs[tabId];
    const ended = tabId in useTerminalSessionStore.getState().ended;
    if (tab?.kind === 'terminal' && tab.cliId && !ended && isSessionBusy(tabId)) {
      const ok = await confirmDialog({
        title: `Close ${terminalTabLabel(tab)}?`,
        description: 'The agent running in this tab will be stopped.',
        confirmLabel: 'Close tab',
        variant: 'destructive',
      });
      if (!ok) return;
    }
    closeTab(projectId, tabId);
  }

  async function requestCloseGroup(): Promise<void> {
    const running = group.tabIds.filter(
      (id) =>
        workspace.tabs[id]?.kind === 'terminal' &&
        !(id in useTerminalSessionStore.getState().ended) &&
        isSessionBusy(id),
    );
    if (running.length > 0) {
      const ok = await confirmDialog({
        title: 'Close this pane?',
        description: `${running.length} terminal${running.length === 1 ? '' : 's'} in it will be stopped.`,
        confirmLabel: 'Close pane',
        variant: 'destructive',
      });
      if (!ok) return;
    }
    closeGroup(projectId, group.id);
  }

  /**
   * Works out where a held tab would land and makes room for it. The slots are measured by their
   * offsets, which the slide doesn't change, so the landing spot doesn't flicker as they move.
   */
  function trackStripDrag(event: React.DragEvent): void {
    const el = stripRef.current;
    if (!el) return;
    const slots = Array.from(el.querySelectorAll<HTMLElement>(':scope > [data-tab-slot]'));
    const boxes = slots.map((slot) => ({ left: slot.offsetLeft, width: slot.offsetWidth }));
    const x = event.clientX - el.getBoundingClientRect().left + el.scrollLeft;
    const index = boxes.findIndex((box) => x < box.left + box.width / 2);
    const live = liveTabDrag?.projectId === projectId ? liveTabDrag : null;
    const from = live ? slots.findIndex((slot) => slot.dataset.tabSlot === live.tabId) : -1;
    const next: StripDrag = {
      at: index === -1 ? boxes.length : index,
      from,
      width: from !== -1 ? boxes[from].width : (live?.width ?? 0),
      boxes,
    };
    if (!sameStripDrag(stripDragRef.current, next)) setStripDrag(next);
  }

  function dropOnStrip(event: React.DragEvent): void {
    const dragged = readDraggedTab(event);
    const at = stripDragRef.current?.at ?? group.tabIds.length;
    setStripDrag(null);
    if (!dragged || dragged.projectId !== projectId) return;
    event.preventDefault();
    const from = group.tabIds.indexOf(dragged.tabId);
    // Moving right within the same strip: the tab's own slot disappears first.
    const index = from !== -1 && from < at ? at - 1 : at;
    store.getState().moveTab(projectId, dragged.tabId, group.id, index);
  }

  function dropOnBody(event: React.DragEvent): void {
    const dragged = readDraggedTab(event);
    const zone = dropZone;
    setDropZone(null);
    if (!dragged || dragged.projectId !== projectId || !zone) return;
    event.preventDefault();
    const state = store.getState();
    if (zone === 'center') {
      if (dragged.groupId !== group.id) state.moveTab(projectId, dragged.tabId, group.id);
      return;
    }
    // Splitting a pane with its own only tab would put everything back where it was.
    if (dragged.groupId === group.id && group.tabIds.length === 1) return;
    const direction = zone === 'left' || zone === 'right' ? 'row' : 'column';
    const side = zone === 'left' || zone === 'top' ? 'before' : 'after';
    const target = state.splitGroup(projectId, group.id, direction, side);
    state.moveTab(projectId, dragged.tabId, target);
  }

  return (
    <section
      data-pane-group-id={group.id}
      aria-label={`${project.name} pane`}
      onPointerDownCapture={() => {
        if (!focused) focusGroup(projectId, group.id);
      }}
      className={cn(
        'chrome-island relative flex h-full min-h-0 w-full min-w-0 flex-col transition-shadow duration-150',
        // The island's own edge colour is unlayered, so the focused edge is drawn in the shadow.
        multiPane &&
          focused &&
          'shadow-[0_0_0_1px_hsl(var(--primary)/0.4),0_0_24px_-10px_hsl(var(--primary)/0.5)]',
      )}
    >
      <header className="flex h-9 shrink-0 items-center gap-1 px-1.5 shadow-[inset_0_-1px_0_hsl(var(--border)/0.6)]">
        {/* The whole stretch up to the pane buttons takes a dropped tab, not only the tabs. */}
        <div
          onDragOver={(event) => {
            if (!isTabDrag(event)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
            trackStripDrag(event);
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node)) setStripDrag(null);
          }}
          onDrop={dropOnStrip}
          className="flex h-full min-w-0 flex-1 items-center gap-0.5"
        >
          {overflow.start || overflow.end ? (
            <StripArrow side="left" disabled={!overflow.start} onScroll={scrollStrip} />
          ) : null}
          <div
            ref={stripRef}
            role="tablist"
            aria-label="Tabs"
            onScroll={syncOverflow}
            // The strip is only as wide as its tabs, so it grows by the gap a tab from another
            // pane needs, or the last tabs would slide out of sight.
            style={
              stripDrag && stripDrag.from === -1 && stripDrag.width > 0
                ? { paddingRight: stripDrag.width + slotGap(stripDrag.boxes) }
                : undefined
            }
            className="relative flex min-w-0 items-center gap-0.5 overflow-x-auto overflow-y-hidden py-1 transition-[padding] duration-200 ease-out motion-reduce:transition-none [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {tabs.map((tab, index) => {
              const shift = stripDrag ? slotShift(stripDrag, index) : 0;
              // The slot never gets narrower than the tab's own minimum. Below it the tab spilled
              // out of its slot and the next tab covered it, so a click on it hit its neighbor.
              // A strip too full for every tab scrolls instead.
              return (
                <div
                  key={tab.id}
                  data-tab-slot={tab.id}
                  // Faded only after the browser has taken its picture of the tab for the drag.
                  onDragStart={() => window.setTimeout(() => setDraggingTabId(tab.id))}
                  style={shift ? { transform: `translateX(${shift}px)` } : undefined}
                  className={cn(
                    'relative flex min-w-[4.5rem] shrink items-center transition-[transform,opacity] duration-200 ease-out motion-reduce:transition-none',
                    draggingTabId === tab.id && 'opacity-40',
                  )}
                >
                  <PaneTab
                    project={project}
                    projectId={projectId}
                    groupId={group.id}
                    tab={tab}
                    active={tab.id === group.activeTabId}
                    groupFocused={focused}
                    onSelect={() => activateTab(projectId, tab.id)}
                    onClose={() => void requestCloseTab(tab.id)}
                  />
                </div>
              );
            })}
            {stripDrag && stripDrag.from === -1 && stripDrag.width > 0 ? (
              <span
                data-tab-landing
                style={{ left: landingLeft(stripDrag), width: stripDrag.width }}
                className="pointer-events-none absolute top-1 h-7 rounded-md bg-primary/10 ring-1 ring-inset ring-primary/40"
              />
            ) : null}
          </div>
          {overflow.start || overflow.end ? (
            <StripArrow side="right" disabled={!overflow.end} onScroll={scrollStrip} />
          ) : null}
          <LauncherMenu project={project} groupId={group.id}>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="New tab"
              className="ml-0.5 shrink-0 data-[state=open]:bg-foreground/10 data-[state=open]:text-foreground"
            >
              <Plus />
            </Button>
          </LauncherMenu>
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          {activeTab?.kind === 'terminal' && activeTab.cliId && exitCode === undefined ? (
            <AutoContinueMenu projectId={projectId} tab={activeTab} />
          ) : null}
          <PaneIconButton
            label={splitRightLabel ? `Split right (${splitRightLabel})` : 'Split right'}
            onClick={() => setLauncherFor(splitGroup(projectId, group.id, 'row'))}
          >
            <SplitView className="h-3 w-3" />
          </PaneIconButton>
          <PaneIconButton
            label={splitDownLabel ? `Split down (${splitDownLabel})` : 'Split down'}
            onClick={() => setLauncherFor(splitGroup(projectId, group.id, 'column'))}
          >
            <SplitView className="h-3 w-3 rotate-90" />
          </PaneIconButton>
          {multiPane ? (
            <>
              <PaneIconButton
                label={
                  zoomed ? 'Restore pane' : zoomLabel ? `Zoom pane (${zoomLabel})` : 'Zoom pane'
                }
                active={zoomed}
                onClick={() => toggleZoom(projectId, group.id)}
              >
                {zoomed ? <Compress className="h-3 w-3" /> : <Expand className="h-3 w-3" />}
              </PaneIconButton>
              <PaneIconButton label="Close pane" onClick={() => void requestCloseGroup()}>
                <X className="h-3 w-3" />
              </PaneIconButton>
            </>
          ) : null}
        </div>
      </header>

      <div
        ref={bodyRef}
        className="relative min-h-0 flex-1"
        onDragOver={(event) => {
          if (!isTabDrag(event) || !bodyRef.current) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
          setDropZone(zoneAt(event, bodyRef.current));
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropZone(null);
        }}
        onDrop={dropOnBody}
      >
        {activeTab?.kind === 'terminal' ? (
          <>
            <TerminalSlot
              key={activeTab.id}
              projectId={projectId}
              tab={activeTab}
              focused={focused}
            />
            {exitCode !== undefined && !resumeTab ? (
              <SessionEndedBar
                exitCode={exitCode}
                onRestart={() => restartTab(projectId, activeTab.id)}
                onClose={() => closeTab(projectId, activeTab.id)}
              />
            ) : null}
          </>
        ) : activeTab?.kind === 'diff' ? (
          <Suspense
            fallback={
              <div className="space-y-2 p-4">
                <Skeleton className="h-5 w-1/3" />
                <Skeleton className="h-40 w-full" />
              </div>
            }
          >
            <DiffTab project={project} tab={activeTab} focused={focused} />
          </Suspense>
        ) : activeTab?.kind === 'file' ? (
          <Suspense
            fallback={
              <div className="space-y-2 p-4">
                <Skeleton className="h-5 w-1/3" />
                <Skeleton className="h-40 w-full" />
              </div>
            }
          >
            <FileTab key={activeTab.id} project={project} tab={activeTab} />
          </Suspense>
        ) : activeTab?.kind === 'browser' ? (
          <Suspense
            fallback={
              <div className="space-y-2 p-2">
                <Skeleton className="h-7 w-full" />
                <Skeleton className="h-40 w-full" />
              </div>
            }
          >
            <BrowserTab
              key={activeTab.id}
              project={project}
              tabId={activeTab.id}
              focused={focused}
            />
          </Suspense>
        ) : (
          <PaneLauncher
            project={project}
            groupId={group.id}
            hero={workspaceEmpty && !multiPane}
            focused={focused}
          />
        )}

        {dropZone ? (
          <div
            className={cn(
              // A dashed outline, since the global border colour would grey out a dashed border.
              'pointer-events-none absolute z-20 rounded-xl bg-primary/10 outline-2 -outline-offset-2 outline-dashed outline-primary/60 transition-all duration-100',
              ZONE_PREVIEW[dropZone],
            )}
          />
        ) : null}
      </div>

      {!activeTab && newTabLabel && !workspaceEmpty ? (
        <p className="pointer-events-none absolute bottom-2 left-0 right-0 text-center text-[10px] text-muted-foreground/60">
          {newTabLabel} opens the tab menu
        </p>
      ) : null}
    </section>
  );
}
