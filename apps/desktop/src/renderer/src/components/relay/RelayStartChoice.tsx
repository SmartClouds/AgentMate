import type { RelayTrigger } from '@agentmat/core';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { CalendarDays, Clock, Play, Plus, TerminalSquare } from '@/components/icons';
import { Combobox } from '@/components/ui/combobox';
import { Switch } from '@/components/ui/switch';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { useAgentStatusStore } from '@/stores/agentStatusStore';
import { terminalTabLabel, useWorkspaceStore } from '@/stores/workspaceStore';

/** When new tasks run once they are on the board. */
export type StartChoice =
  | { kind: 'add' }
  | { kind: 'now' }
  | { kind: 'at'; at: string }
  | { kind: 'after-task'; taskId: string }
  | { kind: 'after-session'; sessionId: string; label: string };

export const ADD_ONLY: StartChoice = { kind: 'add' };

/** The relay trigger a choice makes, or null for "just add" and for a choice not filled in yet. */
export function triggerFor(choice: StartChoice, projectId: string): RelayTrigger | null {
  switch (choice.kind) {
    case 'add':
      return null;
    case 'now':
      return { kind: 'now' };
    case 'at': {
      const at = new Date(choice.at).getTime();
      return Number.isFinite(at) ? { kind: 'at', at } : null;
    }
    case 'after-task':
      return choice.taskId ? { kind: 'after-task', projectId, taskId: choice.taskId } : null;
    case 'after-session':
      return choice.sessionId
        ? { kind: 'after-session', sessionId: choice.sessionId, label: choice.label }
        : null;
  }
}

/** A choice that still needs its time, task or session picked. */
export function choiceIncomplete(choice: StartChoice, projectId: string): boolean {
  return choice.kind !== 'add' && triggerFor(choice, projectId) === null;
}

interface BusySession {
  sessionId: string;
  label: string;
}

/** Agent tabs, in any project, whose agent is working or waiting on its user right now. */
function useBusySessions(): BusySession[] {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const statuses = useAgentStatusStore((s) => s.statuses);
  const projectsQuery = useQuery({
    queryKey: queryKeys.projects,
    queryFn: () => window.agentmat.projects.list(),
  });
  return useMemo(() => {
    const names = new Map((projectsQuery.data ?? []).map((project) => [project.id, project.name]));
    const sessions: BusySession[] = [];
    for (const [projectId, workspace] of Object.entries(workspaces)) {
      for (const tab of Object.values(workspace.tabs ?? {})) {
        if (tab.kind !== 'terminal' || !tab.cliId) continue;
        const status = statuses[tab.id];
        if (status !== 'working' && status !== 'needs-input') continue;
        const project = names.get(projectId);
        sessions.push({
          sessionId: tab.id,
          label: project ? `${project} · ${terminalTabLabel(tab)}` : terminalTabLabel(tab),
        });
      }
    }
    return sessions;
  }, [workspaces, statuses, projectsQuery.data]);
}

const OPTIONS = [
  { kind: 'add', label: 'Just add', hint: 'Run them later from the board', Icon: Plus },
  { kind: 'now', label: 'Run now', hint: 'One session per task, in order', Icon: Play },
  { kind: 'at', label: 'At a time', hint: 'Start on a date and hour', Icon: CalendarDays },
  { kind: 'after-task', label: 'After a task', hint: 'When another task is done', Icon: Clock },
  {
    kind: 'after-session',
    label: 'After a session',
    hint: 'When a working agent finishes',
    Icon: TerminalSquare,
  },
] as const;

function blank(kind: StartChoice['kind']): StartChoice {
  switch (kind) {
    case 'at':
      return { kind, at: '' };
    case 'after-task':
      return { kind, taskId: '' };
    case 'after-session':
      return { kind, sessionId: '', label: '' };
    default:
      return { kind };
  }
}

/**
 * How the new tasks start: the choice as a row of cards, the one field the choice needs under
 * it, and whether each task's first session plans before it changes anything.
 */
