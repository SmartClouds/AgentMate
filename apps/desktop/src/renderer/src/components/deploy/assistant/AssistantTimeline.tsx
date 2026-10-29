import type { SshAgentProgress } from '@shared/apiTypes';
import { useEffect, useRef, useState } from 'react';
import { Check, CircleCheck, CircleX, Play, Spinner, TriangleAlert, X } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import type { AssistantMessage, AssistantStep, AssistantTurn } from '@/stores/deployAssistantStore';

/**
 * The run as a list of steps (E09 T8): each command with its state in words, why it waits when
 * it does, and its output as plain text (it comes from the server). Under it, what the run needs
 * now: an approval, an answer, a decision after an error. The runs the chat carried on from sit
 * above it, each with what the user asked and how it ended.
 */

const STATUS: Record<AssistantStep['status'], string> = {
  proposed: 'Waiting for you',
  running: 'Running',
  done: 'Done',
  skipped: 'Skipped',
};

function StepIcon({ status }: { status: AssistantStep['status'] }) {
  if (status === 'running') return <Spinner className="h-3.5 w-3.5 animate-spin text-primary" />;
  if (status === 'done') return <CircleCheck className="h-3.5 w-3.5 text-success" />;
  if (status === 'skipped') return <X className="h-3.5 w-3.5 text-muted-foreground" />;
  return <TriangleAlert className="h-3.5 w-3.5 text-warning" />;
}

/** How close to the end still counts as being at the end, in pixels. */
const BOTTOM_SLACK = 16;

export function StepItem({
  step,
  tall = false,
}: {
  step: AssistantStep;
  tall?: boolean;
}): React.JSX.Element {
  const output = useRef<HTMLPreElement | null>(null);
  const follow = useRef(true);

  // The output reads from the end, like a terminal, unless the user scrolled up in it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: each new line is the trigger
  useEffect(() => {
    const element = output.current;
    if (element && follow.current) element.scrollTop = element.scrollHeight;
  }, [step.lines, tall]);

  return (
    <li
      className="space-y-1.5 rounded-xl bg-foreground/[0.03] p-2.5 ring-1 ring-inset ring-foreground/[0.07]"
      aria-label={`Step ${step.step}: ${step.command}`}
    >
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <StepIcon status={step.status} />
        <span>Step {step.step}</span>
        <span aria-label="Status" className="ml-auto">
          {STATUS[step.status]}
        </span>
      </div>
      <code className="block whitespace-pre-wrap break-all rounded-md bg-foreground/[0.05] px-2 py-1 font-mono text-[12px] text-foreground">
        {step.command}
      </code>
      {step.note && step.status === 'proposed' && (
        <p className="text-xs text-muted-foreground">{step.note}</p>
      )}
      {step.lines.length > 0 && (
        <pre
          ref={output}
          onScroll={(event) => {
            const element = event.currentTarget;
            follow.current =
              element.scrollHeight - element.scrollTop - element.clientHeight < BOTTOM_SLACK;
          }}
          className={cn(
            'overflow-auto whitespace-pre-wrap break-all rounded-md bg-background/70 px-2 py-1 font-mono text-[11px] leading-4 text-foreground',
            tall ? 'max-h-[28rem]' : 'max-h-48',
          )}
          aria-label={`Output of step ${step.step}`}
        >
          {step.lines.map((line) => line.text).join('\n')}
        </pre>
      )}
    </li>
  );
}

const BUBBLE =
  'ml-auto w-fit max-w-[85%] whitespace-pre-wrap break-words rounded-xl rounded-br-sm bg-primary/12 px-3 py-2 text-sm text-foreground';

function Asked({ text }: { text: string }) {
  return (
    <p aria-label="You asked" className={BUBBLE}>
      {text}
    </p>
  );
}

/** A message the user sent while the run went, and whether the AI has read it yet. */
function Said({ text, unread }: { text: string; unread: boolean }) {
  return (
    <li aria-label="You said" className="flex flex-col items-end gap-1">
      <p className={cn(BUBBLE, 'ml-0')}>{text}</p>
      {unread && (
        <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
          <Spinner className="h-3 w-3 animate-spin" /> Not read yet, the AI gets it at its next step
        </span>
      )}
    </li>
  );
}

/**
 * The steps with the user's messages between them, where they were sent. The last `unread`
 * messages are the ones the AI has not got to yet.
 */
function Steps({
  steps,
  messages,
  unread = 0,
  tall,
}: {
  steps: AssistantStep[];
  messages: AssistantMessage[];
  unread?: number;
  tall: boolean;
}) {
  if (steps.length === 0 && messages.length === 0) return null;
  const firstUnread = messages.length - unread;
  // Sent before step `at`, or after the last one (a step list cut at its cap counts as the end).
  const saidBefore = (at: number) =>
    messages.flatMap((message, index) =>
      message.at === at || (at === steps.length && message.at > at)
        ? [
            <Said
              // A message never changes once sent, so its place is key enough.
              key={`said-${index}`}
              text={message.text}
              unread={index >= firstUnread}
            />,
          ]
        : [],
    );
  return (
    <ol aria-label="Steps" className="space-y-2">
      {steps.map((step, index) => [
        ...saidBefore(index),
        <StepItem key={`${step.step}-${step.command}`} step={step} tall={tall} />,
      ])}
      {saidBefore(steps.length)}
    </ol>
  );
}

