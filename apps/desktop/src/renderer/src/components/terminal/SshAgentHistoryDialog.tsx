import type {
  RdpAgentHistoryEntry,
  RdpAgentHistoryRun,
  SshAgentHistoryEntry,
  SshAgentHistoryRun,
} from '@shared/apiTypes';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  ChevronDown,
  ChevronUp,
  CircleCheck,
  CircleQuestion,
  Copy,
  Crosshair,
  History,
  Link,
  Play,
  Robot,
  StopCircle,
  TerminalSquare,
  TriangleAlert,
} from '@/components/icons';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { TruncatedText } from '@/components/ui/truncated-text';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import {
  answerSshAgentInput,
  answerSshAgentPassword,
  approveSshAgentCommand,
  continueSshAgentTask,
  type SshAgentSessionState,
  sendSshAgentMessage,
  skipSshAgentCommand,
  stopSshAgentTask,
  useSshAgentSession,
  useSshAgentStore,
} from '@/stores/sshAgentStore';
import {
  AgentHistoryFooter,
  type AgentLiveControls,
  type AgentRunContinuation,
} from './AgentHistoryFooter';

/** A run from either kind of AI task: commands in a terminal, or actions on a remote desktop. */
type AgentRun = SshAgentHistoryRun | RdpAgentHistoryRun;
type AgentEntry = SshAgentHistoryEntry | RdpAgentHistoryEntry;

/**
 * Where the history comes from. The dialog reads a terminal's history unless given another
 * source, such as a Remote Desktop session's.
 */
export interface AgentHistorySource {
  kind: 'ssh' | 'rdp';
  queryKey: readonly unknown[];
  load: () => Promise<AgentRun[]>;
  /** The task's live state; each change means the history has moved on and is read again. */
  live: unknown;
  /**
   * What the task going in that session needs, for a source whose live state the dialog cannot
   * read on its own (Remote Desktop). A terminal's comes from its store.
   */
  controls?: AgentLiveControls | null;
}

/** A terminal task's live state as the history footer's controls. */
function sshControls(
  sessionId: string,
  state: SshAgentSessionState | undefined,
): AgentLiveControls | null {
  if (!state) return null;
  return {
    phase: state.phase,
    message: state.message,
    command: state.command,
    canContinue: state.canContinue,
    hasSavedPassword: state.hasSavedPassword,
    answer: (text) => answerSshAgentInput(sessionId, text),
    send: (text) => sendSshAgentMessage(sessionId, text),
    approve: () => approveSshAgentCommand(sessionId),
    skip: () => skipSshAgentCommand(sessionId),
    resume: () => continueSshAgentTask(sessionId),
    stop: () => stopSshAgentTask(sessionId),
    answerPassword: (approved) => answerSshAgentPassword(sessionId, approved),
  };
}

/** Output taller than this starts folded, so one noisy command doesn't bury the rest. */
const FOLDED_OUTPUT_LINES = 12;

