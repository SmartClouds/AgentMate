import type { SshAgentPhase } from '@shared/apiTypes';
import { useEffect, useRef, useState } from 'react';
import {
  CircleCheck,
  History,
  Key,
  MessageSquare,
  Play,
  Robot,
  StopCircle,
  TriangleAlert,
  X,
} from '@/components/icons';
import { Button } from '@/components/ui/button';
import { TruncatedText } from '@/components/ui/truncated-text';
import { cn } from '@/lib/utils';
import {
  answerSshAgentInput,
  answerSshAgentPassword,
  approveSshAgentCommand,
  continueSshAgentTask,
  sendSshAgentMessage,
  skipSshAgentCommand,
  stopSshAgentTask,
  useSshAgentSession,
  useSshAgentStore,
} from '@/stores/sshAgentStore';
import { AgentAnswerPanel } from './AgentAnswerPanel';
import { AgentMessageComposer } from './AgentMessageComposer';

/** What the message box asks for, which depends on when the AI will get to read it. */
function composerPlaceholder(phase: SshAgentPhase, paused: boolean): string {
  if (paused) return 'Message the AI. It reads this when you continue…';
  switch (phase) {
    case 'proposed':
      return 'Tell the AI what to do instead. This skips the command above…';
    case 'running':
    case 'needs-password':
      return 'Message the AI. It reads this when the command finishes…';
    default:
      return 'Message the AI. It reads this right away…';
  }
}

/** The confirmation under the box, saying what happens to the message that was just sent. */
function sentNote(phase: SshAgentPhase, paused: boolean): string {
  if (paused) return 'Sent. The AI reads it when you continue.';
  switch (phase) {
    case 'proposed':
      return 'Sent. That command was skipped and the AI is reading your message.';
    case 'running':
    case 'needs-password':
      return 'Sent. The AI reads it when the command finishes.';
    default:
      return 'Sent. The AI is reading it now.';
  }
}

/** The bar line as plain text, for the tooltip that shows it in full. */
function lineText(state: {
  phase: SshAgentPhase;
  step: number;
  command?: string;
  message?: string;
}): string {
  switch (state.phase) {
    case 'thinking':
      return `Step ${state.step}: thinking…`;
    case 'proposed':
      return `Run ${state.command ?? ''}? ${state.message ?? ''}`.trim();
    case 'running':
      return `Running ${state.command ?? ''}`;
    case 'needs-input':
      return 'Waiting for your answer';
    case 'finished':
      return state.message || 'Task complete.';
    default:
      return state.message ?? '';
  }
}

