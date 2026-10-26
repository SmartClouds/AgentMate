import type { ProjectRunCommand } from '@runova/core';
import type { RunProposal } from '@shared/apiTypes';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useProjectRun } from '@/components/projects/useProjectRun';
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

/**
 * Asks the user about each run command an AI agent suggested. One suggestion shows at a time, in
 * the order they arrived. Nothing is saved until the user chooses Add command or Add and run, and
 * nothing runs unless they chose Add and run. Escape counts as Discard.
 */
export function RunProposalHost(): React.JSX.Element {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<RunProposal[]>([]);
  const [busy, setBusy] = useState(false);
  // Add and run starts the command through the same path as the Run button, so a command with
  // placeholders still asks for its values first. That dialog is drawn here, since the suggestion
  // is already gone from the list by then.
  const { runCommand, runPicker } = useProjectRun();

  useEffect(() => {
    let active = true;
    void window.runova.runProposals.list().then((list) => {
      if (active) setPending(list);
    });
    const unsubscribe = window.runova.runProposals.onChanged((changed) => {
      if (active) setPending(changed.pending);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const current = pending[0];

  async function startRun(projectId: string, command: ProjectRunCommand): Promise<void> {
    const projects = await window.runova.projects.list();
    const project = projects.find((item) => item.id === projectId);
    if (!project) {
      toast.error('The command was added, but its project could not be found to run it.');
      return;
    }
    runCommand(project, command);
  }

  async function decide(decision: 'add' | 'discard', alsoRun = false): Promise<void> {
    if (busy || !current) return;
    const proposal = current;
    setBusy(true);
    try {
      const result = await window.runova.runProposals.decide(proposal.id, decision);
      // Runova drops the suggestion either way, so it leaves the dialog either way.
      setPending((prev) => prev.filter((item) => item.id !== proposal.id));
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      if (decision !== 'add') return;
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects });
      if (alsoRun && result.runCommand) {
        await startRun(result.projectId, result.runCommand);
      } else {
        toast.success(`Added a run command to ${proposal.projectName}.`);
      }
    } finally {
      setBusy(false);
    }
  }

  const title = current?.label
    ? `Add "${current.label}" to ${current.projectName}?`
    : `Add a run command to ${current?.projectName ?? 'this project'}?`;

  return (
    <>
      {current ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) void decide('discard');
          }}
        >
          <DialogContent className="max-w-md gap-0 overflow-hidden p-0">
            <DialogHeader className="border-b border-border/70 px-6 py-5">
              <DialogTitle>{title}</DialogTitle>
              <DialogDescription>
                An AI agent in this project suggested it. Nothing is saved or run until you choose.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-2 px-6 py-5">
              <pre
                dir="ltr"
                className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-border/70 bg-muted/40 px-3 py-2.5 font-mono text-xs leading-relaxed"
              >
                {current.command}
              </pre>
              <p className="text-xs leading-relaxed text-muted-foreground">
                Add saves it to the project&apos;s run commands. Add and run also starts it now.
              </p>
              {pending.length > 1 ? (
                <p className="text-xs text-muted-foreground">1 of {pending.length} suggestions</p>
              ) : null}
            </div>

            <DialogFooter className="items-center gap-2 border-t border-border/70 bg-muted/20 px-6 py-3.5 sm:justify-end">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => void decide('discard')}
              >
                Discard
              </Button>
              <Button
                type="button"
                variant="soft"
                size="sm"
                disabled={busy}
                onClick={() => void decide('add')}
              >
                Add command
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={busy}
                onClick={() => void decide('add', true)}
              >
                Add and run
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
      {runPicker}
    </>
  );
}
