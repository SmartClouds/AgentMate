import {
  EFFORT_LABELS,
  getCliDefinition,
  type ProjectDraft,
  type ScheduledTask,
} from '@runova/core';
import type { PromptHistoryEntry } from '@shared/apiTypes';
import { useEffect, useRef, useState } from 'react';
import { CliLogo } from '@/components/cliLogos';
import {
  ArrowRight,
  Ban,
  CalendarDays,
  Check,
  Copy,
  FileText,
  History,
  Languages,
  Pencil,
  Play,
  RefreshCw,
  Sparkles,
  Trash2,
  TriangleAlert,
} from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { persianTextProps } from '@/lib/rtl';
import { timeAgo } from '@/lib/time';
import { cn } from '@/lib/utils';
import { draftPromptText, formatRunAt, taskPromptText, timeUntil } from './promptItems';

type Tone = 'history' | 'draft' | 'scheduled' | 'attention' | 'done';

const TONE_TILE: Record<Tone, string> = {
  history: 'bg-muted text-muted-foreground',
  draft: 'bg-warning/15 text-warning',
  scheduled: 'bg-primary/15 text-primary',
  attention: 'bg-destructive/15 text-destructive',
  done: 'bg-success/15 text-success',
};

function IconAction({
  label,
  onClick,
  disabled,
  destructive,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  destructive?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <SimpleTooltip label={label} wrapTrigger={disabled}>
      <Button
        variant="ghost"
        size="icon"
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
        className={cn(destructive && 'hover:text-destructive')}
      >
        {children}
      </Button>
    </SimpleTooltip>
  );
}

