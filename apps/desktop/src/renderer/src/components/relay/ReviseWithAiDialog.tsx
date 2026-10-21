import { DEFAULT_RELAY_BUDGET, type RelayProposal } from '@agentmat/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { CircleCheck, ListTodo, Sparkles, Spinner, Wand2 } from '@/components/icons';
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
import { Textarea } from '@/components/ui/textarea';
import { queryKeys } from '@/lib/queryKeys';
import { PlannerProgress } from './PlannerProgress';
import { ProposalReview, proposalSize } from './ProposalReview';
import { RelayPlannerFields, useRelayPlanner } from './RelayPlannerPicker';
import { usePlannerRun } from './usePlannerRun';

export interface ReviseWithAiDialogProps {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/**
 * Brings the board back in line with the project's docs, the spec-driven way: the docs are the
 * source of truth, and a planner reads them and the task files, then proposes tasks to add,
 * change, split or remove. Nothing changes until the user applies what they kept.
 */
export function ReviseWithAiDialog({
  projectId,
  open,
  onOpenChange,
}: ReviseWithAiDialogProps): React.JSX.Element | null {
  const queryClient = useQueryClient();
  const [note, setNote] = useState('');
  const [proposal, setProposal] = useState<RelayProposal | null>(null);
  const [applying, setApplying] = useState(false);
  const run = usePlannerRun();

  const boardQuery = useQuery({
    queryKey: queryKeys.relayBoard(projectId),
    queryFn: () => window.agentmat.relay.board(projectId),
    enabled: open,
  });
  const projectsQuery = useQuery({
    queryKey: queryKeys.projects,
    queryFn: () => window.agentmat.projects.list(),
    enabled: open,
  });
  const project = projectsQuery.data?.find((entry) => entry.id === projectId) ?? null;
  const planner = useRelayPlanner(project?.cliId);
  const docsFolder = boardQuery.data?.docsFolder ?? 'docs';
  const budget = boardQuery.data?.settings?.options?.defaultBudget ?? DEFAULT_RELAY_BUDGET;

  useEffect(() => {
    if (!open) return;
    setNote('');
    setProposal(null);
  }, [open]);

  const planned = run.state.status === 'done' ? run.state.result : null;
  useEffect(() => {
    if (planned) setProposal(planned.proposal);
  }, [planned]);

  const running = run.state.status === 'running';

  async function review(): Promise<void> {
    if (running || !planner.input.cliId) return;
    setProposal(null);
    await run.start((requestId) =>
      window.agentmat.relay.revise({
        requestId,
        projectId,
        note: note.trim() || undefined,
        budget,
        ...planner.input,
      }),
    );
  }

  async function apply(): Promise<void> {
    if (!proposal || applying) return;
    setApplying(true);
    try {
      const result = await window.agentmat.relay.applyProposal(projectId, proposal);
      void queryClient.invalidateQueries({ queryKey: queryKeys.relayBoard(projectId) });
      const removed = result.removed.length > 0 ? `, ${result.removed.length} removed` : '';
      toast.success('Board updated', {
        description: `${plural(result.written.length, 'task file')} written${removed}.`,
      });
      for (const warning of result.warnings) toast.warning(warning);
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[88vh] max-w-2xl flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b border-border/70 px-6 py-5">
          <p className="flex items-center gap-1.5 text-[10px] font-semibold tracking-[0.12em] text-primary uppercase">
            <ListTodo aria-hidden className="h-3 w-3" /> Relay
          </p>
          <DialogTitle>Revise tasks with AI</DialogTitle>
          <DialogDescription>
            The AI reads the docs in <span className="font-mono">{docsFolder}/</span>, which are the
            source of truth, and the task files, then proposes tasks to add, change, split or remove
            so the board matches the docs. It never changes a task that is done.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-5">
          <div className="space-y-1.5">
            <Label htmlFor="relay-revise-note" className="text-xs text-muted-foreground">
              What should change? (optional)
            </Label>
            <Textarea
              id="relay-revise-note"
              value={note}
              disabled={running}
              placeholder="Leave it empty to compare the tasks with the docs as they are."
              onChange={(event) => setNote(event.target.value)}
              className="min-h-20 text-sm"
            />
          </div>

          <RelayPlannerFields planner={planner} disabled={running} />

          {run.state.status === 'running' ? (
            <PlannerProgress
              cliName={planner.cliName}
              elapsed={run.elapsed}
              doing="reading the docs and the tasks"
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
              The tasks already match the docs.
            </Notice>
          ) : planned && proposal ? (
            <ProposalReview
              proposal={planned.proposal}
              entries={planned.entries}
              budget={budget}
              onChange={setProposal}
            />
          ) : null}
        </div>

        <DialogFooter className="items-center gap-2 border-t border-border/70 bg-muted/20 px-6 py-3.5 sm:justify-between">
          <p className="text-[11px] text-muted-foreground">Planned by {planner.label}</p>
          <div className="flex items-center gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            {planned && !nothingToDo ? (
              <>
                <Button
                  type="button"
                  variant="soft"
                  size="sm"
                  disabled={running || applying}
                  onClick={() => void review()}
                >
                  <Sparkles /> Review again
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
                <Sparkles /> Review tasks
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
