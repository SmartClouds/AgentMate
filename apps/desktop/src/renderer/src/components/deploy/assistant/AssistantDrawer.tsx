import { coreErrorMessage } from '@shared/coreErrors';
import type {
  DeployAssistantAppRef,
  DeployAssistantChatSummary,
} from '@shared/deployAssistantTypes';
import type { DeployServer } from '@shared/deployTypes';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { toast } from 'sonner';
import {
  History,
  MessageSquarePlus,
  Robot,
  WindowMaximize,
  WindowRestore,
  X,
} from '@/components/icons';
import { Chip, FOOTER_HAIRLINE } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import {
  type AssistantAiChoice,
  type AssistantProjectChoice,
  isRunActive,
  useDeployAssistantStore,
} from '@/stores/deployAssistantStore';
import { AppAttachment } from './AppAttachment';
import { AssistantComposer } from './AssistantComposer';
import { AssistantHistory } from './AssistantHistory';
import { AssistantTimeline } from './AssistantTimeline';
import { runFromChain } from './historyTurns';
import { useAssistantMode } from './hooks';
import { ModeSwitch } from './ModeSwitch';

/**
 * The Deploy AI drawer (E09 T8), on the right of every Deploy screen. It shows what the AI was
 * pointed at, how commands run (the core's mode), the run as a timeline with approve and skip,
 * the live output, a stop button and follow-up questions. A follow-up, or a Continue after a
 * stop, carries the chat on with what the AI learned so far; New chat starts over. It does not
 * cover the page, so the logs stay readable next to it; Escape closes it and the run carries on.
 * It sits in the page area, under the top bar, so the Deploy AI button there stays in reach to
 * close it again. Its size and what is typed in it are kept in the store, so leaving the page
 * and coming back finds them as they were. On an app's page that app is attached to a new chat,
 * so the AI knows what "it" is; the History button lists the server's past chats, and picking
 * one shows it here, ready to carry on.
 */

/** A container id is 64 hex characters; the first 12 are what Docker shows. */
function shortContainer(id: string): string {
  return /^[0-9a-f]{64}$/i.test(id) ? id.slice(0, 12) : id;
}

/** How close to the end still counts as being at the end, in pixels. */
const BOTTOM_SLACK = 24;

