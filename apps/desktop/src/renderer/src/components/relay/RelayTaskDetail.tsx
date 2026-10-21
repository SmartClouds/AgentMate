import {
  formatTokenCount,
  HANDOFF_SECTIONS,
  type Project,
  type RelayLegRecord,
} from '@agentmat/core';
import type { RelayBoard } from '@shared/relayTypes';
import { useQuery } from '@tanstack/react-query';
import { MarkdownMessage } from '@/components/askAi/MarkdownMessage';
import { CliLogo } from '@/components/cliLogos';
import { MarkdownPreview } from '@/components/editor/MarkdownPreview';
import { ArrowRight, CircleCheck, Play, Sliders, X } from '@/components/icons';
import { LoadFailure } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { RelayRunSettings } from './RelayRunSettings';
import { BOARD_COLUMNS, choiceLabel, columnSpec, formatDuration } from './relayView';
import { runTaskInNewSession } from './useRelay';

const RESULT_WORDS: Record<RelayLegRecord['result'], string> = {
  done: 'Finished the task',
  continue: 'Handed off, out of budget',
  blocked: 'Stopped for your answer',
  testing: 'Done, tests failing',
  failed: 'Session failed',
  interrupted: 'Interrupted',
  'marked-done': 'Marked done by you',
};

function SessionRow({ leg }: { leg: RelayLegRecord }): React.JSX.Element {
  return (
    <li className="flex items-center gap-2 py-1.5 text-[12px]">
      <span className="w-14 shrink-0 font-medium tabular-nums">Session {leg.legNo}</span>
      <CliLogo cliId={leg.cliId} className="h-3 w-3" />
      <span className="min-w-0 flex-1 truncate text-muted-foreground">
        {choiceLabel({ cliId: leg.cliId, model: leg.model, effort: leg.effort, autoSize: false })}
        {' · '}
        {formatDuration(leg.endedAt - leg.startedAt)}
        {leg.peakContextTokens !== null ? ` · peak ${formatTokenCount(leg.peakContextTokens)}` : ''}
      </span>
      <span
        className={cn(
          'shrink-0 text-[11px]',
          leg.result === 'done' || leg.result === 'marked-done'
            ? 'text-emerald-600 dark:text-emerald-400'
            : leg.result === 'continue'
              ? 'text-primary'
              : 'text-amber-600 dark:text-amber-400',
        )}
      >
        {RESULT_WORDS[leg.result]}
      </span>
    </li>
  );
}

/**
 * A task opened from the board: its baton (the handoff the last session left, section by
 * section), every session it took, and the spec itself.
 */
