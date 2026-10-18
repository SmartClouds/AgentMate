import type { ErrorBreadcrumb, ErrorException, ErrorFrame, Project } from '@agentmat/core';
import type { ErrorIssueRef } from '@shared/errorTrackingTypes';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import {
  Ban,
  Bug,
  ChevronDown,
  CircleCheck,
  Copy,
  ExternalLink,
  Undo,
  Wand2,
} from '@/components/icons';
import {
  Chip,
  EmptyState,
  FOOTER_HAIRLINE,
  SECTION_HEADING,
  SECTION_WELL,
} from '@/components/pageKit';
import { ipcErrorMessage } from '@/components/projects/environments/ipcError';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { formatAgo, formatClock } from '../health/healthView';
import { copyText } from '../health/promptParts';
import { ErrorFixDialog } from './ErrorFixDialog';
import { LEVEL_META, STATUS_LABEL } from './errorView';
import { fetchErrorFixPrompt, useErrorIssue, useIssueStatusChange } from './useErrorTracking';

/**
 * One issue up close (E24), in a panel from the right: what it is, how often it happens, and the
 * latest event's stack trace, breadcrumbs, request and tags, with resolve, ignore and the hand-off
 * to an agent. Everything here came through the core parsers, so it is redacted already, and it
 * is shown as plain text, never as markup.
 */

const NO_WRITE =
  'Your Sentry token does not have the event:write scope. Make a token that has it and use Replace token in Connections.';

const IGNORE_CHOICES: { label: string; minutes: number | null }[] = [
  { label: 'Ignore for 1 hour', minutes: 60 },
  { label: 'Ignore for 24 hours', minutes: 24 * 60 },
  { label: 'Ignore forever', minutes: null },
];

const NUMBER = new Intl.NumberFormat();

function Section({
  title,
  children,
  actions,
}: {
  title: string;
  children: React.ReactNode;
  actions?: React.ReactNode;
}): React.JSX.Element {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3
          id={headingId}
          className="text-xs font-semibold uppercase tracking-[0.06em] text-muted-foreground"
        >
          {title}
        </h3>
        {actions}
      </div>
      {children}
    </section>
  );
}

function StatTile({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className={cn(SECTION_WELL, 'min-w-0 space-y-1 px-3 py-2.5')}>
      <dt className={SECTION_HEADING}>{label}</dt>
      <dd className="truncate text-sm font-semibold tabular-nums text-foreground">{children}</dd>
    </div>
  );
}

function ago(iso: string, now: number): string {
  const at = Date.parse(iso);
  return Number.isNaN(at) ? 'Unknown' : formatAgo(at, now);
}

function FrameView({ frame }: { frame: ErrorFrame }): React.JSX.Element {
  const showCode = frame.inApp && frame.context.length > 0;
  return (
    <div
      data-testid="frame"
      className={cn(
        'overflow-hidden rounded-lg ring-1 ring-inset',
        frame.inApp ? 'ring-foreground/[0.1]' : 'ring-foreground/[0.05]',
      )}
    >
      <div
        className={cn(
          'flex flex-wrap items-baseline gap-x-1.5 px-2.5 py-1.5 font-mono text-[11px]',
          frame.inApp ? 'bg-foreground/[0.03]' : 'text-muted-foreground',
        )}
      >
        <span className={cn('break-all', frame.inApp && 'font-medium text-foreground')}>
          {frame.filename || frame.module || 'Unknown file'}
        </span>
        {frame.function && (
          <>
            <span className="text-muted-foreground">in</span>
            <span className={frame.inApp ? 'text-primary' : undefined}>{frame.function}</span>
          </>
        )}
        {frame.lineNo !== null && (
          <span className="text-muted-foreground">
            at line {frame.lineNo}
            {frame.colNo !== null ? `:${frame.colNo}` : ''}
          </span>
        )}
      </div>
      {showCode && (
        <pre className="overflow-x-auto py-1 font-mono text-[11px] leading-relaxed">
          {frame.context.map(([line, text]) => {
            const current = line === frame.lineNo;
            return (
              <div
                key={line}
                data-current={current ? 'true' : undefined}
                className={cn(
                  'flex gap-3 px-2.5',
                  current
                    ? 'bg-destructive/[0.1] text-foreground shadow-[inset_2px_0_0_hsl(var(--destructive))]'
                    : 'text-foreground/75',
                )}
              >
                <span className="w-8 shrink-0 select-none text-right tabular-nums text-muted-foreground/70">
                  {line}
                </span>
                <span className="whitespace-pre">{text}</span>
              </div>
            );
          })}
        </pre>
      )}
    </div>
  );
}

