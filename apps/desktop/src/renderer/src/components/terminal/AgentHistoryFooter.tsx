import type { AgentInstructionTarget } from '@runova/core';
import type { RdpAgentHistoryRun, SshAgentHistoryRun } from '@shared/apiTypes';
import { MAX_SSH_AGENT_MESSAGE_CHARS } from '@shared/sshAgentMessage';
import { useState } from 'react';
import { Key, Link, Play, Sliders, StopCircle } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { TruncatedText } from '@/components/ui/truncated-text';
import { AgentAnswerPanel } from './AgentAnswerPanel';
import { AgentMessageComposer } from './AgentMessageComposer';
import { AgentPromptField } from './AgentPromptField';
import { SSH_AGENT_MODES } from './sshAgentModes';

/**
 * What a task still going needs from the user, and the ways to give it. Built from the terminal's
 * or the Remote Desktop's live state, so the history can do what the status bar does.
 */
export interface AgentLiveControls {
  phase: string;
  message?: string;
  /** The command (or desktop action) proposed or running. */
  command?: string;
  canContinue?: boolean;
  hasSavedPassword?: boolean;
  answer: (text: string) => void;
  send: (text: string) => Promise<boolean>;
  approve: () => void;
  skip: () => void;
  resume: () => void;
  stop: () => void;
  answerPassword?: (approved: boolean) => void;
}

/** How an ended task is picked back up from the history, and where that happens. */
export interface AgentRunContinuation {
  /** The terminal the new task runs in, by its tab's name. */
  where: string;
  /** Why it cannot start right now (a task already running there), or null. */
  blockedReason: string | null;
  runAgain: (run: SshAgentHistoryRun) => void;
  /** Starts a new task that knows what this one did. False when it could not start. */
  continueWith: (run: SshAgentHistoryRun, followUp: string) => Promise<boolean>;
  /** The Ask AI dialog on this task, to change how it runs first. */
  moreOptions: (run: SshAgentHistoryRun) => void;
}

function composerPlaceholder(phase: string, paused: boolean): string {
  if (paused) return 'Message the AI. It reads this when you continue…';
  if (phase === 'proposed') return 'Tell the AI what to do instead. This skips the step above…';
  if (phase === 'running' || phase === 'acting' || phase === 'needs-password') {
    return 'Message the AI. It reads this when the current step finishes…';
  }
  return 'Message the AI. It reads this right away…';
}

function sentNote(phase: string, paused: boolean): string {
  if (paused) return 'Sent. The AI reads it when you continue.';
  if (phase === 'proposed')
    return 'Sent. That step was skipped and the AI is reading your message.';
  if (phase === 'running' || phase === 'acting' || phase === 'needs-password') {
    return 'Sent. The AI reads it when the current step finishes.';
  }
  return 'Sent. The AI is reading it now.';
}

