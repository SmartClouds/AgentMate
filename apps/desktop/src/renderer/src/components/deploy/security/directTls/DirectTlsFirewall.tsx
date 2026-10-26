import { coreErrorMessage } from '@shared/coreErrors';
import type {
  FirewallChange,
  FirewallChangeSetInfo,
} from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { DeployServer } from '@shared/deployTypes';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { queryKeys } from '@/lib/queryKeys';
import { ApplyDialog } from '../../firewall/ApplyDialog';
import { CountdownBanner } from '../../firewall/CountdownBanner';
import { useFirewallData, useFirewallSteps, useTicking } from '../../firewall/hooks';
import type { ProofStepUp } from '../../overview/useProofStepUp';

/**
 * The firewall half of direct TLS: the rule that lets the port through (or takes it away) goes
 * through the Firewall section's own review and safe apply, so it gets the SSH lockout guard, the
 * exact commands, and the countdown that undoes it unless it is kept over a new SSH connection.
 */
export function DirectTlsFirewall({
  server,
  changes,
  stepUp,
  canAdmin,
  onClose,
}: {
  server: DeployServer;
  /** The change set to review, or null when nothing is being reviewed. */
  changes: FirewallChange[] | null;
  stepUp: ProofStepUp;
  canAdmin: boolean;
  onClose: () => void;
}): React.JSX.Element {
  const serverId = server.id;
  const queryClient = useQueryClient();
  const { status } = useFirewallData(serverId, canAdmin);
  const { steps, reset } = useFirewallSteps(serverId);
  const pending = status.data?.pending;
  const now = useTicking(pending !== undefined);
  const [deciding, setDeciding] = useState<'keep' | 'revert' | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: queryKeys.deployFirewall(serverId) });

  function applied(change: FirewallChangeSetInfo): void {
    onClose();
    reset('confirm');
    reset('revert');
    queryClient.setQueryData(
      queryKeys.deployFirewallStatus(serverId),
      (current: typeof status.data) => (current ? { ...current, pending: change } : current),
    );
    refresh();
  }

  async function decide(kind: 'keep' | 'revert', change: FirewallChangeSetInfo): Promise<void> {
    setDeciding(kind);
    setProblem(null);
    try {
      const input = { serverId, changeSetId: change.id };
      if (kind === 'keep') {
        await window.runova.deployFirewall.confirm(input);
        toast.success('Firewall change kept.');
      } else {
        await window.runova.deployFirewall.revert(input);
        toast.success('Firewall change reverted. The old rules are back.');
      }
    } catch (error) {
      setProblem(coreErrorMessage(error));
    } finally {
      setDeciding(null);
      refresh();
    }
  }

  return (
    <>
      {pending && (
        <CountdownBanner
          change={pending}
          windowSeconds={status.data?.confirmWithinSeconds ?? 60}
          now={now}
          busy={deciding}
          steps={steps.revert.length > 0 ? steps.revert : steps.confirm}
          problem={problem}
          canDecide={canAdmin}
          onKeep={() => void decide('keep', pending)}
          onRevert={() => void decide('revert', pending)}
        />
      )}
      <ApplyDialog
        open={changes !== null}
        serverId={serverId}
        changes={changes ?? []}
        stepUp={stepUp}
        steps={steps.apply}
        onOpenChange={(open) => {
          if (!open) onClose();
          else reset('apply');
        }}
        onApplied={applied}
      />
    </>
  );
}
