import type { ChatToolItem, ChatToolKind } from '@runova/core';
import { useState } from 'react';
import {
  ChevronRight,
  CircleCheck,
  CircleX,
  FileText,
  Globe,
  ListTodo,
  Pencil,
  Robot,
  Search,
  Spinner,
  TerminalSquare,
  Wrench,
} from '@/components/icons';
import { cn } from '@/lib/utils';
import type { ChatTheme } from './chatThemes';

const KIND_ICONS: Record<ChatToolKind, typeof Wrench> = {
  shell: TerminalSquare,
  read: FileText,
  edit: Pencil,
  search: Search,
  web: Globe,
  task: Robot,
  plan: ListTodo,
  other: Wrench,
};

const KIND_VERBS: Record<ChatToolKind, string> = {
  shell: 'Ran',
  read: 'Read',
  edit: 'Edited',
  search: 'Searched',
  web: 'Browsed',
  task: 'Agent',
  plan: 'Plan',
  other: 'Used',
};

/** Long output is cut so one big file read cannot slow the whole chat down. */
const OUTPUT_LIMIT = 6000;

function clip(text: string): string {
  return text.length > OUTPUT_LIMIT ? `${text.slice(0, OUTPUT_LIMIT)}\n…` : text;
}

function StatusMark({ status }: { status: ChatToolItem['status'] }): React.JSX.Element {
  if (status === 'running') {
    return <Spinner className="h-3 w-3 shrink-0 animate-spin text-muted-foreground" />;
  }
  if (status === 'error') return <CircleX className="h-3.5 w-3.5 shrink-0 text-destructive" />;
  return <CircleCheck className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />;
}

function EditDiff({ item }: { item: ChatToolItem }): React.JSX.Element | null {
  if (!item.edit) return null;
  const removed = item.edit.before ? item.edit.before.split('\n') : [];
  const added = item.edit.after.split('\n');
  return (
    <pre className="max-h-72 overflow-auto rounded-md bg-black/[0.03] py-1.5 font-mono text-[11px] leading-5 dark:bg-white/[0.04]">
      {removed.map((text, i) => (
        <div key={`-${i}`} className="bg-red-500/10 px-3 text-red-700 dark:text-red-300">
          - {text}
        </div>
      ))}
      {added.map((text, i) => (
        <div
          key={`+${i}`}
          className="bg-emerald-500/10 px-3 text-emerald-700 dark:text-emerald-300"
        >
          + {text}
        </div>
      ))}
    </pre>
  );
}

/** One tool call in a reply: a compact line that opens to show what went in and came out. */
export function ToolCallCard({
  item,
  theme,
}: {
  item: ChatToolItem;
  theme: ChatTheme;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const Icon = KIND_ICONS[item.toolKind];
  const detail = item.edit ? null : item.detail && item.detail !== item.title ? item.detail : null;
  const hasBody = Boolean(item.edit || detail || item.output);
  return (
    <div className={cn('overflow-hidden text-xs', theme.card)}>
      <button
        type="button"
        aria-expanded={open}
        aria-label={`${KIND_VERBS[item.toolKind]} ${item.title}`}
        data-status={item.status}
        disabled={!hasBody}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full min-w-0 cursor-pointer items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-black/[0.03] disabled:cursor-default disabled:hover:bg-transparent dark:hover:bg-white/[0.04]"
      >
        <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0 font-medium text-muted-foreground">
          {KIND_VERBS[item.toolKind]}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]" dir="auto">
          {item.title}
        </span>
        <StatusMark status={item.status} />
        {hasBody ? (
          <ChevronRight
            className={cn(
              'h-3 w-3 shrink-0 text-muted-foreground transition-transform',
              open && 'rotate-90',
            )}
          />
        ) : null}
      </button>
      {open ? (
        <div className="space-y-2 border-t border-inherit px-3 py-2.5">
          {detail ? (
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-5 text-foreground/80">
              {clip(detail)}
            </pre>
          ) : null}
          <EditDiff item={item} />
          {item.output ? (
            <pre
              className={cn(
                'max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-black/[0.03] px-3 py-2 font-mono text-[11px] leading-5 dark:bg-white/[0.04]',
                item.status === 'error' && 'text-destructive',
              )}
            >
              {clip(item.output)}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