/** The frame every prompt row shares: a kind tile, a header line, the text, and actions. */
function RowShell({
  tone,
  icon,
  header,
  actions,
  children,
  highlighted,
}: {
  tone: Tone;
  icon: React.ReactNode;
  header: React.ReactNode;
  actions: React.ReactNode;
  children: React.ReactNode;
  highlighted?: boolean;
}): React.JSX.Element {
  return (
    <div
      className={cn(
        // Glass like the rest of the project page; the edges are rings, since the glass border
        // is unlayered CSS that a border colour utility can't override.
        'glass group flex gap-3 rounded-[calc(var(--radius)+2px)] px-3 py-2.5 transition-shadow hover:ring-1 hover:ring-foreground/10',
        highlighted && 'ring-1 ring-destructive/40 hover:ring-destructive/50',
      )}
    >
      <div
        className={cn(
          'mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md',
          TONE_TILE[tone],
        )}
      >
        {icon}
      </div>
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs">{header}</div>
          <div className="-my-1 -mr-1 flex items-center opacity-70 transition-opacity group-hover:opacity-100">
            {actions}
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}

function KindLabel({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <span className="font-medium text-foreground">{children}</span>;
}

function Meta({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <span className="text-muted-foreground">{children}</span>;
}

/** Two lines of the prompt, with a toggle to read the rest. */
function PromptText({ text, muted }: { text: string; muted?: boolean }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const rtl = persianTextProps(text);
  const long = text.length > 180 || text.split('\n').length > 2;
  return (
    <div className="space-y-1">
      <p
        dir={rtl.dir}
        className={cn(
          'whitespace-pre-wrap break-words text-sm',
          !expanded && 'line-clamp-2',
          muted && 'text-muted-foreground',
          rtl.className,
        )}
      >
        {text || '(empty)'}
      </p>
      {long ? (
        <button
          type="button"
          className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      ) : null}
    </div>
  );
}

export function HistoryRow({
  entry,
  canMove,
  onCopy,
  onMove,
  onDelete,
}: {
  entry: PromptHistoryEntry;
  canMove: boolean;
  onCopy: (text: string) => void;
  onMove: () => void;
  onDelete: () => void;
}): React.JSX.Element {
  const [showOriginal, setShowOriginal] = useState(false);
  const translated = entry.source === 'translate';
  const rawRtl = persianTextProps(entry.rawInput);
  return (
    <RowShell
      tone="history"
      icon={<History className="h-4 w-4" />}
      header={
        <>
          <KindLabel>History</KindLabel>
          <Badge variant="secondary" className="gap-1 px-2 py-0 text-[11px]">
            {translated ? <Languages className="h-3 w-3" /> : <Sparkles className="h-3 w-3" />}
            {translated ? 'Translated' : 'Generated'}
          </Badge>
          {entry.promptType ? <Meta>{entry.promptType}</Meta> : null}
          {entry.targetAI ? <Meta>· {entry.targetAI}</Meta> : null}
          <Meta>· {timeAgo(entry.createdAt)}</Meta>
        </>
      }
      actions={
        <>
          <IconAction label="Copy prompt" onClick={() => onCopy(entry.content)}>
            <Copy className="h-4 w-4" />
          </IconAction>
          {canMove ? (
            <IconAction label="Move to another project" onClick={onMove}>
              <ArrowRight className="h-4 w-4" />
            </IconAction>
          ) : null}
          <IconAction label="Delete" destructive onClick={onDelete}>
            <Trash2 className="h-4 w-4" />
          </IconAction>
        </>
      }
    >
      <PromptText text={entry.content} />
      {entry.rawInput && entry.rawInput !== entry.content ? (
        <div className="space-y-1">
          <button
            type="button"
            className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            onClick={() => setShowOriginal((v) => !v)}
          >
            {showOriginal ? 'Hide original input' : 'Show original input'}
          </button>
          {showOriginal ? (
            <p
              dir={rawRtl.dir}
              className={cn(
                'whitespace-pre-wrap rounded-md border border-border bg-muted/40 p-2 text-xs',
                rawRtl.className,
              )}
            >
              {entry.rawInput}
            </p>
          ) : null}
        </div>
      ) : null}
    </RowShell>
  );
}

export function DraftRow({
  draft,
  saving,
  onSave,
  onSchedule,
  onToggleImplemented,
  onCopy,
  onDelete,
}: {
  draft: ProjectDraft;
  saving: boolean;
  onSave: (text: string) => void;
  onSchedule: () => void;
  onToggleImplemented: () => void;
  onCopy: (text: string) => void;
  onDelete: () => void;
}): React.JSX.Element {
  const text = draftPromptText(draft);
  const implemented = draft.status === 'implemented';
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(text);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const rtl = persianTextProps(value);

  useEffect(() => {
    if (!editing) setValue(text);
  }, [editing, text]);

  useEffect(() => {
    if (!editing) return;
    const area = areaRef.current;
    area?.focus();
    area?.setSelectionRange(area.value.length, area.value.length);
  }, [editing]);

  function finish(): void {
    setEditing(false);
    if (value.trim() && value !== text) onSave(value);
  }

  return (
    <RowShell
      tone={implemented ? 'done' : 'draft'}
      icon={implemented ? <Check className="h-4 w-4" /> : <FileText className="h-4 w-4" />}
      header={
        <>
          <KindLabel>{implemented ? 'Implemented' : 'Draft'}</KindLabel>
          {draft.promptType ? <Meta>{draft.promptType}</Meta> : null}
          {draft.targetAI ? <Meta>· {draft.targetAI}</Meta> : null}
          <Meta>
            ·{' '}
            {implemented && draft.implementedAt
              ? `done ${timeAgo(draft.implementedAt)}`
              : timeAgo(draft.createdAt)}
          </Meta>
          {saving ? <Meta>· Saving…</Meta> : null}
        </>
      }
      actions={
        <>
          {!implemented ? (
            <>
              <IconAction label="Schedule it" onClick={onSchedule}>
                <CalendarDays className="h-4 w-4" />
              </IconAction>
              <IconAction label="Edit" onClick={() => setEditing(true)} disabled={editing}>
                <Pencil className="h-4 w-4" />
              </IconAction>
            </>
          ) : null}
          <IconAction label="Copy prompt" onClick={() => onCopy(text)}>
            <Copy className="h-4 w-4" />
          </IconAction>
          <IconAction
            label={implemented ? 'Reopen draft' : 'Mark implemented'}
            onClick={onToggleImplemented}
          >
            {implemented ? <RefreshCw className="h-4 w-4" /> : <Check className="h-4 w-4" />}
          </IconAction>
          <IconAction label="Delete" destructive onClick={onDelete}>
            <Trash2 className="h-4 w-4" />
          </IconAction>
        </>
      }
    >
      {editing ? (
        <div className="space-y-1.5">
          <Textarea
            ref={areaRef}
            rows={Math.min(12, Math.max(3, value.split('\n').length + 1))}
            dir={rtl.dir}
            className={cn('text-sm', rtl.className)}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onBlur={finish}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                setValue(text);
                setEditing(false);
              } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                finish();
              }
            }}
          />
          <p className="text-[11px] text-muted-foreground">
            Saves when you click away. Esc discards the change.
          </p>
        </div>
      ) : (
        <button
          type="button"
          className="block w-full cursor-text text-left disabled:cursor-default"
          disabled={implemented}
          onDoubleClick={() => setEditing(true)}
        >
          <PromptText text={text} muted={implemented} />
        </button>
      )}
    </RowShell>
  );
}