type FrameItem = { kind: 'frame'; frame: ErrorFrame } | { kind: 'fold'; frames: ErrorFrame[] };

/**
 * The frames with the throwing one first, and each run of library frames folded into one line.
 * A trace with no frame of the app's own is shown whole, since folding it would leave nothing.
 */
function frameItems(frames: readonly ErrorFrame[]): FrameItem[] {
  const ordered = [...frames].reverse();
  if (!ordered.some((one) => one.inApp)) {
    return ordered.map((frame) => ({ kind: 'frame', frame }));
  }
  const items: FrameItem[] = [];
  for (const frame of ordered) {
    const last = items.at(-1);
    if (frame.inApp) items.push({ kind: 'frame', frame });
    else if (last?.kind === 'fold') last.frames.push(frame);
    else items.push({ kind: 'fold', frames: [frame] });
  }
  return items;
}

function LibraryFold({ frames }: { frames: readonly ErrorFrame[] }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const noun = `${frames.length} library frame${frames.length === 1 ? '' : 's'}`;
  return (
    <div className="space-y-1.5">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((value) => !value)}
        className="flex cursor-pointer items-center gap-1.5 rounded-md px-1 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronDown className={cn('h-3 w-3 transition-transform', !open && '-rotate-90')} />
        {open ? `Hide ${noun}` : `Show ${noun}`}
      </button>
      <div id={bodyId} hidden={!open} className="space-y-1.5">
        {open && frames.map((frame, i) => <FrameView key={i} frame={frame} />)}
      </div>
    </div>
  );
}

function ExceptionView({
  exception,
  cause,
}: {
  exception: ErrorException;
  cause: boolean;
}): React.JSX.Element {
  return (
    <div data-testid="exception" className="space-y-2">
      {cause && <p className={SECTION_HEADING}>Caused by</p>}
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <p className="min-w-0 break-words font-mono text-sm">
          <span className="font-semibold text-destructive">{exception.type}</span>
          {exception.value ? `: ${exception.value}` : ''}
        </p>
        {exception.handled === false && <Chip tone="destructive">Unhandled</Chip>}
      </div>
      {exception.frames.length === 0 ? (
        <p className="text-xs text-muted-foreground">No stack frames were recorded.</p>
      ) : (
        <div className="space-y-1.5">
          {frameItems(exception.frames).map((item, i) =>
            item.kind === 'frame' ? (
              <FrameView key={i} frame={item.frame} />
            ) : (
              <LibraryFold key={i} frames={item.frames} />
            ),
          )}
        </div>
      )}
    </div>
  );
}

const CRUMB_DOT: Record<string, string> = {
  fatal: 'bg-destructive',
  error: 'bg-destructive',
  warning: 'bg-warning',
};