/** A slim bar above the terminal showing what the AI is doing, and any action it needs from you. */
export function SshAgentStatusBar({
  sessionId,
  target = 'ssh',
  onOpenHistory,
}: {
  sessionId: string;
  /** An SSH session, or a shell on this computer. It shapes what "Write it for me" writes. */
  target?: 'ssh' | 'local';
  onOpenHistory: () => void;
}): React.JSX.Element | null {
  const state = useSshAgentSession(sessionId);
  const clear = useSshAgentStore((s) => s.clear);
  const [answer, setAnswer] = useState('');
  const [composerOpen, setComposerOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const messageButtonRef = useRef<HTMLButtonElement>(null);
  const question = state?.phase === 'needs-input' ? (state.message ?? '') : null;

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

  // Each question gets a fresh answer box, so half an answer to the last one never carries over.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the question is what changes
  useEffect(() => {
    setAnswer('');
  }, [question]);

  if (!state) return null;

  const waitingOnUser =
    paused ||
    state.phase === 'proposed' ||
    state.phase === 'needs-input' ||
    state.phase === 'needs-password';
  // A question has its own answer field, and what the user types there already reaches the AI.
  const canMessage = !done && state.phase !== 'needs-input';
  const queued = state.queuedMessages ?? 0;

  function closeComposer(): void {
    setComposerOpen(false);
    messageButtonRef.current?.focus();
  }

  return (
    <div
      className={cn(
        'flex shrink-0 flex-col text-xs shadow-[inset_0_-1px_0_hsl(var(--border)/0.6)]',
        state.phase === 'error' && !paused && 'bg-destructive/10',
        (paused || state.phase === 'needs-input' || state.phase === 'needs-password') &&
          'bg-warning/10',
        !done &&
          state.phase !== 'needs-input' &&
          state.phase !== 'needs-password' &&
          state.phase !== 'error' &&
          'bg-primary/5',
      )}
    >
      <div className="flex min-h-9 items-center gap-2 px-3 py-1.5">
        {state.phase === 'error' ? (
          <TriangleAlert
            className={cn('h-3.5 w-3.5 shrink-0', paused ? 'text-warning' : 'text-destructive')}
          />
        ) : state.phase === 'needs-password' ? (
          <Key className="h-3.5 w-3.5 shrink-0 text-warning" />
        ) : state.phase === 'finished' ? (
          <CircleCheck className="h-3.5 w-3.5 shrink-0 text-primary" />
        ) : (
          <Robot className={cn('h-3.5 w-3.5 shrink-0 text-primary', !done && 'animate-pulse')} />
        )}

        <TruncatedText text={lineText(state)} className="flex-1 text-foreground/85">
          {state.phase === 'thinking' && `Step ${state.step}: thinking…`}
          {state.phase === 'proposed' && (
            <>
              Run{' '}
              <code className="rounded bg-foreground/[0.08] px-1 py-0.5 font-mono text-[11px]">
                {state.command}
              </code>
              ? {state.message}
            </>
          )}
          {state.phase === 'running' && (
            <>
              Running{' '}
              <code className="rounded bg-foreground/[0.08] px-1 py-0.5 font-mono text-[11px]">
                {state.command}
              </code>
            </>
          )}
          {state.phase === 'needs-input' && 'Waiting for your answer'}
          {state.phase === 'needs-password' && state.message}
          {state.phase === 'finished' && (state.message || 'Task complete.')}
          {state.phase === 'error' && state.message}
          {state.phase === 'stopped' && state.message}
        </TruncatedText>

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
            <Button size="sm" onClick={() => approveSshAgentCommand(sessionId)}>
              Run
            </Button>
            <Button size="sm" variant="ghost" onClick={() => skipSshAgentCommand(sessionId)}>
              Skip
            </Button>
          </div>
        )}

        {state.phase === 'needs-password' && (
          <div className="flex shrink-0 items-center gap-1.5">
            {state.hasSavedPassword ? (
              <>
                <Button size="sm" onClick={() => answerSshAgentPassword(sessionId, true)}>
                  Enter password
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => answerSshAgentPassword(sessionId, false)}
                >
                  I&apos;ll type it
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => answerSshAgentPassword(sessionId, false)}
              >
                OK
              </Button>
            )}
          </div>
        )}

        {paused && (
          <div className="flex shrink-0 items-center gap-1.5">
            <Button size="sm" onClick={() => continueSshAgentTask(sessionId)}>
              <Play className="h-3 w-3" />
              Continue
            </Button>
            <Button size="sm" variant="ghost" onClick={() => stopSshAgentTask(sessionId)}>
              <StopCircle className="h-3 w-3" />
              Stop
            </Button>
          </div>
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

        {!done && !waitingOnUser && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => stopSshAgentTask(sessionId)}
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

      {question !== null && (
        <AgentAnswerPanel
          question={question}
          target={target}
          draft={answer}
          onDraftChange={setAnswer}
          onAnswer={(text) => answerSshAgentInput(sessionId, text)}
        />
      )}

      {canMessage && composerOpen && (
        <AgentMessageComposer
          placeholder={composerPlaceholder(state.phase, paused)}
          sentNote={sentNote(state.phase, paused)}
          target={target}
          onSend={(text) => sendSshAgentMessage(sessionId, text)}
          draft={draft}
          onDraftChange={setDraft}
          onClose={closeComposer}
        />
      )}
    </div>
  );
}
