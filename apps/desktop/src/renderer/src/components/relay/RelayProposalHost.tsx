import { DEFAULT_RELAY_BUDGET } from '@runova/core';
import type { RelayMcpProposal } from '@shared/relayTypes';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ListTodo, Spinner } from '@/components/icons';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { queryKeys } from '@/lib/queryKeys';
import { ProposalReview, proposalSize } from './ProposalReview';

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/** "T004's session proposes 2 new tasks", or "An agent in Apollo proposes 3 changes". */
export function proposalTitle(item: RelayMcpProposal): string {
  const { proposal } = item;
  const onlyAdds = proposal.change.length + proposal.split.length + proposal.remove.length === 0;
  const what = onlyAdds
    ? plural(proposal.add.length, 'new task')
    : plural(proposalSize(proposal), 'change');
  const who = item.fromTaskId ? `${item.fromTaskId}'s session` : `An agent in ${item.projectName}`;
  return `${who} proposes ${what}`;
}

/**
 * Asks the user about each change an agent proposed for a Relay board through the MCP bridge,
 * one at a time and in the order they arrived. Nothing is written until the user adds them.
 * Closing the dialog declines, as it does for suggested run commands.
 */
export function RelayProposalHost(): React.JSX.Element | null {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<RelayMcpProposal[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    void Promise.resolve(window.runova.relay.pendingProposals()).then((list) => {
      if (!active || !Array.isArray(list)) return;
      setPending((prev) => [
        ...list,
        ...prev.filter((item) => !list.some((p) => p.id === item.id)),
      ]);
    });
    const unsubscribe = window.runova.relay.onProposal((proposal) => {
      if (!active) return;
      setPending((prev) =>
        prev.some((item) => item.id === proposal.id) ? prev : [...prev, proposal],
      );
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const current = pending[0];
  if (!current) return null;

  async function decide(accept: boolean): Promise<void> {
    if (busy || !current) return;
    const item = current;
    setBusy(true);
    try {
      const result = await window.runova.relay.decideProposal(item.id, accept);
      if (accept && result) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.relayBoard(item.projectId) });
        const removed = result.removed.length > 0 ? `, ${result.removed.length} removed` : '';
        toast.success(`Added to ${item.projectName}’s board`, {
          description: `${plural(result.written.length, 'task file')} written${removed}.`,
        });
        for (const warning of result.warnings) toast.warning(warning);
      }
      setPending((prev) => prev.filter((entry) => entry.id !== item.id));
    } catch (error) {
      toast.error('Could not add the proposed tasks', {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) void decide(false);
      }}
    >
      <DialogContent className="flex max-h-[85vh] max-w-xl flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b border-border/70 px-6 py-5">
          <p className="flex items-center gap-1.5 text-[10px] font-semibold tracking-[0.12em] text-primary uppercase">
            <ListTodo aria-hidden className="h-3 w-3" /> Relay
          </p>
          <DialogTitle>{proposalTitle(current)}</DialogTitle>
          <DialogDescription>
            For {current.projectName}&apos;s board. Nothing is written until you add them.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          <ProposalReview
            readOnly
            proposal={current.proposal}
            entries={current.entries}
            budget={DEFAULT_RELAY_BUDGET}
            onChange={() => undefined}
          />
        </div>

        <DialogFooter className="items-center gap-2 border-t border-border/70 bg-muted/20 px-6 py-3.5 sm:justify-between">
          <p className="text-xs text-muted-foreground">
            {pending.length > 1 ? `1 of ${pending.length} proposals` : ''}
          </p>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => void decide(false)}
            >
              Decline
            </Button>
            <Button type="button" size="sm" disabled={busy} onClick={() => void decide(true)}>
              {busy ? <Spinner className="animate-spin" /> : <ListTodo />}
              Add to board
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