function RunChips({ task }: { task: ScheduledTask }): React.JSX.Element | null {
  const cli = task.cliId ? getCliDefinition(task.cliId) : undefined;
  if (!task.cliId && !task.model && !task.effort) return <Meta>· Default CLI</Meta>;
  return (
    <>
      {task.cliId ? (
        <Badge variant="outline" className="gap-1 px-2 py-0 text-[11px] font-normal">
          <CliLogo cliId={task.cliId} className="h-3 w-3" />
          {cli?.name ?? task.cliId}
        </Badge>
      ) : null}
      {task.model ? (
        <Badge variant="outline" className="px-2 py-0 font-mono text-[11px] font-normal">
          {task.model}
        </Badge>
      ) : null}
      {task.effort ? (
        <Badge variant="outline" className="px-2 py-0 text-[11px] font-normal">
          {EFFORT_LABELS[task.effort]}
        </Badge>
      ) : null}
    </>
  );
}

function RunModePill({ task }: { task: ScheduledTask }): React.JSX.Element {
  if (task.runMode !== 'auto') {
    return (
      <Badge variant="secondary" className="gap-1 px-2 py-0 text-[11px]">
        <Play className="h-3 w-3" /> Manual
      </Badge>
    );
  }
  const waiting = task.status === 'pending';
  return (
    <SimpleTooltip label={new Date(task.runAt).toLocaleString()}>
      <Badge
        variant={waiting ? 'default' : 'secondary'}
        className="gap-1 px-2 py-0 text-[11px] shadow-none"
      >
        <CalendarDays className="h-3 w-3" />
        Auto · {formatRunAt(task.runAt)}
        {waiting ? <span className="opacity-80">({timeUntil(task.runAt)})</span> : null}
      </Badge>
    </SimpleTooltip>
  );
}

const STATUS_TEXT: Record<ScheduledTask['status'], string> = {
  pending: 'Scheduled',
  missed: 'Missed',
  completed: 'Ran',
  cancelled: 'Cancelled',
};

export function ScheduledRow({
  task,
  onRun,
  onEdit,
  onCancel,
  onCopy,
  onDelete,
}: {
  task: ScheduledTask;
  onRun: () => void;
  onEdit: () => void;
  onCancel: () => void;
  onCopy: (text: string) => void;
  onDelete: () => void;
}): React.JSX.Element {
  const text = taskPromptText(task);
  const missed = task.status === 'missed';
  const finished = task.status === 'completed' || task.status === 'cancelled';
  const tone: Tone = missed ? 'attention' : finished ? 'done' : 'scheduled';
  return (
    <RowShell
      tone={tone}
      highlighted={missed}
      icon={
        missed ? (
          <TriangleAlert className="h-4 w-4" />
        ) : task.status === 'cancelled' ? (
          <Ban className="h-4 w-4" />
        ) : task.status === 'completed' ? (
          <Check className="h-4 w-4" />
        ) : (
          <CalendarDays className="h-4 w-4" />
        )
      }
      header={
        <>
          <KindLabel>{STATUS_TEXT[task.status]}</KindLabel>
          {!finished ? <RunModePill task={task} /> : null}
          <RunChips task={task} />
          {finished ? (
            <Meta>
              ·{' '}
              {task.status === 'completed' && task.ranAt
                ? `ran ${timeAgo(task.ranAt)}`
                : `added ${timeAgo(task.createdAt)}`}
            </Meta>
          ) : null}
          {missed ? <Meta>· was due {new Date(task.runAt).toLocaleString()}</Meta> : null}
        </>
      }
      actions={
        <>
          {missed ? (
            <Button size="sm" className="mr-1" onClick={onRun}>
              <Play className="h-3.5 w-3.5" /> Run now
            </Button>
          ) : (
            <IconAction label={finished ? 'Run again' : 'Run now'} onClick={onRun}>
              <Play className="h-4 w-4" />
            </IconAction>
          )}
          {!finished ? (
            <IconAction label="Edit" onClick={onEdit}>
              <Pencil className="h-4 w-4" />
            </IconAction>
          ) : null}
          <IconAction label="Copy prompt" onClick={() => onCopy(text)}>
            <Copy className="h-4 w-4" />
          </IconAction>
          {!finished ? (
            <IconAction label="Cancel" onClick={onCancel}>
              <Ban className="h-4 w-4" />
            </IconAction>
          ) : null}
          <IconAction label="Delete" destructive onClick={onDelete}>
            <Trash2 className="h-4 w-4" />
          </IconAction>
        </>
      }
    >
      <PromptText text={text} muted={finished} />
    </RowShell>
  );
}