function clockTime(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function dayAndTime(at: number): string {
  const date = new Date(at);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return sameDay
    ? clockTime(at)
    : `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${clockTime(at)}`;
}

function duration(run: AgentRun): string {
  const ms = (run.endedAt ?? Date.now()) - run.startedAt;
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60
    ? `${minutes}m ${seconds % 60}s`
    : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function stepCount(run: AgentRun): number {
  return run.entries.filter((entry) => entry.kind === 'command' || entry.kind === 'action').length;
}

const STATUS_LABELS: Record<SshAgentHistoryRun['status'], string> = {
  running: 'Running',
  paused: 'Paused',
  finished: 'Done',
  error: 'Failed',
  stopped: 'Stopped',
};

function StatusDot({ status }: { status: SshAgentHistoryRun['status'] }): React.JSX.Element {
  return (
    <span
      className={cn(
        'h-2 w-2 shrink-0 rounded-full',
        status === 'running' && 'animate-pulse bg-primary shadow-[0_0_6px_hsl(var(--primary))]',
        status === 'paused' && 'bg-amber-400',
        status === 'finished' && 'bg-success',
        status === 'error' && 'bg-destructive',
        status === 'stopped' && 'bg-muted-foreground/50',
      )}
    />
  );
}

/** The whole run as plain text, for pasting into an issue or a chat. */
function runAsText(run: AgentRun): string {
  const lines = [`Task: ${run.prompt}`, `AI: ${run.aiLabel || 'AI'}`, ''];
  for (const entry of run.entries) {
    switch (entry.kind) {
      case 'command':
        lines.push(
          `$ ${entry.command}${entry.exitCode !== null ? `  [exit ${entry.exitCode}]` : ''}`,
        );
        if (entry.output) lines.push(entry.output);
        lines.push('');
        break;
      case 'action':
        lines.push(`> ${entry.action}  [${entry.ok ? 'ok' : 'failed'}]`);
        if (entry.outcome) lines.push(entry.outcome);
        lines.push('');
        break;
      case 'skipped':
        lines.push(
          'command' in entry ? `$ ${entry.command}  [skipped]` : `> ${entry.action}  [skipped]`,
          '',
        );
        break;
      case 'question':
        lines.push(`AI asked: ${entry.text}`);
        break;
      case 'answer':
        lines.push(`You answered: ${entry.text || '(nothing)'}`, '');
        break;
      case 'message':
        lines.push(`You told the AI: ${entry.text}`, '');
        break;
      case 'error':
        lines.push(entry.text);
        break;
      case 'continued':
        lines.push('You continued the task.', '');
        break;
      case 'finished':
        lines.push(`Finished: ${entry.text}`);
        break;
      case 'stopped':
        lines.push(`Stopped: ${entry.text}`);
        break;
    }
  }
  return lines.join('\n').trim();
}

function copy(text: string, what: string): void {
  void navigator.clipboard.writeText(text).then(
    () => toast.success(`${what} copied`),
    () => toast.error(`Couldn't copy the ${what.toLowerCase()}`),
  );
}

function ExitBadge({
  entry,
}: {
  entry: Extract<SshAgentHistoryEntry, { kind: 'command' }>;
}): React.JSX.Element {
  const [label, tone] =
    entry.exitCode === 0
      ? ['OK', 'border-success/30 bg-success/10 text-success']
      : entry.exitCode !== null
        ? [`Exit ${entry.exitCode}`, 'border-destructive/30 bg-destructive/10 text-destructive']
        : entry.timedOut
          ? ['Timed out', 'border-amber-400/30 bg-amber-400/10 text-amber-400']
          : ['Ended', 'border-white/15 bg-white/5 text-zinc-400'];
  return (
    <span
      className={cn(
        'shrink-0 rounded-full border px-2 py-px text-[10px] font-medium uppercase tracking-wide',
        tone,
      )}
    >
      {label}
    </span>
  );
}

function CommandEntry({
  entry,
}: {
  entry: Extract<SshAgentHistoryEntry, { kind: 'command' }>;
}): React.JSX.Element {
  const lines = entry.output ? entry.output.split('\n') : [];
  const foldable = lines.length > FOLDED_OUTPUT_LINES;
  const [expanded, setExpanded] = useState(false);
  const shown = foldable && !expanded ? lines.slice(0, FOLDED_OUTPUT_LINES) : lines;

  // Terminal colors in both themes: this is what the shell printed, and it reads like it.
  return (
    <div className="overflow-hidden rounded-lg border border-white/10 bg-[#0a1210] shadow-sm">
      <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2">
        <TerminalSquare className="h-3.5 w-3.5 shrink-0 text-primary" />
        <code className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-100">
          {entry.command}
        </code>
        <ExitBadge entry={entry} />
        <span className="shrink-0 text-[10px] tabular-nums text-zinc-500">
          {clockTime(entry.at)}
        </span>
        <SimpleTooltip label="Copy command">
          <button
            type="button"
            aria-label="Copy command"
            onClick={() => copy(entry.command, 'Command')}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-zinc-500 hover:bg-white/10 hover:text-zinc-100"
          >
            <Copy className="h-3 w-3" />
          </button>
        </SimpleTooltip>
      </div>
      {lines.length > 0 ? (
        <>
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all px-3 py-2 font-mono text-[11px] leading-relaxed text-zinc-300">
            {shown.join('\n')}
          </pre>
          {foldable && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="flex w-full items-center justify-center gap-1 border-t border-white/10 py-1 text-[11px] text-zinc-400 hover:bg-white/5 hover:text-zinc-100"
            >
              {expanded ? (
                <>
                  <ChevronUp className="h-3 w-3" /> Show less
                </>
              ) : (
                <>
                  <ChevronDown className="h-3 w-3" /> Show all {lines.length} lines
                </>
              )}
            </button>
          )}
        </>
      ) : (
        <p className="px-3 py-2 text-[11px] italic text-zinc-500">No output</p>
      )}
    </div>
  );
}

/** One mouse or keyboard action the AI took on a remote desktop, and how it went. */
function ActionEntry({
  entry,
}: {
  entry: Extract<RdpAgentHistoryEntry, { kind: 'action' }>;
}): React.JSX.Element {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card shadow-sm">
      <div className="flex items-center gap-2 px-3 py-2">
        <Crosshair className="h-3.5 w-3.5 shrink-0 text-primary" />
        <code className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
          {entry.action}
        </code>
        <span
          className={cn(
            'shrink-0 rounded-full border px-2 py-px text-[10px] font-medium uppercase tracking-wide',
            entry.ok
              ? 'border-success/30 bg-success/10 text-success'
              : 'border-destructive/30 bg-destructive/10 text-destructive',
          )}
        >
          {entry.ok ? 'OK' : 'Failed'}
        </span>
        <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
          {clockTime(entry.at)}
        </span>
      </div>
      {entry.outcome && (
        <p className="border-t border-border/60 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
          {entry.outcome}
        </p>
      )}
    </div>
  );
}