/** How a run ended. `live` is the run going now, which screen readers hear about. */
function Ended({ progress, live }: { progress: SshAgentProgress | null; live: boolean }) {
  const phase = progress?.phase;
  if (phase === 'error' && !live) {
    return (
      <p className="flex items-start gap-2 rounded-xl bg-destructive/10 p-3 text-sm ring-1 ring-inset ring-destructive/30">
        <CircleX className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
        {progress?.message}
      </p>
    );
  }
  if (phase !== 'finished' && phase !== 'stopped') return null;
  return (
    <p
      role={live ? 'status' : undefined}
      className={cn(
        'flex items-start gap-2 rounded-xl p-3 text-sm ring-1 ring-inset',
        phase === 'finished'
          ? 'bg-success/8 ring-success/25'
          : 'bg-foreground/[0.03] ring-foreground/[0.07]',
      )}
    >
      {phase === 'finished' ? (
        <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
      ) : (
        <X className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      )}
      <span>
        <span className="font-medium">{phase === 'finished' ? 'Finished: ' : 'Stopped: '}</span>
        {progress?.message}
      </span>
    </p>
  );
}

export function AssistantTimeline({
  earlier = [],
  prompt,
  messages = [],
  steps,
  progress,
  onApprove,
  onSkip,
  onAnswer,
  onResume,
  onStop,
  tall = false,
}: {
  /** The runs before this one in the chat, oldest first. */
  earlier?: AssistantTurn[];
  /** What the user asked this run. */
  prompt?: string;
  /** What the user told this run while it went. */
  messages?: AssistantMessage[];
  steps: AssistantStep[];
  progress: SshAgentProgress | null;
  /** The drawer is maximized, so each step's output gets more room. */
  tall?: boolean;
  onApprove: () => void;
  onSkip: () => void;
  onAnswer: (answer: string) => void;
  onResume: () => void;
  onStop: () => void;
}): React.JSX.Element {
  const [answer, setAnswer] = useState('');
  const phase = progress?.phase;

  return (
    <div className="space-y-3">
      {earlier.map((turn, index) => (
        // A turn never changes once it is in the list, so its place is key enough.
        <section key={index} aria-label="Earlier run" className="space-y-3">
          {turn.prompt && <Asked text={turn.prompt} />}
          <Steps steps={turn.steps} messages={turn.messages ?? []} tall={tall} />
          <Ended progress={turn.progress} live={false} />
        </section>
      ))}

      {prompt && <Asked text={prompt} />}
      <Steps steps={steps} messages={messages} unread={progress?.queuedMessages ?? 0} tall={tall} />

      {phase === 'thinking' && (
        <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
          <Spinner className="h-3.5 w-3.5 animate-spin" /> Working out the next step
        </p>
      )}

      {phase === 'proposed' && (
        <div
          role="group"
          aria-label="Approve the command"
          className="space-y-2 rounded-xl bg-warning/10 p-3 ring-1 ring-inset ring-warning/30"
        >
          <p className="text-sm text-foreground">
            {progress?.message ?? 'The AI wants to run this command on the server.'}
          </p>
          <code className="block whitespace-pre-wrap break-all font-mono text-[12px]">
            {progress?.command}
          </code>
          <div className="flex gap-2">
            <Button size="sm" onClick={onApprove}>
              <Play /> Run it
            </Button>
            <Button size="sm" variant="soft" onClick={onSkip}>
              Skip
            </Button>
          </div>
        </div>
      )}

      {phase === 'needs-input' && (
        <form
          className="space-y-2 rounded-xl bg-foreground/[0.03] p-3 ring-1 ring-inset ring-foreground/[0.07]"
          onSubmit={(event) => {
            event.preventDefault();
            onAnswer(answer);
            setAnswer('');
          }}
        >
          <p className="text-sm text-foreground">{progress?.message}</p>
          <div className="flex gap-2">
            <Input
              value={answer}
              onChange={(event) => setAnswer(event.target.value)}
              aria-label="Your answer"
              className="h-8"
            />
            <Button size="sm" type="submit" disabled={!answer.trim()}>
              Answer
            </Button>
          </div>
        </form>
      )}

      {phase === 'error' && (
        <div
          role="alert"
          className="space-y-2 rounded-xl bg-destructive/10 p-3 ring-1 ring-inset ring-destructive/30"
        >
          <p className="flex items-start gap-2 text-sm text-foreground">
            <CircleX className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
            {progress?.message}
          </p>
          {progress?.canContinue && (
            <div className="flex gap-2">
              <Button size="sm" onClick={onResume}>
                Continue
              </Button>
              <Button size="sm" variant="soft" onClick={onStop}>
                Stop
              </Button>
            </div>
          )}
        </div>
      )}

      <Ended progress={progress} live />
    </div>
  );
}
