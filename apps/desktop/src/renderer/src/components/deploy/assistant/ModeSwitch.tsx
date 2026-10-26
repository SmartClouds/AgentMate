import { coreErrorMessage } from '@shared/coreErrors';
import type { AssistantMode } from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { DeployServer } from '@shared/deployTypes';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { Shield } from '@/components/icons';
import { segmentClass } from '@/components/pageKit';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { useProofStepUp } from '../overview/useProofStepUp';

/**
 * The two modes (E09 T5), kept by the core for this session: approve every command (the default),
 * or let read-only checks run without asking. Turning the second on asks for the password (a
 * step-up) when the last one has run out. The choice is in words, not only in colour.
 */

const MODES: ReadonlyArray<{ value: AssistantMode; label: string; hint: string }> = [
  {
    value: 'approveEveryCommand',
    label: 'Approve every command',
    hint: 'Nothing runs on the server until you click Run on it.',
  },
  {
    value: 'autoRunDiagnostics',
    label: 'Auto-run diagnostics',
    hint: 'Read-only checks such as docker ps, docker logs, journalctl or df run without asking. Anything else still waits for you, and the core itself refuses it without your approval.',
  },
];

export function ModeSwitch({
  server,
  mode,
  disabled,
}: {
  server: DeployServer;
  mode: AssistantMode;
  disabled?: boolean;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const stepUp = useProofStepUp(server);
  const [busy, setBusy] = useState(false);

  async function choose(next: AssistantMode): Promise<void> {
    if (next === mode || busy) return;
    setBusy(true);
    try {
      const info = await stepUp.run(
        (proof) =>
          window.runova.deployAssistant.setMode({ serverId: server.id, mode: next, ...proof }),
        'let the AI run read-only checks without asking',
      );
      if (info) queryClient.setQueryData(queryKeys.deployAssistantMode(server.id), info);
    } catch (error) {
      toast.error(coreErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="radiogroup"
      aria-label="How commands run"
      className="grid grid-cols-2 gap-0.5 rounded-full bg-foreground/8 p-0.5"
    >
      {MODES.map((option) => {
        const checked = option.value === mode;
        return (
          <SimpleTooltip key={option.value} label={option.hint} className="max-w-72">
            <button
              type="button"
              role="radio"
              aria-checked={checked}
              disabled={disabled || busy}
              onClick={() => void choose(option.value)}
              className={cn(
                segmentClass(checked),
                'h-7 w-full gap-1.5 px-2 disabled:cursor-not-allowed disabled:opacity-60',
                checked && 'text-primary',
              )}
            >
              {option.value === 'autoRunDiagnostics' && <Shield className="h-3 w-3" />}
              {option.label}
              {checked && <span className="sr-only"> (on)</span>}
            </button>
          </SimpleTooltip>
        );
      })}
      {stepUp.dialog}
    </div>
  );
}