function crumbTime(iso: string | null): string {
  if (!iso) return '';
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return '';
  return new Date(at).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function Breadcrumbs({ crumbs }: { crumbs: readonly ErrorBreadcrumb[] }): React.JSX.Element {
  return (
    <ol aria-label="Breadcrumbs" className="relative space-y-2 pl-5">
      <span aria-hidden className="absolute bottom-1 left-[5px] top-1 w-px bg-foreground/10" />
      {crumbs.map((crumb, i) => (
        <li key={i} className="relative">
          <span
            aria-hidden
            className={cn(
              'absolute -left-5 top-1 h-[11px] w-[11px] rounded-full ring-2 ring-background',
              CRUMB_DOT[crumb.level ?? ''] ?? 'bg-muted-foreground/50',
            )}
          />
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
            {crumb.category && <Chip className="h-4 px-1.5 text-[10px]">{crumb.category}</Chip>}
            <span className="tabular-nums">{crumbTime(crumb.timestamp)}</span>
          </div>
          <p className="mt-0.5 break-words font-mono text-[11px] text-foreground/90">
            {crumb.message}
          </p>
        </li>
      ))}
    </ol>
  );
}

function PanelShimmer(): React.JSX.Element {
  return (
    <div className="space-y-4 px-5 py-4" role="status" aria-label="Loading the issue">
      <Skeleton className="h-6 w-3/4" />
      <Skeleton className="h-4 w-1/2" />
      <div className="grid grid-cols-4 gap-2">
        <Skeleton className="h-14 rounded-xl" />
        <Skeleton className="h-14 rounded-xl" />
        <Skeleton className="h-14 rounded-xl" />
        <Skeleton className="h-14 rounded-xl" />
      </div>
      <Skeleton className="h-48 w-full rounded-xl" />
    </div>
  );
}

export function ErrorIssueDetail({
  issueRef,
  onClose,
  projects,
  now,
}: {
  issueRef: ErrorIssueRef | null;
  onClose: () => void;
  projects: readonly Project[];
  now: number;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const detail = useErrorIssue(issueRef);
  const changeStatus = useIssueStatusChange();
  const [fixOpen, setFixOpen] = useState(false);
  const [copying, setCopying] = useState(false);

  const data = detail.data ?? null;
  const issue = data?.issue ?? null;
  const event = data?.event ?? null;
  const project = issue ? projects.find((one) => one.id === issue.projectId) : undefined;
  const meta = issue ? (LEVEL_META[issue.level] ?? LEVEL_META.error) : null;
  const canWrite = data?.canWrite ?? false;
  // The thrown exception first, then what caused it.
  const exceptions = event ? [...event.exceptions].reverse() : [];

  async function copyForAi(): Promise<void> {
    if (!issue) return;
    setCopying(true);
    try {
      const prompt = await fetchErrorFixPrompt(queryClient, {
        connectionId: issue.connectionId,
        issueId: issue.id,
      });
      if (prompt?.prompt) copyText(prompt.prompt, 'Prompt');
      else toast.info('Sentry has no event for this issue, so there is nothing to copy.');
    } catch (error) {
      toast.error('Could not build the prompt', {
        description: ipcErrorMessage(error, 'Something went wrong.'),
      });
    } finally {
      setCopying(false);
    }
  }

  return (
    <>
      <Dialog open={issueRef !== null} onOpenChange={(open) => !open && onClose()}>
        <DialogContent
          className="left-auto right-0 top-0 flex h-full max-h-none w-[min(48rem,100vw)] max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none rounded-l-xl p-0 data-[state=closed]:zoom-out-100 data-[state=open]:zoom-in-100"
          aria-describedby={undefined}
        >
          {detail.isLoading ? (
            <>
              <DialogTitle className="sr-only">Loading the issue</DialogTitle>
              <PanelShimmer />
            </>
          ) : !issue || !meta ? (
            <>
              <DialogTitle className="sr-only">Issue not found</DialogTitle>
              <EmptyState
                icon={Bug}
                title={detail.isError ? 'Could not load this issue' : 'This issue is gone'}
                description={
                  detail.isError
                    ? ipcErrorMessage(detail.error, 'Something went wrong.')
                    : 'It may have been deleted or merged in Sentry.'
                }
                action={
                  <Button size="sm" variant="soft" onClick={onClose}>
                    Close
                  </Button>
                }
              />
            </>
          ) : (
            <>
              <DialogHeader className="space-y-2 px-5 py-4 pr-12 shadow-[inset_0_-1px_0_hsl(var(--foreground)/0.08)]">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Chip tone={meta.tone} dot>
                    {meta.label}
                  </Chip>
                  <Chip tone={issue.status === 'unresolved' ? 'warning' : 'neutral'}>
                    {STATUS_LABEL[issue.status]}
                  </Chip>
                  <Chip className="font-mono">{issue.shortId}</Chip>
                  {issue.isNew && <Chip tone="primary">New</Chip>}
                </div>
                <DialogTitle className="break-words text-base font-semibold leading-snug tracking-tight">
                  {issue.title}
                </DialogTitle>
                <DialogDescription asChild>
                  <div className="space-y-1 text-xs text-muted-foreground">
                    {issue.culprit && (
                      <p className="break-all font-mono text-[11px] text-foreground/80">
                        {issue.culprit}
                      </p>
                    )}
                    <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="font-medium text-foreground/85">
                        {project?.name ??
                          (issue.projectId ? 'Unknown project' : 'Not linked to a project')}
                      </span>
                      <span className="font-mono text-[11px]">· {issue.remoteProjectSlug}</span>
                      {event?.environment && <span>· {event.environment}</span>}
                      {event?.release && (
                        <span className="font-mono text-[11px]">· {event.release}</span>
                      )}
                    </p>
                  </div>
                </DialogDescription>
              </DialogHeader>

              <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-5">
                <dl
                  role="group"
                  aria-label="Issue numbers"
                  className="grid grid-cols-2 gap-2 sm:grid-cols-4"
                >
                  <StatTile label="Events">{NUMBER.format(issue.count)}</StatTile>
                  <StatTile label="Users">{NUMBER.format(issue.userCount)}</StatTile>
                  <StatTile label="First seen">
                    <SimpleTooltip label={formatClock(Date.parse(issue.firstSeen))}>
                      <span>{ago(issue.firstSeen, now)}</span>
                    </SimpleTooltip>
                  </StatTile>
                  <StatTile label="Last seen">
                    <SimpleTooltip label={formatClock(Date.parse(issue.lastSeen))}>
                      <span>{ago(issue.lastSeen, now)}</span>
                    </SimpleTooltip>
                  </StatTile>
                </dl>

                {!event ? (
                  <p className="text-sm text-muted-foreground">
                    Sentry has no event to show for this issue yet.
                  </p>
                ) : (
                  <>
                    <Section title="Stack trace">
                      {exceptions.length > 0 ? (
                        <div className="space-y-5">
                          {exceptions.map((one, i) => (
                            <ExceptionView key={i} exception={one} cause={i > 0} />
                          ))}
                        </div>
                      ) : (
                        <div className={SECTION_WELL}>
                          <p className="whitespace-pre-wrap break-words font-mono text-xs">
                            {event.message ?? 'This event has no stack trace.'}
                          </p>
                        </div>
                      )}
                    </Section>

                    {event.breadcrumbs.length > 0 && (
                      <Section title="Breadcrumbs">
                        <Breadcrumbs crumbs={event.breadcrumbs} />
                      </Section>
                    )}

                    {event.request && (
                      <Section title="Request">
                        <p className={cn(SECTION_WELL, 'break-all py-2 font-mono text-xs')}>
                          {[event.request.method, event.request.url].filter(Boolean).join(' ')}
                        </p>
                      </Section>
                    )}

                    {event.tags.length > 0 && (
                      <Section title="Tags">
                        <ul className="flex flex-wrap gap-1.5">
                          {event.tags.map((tag) => (
                            <li key={`${tag.key}=${tag.value}`}>
                              <Chip className="h-auto min-h-5 whitespace-normal py-0.5">
                                <span className="text-muted-foreground/80">{tag.key}</span>
                                <span className="font-mono text-foreground/90">{tag.value}</span>
                              </Chip>
                            </li>
                          ))}
                        </ul>
                      </Section>
                    )}
                  </>
                )}
              </div>

              <div
                className={cn(
                  FOOTER_HAIRLINE,
                  'flex flex-wrap items-center justify-between gap-2 px-5 py-3',
                )}
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  <SimpleTooltip
                    label={
                      project
                        ? undefined
                        : issue.projectId
                          ? 'The project this issue belongs to is missing.'
                          : 'Link this Sentry project to one of your projects first.'
                    }
                    wrapTrigger
                  >
                    <Button
                      size="sm"
                      variant="tint"
                      disabled={!project}
                      onClick={() => setFixOpen(true)}
                    >
                      <Wand2 />
                      Fix with AI
                    </Button>
                  </SimpleTooltip>
                  <Button
                    size="sm"
                    variant="soft"
                    disabled={copying}
                    onClick={() => void copyForAi()}
                  >
                    <Copy />
                    Copy for AI
                  </Button>
                  <Button size="sm" variant="ghost" asChild>
                    <a href={issue.permalink} target="_blank" rel="noreferrer">
                      <ExternalLink />
                      Open in Sentry
                    </a>
                  </Button>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {issue.status === 'unresolved' ? (
                    <>
                      <SimpleTooltip label={canWrite ? undefined : NO_WRITE} wrapTrigger>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button size="sm" variant="soft" disabled={!canWrite}>
                              <Ban />
                              Ignore
                              <ChevronDown className="opacity-60" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="min-w-[11rem]">
                            {IGNORE_CHOICES.map((choice) => (
                              <DropdownMenuItem
                                key={choice.label}
                                onSelect={() => void changeStatus(issue, 'ignored', choice.minutes)}
                              >
                                {choice.label}
                              </DropdownMenuItem>
                            ))}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </SimpleTooltip>
                      <SimpleTooltip label={canWrite ? undefined : NO_WRITE} wrapTrigger>
                        <Button
                          size="sm"
                          disabled={!canWrite}
                          onClick={() => void changeStatus(issue, 'resolved')}
                        >
                          <CircleCheck />
                          Resolve
                        </Button>
                      </SimpleTooltip>
                    </>
                  ) : (
                    <SimpleTooltip label={canWrite ? undefined : NO_WRITE} wrapTrigger>
                      <Button
                        size="sm"
                        variant="soft"
                        disabled={!canWrite}
                        onClick={() => void changeStatus(issue, 'unresolved')}
                      >
                        <Undo />
                        Reopen
                      </Button>
                    </SimpleTooltip>
                  )}
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      {issue && project && (
        <ErrorFixDialog project={project} issue={issue} open={fixOpen} onOpenChange={setFixOpen} />
      )}
    </>
  );
}
