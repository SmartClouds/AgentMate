import type { RelayTrigger } from '@runova/core';
import type { RelayBoard } from '@shared/relayTypes';
import { useMemo, useState } from 'react';
import { CalendarDays, ChevronDown, Clock, Play, TerminalSquare } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { useAgentStatusStore } from '@/stores/agentStatusStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { useRelayActions } from './useRelay';

type ScheduleKind = 'at' | 'after-task' | 'after-session';

export interface BusySession {
  id: string;
  label: string;
}

/** Agent tabs that are working or waiting on the user right now: what "after a session" can follow. */
export function useBusySessions(): BusySession[] {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const statuses = useAgentStatusStore((s) => s.statuses);
  return useMemo(() => {
    const sessions: BusySession[] = [];
    for (const workspace of Object.values(workspaces)) {
      for (const tab of Object.values(workspace.tabs)) {
        if (tab.kind !== 'terminal' || !tab.cliId) continue;
        const status = statuses[tab.id];
        if (status !== 'working' && status !== 'needs-input') continue;
        sessions.push({ id: tab.id, label: tab.userTitle ?? tab.agentTitle ?? tab.title });
      }
    }
    return sessions;
  }, [workspaces, statuses]);
}

/** A local date-time input value, an hour from now, rounded to the minute. */
function inAnHour(now = Date.now()): string {
  const date = new Date(now + 60 * 60_000);
  date.setSeconds(0, 0);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const KINDS: {
  kind: ScheduleKind;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}[] = [
  { kind: 'at', label: 'At a time', icon: CalendarDays },
  { kind: 'after-task', label: 'After a task', icon: Clock },
  { kind: 'after-session', label: 'After a session', icon: TerminalSquare },
];

export function ScheduleRelayDialog({
  board,
  open,
  onOpenChange,
}: {
  board: RelayBoard;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const { start } = useRelayActions();
  const sessions = useBusySessions();
  const [kind, setKind] = useState<ScheduleKind>('at');
  const [at, setAt] = useState(inAnHour);
  const [taskId, setTaskId] = useState('');
  const [sessionId, setSessionId] = useState('');
  const pending = board.tasks.filter((task) => task.status !== 'done');

  let trigger: RelayTrigger | null = null;
  if (kind === 'at' && at) {
    const when = new Date(at).getTime();
    if (Number.isFinite(when)) trigger = { kind: 'at', at: when };
  } else if (kind === 'after-task' && taskId) {
    trigger = { kind: 'after-task', projectId: board.projectId, taskId };
  } else if (kind === 'after-session' && sessionId) {
    const label = sessions.find((session) => session.id === sessionId)?.label;
    trigger = { kind: 'after-session', sessionId, label };
  }

  async function schedule(): Promise<void> {
    if (!trigger) return;
    if (await start({ projectId: board.projectId, trigger })) onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Schedule the relay</DialogTitle>
          <DialogDescription>
            Every task that is not done runs one after another, each in a fresh session, once this
            happens.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div role="radiogroup" aria-label="Start" className="grid grid-cols-3 gap-1.5">
            {KINDS.map((option) => (
              <button
                key={option.kind}
                type="button"
                role="radio"
                aria-checked={kind === option.kind}
                onClick={() => setKind(option.kind)}
                className={cn(
                  'flex cursor-pointer flex-col items-center gap-1 rounded-lg border px-2 py-2.5 text-[12px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
                  kind === option.kind
                    ? 'border-primary/60 bg-primary/10 text-foreground'
                    : 'border-border/70 text-muted-foreground hover:bg-foreground/[0.04]',
                )}
              >
                <option.icon className="h-3.5 w-3.5" />
                {option.label}
              </button>
            ))}
          </div>
          {kind === 'at' ? (
            <div className="space-y-1.5">
              <Label htmlFor="relay-schedule-at">Starts at</Label>
              <Input
                id="relay-schedule-at"
                type="datetime-local"
                value={at}
                onChange={(event) => setAt(event.target.value)}
              />
            </div>
          ) : null}
          {kind === 'after-task' ? (
            <div className="space-y-1.5">
              <Label>Starts when this task is done</Label>
              <Combobox
                ariaLabel="Task to wait for"
                options={pending.map((task) => ({
                  value: task.id,
                  label: `${task.id} ${task.title}`,
                }))}
                value={taskId}
                onChange={setTaskId}
                placeholder="Pick a task"
                emptyText="Every task is done."
              />
            </div>
          ) : null}
          {kind === 'after-session' ? (
            <div className="space-y-1.5">
              <Label>Starts when this session finishes</Label>
              {sessions.length > 0 ? (
                <Combobox
                  ariaLabel="Session to wait for"
                  options={sessions.map((session) => ({ value: session.id, label: session.label }))}
                  value={sessionId}
                  onChange={setSessionId}
                  placeholder="Pick a session"
                />
              ) : (
                <p className="text-[12px] text-muted-foreground">
                  No agent is working right now. Start one, then come back to follow it.
                </p>
              )}
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" disabled={!trigger} onClick={() => void schedule()}>
            <Clock /> Schedule relay
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Starts the relay now, or schedules it. Split like a dropdown button: the face runs every task
 * that is not done, the arrow offers the rest.
 */
export function RunRelayButton({
  board,
  size = 'sm',
}: {
  board: RelayBoard;
  size?: 'sm' | 'default';
}): React.JSX.Element {
  const { start } = useRelayActions();
  const [scheduling, setScheduling] = useState(false);
  const runnable = board.tasks.some((task) => task.status !== 'done' && task.status !== 'blocked');

  return (
    <>
      <div className="inline-flex items-stretch">
        <Button
          type="button"
          size={size}
          disabled={!runnable}
          className="rounded-r-none pr-2.5"
          onClick={() => void start({ projectId: board.projectId, trigger: { kind: 'now' } })}
        >
          <Play /> Run relay
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              size={size}
              aria-label="More ways to run"
              className="rounded-l-none border-l border-primary-foreground/20 px-1.5"
            >
              <ChevronDown className="h-3 w-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuItem
              disabled={!runnable}
              onSelect={() => void start({ projectId: board.projectId, trigger: { kind: 'now' } })}
            >
              <Play /> Run every task now
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setScheduling(true)}>
              <Clock /> Schedule…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <ScheduleRelayDialog board={board} open={scheduling} onOpenChange={setScheduling} />
    </>
  );
}
