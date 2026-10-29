import { coreErrorMessage } from '@shared/coreErrors';
import type { DeployServer } from '@shared/deployTypes';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { MessageSquarePlus, Robot, WindowMaximize, WindowRestore, X } from '@/components/icons';
import { Chip, FOOTER_HAIRLINE } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import {
  type AssistantAiChoice,
  type AssistantProjectChoice,
  useDeployAssistantStore,
} from '@/stores/deployAssistantStore';
import { AssistantComposer } from './AssistantComposer';
import { AssistantTimeline } from './AssistantTimeline';
import { useAssistantMode } from './hooks';
import { ModeSwitch } from './ModeSwitch';

/**
 * The Deploy AI drawer (E09 T8), on the right of every Deploy screen. It shows what the AI was
 * pointed at, how commands run (the core's mode), the run as a timeline with approve and skip,
 * the live output, a stop button and follow-up questions. A follow-up, or a Continue after a
 * stop, carries the chat on with what the AI learned so far; New chat starts over. It does not
 * cover the page, so the logs stay readable next to it; Escape closes it and the run carries on.
 */

const ACTIVE = new Set(['thinking', 'proposed', 'running', 'needs-input', 'needs-password']);

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
  const open = openServerId === server.id;
  const mode = useAssistantMode(server.id, open);
  const panel = useRef<HTMLElement | null>(null);
  const body = useRef<HTMLDivElement | null>(null);
  const follow = useRef(true);
  const [maximized, setMaximized] = useState(false);
  const context = draft?.serverId === server.id ? draft.context : null;
  const progress = run?.progress ?? null;
  const running =
    (progress !== null && ACTIVE.has(progress.phase)) ||
    (progress?.phase === 'error' && progress.canContinue === true);
  // Stopped, finished or failed for good: the next task carries this chat on.
  const over = progress !== null && !running;
  const canContinue = over && progress?.phase !== 'finished';
  const hasChat = run !== undefined && (run.steps.length > 0 || run.earlier.length > 0 || over);

  useEffect(() => {
    if (!open) return;
    follow.current = true;
    panel.current?.focus();
  }, [open]);

  // New steps, output and questions land at the end, so the view follows them there unless the
  // user scrolled up to read something.
  // biome-ignore lint/correctness/useExhaustiveDependencies: new content is the trigger
  useEffect(() => {
    const element = body.current;
    if (element && follow.current) element.scrollTop = element.scrollHeight;
  }, [open, run?.steps, progress, maximized]);

  // A window opened (or reloaded) while a run goes on picks up where it is.
  useEffect(() => {
    if (!open || run) return;
    let cancelled = false;
    window.runova.deployAssistant.state(server.id).then(
      (state) => {
        if (!cancelled && state?.progress) {
          useDeployAssistantStore
            .getState()
            .progress({ serverId: server.id, progress: state.progress });
        }
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [open, run, server.id]);

  if (!open) return null;

  const serverId = server.id;
  const act = (work: Promise<unknown>) =>
    void work.catch((error: unknown) => toast.error(coreErrorMessage(error)));

  async function start(
    prompt: string,
    ai: AssistantAiChoice,
    project: AssistantProjectChoice | null,
  ): Promise<boolean> {
    const before = useDeployAssistantStore.getState().runs[serverId];
    follow.current = true;
    if (over) followUp(serverId, prompt);
    else reset(serverId, prompt);
    try {
      await window.runova.deployAssistant.start({
        serverId,
        prompt,
        cliId: ai.cliId,
        ...(ai.modelId ? { modelId: ai.modelId } : {}),
        ...(ai.effort ? { effort: ai.effort } : {}),
        ...(project ? { project } : {}),
        ...(context ? { context } : {}),
        ...(over ? { continuePrevious: true } : {}),
      });
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
    if (draft?.serverId === serverId) clearDraft();
    follow.current = true;
  }

  return (
    <aside
      ref={panel}
      tabIndex={-1}
      aria-label="Deploy AI"
      onKeyDown={(event) => {
        if (event.key === 'Escape') close();
      }}
      // Near-opaque glass, so the logs it sits beside never show through its text.
      className={cn(
        'glass-opaque fixed bottom-2 right-2 top-2 z-40 flex flex-col overflow-hidden rounded-[calc(var(--radius)+4px)] transition-[width] focus:outline-none',
        maximized ? 'w-[calc(100vw-1rem)]' : 'w-[min(28rem,calc(100vw-1rem))]',
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
        {hasChat && (
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
            onClick={() => setMaximized((value) => !value)}
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
        className={cn('rail-scroll flex-1 space-y-4 overflow-y-auto px-4 py-3', FOOTER_HAIRLINE)}
      >
        {mode.loading ? (
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

        {context && (
          <div aria-label="Context" className="flex flex-wrap items-center gap-1.5">
            <Chip tone="primary" className="max-w-full truncate">
              {context.title}
            </Chip>
            {context.containerId && <Chip>container {context.containerId}</Chip>}
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
          onStop={() => act(window.runova.deployAssistant.stop(serverId))}
        />
      </div>

      <footer className={cn('px-4 py-3', FOOTER_HAIRLINE)}>
        <AssistantComposer
          key={draft?.serverId === serverId ? draft.prompt : 'free'}
          serverId={serverId}
          running={running}
          phase={progress?.phase}
          followUp={over}
          canContinue={canContinue}
          initialPrompt={draft?.serverId === serverId ? draft.prompt : ''}
          disabled={!mode.info}
          onStart={start}
          onMessage={message}
          onStop={() => act(window.runova.deployAssistant.stop(serverId))}
        />
      </footer>
    </aside>
  );
}
