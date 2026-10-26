import { getCliDefinition, type Project } from '@runova/core';
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { toast } from 'sonner';
import { Crosshair, MessageSquarePlus } from '@/components/icons';
import { OVERLAY_SURFACE } from '@/components/ui/overlay';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { elementLabel } from '@/lib/browser/annotationPrompt';
import { browserRuntime } from '@/lib/browser/browserRuntime';
import { onBrowserShortcut } from '@/lib/browser/browserSync';
import { copyAnnotations, sendAnnotations } from '@/lib/browser/sendAnnotations';
import type { BrowserAnnotation } from '@/lib/browser/types';
import { viewportPreset } from '@/lib/browser/viewportPresets';
import { useTerminalSessionStore } from '@/lib/terminal/terminalRuntime';
import { cn } from '@/lib/utils';
import { listAgentTerminals } from '@/lib/workspace/agentTarget';
import { projectCliId } from '@/lib/workspace/launch';
import { useBrowserStore } from '@/stores/browserStore';
import { confirmDialog } from '@/stores/confirmStore';
import { detectedServersFor, useDevServerStore } from '@/stores/devServerStore';
import {
  terminalTabLabel,
  useWorkspaceStore,
  type WorkspaceBrowserTab,
} from '@/stores/workspaceStore';
import { useAgentChoices } from '../useAgentChoices';
import { BrowserError } from './BrowserError';
import { BrowserStartPage } from './BrowserStartPage';
import { BrowserToolbar } from './BrowserToolbar';
import { CommentComposer } from './CommentComposer';
import { CommentTray, type SendTargets } from './CommentTray';
import { usePagePicker } from './usePagePicker';

/**
 * A workspace tab showing a web page, usually the project's dev server, where elements can be
 * picked and commented on for the agent. The page itself lives in the browser runtime's layer
 * and is laid over this tab's body (see browserRuntime.ts); what sits over the page, the comment
 * tray and the picking hint, is portaled into the layer above it.
 */

const NO_ANNOTATIONS: BrowserAnnotation[] = [];

function cliName(cliId: string | null | undefined): string | null {
  return cliId ? (getCliDefinition(cliId)?.name ?? cliId) : null;
}

/** The dev servers printed by terminals of this workspace. */
function useWorkspaceServers(projectId: string) {
  const servers = useDevServerStore((s) => s.servers);
  const tabs = useWorkspaceStore((s) => s.workspaces[projectId]?.tabs);
  const terminals = Object.values(tabs ?? {}).flatMap((tab) =>
    tab.kind === 'terminal' ? [{ id: tab.id, title: terminalTabLabel(tab) }] : [],
  );
  return detectedServersFor(servers, terminals);
}

function useSendTargets(project: Project): SendTargets {
  // Both only make this component render again when agents come and go; the list is read below.
  useWorkspaceStore((s) => s.workspaces[project.id]?.tabs);
  useTerminalSessionStore((s) => s.ended);
  const agents = useAgentChoices(project);
  const running = listAgentTerminals(project.id).map((tab) => ({
    tabId: tab.id,
    cliId: tab.cliId ?? '',
    label: terminalTabLabel(tab),
  }));
  return {
    defaultLabel: cliName(running[0]?.cliId) ?? cliName(projectCliId(project)) ?? 'your agent',
    running,
    newTabs: agents.installed.map((choice) => ({ cliId: choice.cli.id, name: choice.cli.name })),
  };
}

function PickingHint({ intent }: { intent: 'copy' | 'comment' }): React.JSX.Element {
  const Icon = intent === 'copy' ? Crosshair : MessageSquarePlus;
  return (
    <div className="pointer-events-none absolute inset-x-0 top-2 flex justify-center px-3">
      {/* The app's frosted overlay, like a menu. The !-radius beats the overlay's own corners. */}
      <div
        className={cn(
          OVERLAY_SURFACE,
          'flex items-center gap-2 rounded-full! py-1 pl-2.5 pr-3 text-[11px] text-foreground animate-in fade-in-0 slide-in-from-top-1',
        )}
      >
        <Icon className="h-3 w-3 text-primary" />
        {intent === 'copy' ? (
          <span>Click an element to copy its details · Esc to stop</span>
        ) : (
          <span>Click an element to comment · Right-click to copy · Esc to stop</span>
        )}
      </div>
    </div>
  );
}

