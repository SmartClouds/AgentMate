import { DEFAULT_RELAY_BUDGET, type RelayProposal, taskIdFromFileName } from '@runova/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { CircleCheck, FolderKanban, ListTodo, Sparkles, Spinner } from '@/components/icons';
import { Notice } from '@/components/pageKit';
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
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { queryKeys } from '@/lib/queryKeys';
import { useRelayBoardStore } from '@/stores/relayBoardStore';
import { BudgetPicker } from './BudgetPicker';
import { PlannerProgress } from './PlannerProgress';
import { ProposalReview } from './ProposalReview';
import { RelayPlannerFields, useRelayPlanner } from './RelayPlannerPicker';
import {
  ADD_ONLY,
  choiceIncomplete,
  RelayStartChoice,
  type StartChoice,
  triggerFor,
} from './RelayStartChoice';
import { usePlannerRun } from './usePlannerRun';

/** "T014", "T014 and T015", "T014, T015 and T016". */
export function joinIds(ids: readonly string[]): string {
  if (ids.length <= 1) return ids[0] ?? '';
  return `${ids.slice(0, -1).join(', ')} and ${ids[ids.length - 1]}`;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

export interface SplitIntoTasksDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** What the tasks should deliver: the built prompt, or the request it was built from. */
  request: string;
  /** The project the tasks go to. Null lets the user pick one (the standalone Prompt Builder). */
  projectId: string | null;
  /** The project the picker starts on, when the user picks one. */
  defaultProjectId?: string | null;
}

interface Added {
  projectId: string;
  ids: string[];
  started: boolean;
}

/**
 * Breaks a request into tasks that each fit one AI session, for the Relay board. A planner CLI
 * reads the project (without changing it) and proposes the tasks; the user trims and corrects
 * them, then adds them to the board and chooses when they run: now, at a time, or once another
 * task or agent session is finished.
 */