export function AssistantDrawer({ server }: { server: DeployServer }): React.JSX.Element | null {
  const openServerId = useDeployAssistantStore((state) => state.openServerId);
  const draft = useDeployAssistantStore((state) => state.draft);
  const run = useDeployAssistantStore((state) => state.runs[server.id]);
  const close = useDeployAssistantStore((state) => state.close);
  const reset = useDeployAssistantStore((state) => state.reset);
  const followUp = useDeployAssistantStore((state) => state.followUp);
  const restore = useDeployAssistantStore((state) => state.restore);
  const said = useDeployAssistantStore((state) => state.said);
  const clearDraft = useDeployAssistantStore((state) => state.clearDraft);
  const maximized = useDeployAssistantStore((state) => state.maximized);
  const setMaximized = useDeployAssistantStore((state) => state.setMaximized);
  const pageApp = useDeployAssistantStore((state) =>
    state.pageApp?.serverId === server.id ? state.pageApp : null,
  );
  const dismissed = useDeployAssistantStore((state) => state.dismissedApps[server.id]);
  const dismissApp = useDeployAssistantStore((state) => state.dismissApp);
  const setChatApp = useDeployAssistantStore((state) => state.setChatApp);
  const continueFrom = useDeployAssistantStore((state) => state.continueFrom[server.id]);
  const clearContinueFrom = useDeployAssistantStore((state) => state.clearContinueFrom);
  const openChat = useDeployAssistantStore((state) => state.openChat);
  const [view, setView] = useState<'chat' | 'history'>('chat');
  /** The newest run main has for this server's chat on screen, which the history marks. */
  const [liveRunId, setLiveRunId] = useState<string | undefined>();
  const open = openServerId === server.id;
  const mode = useAssistantMode(server.id, open);
  const panel = useRef<HTMLElement | null>(null);
  const body = useRef<HTMLDivElement | null>(null);
  const follow = useRef(true);
  const context = draft?.serverId === server.id ? draft.context : null;
  const progress = run?.progress ?? null;
  const running = isRunActive(progress);
  // Stopped, finished or failed for good: the next task carries this chat on.
  const over = progress !== null && !running;
  const canContinue = over && progress?.phase !== 'finished';
  const hasChat = run !== undefined && (run.steps.length > 0 || run.earlier.length > 0 || over);
  const page: DeployAssistantAppRef | null = pageApp
    ? { stackId: pageApp.stackId, name: pageApp.name }
    : null;
  // The chat's own app wins; a chat without one takes the app on the page, unless taken off.
  const app = run?.app ?? (page && dismissed !== page.stackId ? page : null);
  const currentRunId = continueFrom ?? (hasChat ? liveRunId : undefined);

  useEffect(() => {
    if (!open) return;
    follow.current = true;
    setView('chat');
    panel.current?.focus();
  }, [open]);

  // New steps, output and questions land at the end, so the view follows them there unless the
  // user scrolled up to read something.
  // biome-ignore lint/correctness/useExhaustiveDependencies: new content is the trigger
  useEffect(() => {
    const element = body.current;
    if (element && follow.current) element.scrollTop = element.scrollHeight;
  }, [open, run?.steps, progress, maximized]);

  // A window opened (or reloaded) while a run goes on picks up where it is, and a run that ended
  // while nothing was listening ends here too rather than looking stuck.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    syncWithMain(server.id, () => cancelled);
    return () => {
      cancelled = true;
    };
  }, [open, server.id]);

  if (!open) return null;

  const serverId = server.id;
  const act = (work: Promise<unknown>) =>
    void work.catch((error: unknown) => toast.error(coreErrorMessage(error)));
  // Main ignores a stop for a run it no longer has, so ask it afterwards how things stand.
  const stop = () =>
    act(window.runova.deployAssistant.stop(serverId).finally(() => syncWithMain(serverId)));

  async function start(
    prompt: string,
    ai: AssistantAiChoice,
    project: AssistantProjectChoice | null,
  ): Promise<boolean> {
    const before = useDeployAssistantStore.getState().runs[serverId];
    follow.current = true;
    if (over) followUp(serverId, prompt, app ?? undefined);
    else reset(serverId, prompt, app ?? undefined);
    try {
      await window.runova.deployAssistant.start({
        serverId,
        prompt,
        cliId: ai.cliId,
        ...(ai.modelId ? { modelId: ai.modelId } : {}),
        ...(ai.effort ? { effort: ai.effort } : {}),
        ...(project ? { project } : {}),
        ...(context ? { context } : {}),
        ...(app ? { app: { stackId: app.stackId } } : {}),
        // A chat picked from the history carries on from its own last run.
        ...(continueFrom
          ? { continueFromRunId: continueFrom }
          : over
            ? { continuePrevious: true }
            : {}),
      });
      if (continueFrom) clearContinueFrom(serverId);
      return true;
    } catch (error) {
      restore(serverId, before);
      toast.error(coreErrorMessage(error));
      return false;
    }
  }

  async function message(text: string): Promise<boolean> {
    try {
      const sent = await window.runova.deployAssistant.message(serverId, text);
      if (sent) said(serverId, text);
      else toast.error('The AI has already finished, so nothing was sent.');
      return sent;
    } catch (error) {
      toast.error(coreErrorMessage(error));
      return false;
    }
  }

  function newChat(): void {
    reset(serverId);
    dismissApp(serverId, null);
    if (draft?.serverId === serverId) clearDraft();
    follow.current = true;
  }

  function removeApp(): void {
    if (!app) return;
    if (run?.app) setChatApp(serverId, null);
    if (page?.stackId === app.stackId) dismissApp(serverId, app.stackId);
  }

  function attachApp(): void {
    if (!page) return;
    dismissApp(serverId, null);
    if (run) setChatApp(serverId, page);
  }

  function openHistory(): void {
    setView('history');
    window.runova.deployAssistant.state(serverId).then(
      (state) => setLiveRunId(state?.history[0]?.id),
      () => undefined,
    );
  }

  async function openPast(chat: DeployAssistantChatSummary): Promise<void> {
    // The chat on screen is already here as it goes, with more than the history has of it.
    if (chat.runId === currentRunId && !continueFrom) {
      setView('chat');
      return;
    }
    try {
      const chain = await window.runova.deployAssistant.chat({ serverId, runId: chat.runId });
      if (!chain) {
        toast.error('That chat is no longer in the history.');
        return;
      }
      openChat(serverId, runFromChain(chain), chat.runId);
      if (draft?.serverId === serverId) clearDraft();
      follow.current = true;
      setView('chat');
    } catch (error) {
      toast.error(coreErrorMessage(error));
    }
  }

  function deleted(runId: string): void {
    if (runId === currentRunId) reset(serverId);
  }

  // The app shell's page area, there before any page renders. Outside the shell (a test, say)
  // the drawer sits on the window.
  const island = document.querySelector<HTMLElement>('[data-page-island]');

  const drawer = (
    <aside
      ref={panel}
      tabIndex={-1}
      aria-label="Deploy AI"
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        // The history is a view in the drawer: Escape leaves it, the next one closes the drawer.
        if (view === 'history') setView('chat');
        else close();
      }}
      // Near-opaque glass, so the logs it sits beside never show through its text.
      className={cn(
        'glass-opaque bottom-2 right-2 top-2 z-40 flex flex-col overflow-hidden rounded-[calc(var(--radius)+4px)] transition-[width] focus:outline-none',
        island ? 'absolute' : 'fixed',
        maximized ? 'w-[calc(100%-1rem)]' : 'w-[min(28rem,calc(100%-1rem))]',
      )}
    >
      <header className="flex items-center gap-3 px-4 py-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/12 text-primary shadow-[0_0_28px_-12px_hsl(var(--primary)/0.7)]">
          <Robot className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold leading-tight text-foreground">Deploy AI</h2>
          <p className="truncate text-xs text-muted-foreground">on {server.nickname}</p>
        </div>
        <SimpleTooltip label={running ? 'Stop the AI to open another chat' : 'Chat history'}>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Chat history"
            aria-pressed={view === 'history'}
            disabled={running}
            onClick={() => (view === 'history' ? setView('chat') : openHistory())}
          >
            <History />
          </Button>
        </SimpleTooltip>
        {hasChat && view === 'chat' && (
          <SimpleTooltip label={running ? 'Stop the AI to start a new chat' : 'New chat'}>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="New chat"
              disabled={running}
              onClick={newChat}
            >
              <MessageSquarePlus />
            </Button>
          </SimpleTooltip>
        )}
        <SimpleTooltip label={maximized ? 'Restore size' : 'Maximize'}>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={maximized ? 'Restore size' : 'Maximize'}
            aria-pressed={maximized}
            onClick={() => setMaximized(!maximized)}
          >
            {maximized ? <WindowRestore /> : <WindowMaximize />}
          </Button>
        </SimpleTooltip>
        <SimpleTooltip label="Close">
          <Button size="icon-sm" variant="ghost" aria-label="Close" onClick={close}>
            <X />
          </Button>
        </SimpleTooltip>
      </header>

      <div
        ref={body}
        aria-label="Run"
        onScroll={(event) => {
          const element = event.currentTarget;
          follow.current =
            element.scrollHeight - element.scrollTop - element.clientHeight < BOTTOM_SLACK;
        }}
        className={cn(
          'rail-scroll min-w-0 flex-1 space-y-4 overflow-y-auto overflow-x-hidden px-4 py-3',
          FOOTER_HAIRLINE,
        )}
      >
        {view === 'history' ? (
          <AssistantHistory
            serverId={serverId}
            currentRunId={currentRunId}
            onOpen={(chat) => void openPast(chat)}
            onBack={() => setView('chat')}
            onDeleted={deleted}
          />
        ) : mode.loading ? (
          <Skeleton className="h-7 w-full rounded-full" />
        ) : mode.forbidden ? (
          <p role="alert" className="text-sm text-muted-foreground">
            The Deploy AI runs commands on the server, which only an Admin of this core may do.
          </p>
        ) : mode.info ? (
          <ModeSwitch server={server} mode={mode.info.mode} disabled={running} />
        ) : (
          <p role="alert" className="text-sm text-destructive">
            {coreErrorMessage(mode.error)}
          </p>
        )}

        {view === 'chat' && context && (
          <div aria-label="Context" className="flex min-w-0 flex-wrap items-center gap-1.5">
            <Chip tone="primary" className="min-w-0 max-w-full" title={context.title}>
              <span className="truncate">{context.title}</span>
            </Chip>
            {context.containerId && (
              <Chip className="min-w-0 max-w-full" title={context.containerId}>
                <span className="truncate">container {shortContainer(context.containerId)}</span>
              </Chip>
            )}
            {!running && (
              <button
                type="button"
                onClick={clearDraft}
                className="cursor-pointer rounded-sm text-xs text-muted-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Clear
              </button>
            )}
          </div>
        )}

        {view === 'chat' && (
          <AssistantTimeline
            earlier={run?.earlier}
            prompt={run?.prompt}
            messages={run?.messages}
            steps={run?.steps ?? []}
            progress={progress}
            tall={maximized}
            onApprove={() => act(window.runova.deployAssistant.approve(serverId))}
            onSkip={() => act(window.runova.deployAssistant.skip(serverId))}
            onAnswer={(answer) => act(window.runova.deployAssistant.answer(serverId, answer))}
            onResume={() => act(window.runova.deployAssistant.resume(serverId))}
            onStop={stop}
          />
        )}
      </div>

      {view === 'chat' && (
        <footer className={cn('px-4 py-3', FOOTER_HAIRLINE)}>
          <AssistantComposer
            serverId={serverId}
            running={running}
            phase={progress?.phase}
            followUp={over}
            canContinue={canContinue}
            disabled={!mode.info}
            attachment={
              <AppAttachment
                app={app}
                suggested={app ? null : page}
                locked={running}
                onRemove={removeApp}
                onAttach={attachApp}
              />
            }
            onStart={start}
            onMessage={message}
            onStop={stop}
          />
        </footer>
      )}
    </aside>
  );

  return island ? createPortal(drawer, island) : drawer;
}

/** Reads the run's state from main into the store, unless `cancelled` says not to any more. */
function syncWithMain(serverId: string, cancelled: () => boolean = () => false): void {
  window.runova.deployAssistant.state(serverId).then(
    (state) => {
      if (!cancelled() && state) useDeployAssistantStore.getState().sync(serverId, state);
    },
    () => undefined,
  );
}