function BrowserTabBody({
  project,
  tab,
}: {
  project: Project;
  tab: WorkspaceBrowserTab;
}): React.JSX.Element {
  const setBrowserPage = useWorkspaceStore((s) => s.setBrowserPage);
  const setBrowserViewport = useWorkspaceStore((s) => s.setBrowserViewport);
  const hasPage = tab.url !== '';
  const slotRef = useRef<HTMLDivElement>(null);
  const [overlay, setOverlay] = useState<HTMLElement | null>(null);
  const [focusAddressToken, setFocusAddressToken] = useState(0);

  // The page is created once per tab and kept by the runtime; this only asks for it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: tab.url is only the first address, later navigations happen inside the page
  useLayoutEffect(() => {
    if (!hasPage) {
      setOverlay(null);
      return;
    }
    browserRuntime.ensure(tab.id, tab.url);
    setOverlay(browserRuntime.overlay(tab.id));
  }, [hasPage, tab.id]);

  useLayoutEffect(() => {
    const slot = slotRef.current;
    if (!hasPage || !slot) return;
    return browserRuntime.attach(tab.id, slot);
  }, [hasPage, tab.id]);

  useEffect(() => {
    if (hasPage) browserRuntime.setViewport(tab.id, tab.viewport);
  }, [hasPage, tab.id, tab.viewport]);

  const nav = useSyncExternalStore(
    (listener) => browserRuntime.subscribe(tab.id, listener),
    () => browserRuntime.state(tab.id),
  );
  const pageUrl = nav.url || tab.url;
  const preset = viewportPreset(tab.viewport);
  const picker = usePagePicker({
    project,
    tabId: tab.id,
    url: pageUrl,
    preset: preset.id === 'responsive' ? null : preset.label,
  });
  const annotations = useBrowserStore((s) => s.annotations[tab.id]) ?? NO_ANNOTATIONS;
  const servers = useWorkspaceServers(project.id);
  const recent = useBrowserStore((s) => s.recentUrls[project.id]) ?? NO_ANNOTATIONS_URLS;
  const targets = useSendTargets(project);

  const open = (url: string): void => {
    if (hasPage) browserRuntime.navigate(tab.id, url);
    else setBrowserPage(project.id, tab.id, { url, title: '', faviconUrl: null });
  };

  // Browser shortcuts pressed while the page has focus, handed over by main.
  useEffect(
    () =>
      onBrowserShortcut(tab.id, (shortcut) => {
        if (shortcut === 'pick') picker.start('comment');
        else if (shortcut === 'focusAddress') setFocusAddressToken((n) => n + 1);
        else if (shortcut === 'reload') browserRuntime.reload(tab.id, false);
        else if (shortcut === 'hardReload') browserRuntime.reload(tab.id, true);
        else if (shortcut === 'back') browserRuntime.back(tab.id);
        else if (shortcut === 'forward') browserRuntime.forward(tab.id);
        else if (shortcut === 'devtools') browserRuntime.openDevTools(tab.id);
      }),
    [tab.id, picker.start],
  );

  const clear = async (): Promise<void> => {
    if (annotations.length > 2) {
      const ok = await confirmDialog({
        title: `Clear ${annotations.length} comments?`,
        description: 'They have not been sent to an agent yet.',
        confirmLabel: 'Clear',
        variant: 'destructive',
      });
      if (!ok) return;
    }
    useBrowserStore.getState().clearTab(tab.id);
  };

  const composing = picker.state.mode === 'composing' ? picker.state.payload : null;
  const frame = browserRuntime.frame(tab.id);
  const anchor = composing?.element.rectViewport;

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      onKeyDownCapture={(event) => {
        // Ctrl+L while the tab's own controls have focus; inside the page main hands it over.
        const mod = event.ctrlKey || event.metaKey;
        if (mod && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'l') {
          event.preventDefault();
          setFocusAddressToken((n) => n + 1);
        }
      }}
    >
      <BrowserToolbar
        nav={{ ...nav, url: pageUrl }}
        viewport={tab.viewport}
        picking={
          picker.state.mode === 'picking' ? picker.state.intent : composing ? 'comment' : null
        }
        commentCount={annotations.length}
        focusAddressToken={focusAddressToken}
        onNavigate={open}
        onBack={() => browserRuntime.back(tab.id)}
        onForward={() => browserRuntime.forward(tab.id)}
        onReload={(hard) => browserRuntime.reload(tab.id, hard)}
        onStop={() => browserRuntime.stop(tab.id)}
        onPick={picker.start}
        onViewport={(viewport) => setBrowserViewport(project.id, tab.id, viewport)}
        onDevTools={() => browserRuntime.openDevTools(tab.id)}
        onOpenExternal={() => void window.runova.shell.openExternal(pageUrl)}
        onCopyUrl={() => {
          void navigator.clipboard.writeText(pageUrl);
          toast.success('Address copied');
        }}
      />

      <div className="relative min-h-0 flex-1 bg-[repeating-linear-gradient(135deg,hsl(var(--foreground)/0.025)_0_10px,transparent_10px_20px)]">
        {hasPage ? (
          <div ref={slotRef} data-browser-slot={tab.id} className="absolute inset-0" />
        ) : (
          <BrowserStartPage servers={servers} recent={recent} onOpen={open} />
        )}
      </div>

      {overlay
        ? createPortal(
            <>
              {nav.error ? (
                <BrowserError
                  error={nav.error}
                  servers={servers}
                  onRetry={() => browserRuntime.reload(tab.id, false)}
                  onOpen={open}
                />
              ) : null}
              {picker.state.mode === 'picking' ? (
                <PickingHint intent={picker.state.intent} />
              ) : null}
              <Popover open={!!composing}>
                {anchor ? (
                  <PopoverAnchor asChild>
                    <div
                      className="pointer-events-none absolute"
                      style={{
                        left: frame.left + anchor.x * frame.scale,
                        top: frame.top + anchor.y * frame.scale,
                        width: Math.max(1, anchor.width * frame.scale),
                        height: Math.max(1, anchor.height * frame.scale),
                      }}
                    />
                  </PopoverAnchor>
                ) : null}
                {composing ? (
                  <PopoverContent
                    side="bottom"
                    align="start"
                    sideOffset={10}
                    className="w-auto p-3"
                    onOpenAutoFocus={(event) => event.preventDefault()}
                    onEscapeKeyDown={(event) => {
                      event.preventDefault();
                      picker.cancelCard();
                    }}
                    onInteractOutside={(event) => event.preventDefault()}
                  >
                    <CommentComposer
                      label={elementLabel(composing.element)}
                      selector={composing.element.selector}
                      thumbDataUrl={picker.shot?.thumbDataUrl ?? null}
                      sendLabel={`Send to ${targets.defaultLabel}`}
                      onAdd={picker.add}
                      onSend={(draft) => void picker.sendNow(draft)}
                      onCancel={picker.cancelCard}
                    />
                  </PopoverContent>
                ) : null}
              </Popover>
              <CommentTray
                annotations={annotations}
                currentUrl={pageUrl}
                targets={targets}
                onSend={(target) => {
                  picker.stop();
                  void sendAnnotations(project, tab.id, target);
                }}
                onCopy={() => void copyAnnotations(tab.id)}
                onClear={() => void clear()}
                onEdit={(id, comment) =>
                  useBrowserStore.getState().updateAnnotation(tab.id, id, { comment })
                }
                onRemove={(id) => useBrowserStore.getState().removeAnnotation(tab.id, id)}
                onHover={picker.flash}
                onReveal={(annotation) => {
                  if (
                    annotation.page.url.replace(/#(?!\/).*$/, '') ===
                    pageUrl.replace(/#(?!\/).*$/, '')
                  ) {
                    picker.reveal(annotation.id);
                  } else {
                    browserRuntime.navigate(tab.id, annotation.page.url);
                  }
                }}
              />
            </>,
            overlay,
          )
        : null}
    </div>
  );
}

const NO_ANNOTATIONS_URLS: string[] = [];

export default function BrowserTab({
  project,
  tabId,
}: {
  project: Project;
  tabId: string;
  focused: boolean;
}): React.JSX.Element | null {
  const tab = useWorkspaceStore((s) => s.workspaces[project.id]?.tabs[tabId]);
  if (tab?.kind !== 'browser') return null;
  return <BrowserTabBody project={project} tab={tab} />;
}