/** A chat bubble: the user's words sit on the right, the AI's on the left. */
function Bubble({
  from,
  at,
  children,
  tone = 'default',
}: {
  from: 'you' | 'ai';
  at: number;
  children: React.ReactNode;
  tone?: 'default' | 'question';
}): React.JSX.Element {
  return (
    <div className={cn('flex flex-col gap-1', from === 'you' ? 'items-end' : 'items-start')}>
      <div
        className={cn(
          'max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2 text-sm',
          from === 'you'
            ? 'rounded-br-md bg-primary/15 text-foreground'
            : tone === 'question'
              ? 'rounded-bl-md border border-amber-400/30 bg-amber-400/10 text-foreground'
              : 'rounded-bl-md bg-foreground/5 text-foreground',
        )}
      >
        {children}
      </div>
      <span className="px-1 text-[10px] text-muted-foreground">
        {from === 'you' ? 'You' : 'AI'} · {clockTime(at)}
      </span>
    </div>
  );
}

function Note({
  icon,
  tone,
  children,
}: {
  icon: React.ReactNode;
  tone: 'error' | 'muted' | 'success';
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex items-start gap-2 rounded-lg px-3 py-2 text-xs',
        tone === 'error' && 'bg-destructive/10 text-destructive',
        tone === 'muted' && 'text-muted-foreground',
        tone === 'success' && 'border border-success/25 bg-success/10 text-foreground',
      )}
    >
      <span className="mt-px shrink-0">{icon}</span>
      <span className="min-w-0 flex-1 break-words">{children}</span>
    </div>
  );
}

function Entry({ entry }: { entry: AgentEntry }): React.JSX.Element {
  switch (entry.kind) {
    case 'command':
      return <CommandEntry entry={entry} />;
    case 'action':
      return <ActionEntry entry={entry} />;
    case 'skipped':
      return (
        <Note icon={<StopCircle className="h-3.5 w-3.5" />} tone="muted">
          You skipped{' '}
          <code className="rounded bg-black/30 px-1 font-mono">
            {'command' in entry ? entry.command : entry.action}
          </code>
        </Note>
      );
    case 'question':
      return (
        <Bubble from="ai" at={entry.at} tone="question">
          <span className="mb-0.5 flex items-center gap-1.5 text-[11px] font-medium text-amber-400">
            <CircleQuestion className="h-3 w-3" /> Question
          </span>
          {entry.text}
        </Bubble>
      );
    case 'answer':
      return (
        <Bubble from="you" at={entry.at}>
          {entry.text || <span className="italic text-muted-foreground">(no answer)</span>}
        </Bubble>
      );
    case 'message':
      return (
        <Bubble from="you" at={entry.at}>
          {entry.text}
        </Bubble>
      );
    case 'error':
      return (
        <Note icon={<TriangleAlert className="h-3.5 w-3.5" />} tone="error">
          {entry.text}
        </Note>
      );
    case 'continued':
      return (
        <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
          <span className="h-px flex-1 bg-border" />
          <span className="flex items-center gap-1">
            <Play className="h-3 w-3" /> You continued at {clockTime(entry.at)}
          </span>
          <span className="h-px flex-1 bg-border" />
        </div>
      );
    case 'finished':
      return (
        <Note icon={<CircleCheck className="h-3.5 w-3.5 text-success" />} tone="success">
          {entry.text}
        </Note>
      );
    case 'stopped':
      return (
        <Note icon={<StopCircle className="h-3.5 w-3.5" />} tone="muted">
          {entry.text}
        </Note>
      );
  }
}