function LiveFooter({
  live,
  target,
}: {
  live: AgentLiveControls;
  target: AgentInstructionTarget;
}): React.JSX.Element | null {
  const [answer, setAnswer] = useState('');
  const [draft, setDraft] = useState('');
  const paused = live.phase === 'error' && live.canContinue === true;
  const ended =
    !paused && (live.phase === 'finished' || live.phase === 'stopped' || live.phase === 'error');
  if (ended) return null;

  if (live.phase === 'needs-input') {
    return (
      <AgentAnswerPanel
        question={live.message ?? ''}
        target={target}
        draft={answer}
        onDraftChange={setAnswer}
        onAnswer={live.answer}
      />
    );
  }

  return (
    <div className="flex flex-col">
      <div className="flex min-h-9 items-center gap-2 px-4 py-1.5 text-xs">
        <span className="min-w-0 flex-1 text-muted-foreground">
          {live.phase === 'proposed' && (
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="shrink-0">{target === 'rdp' ? 'Do' : 'Run'}</span>
              <code className="min-w-0 truncate rounded bg-foreground/[0.08] px-1 py-0.5 font-mono text-[11px] text-foreground">
                {live.command}
              </code>
              <span className="shrink-0">?</span>
            </span>
          )}
          {live.phase === 'needs-password' && (
            <span className="flex items-center gap-1.5">
              <Key className="h-3 w-3 shrink-0 text-warning" />
              <TruncatedText text={live.message ?? ''} />
            </span>
          )}
          {paused && <TruncatedText text={live.message ?? 'Paused.'} />}
          {(live.phase === 'thinking' || live.phase === 'running' || live.phase === 'acting') &&
            'The AI is working. Anything you send reaches it at its next step.'}
        </span>
        {live.phase === 'proposed' && (
          <>
            <Button size="sm" onClick={live.approve}>
              {target === 'rdp' ? 'Approve' : 'Run'}
            </Button>
            <Button size="sm" variant="ghost" onClick={live.skip}>
              Skip
            </Button>
          </>
        )}
        {live.phase === 'needs-password' &&
          live.answerPassword &&
          (live.hasSavedPassword ? (
            <>
              <Button size="sm" onClick={() => live.answerPassword?.(true)}>
                Enter password
              </Button>
              <Button size="sm" variant="ghost" onClick={() => live.answerPassword?.(false)}>
                I&apos;ll type it
              </Button>
            </>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => live.answerPassword?.(false)}>
              OK
            </Button>
          ))}
        {paused && (
          <Button size="sm" onClick={live.resume}>
            <Play className="h-3 w-3" />
            Continue
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={live.stop} className="shrink-0">
          <StopCircle className="h-3 w-3" />
          Stop
        </Button>
      </div>
      <AgentMessageComposer
        autoFocus={false}
        placeholder={composerPlaceholder(live.phase, paused)}
        sentNote={sentNote(live.phase, paused)}
        target={target}
        onSend={live.send}
        draft={draft}
        onDraftChange={setDraft}
      />
    </div>
  );
}

function ContinueFooter({
  run,
  continuation,
  target,
}: {
  run: SshAgentHistoryRun;
  continuation: AgentRunContinuation;
  target: AgentInstructionTarget;
}): React.JSX.Element {
  const [followUp, setFollowUp] = useState('');
  const [starting, setStarting] = useState(false);
  const blocked = continuation.blockedReason !== null;
  const mode = SSH_AGENT_MODES.find((m) => m.value === run.settings?.mode)?.label;
  const how = [`Runs in ${continuation.where}`, mode, run.aiLabel].filter(Boolean).join(' · ');

  async function submit(): Promise<void> {
    const text = followUp.trim();
    if (!text || starting || blocked) return;
    setStarting(true);
    try {
      if (await continuation.continueWith(run, text)) setFollowUp('');
    } finally {
      setStarting(false);
    }
  }

  return (
    <div className="flex flex-col gap-1.5 px-4 py-3">
      <AgentPromptField
        value={followUp}
        onChange={setFollowUp}
        purpose="task"
        target={target}
        ariaLabel="What to do next"
        placeholder="Continue this task: tell the AI what to do next. It knows what happened here…"
        maxLength={MAX_SSH_AGENT_MESSAGE_CHARS}
        readOnly={starting}
        onSubmit={() => void submit()}
        trailing={
          <Button
            size="sm"
            className="h-7 shrink-0 gap-1.5"
            disabled={!followUp.trim() || starting || blocked}
            onClick={() => void submit()}
          >
            <Link className="h-3 w-3" />
            Continue task
          </Button>
        }
      />
      <div className="flex min-w-0 items-center gap-2 px-1 text-[11px] text-muted-foreground">
        {blocked ? (
          <span className="min-w-0 flex-1 text-warning">{continuation.blockedReason}</span>
        ) : (
          <TruncatedText text={how} className="flex-1" />
        )}
        <SimpleTooltip
          label="Put this prompt back in the Ask AI box, set up the way it ran"
          wrapTrigger={blocked}
        >
          <Button
            size="sm"
            variant="ghost"
            className="h-6 gap-1 px-2 text-[11px]"
            disabled={blocked}
            onClick={() => continuation.runAgain(run)}
          >
            <Play className="h-2.5 w-2.5" />
            Run again
          </Button>
        </SimpleTooltip>
        <SimpleTooltip label="Continue with another AI, model or approval mode">
          <Button
            size="sm"
            variant="ghost"
            className="h-6 gap-1 px-2 text-[11px]"
            onClick={() => continuation.moreOptions(run)}
          >
            <Sliders className="h-2.5 w-2.5" />
            More options
          </Button>
        </SimpleTooltip>
      </div>
    </div>
  );
}

/**
 * The bottom of the AI task history, so the history is a place to act and not only to read. While
 * the task is going it answers the AI, runs or skips a step, takes a message, and continues or
 * stops it. Once the task is over it starts the next one with what this one did as background.
 */
export function AgentHistoryFooter({
  run,
  target,
  live,
  continuation,
}: {
  run: SshAgentHistoryRun | RdpAgentHistoryRun;
  target: AgentInstructionTarget;
  /** Set while this run is the one going in its session. */
  live: AgentLiveControls | null;
  /** Set where an ended terminal task can be picked back up. */
  continuation: AgentRunContinuation | null;
}): React.JSX.Element | null {
  const going = run.status === 'running' || run.status === 'paused';
  let body: React.ReactNode = null;
  if (going && live) {
    body = <LiveFooter key={run.id} live={live} target={target} />;
  } else if (!going && continuation) {
    body = (
      <ContinueFooter
        key={run.id}
        run={run as SshAgentHistoryRun}
        continuation={continuation}
        target={target}
      />
    );
  }
  if (!body) return null;
  return <div className="shrink-0 border-t border-border/60 bg-background/40">{body}</div>;
}