export function SplitIntoTasksDialog({
  open,
  onOpenChange,
  request,
  projectId,
  defaultProjectId = null,
}: SplitIntoTasksDialogProps): React.JSX.Element {
  const queryClient = useQueryClient();
  const [text, setText] = useState(request);
  const [pickedProjectId, setPickedProjectId] = useState(projectId ?? defaultProjectId ?? '');
  const [budget, setBudget] = useState<number>(DEFAULT_RELAY_BUDGET);
  const [proposal, setProposal] = useState<RelayProposal | null>(null);
  const [start, setStart] = useState<StartChoice>(ADD_ONLY);
  const [planFirst, setPlanFirst] = useState(false);
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState<Added | null>(null);
  const run = usePlannerRun();

  const projectsQuery = useQuery({
    queryKey: queryKeys.projects,
    queryFn: () => window.runova.projects.list(),
    enabled: open,
  });
  const targetId = projectId ?? pickedProjectId;
  const project = projectsQuery.data?.find((entry) => entry.id === targetId) ?? null;
  const planner = useRelayPlanner(project?.cliId);

  // Every opening starts from the request it was opened with.
  useEffect(() => {
    if (!open) return;
    setText(request);
    setPickedProjectId(projectId ?? defaultProjectId ?? '');
    setProposal(null);
    setStart(ADD_ONLY);
    setAdded(null);
  }, [open, request, projectId, defaultProjectId]);

  const planned = run.state.status === 'done' ? run.state.result : null;
  useEffect(() => {
    if (planned) setProposal(planned.proposal);
  }, [planned]);

  const running = run.state.status === 'running';
  const canPlan =
    Boolean(targetId) && text.trim() !== '' && Boolean(planner.input.cliId) && !running;

  async function plan(): Promise<void> {
    if (!canPlan) return;
    setProposal(null);
    await run.start((requestId) =>
      window.runova.relay.decompose({
        requestId,
        projectId: targetId,
        request: text.trim(),
        budget,
        ...planner.input,
      }),
    );
  }

  async function add(): Promise<void> {
    if (!proposal || !targetId || adding) return;
    setAdding(true);
    try {
      const before = await queryClient.fetchQuery({
        queryKey: queryKeys.relayBoard(targetId),
        queryFn: () => window.runova.relay.board(targetId),
      });
      const existing = new Set(before.tasks.map((task) => task.id));
      const result = await window.runova.relay.applyProposal(targetId, proposal);
      const ids = result.written
        .map((file) => taskIdFromFileName(file))
        .filter((id): id is string => id !== null && !existing.has(id));
      void queryClient.invalidateQueries({ queryKey: queryKeys.relayBoard(targetId) });

      const trigger = triggerFor(start, targetId);
      let started = false;
      if (trigger && ids.length > 0) {
        const outcome = await window.runova.relay.start({
          projectId: targetId,
          only: ids,
          trigger,
          options: { planFirst },
        });
        if (outcome.ok) started = true;
        else
          toast.error('The tasks were added, but the relay did not start', {
            description: outcome.error,
          });
      }
      for (const warning of result.warnings) toast.warning(warning);
      setAdded({ projectId: targetId, ids, started });
    } catch (error) {
      toast.error('Could not add the tasks', {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setAdding(false);
    }
  }

  const addCount = proposal?.add.length ?? 0;
  const projectOptions = (projectsQuery.data ?? []).map((entry) => ({
    value: entry.id,
    label: entry.name,
  }));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[88vh] max-w-2xl flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b border-border/70 px-6 py-5">
          <p className="flex items-center gap-1.5 text-[10px] font-semibold tracking-[0.12em] text-primary uppercase">
            <ListTodo aria-hidden className="h-3 w-3" /> Relay
          </p>
          <DialogTitle>Split into tasks</DialogTitle>
          <DialogDescription>
            Each task is sized to finish in one AI session, so no session runs out of context. They
            run one after another, and every session leaves a handoff for the next.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-5">
          {added ? (
            <div className="flex flex-col items-center gap-3 py-6 text-center">
              <CircleCheck aria-hidden className="h-8 w-8 text-success" />
              <p className="text-sm font-medium">
                Added {joinIds(added.ids)} to the board.
                {added.started ? ' The relay will run them as you chose.' : ''}
              </p>
              <Button
                type="button"
                variant="tint"
                onClick={() => {
                  useRelayBoardStore.getState().open(added.projectId, added.ids[0]);
                  onOpenChange(false);
                }}
              >
                <FolderKanban /> Open board
              </Button>
            </div>
          ) : (
            <>
              {projectId ? null : (
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Project</Label>
                  <Combobox
                    ariaLabel="Project"
                    className="h-8 text-xs"
                    value={pickedProjectId}
                    onChange={setPickedProjectId}
                    disabled={running}
                    placeholder="Pick the project the tasks belong to"
                    searchPlaceholder="Search projects…"
                    emptyText="No projects yet."
                    options={projectOptions}
                  />
                </div>
              )}

              <div className="space-y-1.5">
                <Label htmlFor="relay-split-request" className="text-xs text-muted-foreground">
                  What should the tasks deliver?
                </Label>
                <Textarea
                  id="relay-split-request"
                  value={text}
                  disabled={running}
                  onChange={(event) => setText(event.target.value)}
                  className="min-h-28 text-sm"
                />
              </div>

              <div className="flex flex-wrap items-end justify-between gap-3">
                <div className="space-y-1.5">
                  <p className="text-xs text-muted-foreground">Context per session</p>
                  <BudgetPicker value={budget} onChange={setBudget} disabled={running} />
                </div>
              </div>

              <RelayPlannerFields planner={planner} disabled={running} />

              {run.state.status === 'running' ? (
                <PlannerProgress
                  cliName={planner.cliName}
                  elapsed={run.elapsed}
                  doing="reading the project and sizing tasks"
                  onCancel={run.cancel}
                />
              ) : null}

              {run.state.status === 'failed' ? (
                <Notice tone="destructive" size="sm">
                  {run.state.error}
                </Notice>
              ) : null}

              {proposal && planned ? (
                <section aria-label="Proposed tasks" className="space-y-4">
                  <ProposalReview
                    proposal={planned.proposal}
                    entries={planned.entries}
                    budget={budget}
                    onChange={setProposal}
                  />
                  <RelayStartChoice
                    projectId={targetId}
                    value={start}
                    onChange={setStart}
                    planFirst={planFirst}
                    onPlanFirstChange={setPlanFirst}
                    disabled={adding}
                  />
                </section>
              ) : null}
            </>
          )}
        </div>

        <DialogFooter className="items-center gap-2 border-t border-border/70 bg-muted/20 px-6 py-3.5 sm:justify-between">
          <p className="text-[11px] text-muted-foreground">
            {added ? '' : `Planned by ${planner.label}`}
          </p>
          <div className="flex items-center gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              {added ? 'Close' : 'Cancel'}
            </Button>
            {added ? null : proposal ? (
              <>
                <Button
                  type="button"
                  variant="soft"
                  size="sm"
                  disabled={running || adding}
                  onClick={() => void plan()}
                >
                  <Sparkles /> Plan again
                </Button>
                <Button
                  type="button"
                  size="sm"
                  disabled={addCount === 0 || adding || choiceIncomplete(start, targetId)}
                  onClick={() => void add()}
                >
                  {adding ? <Spinner className="animate-spin" /> : <ListTodo />}
                  {`Add ${plural(addCount, 'task')} to board`}
                </Button>
              </>
            ) : (
              <Button type="button" size="sm" disabled={!canPlan} onClick={() => void plan()}>
                <Sparkles /> Plan tasks
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
