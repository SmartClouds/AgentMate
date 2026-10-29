import { DEFAULT_RELAY_BUDGET, type RelayProposal } from '@runova/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useState } from 'react';
import { toast } from 'sonner';
import { CircleCheck, ListTodo, Route, Sparkles, Spinner, Wand2 } from '@/components/icons';
import { Notice } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { useRelayBoardStore } from '@/stores/relayBoardStore';
import { planJobKey, useRelayPlanJobsStore } from '@/stores/relayPlanJobsStore';
import { PlannerProgress } from './PlannerProgress';
import { ProposalReview, proposalSize } from './ProposalReview';
import { RelayPlannerFields, useRelayPlanner } from './RelayPlannerPicker';
import { announceBackgroundPlanning, usePlanJob } from './usePlanJob';

/**
 * `revise` brings an existing board in line with the docs. `catch-up` is for a project already
 * under way: the AI works out what is finished, half done and left, from the code, the plans and
 * the history, and turns the rest into tasks.
 */
export type PlanWithAiMode = 'revise' | 'catch-up';

export interface ReviseWithAiDialogProps {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode?: PlanWithAiMode;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

const COPY = {
  revise: {
    Icon: Sparkles,
    title: 'Revise tasks with AI',
    noteLabel: 'What should change? (optional)',
    notePlaceholder: 'Leave it empty to compare the tasks with the docs as they are.',
    doing: 'reading the docs and the tasks',
    start: 'Review tasks',
    again: 'Review again',
    nothing: 'The tasks already match the docs.',
  },
  'catch-up': {
    Icon: Route,
    title: 'Pick up a project in progress',
    noteLabel: 'Anything it should know? (optional)',
    notePlaceholder: 'Where the plan lives, what to skip, what matters most.',
    doing: 'reading the code, the plans and the history',
    start: 'Plan the rest',
    again: 'Plan again',
    nothing: 'Nothing is left to plan. The code already does what the plans describe.',
  },
} as const;

/** How a catch-up proposal splits the project: finished, half done (with a handoff) and to do. */
function standing(proposal: RelayProposal): { finished: number; half: number; todo: number } {
  let finished = proposal.change.filter((change) => change.status === 'done').length;
  let half = 0;
  let todo = proposal.split.reduce((sum, split) => sum + split.into.length, 0);
  for (const task of proposal.add) {
    if (task.status === 'done') finished += 1;
    else if (task.handoff) half += 1;
    else todo += 1;
  }
  return { finished, half, todo };
}

/**
 * The project as the relay would pick it up: a short track where finished legs are filled, the
 * half-done one carries half a baton and the rest wait as open rings.
 */
function ProjectStanding({ proposal }: { proposal: RelayProposal }): React.JSX.Element | null {
  const descriptionId = useId();
  const { finished, half, todo } = standing(proposal);
  const total = finished + half + todo;
  if (total === 0) return null;
  const words = `${finished} finished, ${half} half done, ${todo} to do`;
  const stations = [
    ...Array.from({ length: finished }, () => 'finished' as const),
    ...Array.from({ length: half }, () => 'half' as const),
    ...Array.from({ length: todo }, () => 'todo' as const),
  ];
  return (
    <div className="space-y-2 rounded-xl bg-foreground/[0.03] px-4 py-3 ring-1 ring-foreground/[0.07] ring-inset">
      <div
        role="img"
        aria-label="Where the project stands"
        aria-describedby={descriptionId}
        className="relative flex items-center gap-1.5"
      >
        <span aria-hidden className="absolute inset-x-1 top-1/2 h-px bg-foreground/10" />
        {stations.map((kind, index) => (
          <span
            // The stations are interchangeable dots, so their place is their identity.
            key={index}
            aria-hidden
            className={cn(
              'relative h-2.5 min-w-1.5 flex-1 rounded-full',
              kind === 'finished' && 'bg-success shadow-[0_0_8px_-2px_hsl(var(--success)/0.7)]',
              kind === 'half' &&
                'bg-[linear-gradient(90deg,hsl(var(--primary))_50%,hsl(var(--foreground)/0.08)_50%)] ring-1 ring-primary/50 ring-inset',
              kind === 'todo' && 'bg-background ring-1 ring-foreground/20 ring-inset',
            )}
          />
        ))}
      </div>
      <p id={descriptionId} className="flex flex-wrap gap-x-3 text-[11px] text-muted-foreground">
        <span className="sr-only">{words}</span>
        <span aria-hidden className="inline-flex items-center gap-1">
          <span className="h-1.5 w-1.5 rounded-full bg-success" /> {finished} finished
        </span>
        <span aria-hidden className="inline-flex items-center gap-1">
          <span className="h-1.5 w-1.5 rounded-full bg-primary" /> {half} half done
        </span>
        <span aria-hidden className="inline-flex items-center gap-1">
          <span className="h-1.5 w-1.5 rounded-full ring-1 ring-foreground/30" /> {todo} to do
        </span>
      </p>
    </div>
  );
}

/**
 * Planning a board with AI, the spec-driven way. Revising treats the docs as the source of truth:
 * a planner reads them and the task files, then proposes tasks to add, change, split or remove.
 * Catching up reads the code and the history as well, to see what is already built. Nothing
 * changes until the user applies what they kept.
 */
export function ReviseWithAiDialog({
  projectId,
  open,
  onOpenChange,
  mode = 'revise',
}: ReviseWithAiDialogProps): React.JSX.Element | null {
  const queryClient = useQueryClient();
  const openBoard = useRelayBoardStore((s) => s.open);
  const [note, setNote] = useState('');
  const [recordDone, setRecordDone] = useState(true);
  const [applying, setApplying] = useState(false);
  const run = usePlanJob(planJobKey(mode, projectId), open);
  const copy = COPY[mode];
  const catchingUp = mode === 'catch-up';

  const boardQuery = useQuery({
    queryKey: queryKeys.relayBoard(projectId),
    queryFn: () => window.runova.relay.board(projectId),
    enabled: open,
  });
  const projectsQuery = useQuery({
    queryKey: queryKeys.projects,
    queryFn: () => window.runova.projects.list(),
    enabled: open,
  });
  const project = projectsQuery.data?.find((entry) => entry.id === projectId) ?? null;
  const planner = useRelayPlanner(project?.cliId);
  const docsFolder = boardQuery.data?.docsFolder ?? 'docs';
  const budget = boardQuery.data?.settings?.options?.defaultBudget ?? DEFAULT_RELAY_BUDGET;

  // A plan still waiting from an earlier opening comes back with the form it was started from.
  useEffect(() => {
    if (!open) return;
    const job = useRelayPlanJobsStore.getState().jobs[planJobKey(mode, projectId)];
    setNote(job?.text ?? '');
    setRecordDone(job?.recordDone ?? true);
  }, [open, mode, projectId]);

  const planned = run.state.status === 'done' ? run.state.result : null;
  const proposal = planned ? (run.job?.proposal ?? planned.proposal) : null;

  const running = run.state.status === 'running';

  async function review(): Promise<void> {
    if (running || !planner.input.cliId) return;
    const fields = { projectId, note: note.trim() || undefined, budget, ...planner.input };
    const start = {
      kind: mode,
      projectId,
      projectName: project?.name ?? '',
      text: note.trim(),
      budget,
      recordDone: catchingUp ? recordDone : undefined,
    };
    await run.start(start, (requestId) =>
      catchingUp
        ? window.runova.relay.catchUp({ requestId, recordDone, ...fields })
        : window.runova.relay.revise({ requestId, ...fields }),
    );
  }

  async function apply(): Promise<void> {
    if (!proposal || applying) return;
    setApplying(true);
    try {
      const result = await window.runova.relay.applyProposal(projectId, proposal);
      void queryClient.invalidateQueries({ queryKey: queryKeys.relayBoard(projectId) });
      const removed = result.removed.length > 0 ? `, ${result.removed.length} removed` : '';
      toast.success('Board updated', {
        description: `${plural(result.written.length, 'task file')} written${removed}.`,
        ...(catchingUp
          ? { action: { label: 'Open the board', onClick: () => openBoard(projectId) } }
          : {}),
      });
      for (const warning of result.warnings) toast.warning(warning);
      run.cancel();
      onOpenChange(false);
    } catch (error) {
      toast.error('Could not update the board', {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setApplying(false);
    }
  }

  const size = proposal ? proposalSize(proposal) : 0;
  const nothingToDo = planned !== null && proposalSize(planned.proposal) === 0;
  const noteId = `relay-${mode}-note`;
  const recordDoneId = `relay-${mode}-record-done`;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && running) announceBackgroundPlanning();
        onOpenChange(next);
      }}
    >
      <DialogContent className="flex max-h-[88vh] max-w-2xl flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b border-border/70 px-6 py-5">
          <p className="flex items-center gap-1.5 text-[10px] font-semibold tracking-[0.12em] text-primary uppercase">
            <ListTodo aria-hidden className="h-3 w-3" /> Relay
          </p>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>
            {catchingUp ? (
              <>
                For a project already under way. The AI reads the code, the plans and the git
                history, works out what is finished, half done and left, and turns the rest into
                tasks that each fit one session. Half-done work starts from a handoff that says
                where it stands. Nothing is written until you apply it.
              </>
            ) : (
              <>
                The AI reads the docs in <span className="font-mono">{docsFolder}/</span>, which are
                the source of truth, and the task files, then proposes tasks to add, change, split
                or remove so the board matches the docs. It never changes a task that is done.
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-5">
          <div className="space-y-1.5">
            <Label htmlFor={noteId} className="text-xs text-muted-foreground">
              {copy.noteLabel}
            </Label>
            <Textarea
              id={noteId}
              value={note}
              disabled={running}
              placeholder={copy.notePlaceholder}
              onChange={(event) => setNote(event.target.value)}
              className="min-h-20 text-sm"
            />
          </div>

          {catchingUp ? (
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-0.5">
                <Label htmlFor={recordDoneId} className="text-sm">
                  Put finished work on the board
                </Label>
                <p className="text-xs text-muted-foreground">
                  As done tasks, so the board shows the progress and new tasks can build on them.
                </p>
              </div>
              <Switch
                id={recordDoneId}
                checked={recordDone}
                disabled={running}
                onCheckedChange={setRecordDone}
              />
            </div>
          ) : null}

          <RelayPlannerFields planner={planner} disabled={running} />

          {run.state.status === 'running' ? (
            <PlannerProgress
              cliName={planner.cliName}
              elapsed={run.elapsed}
              doing={copy.doing}
              onCancel={run.cancel}
            />
          ) : null}

          {run.state.status === 'failed' ? (
            <Notice tone="destructive" size="sm">
              {run.state.error}
            </Notice>
          ) : null}

          {nothingToDo ? (
            <Notice tone="success" size="sm" icon={CircleCheck}>
              {copy.nothing}
            </Notice>
          ) : planned && proposal ? (
            <div className="space-y-3">
              {catchingUp ? <ProjectStanding proposal={proposal} /> : null}
              <ProposalReview
                proposal={planned.proposal}
                entries={planned.entries}
                budget={budget}
                onChange={run.setProposal}
              />
            </div>
          ) : null}
        </div>

        <DialogFooter className="items-center gap-2 border-t border-border/70 bg-muted/20 px-6 py-3.5 sm:justify-between">
          <p className="text-[11px] text-muted-foreground">Planned by {planner.label}</p>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                if (running) announceBackgroundPlanning();
                onOpenChange(false);
              }}
            >
              {running ? 'Close' : 'Cancel'}
            </Button>
            {planned || run.state.status === 'failed' ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={applying}
                onClick={() => {
                  run.cancel();
                  setNote('');
                }}
              >
                Discard
              </Button>
            ) : null}
            {planned && !nothingToDo ? (
              <>
                <Button
                  type="button"
                  variant="soft"
                  size="sm"
                  disabled={running || applying}
                  onClick={() => void review()}
                >
                  <Sparkles /> {copy.again}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  disabled={size === 0 || applying}
                  onClick={() => void apply()}
                >
                  {applying ? <Spinner className="animate-spin" /> : <Wand2 />}
                  {`Apply ${plural(size, 'change')}`}
                </Button>
              </>
            ) : (
              <Button
                type="button"
                size="sm"
                disabled={running || !planner.input.cliId}
                onClick={() => void review()}
              >
                <copy.Icon /> {copy.start}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
