import type { RdpAgentPhase } from '@shared/apiTypes';
import { useEffect, useRef, useState } from 'react';
import {
  CircleCheck,
  History,
  MessageSquare,
  Play,
  Robot,
  StopCircle,
  TriangleAlert,
  X,
} from '@/components/icons';
import { AgentMessageComposer } from '@/components/terminal/AgentMessageComposer';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import {
  answerRdpAgentInput,
  approveRdpAgentAction,
  continueRdpAgentTask,
  sendRdpAgentMessage,
  skipRdpAgentAction,
  stopRdpAgentTask,
  useRdpAgentSession,
  useRdpAgentStore,
} from '@/stores/rdpAgentStore';

function ActionCode({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <code className="rounded bg-foreground/10 px-1 py-0.5 font-mono text-[11px]">{children}</code>
  );
}

/** What the message box asks for, which depends on when the AI will get to read it. */
function composerPlaceholder(phase: RdpAgentPhase, paused: boolean): string {
  if (paused) return 'Message the AI. It reads this when you continue…';
  switch (phase) {
    case 'proposed':
      return 'Tell the AI what to do instead. This skips the action above…';
    case 'acting':
      return 'Message the AI. It reads this once the current action is done…';
    default:
      return 'Message the AI. It reads this right away…';
  }
}

/** The confirmation under the box, saying what happens to the message that was just sent. */
function sentNote(phase: RdpAgentPhase, paused: boolean): string {
  if (paused) return 'Sent. The AI reads it when you continue.';
  switch (phase) {
    case 'proposed':
      return 'Sent. That action was skipped and the AI is reading your message.';
    case 'acting':
      return 'Sent. The AI reads it once the current action is done.';
    default:
      return 'Sent. The AI is reading it now.';
  }
}

/**
 * A slim row between the title bar and the remote screen showing what the AI is doing, and any
 * decision it needs from you. It sits outside the session area so it never covers the desktop.
 */
export function RdpAgentStatusBar({
  sessionId,
  onOpenHistory,
}: {
  sessionId: string;
  onOpenHistory: () => void;
}): React.JSX.Element | null {
  const state = useRdpAgentSession(sessionId);
  const clear = useRdpAgentStore((s) => s.clear);
  const [answer, setAnswer] = useState('');
  const [composerOpen, setComposerOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const messageButtonRef = useRef<HTMLButtonElement>(null);

  // A paused run looks like an error but is still alive, waiting for Continue or Stop.
  const paused = state?.phase === 'error' && state.canContinue === true;
  const done =
    !!state &&
    !paused &&
    (state.phase === 'finished' || state.phase === 'error' || state.phase === 'stopped');

  // Once the task is over there is nobody to message, and a leftover draft would greet the next one.
  useEffect(() => {
    if (state && !done) return;
    setComposerOpen(false);
    setDraft('');
  }, [state, done]);

  if (!state) return null;

  // A question has its own answer field, and what the user types there already reaches the AI.
  const canMessage = !done && state.phase !== 'needs-input';
  const queued = state.queuedMessages ?? 0;

  function submitAnswer(): void {
    if (!answer.trim()) return;
    answerRdpAgentInput(sessionId, answer.trim());
    setAnswer('');
  }

  function closeComposer(): void {
    setComposerOpen(false);
    messageButtonRef.current?.focus();
  }

  return (
    <div
      className={cn(
        'flex shrink-0 flex-col border-b border-border bg-background text-xs',
        state.phase === 'error' && !paused && 'bg-destructive/10',
        (paused || state.phase === 'needs-input') && 'bg-amber-500/10',
      )}
    >
      <div className="flex min-h-9 items-center gap-2 px-3 py-1.5">
        {state.phase === 'error' ? (
          <TriangleAlert
            className={cn('h-3.5 w-3.5 shrink-0', paused ? 'text-amber-400' : 'text-destructive')}
          />
        ) : state.phase === 'finished' ? (
          <CircleCheck className="h-3.5 w-3.5 shrink-0 text-primary" />
        ) : (
          <Robot className={cn('h-3.5 w-3.5 shrink-0 text-primary', !done && 'animate-pulse')} />
        )}

        <span className="min-w-0 flex-1 truncate text-foreground/85">
          {state.phase === 'thinking' && `Step ${state.step}: looking at the screen…`}
          {state.phase === 'proposed' && (
            <>
              Step {state.step}: do <ActionCode>{state.action}</ActionCode>? {state.message}
            </>
          )}
          {state.phase === 'acting' && (
            <>
              Step {state.step}: <ActionCode>{state.action}</ActionCode>
            </>
          )}
          {state.phase === 'needs-input' && state.message}
          {state.phase === 'finished' && (state.message || 'Task complete.')}
          {state.phase === 'error' && state.message}
          {state.phase === 'stopped' && state.message}
        </span>

        {queued > 0 && (
          <span
            role="status"
            className="shrink-0 rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-medium text-primary"
          >
            {queued === 1 ? 'Message queued' : `${queued} messages queued`}
          </span>
        )}

        {state.phase === 'proposed' && (
          <div className="flex shrink-0 items-center gap-1.5">
            <Button size="sm" onClick={() => approveRdpAgentAction(sessionId)}>
              Approve
            </Button>
            <Button size="sm" variant="ghost" onClick={() => skipRdpAgentAction(sessionId)}>
              Skip
            </Button>
          </div>
        )}

        {state.phase === 'needs-input' && (
          <div className="flex shrink-0 items-center gap-1.5">
            <Input
              autoFocus
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitAnswer();
              }}
              placeholder="Your answer…"
              className="h-7 w-48 text-xs"
            />
            <Button size="sm" onClick={submitAnswer} disabled={!answer.trim()}>
              Send
            </Button>
          </div>
        )}

        {paused && (
          <Button size="sm" className="shrink-0" onClick={() => continueRdpAgentTask(sessionId)}>
            <Play className="h-3 w-3" />
            Continue
          </Button>
        )}

        {canMessage && (
          <Button
            ref={messageButtonRef}
            size="sm"
            variant={composerOpen ? 'secondary' : 'ghost'}
            aria-expanded={composerOpen}
            onClick={() => (composerOpen ? closeComposer() : setComposerOpen(true))}
            className="shrink-0 gap-1.5 text-muted-foreground hover:text-foreground"
          >
            <MessageSquare className="h-3 w-3" />
            Message
          </Button>
        )}

        <Button
          size="sm"
          variant="ghost"
          onClick={onOpenHistory}
          className="shrink-0 gap-1.5 text-muted-foreground hover:text-foreground"
        >
          <History className="h-3 w-3" />
          History
        </Button>

        {!done && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => stopRdpAgentTask(sessionId)}
            className="shrink-0"
          >
            <StopCircle className="h-3 w-3" />
            Stop
          </Button>
        )}

        {done && (
          <Button
            size="icon-xs"
            variant="ghost"
            onClick={() => clear(sessionId)}
            aria-label="Dismiss"
            className="shrink-0"
          >
            <X />
          </Button>
        )}
      </div>

      {canMessage && composerOpen && (
        <AgentMessageComposer
          placeholder={composerPlaceholder(state.phase, paused)}
          sentNote={sentNote(state.phase, paused)}
          onSend={(text) => sendRdpAgentMessage(sessionId, text)}
          draft={draft}
          onDraftChange={setDraft}
          onClose={closeComposer}
        />
      )}
    </div>
  );
}
