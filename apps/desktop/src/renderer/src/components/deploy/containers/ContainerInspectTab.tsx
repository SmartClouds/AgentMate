import { coreErrorMessage } from '@shared/coreErrors';
import type {
  ContainerDetails,
  ContainerEnvVariable,
} from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { useState } from 'react';
import { Eye, EyeOff, Lock, Spinner } from '@/components/icons';
import { SECTION_HEADING, SECTION_WELL } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { ProofStepUp } from '../overview/useProofStepUp';

/**
 * What the engine says about a container (E06 T8): its environment variables by name only, with
 * the values one Admin click away (after the password again), and its labels. Revealed values
 * stay in this tab while it is open and are never written anywhere.
 */

export function ContainerInspectTab({
  serverId,
  details,
  canReveal,
  stepUp,
  revealed,
  onRevealed,
}: {
  serverId: string;
  details: ContainerDetails;
  canReveal: boolean;
  stepUp: ProofStepUp;
  revealed: ContainerEnvVariable[] | null;
  onRevealed: (values: ContainerEnvVariable[] | null) => void;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const containerId = details.summary.id;

  async function reveal(): Promise<void> {
    setBusy(true);
    setProblem(null);
    try {
      const values = await stepUp.run(
        (proof) => window.runova.deployDocker.revealEnv({ serverId, containerId, ...proof }),
        'Showing environment values',
      );
      if (values) onRevealed(values);
    } catch (error) {
      setProblem(coreErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  const values = new Map(revealed?.map((variable) => [variable.name, variable.value]) ?? []);

  return (
    <div className="space-y-5">
      <section aria-label="Environment variables" className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className={SECTION_HEADING}>Environment variables</h3>
          {details.envKeys.length > 0 &&
            (revealed ? (
              <Button size="sm" variant="soft" onClick={() => onRevealed(null)}>
                <EyeOff className="h-3.5 w-3.5" /> Hide values
              </Button>
            ) : canReveal ? (
              <Button size="sm" variant="soft" onClick={() => void reveal()} disabled={busy}>
                {busy ? (
                  <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" />
                ) : (
                  <Eye className="h-3.5 w-3.5" />
                )}
                Show values
              </Button>
            ) : (
              <SimpleTooltip label="Only Admins can see the values, after confirming their password.">
                <span
                  className="flex items-center gap-1.5 text-xs text-muted-foreground"
                  tabIndex={0}
                >
                  <Lock className="h-3 w-3" /> Values are for Admins
                </span>
              </SimpleTooltip>
            ))}
        </div>
        {problem && (
          <p role="alert" className="text-sm text-destructive">
            {problem}
          </p>
        )}
        {details.envKeys.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            This container has no environment variables.
          </p>
        ) : (
          <ul className={cn(SECTION_WELL, 'settings-rows p-0')} aria-label="Variables">
            {details.envKeys.map((key) => (
              <li
                key={key}
                className="grid grid-cols-[minmax(8rem,auto)_minmax(0,1fr)] gap-3 px-3 py-1.5 font-mono text-xs"
              >
                <span className="text-foreground">{key}</span>
                <span className="truncate text-muted-foreground">
                  {revealed ? (values.get(key) ?? '') : '••••••'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Labels" className="space-y-2">
        <h3 className={SECTION_HEADING}>Labels</h3>
        {details.labels.length === 0 ? (
          <p className="text-sm text-muted-foreground">No labels.</p>
        ) : (
          <ul className={cn(SECTION_WELL, 'settings-rows p-0')}>
            {details.labels.map((label) => (
              <li
                key={label.name}
                className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-3 px-3 py-1.5 font-mono text-xs"
              >
                <span className="truncate text-foreground">{label.name}</span>
                <span className="truncate text-muted-foreground">{label.value}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
