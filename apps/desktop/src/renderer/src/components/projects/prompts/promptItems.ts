import type { ProjectDraft, ScheduledTask } from '@runova/core';
import type { PromptHistoryEntry } from '@shared/apiTypes';

export type PromptView = 'all' | 'drafts' | 'scheduled';

export const PROMPT_VIEWS: readonly PromptView[] = ['all', 'drafts', 'scheduled'];

export function isPromptView(value: string | null): value is PromptView {
  return value !== null && (PROMPT_VIEWS as readonly string[]).includes(value);
}

export type PromptItem =
  | { kind: 'history'; id: string; date: string; entry: PromptHistoryEntry }
  | { kind: 'draft'; id: string; date: string; draft: ProjectDraft }
  | { kind: 'scheduled'; id: string; date: string; task: ScheduledTask };

/** The prompt a draft would run: the generated one, or the request itself when nothing was generated. */
export function draftPromptText(draft: ProjectDraft): string {
  return draft.content.trim() ? draft.content : draft.rawInput;
}

export function taskPromptText(task: ScheduledTask): string {
  return task.content.trim() ? task.content : task.rawInput;
}

/**
 * Everything in one newest-first list. A scheduled task sorts by when it last ran, or else when
 * it was created, so the timeline says what happened when rather than what's planned.
 */
export function mergePromptItems(
  history: PromptHistoryEntry[],
  drafts: ProjectDraft[],
  tasks: ScheduledTask[],
): PromptItem[] {
  const items: PromptItem[] = [
    ...history.map((entry) => ({
      kind: 'history' as const,
      id: `history:${entry.id}`,
      date: entry.createdAt,
      entry,
    })),
    ...drafts.map((draft) => ({
      kind: 'draft' as const,
      id: `draft:${draft.id}`,
      date: draft.implementedAt ?? draft.createdAt,
      draft,
    })),
    ...tasks.map((task) => ({
      kind: 'scheduled' as const,
      id: `scheduled:${task.id}`,
      date: task.ranAt ?? task.createdAt,
      task,
    })),
  ];
  return items.sort((a, b) => b.date.localeCompare(a.date));
}

function itemText(item: PromptItem): string {
  switch (item.kind) {
    case 'history':
      return [item.entry.content, item.entry.rawInput, item.entry.promptType, item.entry.targetAI]
        .concat(item.entry.tags)
        .join('\n');
    case 'draft':
      return [
        item.draft.content,
        item.draft.rawInput,
        item.draft.promptType,
        item.draft.targetAI,
      ].join('\n');
    case 'scheduled':
      return [
        item.task.content,
        item.task.rawInput,
        item.task.targetAI,
        item.task.cliId ?? '',
        item.task.model ?? '',
      ].join('\n');
  }
}

export function matchesSearch(item: PromptItem, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return itemText(item).toLowerCase().includes(needle);
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** "Today", "Yesterday", or a short date, for grouping the timeline. */
export function dayLabel(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return date.toLocaleDateString(undefined, {
    weekday: days < 7 ? 'long' : undefined,
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric',
  });
}

export function groupByDay(
  items: PromptItem[],
  now: Date = new Date(),
): { label: string; items: PromptItem[] }[] {
  const groups: { label: string; items: PromptItem[] }[] = [];
  for (const item of items) {
    const label = dayLabel(item.date, now);
    const last = groups[groups.length - 1];
    if (last?.label === label) last.items.push(item);
    else groups.push({ label, items: [item] });
  }
  return groups;
}

export interface ScheduledGroups {
  /** Automatic tasks whose time passed while the app was closed. */
  attention: ScheduledTask[];
  /** Automatic tasks by time, then manual ones by when they were added. */
  upcoming: ScheduledTask[];
  /** Run or cancelled, most recent first. */
  past: ScheduledTask[];
}

export function groupScheduled(tasks: ScheduledTask[]): ScheduledGroups {
  const attention = tasks.filter((t) => t.status === 'missed');
  const pending = tasks.filter((t) => t.status === 'pending');
  const auto = pending
    .filter((t) => t.runMode === 'auto')
    .sort((a, b) => a.runAt.localeCompare(b.runAt));
  const manual = pending
    .filter((t) => t.runMode !== 'auto')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const past = tasks
    .filter((t) => t.status === 'completed' || t.status === 'cancelled')
    .sort((a, b) => (b.ranAt ?? b.createdAt).localeCompare(a.ranAt ?? a.createdAt));
  return { attention, upcoming: [...auto, ...manual], past };
}

/** "in 5m", "in 3h", "in 2d", or "now" once the time has come. */
export function timeUntil(iso: string, now: number = Date.now()): string {
  const minutes = Math.round((new Date(iso).getTime() - now) / 60_000);
  if (minutes <= 0) return 'now';
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}

/** Value for a datetime-local input, in local time, e.g. "2026-07-19T10:00". */
export function toLocalInputValue(date: Date): string {
  const copy = new Date(date);
  copy.setSeconds(0, 0);
  return new Date(copy.getTime() - copy.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

/** An hour from now, on the minute. */
export function defaultRunAtInput(now: number = Date.now()): string {
  return toLocalInputValue(new Date(now + 60 * 60 * 1000));
}

/** Short run time for a card: "Tue 14:00", with the date added when it isn't this week. */
export function formatRunAt(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  const withinWeek = Math.abs(date.getTime() - now.getTime()) < 6 * 86_400_000;
  return date.toLocaleString(undefined, {
    weekday: withinWeek ? 'short' : undefined,
    month: withinWeek ? undefined : 'short',
    day: withinWeek ? undefined : 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
