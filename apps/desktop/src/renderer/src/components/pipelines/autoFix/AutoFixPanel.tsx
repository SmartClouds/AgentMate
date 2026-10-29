import type { AutoFixBlocker, AutoFixSession } from '@shared/ciAutoFixTypes';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CliLogo } from '@/components/cliLogos';
import {
  GitCommit,
  RotateCw,
  Spinner,
  StopCircle,
  TerminalSquare,
  Upload,
  X,
} from '@/components/icons';
import { Notice } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { confirmDialog } from '@/stores/confirmStore';
import { AutoFixChip } from './AutoFixChip';
import { attemptRuns, cliName, isAutoFixActive, phaseView } from './autoFixView';
import { useAutoFixActions } from './useAutoFix';

/** Blockers the user clears outside the panel (a branch switch, a pull), after which Retry works. */
const RETRY_BLOCKERS = new Set<AutoFixBlocker>([
  'wrong-branch',
  'dirty-tree',
  'behind',
  'read-failed',
  'launch-failed',
  'agent-lost',
  'commit-failed',
  'push-failed',
  'run-missing',
]);

const STATE_TEXT = { running: 'running', passed: 'passed', failed: 'failed' } as const;
const STATE_TONE = {
  running: 'text-muted-foreground',
  passed: 'text-success',
  failed: 'text-destructive',
} as const;

function Timeline({ session }: { session: AutoFixSession }): React.JSX.Element | null {
  if (session.attempts.length === 0) return null;
  return (
    <ol className="space-y-2 border-l border-foreground/10 pl-3">
      {session.attempts.map((attempt) => {
        const runs = attemptRuns(attempt);
        return (
          <li key={attempt.n} className="relative space-y-0.5 text-[11px]">
            <span
              aria-hidden
              className={cn(
                'absolute -left-[15.5px] top-1 h-2 w-2 rounded-full ring-2 ring-background',
                attempt.outcome === 'passed'
                  ? 'bg-success'
                  : attempt.outcome === 'failed' || attempt.outcome === 'no-change'
                    ? 'bg-destructive'
                    : 'bg-primary',
              )}
            />
            <p className="font-medium text-foreground/90">{`Attempt ${attempt.n}`}</p>
            <p className="flex flex-wrap items-center gap-x-1.5 text-muted-foreground">
              <span className="text-destructive">{`Run ${runs.failed} failed`}</span>
              {runs.commit ? (
                <>
                  <span aria-hidden>→</span>
                  <span className="inline-flex items-center gap-1">
                    <GitCommit className="h-3 w-3" />
                    {`Pushed ${runs.commit}`}
                  </span>
                </>
              ) : attempt.outcome === 'no-change' ? (
                <>
                  <span aria-hidden>→</span>
                  <span>No change to push</span>
                </>
              ) : attempt.outcome === 'cancelled' ? (
                <>
                  <span aria-hidden>→</span>
                  <span>Stopped</span>
                </>
              ) : null}
              {runs.next ? (
                <>
                  <span aria-hidden>→</span>
                  <span className={STATE_TONE[runs.nextState]}>
                    {`Run ${runs.next} ${STATE_TEXT[runs.nextState]}`}
                  </span>
                </>
              ) : null}
            </p>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * One auto-fix session: where it stands, the attempts so far, and what the user can do about it.
 * When it needs them, the reason is a sentence with the one action that unblocks it.
 */
export function AutoFixPanel({
  session,
  className,
}: {
  session: AutoFixSession;
  className?: string;
}): React.JSX.Element {
  const navigate = useNavigate();
  const actions = useAutoFixActions();
  const [busy, setBusy] = useState<string | null>(null);
  const view = phaseView(session);
  const active = isAutoFixActive(session);
  const tabId = session.attempts[session.attempts.length - 1]?.tabId ?? null;
  const asking = session.phase === 'attention' && session.blocker === 'needs-input';
  const tabOpen = Boolean(tabId) && (session.phase === 'fixing' || session.phase === 'attention');
  const canCommit =
    tabOpen &&
    (session.phase === 'fixing' ||
      session.blocker === 'needs-input' ||
      session.blocker === 'agent-lost');
  const canRetry =
    session.phase === 'attention' &&
    session.blocker !== null &&
    RETRY_BLOCKERS.has(session.blocker);

  async function run(name: string, work: () => Promise<void>): Promise<void> {
    setBusy(name);
    try {
      await work();
    } finally {
      setBusy(null);
    }
  }

  async function stop(): Promise<void> {
    const confirmed = await confirmDialog({
      title: `Stop auto-fix for ${session.workflowName}?`,
      description:
        'Nothing more is committed or pushed. An agent that is still working keeps its tab, and its changes stay in your working tree.',
      confirmLabel: 'Stop auto-fix',
      variant: 'destructive',
    });
    if (confirmed) await run('stop', () => actions.stop(session.id));
  }

  const openTab = (): void => {
    if (tabId) navigate(`/workspace/${session.projectId}?session=${encodeURIComponent(tabId)}`);
  };

  return (
    <section aria-label="Auto-fix" className={cn('space-y-3', className)}>
      <header className="flex items-start gap-2.5">
        <CliLogo cliId={session.cliId} className="mt-0.5 h-7 w-7 shrink-0" />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <AutoFixChip session={session} />
            <span className="truncate text-[11px] text-muted-foreground">
              {[cliName(session.cliId), session.runLabel].filter(Boolean).join(' · ')}
            </span>
          </div>
          {session.phase === 'attention' ? null : (
            <p className="text-xs leading-relaxed text-foreground/85">{view.description}</p>
          )}
        </div>
      </header>

      {session.phase === 'attention' ? (
        <Notice
          tone="warning"
          size="sm"
          action={
            asking ? (
              <Button size="xs" variant="soft" onClick={openTab}>
                <TerminalSquare />
                Answer in tab
              </Button>
            ) : canRetry ? (
              <Button
                size="xs"
                variant="soft"
                disabled={busy !== null}
                onClick={() => void run('retry', () => actions.retry(session.id))}
              >
                {busy === 'retry' ? <Spinner className="animate-spin" /> : <RotateCw />}
                Retry
              </Button>
            ) : null
          }
        >
          {view.description}
        </Notice>
      ) : null}

      <Timeline session={session} />

      <div className="flex flex-wrap items-center gap-1.5">
        {tabOpen && !asking ? (
          <Button size="xs" variant="soft" onClick={openTab}>
            <TerminalSquare />
            Open agent tab
          </Button>
        ) : null}
        {canCommit ? (
          <Button
            size="xs"
            variant="ghost"
            disabled={busy !== null}
            onClick={() => void run('commit', () => actions.commitNow(session.id))}
          >
            {busy === 'commit' ? <Spinner className="animate-spin" /> : <Upload />}
            Commit & push now
          </Button>
        ) : null}
        <span className="flex-1" />
        {active ? (
          <Button
            size="xs"
            variant="ghost"
            className="text-muted-foreground hover:text-destructive"
            disabled={busy !== null}
            onClick={() => void stop()}
          >
            {busy === 'stop' ? <Spinner className="animate-spin" /> : <StopCircle />}
            Stop auto-fix
          </Button>
        ) : (
          <Button
            size="xs"
            variant="ghost"
            className="text-muted-foreground"
            onClick={() => void run('clear', () => actions.dismiss(session.id))}
          >
            <X />
            Clear
          </Button>
        )}
      </div>
    </section>
  );
}