export function RelayTaskDetail({
  board,
  project,
  taskId,
  onClose,
  onSetStatus,
  onMarkDone,
}: {
  board: RelayBoard;
  project: Project | null;
  taskId: string;
  onClose: () => void;
  onSetStatus: (status: (typeof BOARD_COLUMNS)[number]['status']) => void;
  /** Set while the relay is running this task, to count it done and move on. */
  onMarkDone?: () => void;
}): React.JSX.Element {
  const query = useQuery({
    queryKey: queryKeys.relayTask(board.projectId, taskId),
    queryFn: () => window.agentmat.relay.task(board.projectId, taskId),
  });
  const card = board.tasks.find((task) => task.id === taskId);
  const column = columnSpec(card?.status ?? 'todo');
  const detail = query.data;
  const handoff = detail?.handoff ?? null;

  return (
    <aside
      aria-label={`${taskId} details`}
      className="flex h-full w-[min(28rem,100%)] shrink-0 flex-col overflow-hidden rounded-2xl border border-border/70 bg-popover/85 shadow-2xl backdrop-blur-xl"
    >
      <header className="flex items-start gap-2 border-b border-border/60 px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 text-[10.5px] font-semibold">
            <span className="font-mono">{taskId}</span>
            <span
              className="rounded-full px-1.5 py-px text-[10px]"
              style={{ background: `hsl(${column.tone} / 0.15)`, color: `hsl(${column.tone})` }}
            >
              {column.label}
            </span>
          </p>
          <h2 className="mt-0.5 text-[15px] leading-snug font-semibold">{card?.title ?? taskId}</h2>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Close details"
          onClick={onClose}
        >
          <X />
        </Button>
      </header>

      <div className="flex flex-wrap items-center gap-1.5 border-b border-border/60 px-4 py-2">
        <Button
          type="button"
          size="sm"
          variant="soft"
          disabled={!project}
          onClick={() => project && void runTaskInNewSession(project, taskId)}
        >
          <Play /> Run in a new session
        </Button>
        <RelayRunSettings
          projectId={board.projectId}
          project={project}
          settings={board.settings}
          taskId={taskId}
          align="start"
        >
          <Button type="button" size="sm" variant="ghost">
            <Sliders /> Run settings
          </Button>
        </RelayRunSettings>
        {onMarkDone ? (
          <Button type="button" size="sm" variant="ghost" onClick={onMarkDone}>
            <CircleCheck /> Mark done
          </Button>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" size="sm" variant="ghost">
              <ArrowRight /> Move to
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {BOARD_COLUMNS.filter((option) => option.status !== card?.status).map((option) => (
              <DropdownMenuItem key={option.status} onSelect={() => onSetStatus(option.status)}>
                <span
                  aria-hidden
                  className="h-2 w-2 rounded-full"
                  style={{ background: `hsl(${option.tone})` }}
                />
                {option.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4">
        {query.isPending ? (
          <div aria-busy="true" className="space-y-2">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-16" />
            <Skeleton className="h-16" />
          </div>
        ) : query.isError || !detail ? (
          <LoadFailure
            message={`${taskId} could not be read.`}
            retry={() => void query.refetch()}
          />
        ) : (
          <>
            <section aria-label="Baton">
              <div className="mb-2 flex items-baseline justify-between gap-2">
                <h3 className="text-[10px] font-semibold tracking-[0.12em] text-primary uppercase">
                  Baton
                </h3>
                {handoff ? (
                  <p className="text-[11px] text-muted-foreground">
                    {handoff.leg !== null ? `Session ${handoff.leg}` : 'Handoff'}
                    {handoff.outcome ? ` · ${handoff.outcome}` : ''}
                    {handoff.tests ? ` · tests ${handoff.tests}` : ''}
                  </p>
                ) : null}
              </div>
              {handoff ? (
                <ol className="relative space-y-3 border-l border-border/80 pl-4">
                  {HANDOFF_SECTIONS.map((section) => {
                    const text = handoff.sections[section.key];
                    return (
                      <li key={section.key} className="relative">
                        <span
                          aria-hidden
                          className={cn(
                            'absolute top-1 -left-[21px] h-2.5 w-2.5 rounded-full border-2 border-popover',
                            text ? 'bg-primary' : 'bg-foreground/20',
                          )}
                        />
                        <h4 className="text-[12px] font-semibold">{section.heading}</h4>
                        {text ? (
                          <MarkdownMessage
                            content={text}
                            className="text-[12px] text-foreground/85"
                          />
                        ) : (
                          <p className="text-[11.5px] text-muted-foreground italic">
                            Not written yet.
                          </p>
                        )}
                      </li>
                    );
                  })}
                </ol>
              ) : (
                <p className="text-[12px] text-muted-foreground">
                  No session has worked on this task yet. The first one writes the handoff the next
                  one starts from.
                </p>
              )}
              {handoff && handoff.issues.length > 0 ? (
                <p className="mt-2 text-[11px] text-amber-600 dark:text-amber-400">
                  {handoff.issues.map((issue) => issue.message).join(' ')}
                </p>
              ) : null}
            </section>

            {detail.legs.length > 0 ? (
              <section aria-label="Sessions">
                <h3 className="mb-1 text-[10px] font-semibold tracking-[0.12em] text-primary uppercase">
                  Sessions
                </h3>
                <ol className="divide-y divide-border/50">
                  {detail.legs.map((leg) => (
                    <SessionRow key={leg.legId} leg={leg} />
                  ))}
                </ol>
              </section>
            ) : null}

            <section aria-label="Spec">
              <div className="mb-1 flex items-baseline justify-between">
                <h3 className="text-[10px] font-semibold tracking-[0.12em] text-primary uppercase">
                  Spec
                </h3>
                <SimpleTooltip label="The task file this card is read from">
                  <span className="font-mono text-[10.5px] text-muted-foreground">
                    {detail.task.file}
                  </span>
                </SimpleTooltip>
              </div>
              {detail.task.body.trim() ? (
                <MarkdownPreview content={detail.task.body} className="text-[12.5px]" />
              ) : (
                <p className="text-[12px] text-muted-foreground">The task file has no body.</p>
              )}
            </section>
          </>
        )}
      </div>
    </aside>
  );
}