function RunTimeline({
  run,
  parent,
  onOpenRun,
}: {
  run: AgentRun;
  /** The earlier task this one continued, when it is still in the list. */
  parent: AgentRun | null;
  onOpenRun: (id: string) => void;
}): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  // Follow a live run the way a chat does, unless the user scrolled up to read something.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  });

  // A plain block with spaced children, not a flex column. In a flex column the command and
  // action cards (overflow-hidden, so free to shrink to nothing) get squeezed to their borders
  // as soon as a long task has more entries than fit, and the whole timeline reads as blank rules.
  return (
    <div
      ref={scrollRef}
      data-testid="agent-timeline"
      onScroll={(e) => {
        const el = e.currentTarget;
        stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
      className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4"
    >
      {'continuedFromRunId' in run && run.continuedFromRunId ? (
        parent ? (
          <button
            type="button"
            aria-label={`Continues: ${parent.prompt}`}
            onClick={() => onOpenRun(parent.id)}
            className="flex w-full min-w-0 items-center gap-2 rounded-lg bg-primary/5 px-3 py-2 text-left text-xs ring-1 ring-inset ring-primary/15 transition-colors hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Link className="h-3 w-3 shrink-0 text-primary" />
            <span className="shrink-0 text-muted-foreground">Continues</span>
            <TruncatedText text={parent.prompt} focusable={false} className="flex-1 font-medium" />
            <span className="shrink-0 text-[10px] text-muted-foreground">Open</span>
          </button>
        ) : (
          <Note icon={<Link className="h-3.5 w-3.5" />} tone="muted">
            Continues an earlier task that is no longer in this list.
          </Note>
        )
      ) : null}
      <Bubble from="you" at={run.startedAt}>
        {run.prompt}
      </Bubble>
      {run.entries.map((entry, index) => (
        // Entries are only ever appended, so the index is a stable key.
        <Entry key={index} entry={entry} />
      ))}
      {run.status === 'running' && (
        <div className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
          <Robot className="h-3.5 w-3.5 animate-pulse text-primary" />
          Working…
        </div>
      )}
    </div>
  );
}

export function SshAgentHistoryDialog({
  sessionId,
  sessionTitle,
  open,
  onOpenChange,
  source,
  initialRunId = null,
  continuation = null,
}: {
  sessionId: string;
  sessionTitle: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Where to read the history from. A terminal's AI task history when absent. */
  source?: AgentHistorySource;
  /** The task shown first. The newest one when absent. */
  initialRunId?: string | null;
  /** How an ended terminal task is continued or run again from here. Read-only when absent. */
  continuation?: AgentRunContinuation | null;
}): React.JSX.Element {
  const sshLiveState = useSshAgentSession(sessionId);
  const liveState = source ? source.live : sshLiveState;
  const desktop = source?.kind === 'rdp';
  const historyQuery = useQuery<AgentRun[]>({
    queryKey: source?.queryKey ?? queryKeys.sshAgentHistory(sessionId),
    queryFn: source?.load ?? (() => window.runova.sshAgent.history(sessionId)),
    enabled: open,
    meta: { silentLoading: true },
  });
  const { refetch } = historyQuery;
  const runs = historyQuery.data ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = runs.find((run) => run.id === selectedId) ?? runs[0] ?? null;
  const selectedState = useSshAgentStore((s) =>
    selected ? s.sessions[selected.sessionId] : undefined,
  );
  // Only a session's newest task can be the one still going there.
  const isNewestOfSession =
    selected !== null && runs.find((run) => run.sessionId === selected.sessionId) === selected;
  const liveControls =
    !selected || !isNewestOfSession
      ? null
      : desktop
        ? (source?.controls ?? null)
        : sshControls(selected.sessionId, selectedState);
  // Once the next task starts, the list jumps to it, the newest, so the user sees it run.
  const footerContinuation: AgentRunContinuation | null = continuation && {
    ...continuation,
    continueWith: async (run, followUp) => {
      const started = await continuation.continueWith(run, followUp);
      if (started) setSelectedId(null);
      return started;
    },
  };
  const parentRun =
    selected && 'continuedFromRunId' in selected && selected.continuedFromRunId
      ? (runs.find((run) => run.id === selected.continuedFromRunId) ?? null)
      : null;

  // Each progress event means the history changed (a command ended, a question was answered).
  useEffect(() => {
    if (open && liveState) void refetch();
  }, [open, liveState, refetch]);

  // Opening again starts on the task asked for, or the newest one.
  useEffect(() => {
    if (open) setSelectedId(initialRunId);
  }, [open, initialRunId]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[80vh] max-w-5xl flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b border-border/70 px-5 py-4 pr-14">
          <DialogTitle className="flex items-center gap-2 text-base">
            <History className="h-4 w-4 text-primary" />
            AI task history
          </DialogTitle>
          <DialogDescription asChild>
            <div className="min-w-0">
              <TruncatedText
                text={
                  desktop
                    ? `Every task the AI ran in ${sessionTitle || 'this desktop'}, with each action, how it went, and what you answered. Answer, message or stop a task still going from here. Kept until Runova closes.`
                    : `Every task the AI ran in ${sessionTitle || 'this terminal'}, with each command, its output, and what you answered. Answer a task still going, or continue one that ended, from here. Tasks on a saved server are kept after Runova closes.`
                }
              />
            </div>
          </DialogDescription>
        </DialogHeader>

        {runs.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
            <div className="flex h-11 w-11 items-center justify-center rounded-full bg-primary/15 text-primary">
              <Robot className="h-5 w-5" />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium">No AI tasks here yet</p>
              <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">
                {historyQuery.isLoading
                  ? 'Loading…'
                  : desktop
                    ? 'Start one with Ask AI in the toolbar. Everything it does shows up here.'
                    : 'Start one with the robot button in the terminal bar. Everything it does shows up here.'}
              </p>
            </div>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1">
            <nav
              aria-label="Tasks"
              className="flex w-64 shrink-0 flex-col gap-1 overflow-y-auto border-r border-border/70 p-2"
            >
              {runs.map((run) => {
                const active = run.id === selected?.id;
                const count = stepCount(run);
                const noun = desktop ? 'action' : 'command';
                return (
                  <button
                    key={run.id}
                    type="button"
                    aria-current={active ? 'true' : undefined}
                    onClick={() => setSelectedId(run.id)}
                    className={cn(
                      'flex flex-col gap-1 rounded-lg px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      active ? 'bg-primary/10' : 'hover:bg-foreground/5',
                    )}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <StatusDot status={run.status} />
                      <TruncatedText
                        text={run.prompt}
                        lines={2}
                        side="right"
                        focusable={false}
                        className="flex-1 text-xs font-medium text-foreground"
                      />
                      {'continuedFromRunId' in run && run.continuedFromRunId ? (
                        <Link
                          aria-label="Continues an earlier task"
                          className="h-2.5 w-2.5 shrink-0 text-muted-foreground"
                        />
                      ) : null}
                    </span>
                    <span className="pl-4 text-[10px] text-muted-foreground">
                      {dayAndTime(run.startedAt)} · {count} {noun}
                      {count === 1 ? '' : 's'}
                    </span>
                  </button>
                );
              })}
            </nav>

            {selected && (
              <section className="flex min-w-0 flex-1 flex-col">
                <div className="flex items-center gap-2 border-b border-border/50 px-4 py-2 text-xs text-muted-foreground">
                  <StatusDot status={selected.status} />
                  <span className="font-medium text-foreground">
                    {STATUS_LABELS[selected.status]}
                  </span>
                  <span>·</span>
                  <span>{selected.aiLabel || 'AI'}</span>
                  <span>·</span>
                  <span>{duration(selected)}</span>
                  <span className="flex-1" />
                  <Button
                    size="sm"
                    variant="ghost"
                    className="gap-1.5"
                    onClick={() => copy(runAsText(selected), 'Transcript')}
                  >
                    <Copy className="h-3 w-3" />
                    Copy transcript
                  </Button>
                </div>
                <RunTimeline
                  key={selected.id}
                  run={selected}
                  parent={parentRun}
                  onOpenRun={setSelectedId}
                />
                <AgentHistoryFooter
                  run={selected}
                  target={
                    desktop
                      ? 'rdp'
                      : 'settings' in selected && selected.settings?.target === 'local'
                        ? 'local'
                        : 'ssh'
                  }
                  live={liveControls}
                  continuation={desktop ? null : footerContinuation}
                />
              </section>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
