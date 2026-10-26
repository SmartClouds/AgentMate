import type { ChecklistRow } from '@runova/core';
import {
  CircleCheck,
  CircleInfo,
  CircleX,
  Clock,
  Copy,
  FileText,
  Lock,
  Spinner,
  TerminalSquare,
  TriangleAlert,
} from '@/components/icons';
import { Chip } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { RowAction, RowIcon, RowTone, RowView } from './devSetupView';

/**
 * One tool in the checklist: what it is, how it stands, and the one thing to do about it. The
 * words and the choice of button come from `describeRow`; this only lays them out.
 */

const TEXT_TONE: Record<RowTone, string> = {
  success: 'text-success',
  warning: 'text-warning',
  destructive: 'text-destructive',
  primary: 'text-primary',
  neutral: 'text-muted-foreground',
};

const ICON_TONE: Record<RowTone, string> = {
  success: 'text-success',
  warning: 'text-warning',
  destructive: 'text-destructive',
  primary: 'text-primary',
  neutral: 'text-muted-foreground',
};

function StatusIcon({
  icon,
  tone,
  checking,
}: {
  icon: RowIcon;
  tone: RowTone;
  checking: boolean;
}): React.JSX.Element {
  const shared = cn('mt-0.5 h-4 w-4 shrink-0', ICON_TONE[tone]);
  if (checking) return <Skeleton className="mt-0.5 h-4 w-4 shrink-0 rounded-full" />;
  switch (icon) {
    case 'installed':
      return <CircleCheck aria-hidden className={shared} />;
    case 'outdated':
      return <TriangleAlert aria-hidden className={shared} />;
    case 'blocked':
      return <Lock aria-hidden className={cn(shared, 'h-3.5 w-3.5')} />;
    case 'queued':
      return <Clock aria-hidden className={shared} />;
    case 'installing':
      return (
        <Spinner aria-hidden className={cn(shared, 'animate-spin motion-reduce:animate-none')} />
      );
    case 'failed':
      return <CircleX aria-hidden className={shared} />;
    case 'info':
    case 'unavailable':
      return <CircleInfo aria-hidden className={shared} />;
    default:
      // Not installed: an empty ring, so the row reads as "still to do" without shouting.
      return (
        <span
          aria-hidden
          className="mt-0.5 h-4 w-4 shrink-0 rounded-full ring-2 ring-inset ring-muted-foreground/35"
        />
      );
  }
}

function ProgressBar({
  fraction,
  label,
}: {
  fraction: number | null;
  label: string;
}): React.JSX.Element {
  const percent = fraction === null ? null : Math.round(Math.min(1, Math.max(0, fraction)) * 100);
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent ?? undefined}
      className="mt-2 h-1.5 w-full max-w-sm overflow-hidden rounded-full bg-foreground/10"
    >
      <div
        className={cn(
          'h-full rounded-full bg-primary transition-[width] duration-300 motion-reduce:transition-none',
          percent === null && 'w-1/3 motion-safe:animate-pulse',
        )}
        style={percent === null ? undefined : { width: `${percent}%` }}
      />
    </div>
  );
}

export interface DevItemRowProps {
  row: ChecklistRow;
  view: RowView;
  onAction: (action: RowAction) => void;
  onTerminal: () => void;
  onCopy: () => void;
  onShowLog?: () => void;
}

export function DevItemRow({
  row,
  view,
  onAction,
  onTerminal,
  onCopy,
  onShowLog,
}: DevItemRowProps): React.JSX.Element {
  const { action } = view;
  const installed = row.state.kind === 'installed';
  // A tool that is being installed is explained by its description; one that is already in place
  // is not, which keeps a finished list quiet.
  const showDescription = !installed && !view.checking;

  const button = action ? (
    <SimpleTooltip label={action.hint} wrapTrigger={Boolean(action.disabled)}>
      <Button
        size="sm"
        variant={
          action.kind === 'install' || action.kind === 'update'
            ? 'tint'
            : action.kind === 'retry'
              ? 'danger'
              : 'soft'
        }
        disabled={action.disabled}
        onClick={() => onAction(action)}
      >
        {action.label}
      </Button>
    </SimpleTooltip>
  ) : null;

  return (
    <li className="flex flex-col gap-2 px-4 py-3 @xl/devsetup:flex-row @xl/devsetup:items-center @xl/devsetup:gap-4">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <StatusIcon icon={view.icon} tone={view.tone} checking={view.checking} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-sm font-medium leading-tight">{row.name}</span>
            {row.item.optional && <Chip>Optional</Chip>}
            {view.chips.map((chip) => (
              <Chip key={chip.text} tone={chip.tone}>
                {chip.text}
              </Chip>
            ))}
          </div>
          {view.checking ? (
            <div role="status" aria-label={`Checking ${row.name}`}>
              <Skeleton className="mt-1.5 h-3 w-40 max-w-full" />
            </div>
          ) : (
            <p className={cn('mt-0.5 break-words text-xs font-medium', TEXT_TONE[view.tone])}>
              {view.text}
            </p>
          )}
          {showDescription && (
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
              {row.item.description}
            </p>
          )}
          {view.progress && <ProgressBar {...view.progress} />}
        </div>
      </div>

      {(button || view.terminalCommand || view.showLog) && (
        <div className="flex shrink-0 flex-wrap items-center gap-1.5 pl-7 @xl/devsetup:justify-end @xl/devsetup:pl-0">
          {view.showLog && onShowLog && (
            <SimpleTooltip label="Show log">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Show the ${row.name} install log`}
                onClick={onShowLog}
              >
                <FileText />
              </Button>
            </SimpleTooltip>
          )}
          {view.terminalCommand && (
            <>
              <SimpleTooltip label="Open in terminal">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Open the ${row.name} install in a terminal`}
                  onClick={onTerminal}
                >
                  <TerminalSquare />
                </Button>
              </SimpleTooltip>
              <SimpleTooltip label="Copy command">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Copy the ${row.name} install command`}
                  onClick={onCopy}
                >
                  <Copy />
                </Button>
              </SimpleTooltip>
            </>
          )}
          {button}
        </div>
      )}
    </li>
  );
}