export function RelayStartChoice({
  projectId,
  value,
  onChange,
  planFirst,
  onPlanFirstChange,
  disabled = false,
}: {
  projectId: string;
  value: StartChoice;
  onChange: (next: StartChoice) => void;
  planFirst: boolean;
  onPlanFirstChange: (next: boolean) => void;
  disabled?: boolean;
}): React.JSX.Element {
  const boardQuery = useQuery({
    queryKey: queryKeys.relayBoard(projectId),
    queryFn: () => window.agentmat.relay.board(projectId),
    enabled: value.kind === 'after-task',
  });
  const sessions = useBusySessions();
  const waitable = (boardQuery.data?.tasks ?? []).filter((task) => task.status !== 'done');

  return (
    <div className="space-y-3">
      <div
        role="radiogroup"
        aria-label="When to run"
        className="grid grid-cols-2 gap-1.5 sm:grid-cols-5"
      >
        {OPTIONS.map((option) => {
          const selected = value.kind === option.kind;
          return (
            <button
              key={option.kind}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={disabled}
              onClick={() => onChange(blank(option.kind))}
              className={cn(
                'flex min-w-0 cursor-pointer flex-col items-start gap-1 rounded-xl px-2.5 py-2 text-left ring-1 transition-colors ring-inset disabled:pointer-events-none disabled:opacity-50',
                selected
                  ? 'bg-primary/10 ring-primary/40'
                  : 'bg-foreground/[0.03] ring-foreground/[0.08] hover:bg-foreground/[0.06]',
              )}
            >
              <option.Icon
                aria-hidden
                className={cn('h-3.5 w-3.5', selected ? 'text-primary' : 'text-muted-foreground')}
              />
              <span className="text-xs font-medium">{option.label}</span>
              <span className="text-[10px] leading-snug text-muted-foreground">{option.hint}</span>
            </button>
          );
        })}
      </div>

      {value.kind === 'at' ? (
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>Start at</span>
          <input
            type="datetime-local"
            aria-label="Start at"
            value={value.at}
            disabled={disabled}
            onChange={(event) => onChange({ kind: 'at', at: event.target.value })}
            className="field-surface h-8 rounded-lg px-2.5 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </label>
      ) : null}

      {value.kind === 'after-task' ? (
        <Combobox
          ariaLabel="Task to wait for"
          className="h-8 text-xs"
          value={value.taskId}
          disabled={disabled}
          onChange={(taskId) => onChange({ kind: 'after-task', taskId })}
          placeholder={boardQuery.isPending ? 'Loading tasks…' : 'Pick a task'}
          searchPlaceholder="Search tasks…"
          emptyText="No task left to wait for."
          options={waitable.map((task) => ({
            value: task.id,
            label: `${task.id} ${task.title}`,
          }))}
        />
      ) : null}

      {value.kind === 'after-session' ? (
        <Combobox
          ariaLabel="Session to wait for"
          className="h-8 text-xs"
          value={value.sessionId}
          disabled={disabled}
          onChange={(sessionId) =>
            onChange({
              kind: 'after-session',
              sessionId,
              label: sessions.find((session) => session.sessionId === sessionId)?.label ?? '',
            })
          }
          placeholder={sessions.length > 0 ? 'Pick a session' : 'No agent is working now'}
          searchPlaceholder="Search sessions…"
          emptyText="No agent is working now."
          options={sessions.map((session) => ({ value: session.sessionId, label: session.label }))}
        />
      ) : null}

      <div className="flex items-start justify-between gap-3 rounded-xl bg-foreground/[0.03] px-3 py-2.5 ring-1 ring-foreground/[0.07] ring-inset">
        <div className="min-w-0">
          <p className="text-xs font-medium">Plan first</p>
          <p className="text-[11px] leading-snug text-muted-foreground">
            Each task&apos;s first session starts in plan mode. Claude Code moves on to the work by
            itself when the plan has no open questions; other CLIs wait for you to approve it.
          </p>
        </div>
        <Switch
          aria-label="Plan first"
          checked={planFirst}
          disabled={disabled}
          onCheckedChange={onPlanFirstChange}
        />
      </div>
    </div>
  );
}
