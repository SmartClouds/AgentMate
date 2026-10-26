import { coreErrorMessage } from '@shared/coreErrors';
import type {
  FirewallChange,
  FirewallChangeSetInfo,
} from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Lock, Spinner, TriangleAlert } from '@/components/icons';
import { SECTION_HEADING } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { POLICY_LABEL } from '@/lib/deploy/firewall/format';
import { cn } from '@/lib/utils';
import { Notice } from '../deployKit';
import type { ProofStepUp } from '../overview/useProofStepUp';
import { CODE_WELL } from '../security/SecurityCard';
import { StepList, type StepStates } from './StepList';

/**
 * The last look before a change set touches the server: the exact commands the core will run,
 * what the firewall looks like afterwards, and the SSH guard's verdict. A change the guard
 * refuses can still be applied by typing its phrase (and confirming the password). Applying
 * starts the countdown: the change undoes itself unless it is kept in time.
 */

export function ApplyDialog({
  open,
  serverId,
  changes,
  stepUp,
  steps,
  onOpenChange,
  onApplied,
}: {
  open: boolean;
  serverId: string;
  changes: FirewallChange[];
  stepUp: ProofStepUp;
  /** The apply's steps as the main process reports them. */
  steps: StepStates;
  onOpenChange: (open: boolean) => void;
  onApplied: (change: FirewallChangeSetInfo) => void;
}): React.JSX.Element {
  const [phrase, setPhrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setPhrase('');
      setProblem(null);
    }
  }, [open]);

  const preview = useQuery({
    queryKey: ['deploy', 'firewall', serverId, 'preview', changes],
    queryFn: () => window.runova.deployFirewall.preview({ serverId, changes }),
    enabled: open && changes.length > 0,
    retry: false,
    gcTime: 0,
  });
  const verdict = preview.data?.guard;
  const blocked = verdict?.blocked ?? false;
  const expected = verdict?.confirmationPhrase ?? '';
  const phraseOk = !blocked || phrase.trim().toLowerCase() === expected.toLowerCase();

  async function apply(): Promise<void> {
    setBusy(true);
    setProblem(null);
    try {
      const change = await stepUp.run(
        (proof) =>
          window.runova.deployFirewall.applyChanges({
            serverId,
            changes,
            ...(blocked ? { overrideConfirmation: phrase.trim() } : {}),
            ...proof,
          }),
        'Applying this firewall change',
      );
      if (change) onApplied(change);
    } catch (error) {
      setProblem(coreErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Review the firewall change</DialogTitle>
          <DialogDescription>
            After it applies you have {preview.data?.confirmWithinSeconds ?? 60} seconds to keep it.
            If you do not, or this computer cannot get back in, the old rules come back by
            themselves.
          </DialogDescription>
        </DialogHeader>

        {preview.isPending ? (
          <div className="space-y-2" aria-busy="true">
            <Skeleton className="h-5 w-2/3" />
            <Skeleton className="h-20 w-full" />
          </div>
        ) : preview.error ? (
          <p role="alert" className="text-sm text-destructive">
            {coreErrorMessage(preview.error)}
          </p>
        ) : (
          preview.data && (
            <div className="space-y-4">
              <p className="text-sm text-foreground">{preview.data.summary}</p>
              <div>
                <p className={cn(SECTION_HEADING, 'mb-1.5')}>Commands the server runs</p>
                <pre aria-label="Commands" className={cn(CODE_WELL, 'max-h-40')}>
                  {preview.data.commands.join('\n')}
                </pre>
              </div>
              <p className="text-xs text-muted-foreground">
                Afterwards: firewall {preview.data.resultingActive ? 'on' : 'off'}, incoming{' '}
                {POLICY_LABEL[preview.data.resultingDefaultIncoming].toLowerCase()} by default,{' '}
                {preview.data.resultingRules.length} rules.
              </p>
              {preview.data.notes.length > 0 && (
                <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
                  {preview.data.notes.map((note) => (
                    <li key={note}>{note}</li>
                  ))}
                </ul>
              )}
              {blocked && verdict && (
                <Notice
                  role="alert"
                  tone="destructive"
                  icon={TriangleAlert}
                  className="[&>div]:space-y-2"
                >
                  <p className="text-sm font-medium text-destructive">
                    This could lock this computer out of SSH
                  </p>
                  <ul className="space-y-0.5 text-xs text-foreground">
                    {verdict.reasons.map((reason) => (
                      <li key={reason}>{reason}</li>
                    ))}
                  </ul>
                  <Label htmlFor="guard-phrase" className="text-xs">
                    To apply it anyway, type{' '}
                    <span className="select-all font-mono font-semibold">{expected}</span>
                  </Label>
                  <Input
                    id="guard-phrase"
                    value={phrase}
                    onChange={(event) => setPhrase(event.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                    className="font-mono"
                  />
                </Notice>
              )}
              {preview.data.needsStepUp && (
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Lock className="h-3 w-3" /> This change asks for your password again.
                </p>
              )}
            </div>
          )
        )}

        {busy && <StepList steps={steps} />}
        {problem && (
          <p role="alert" className="text-sm text-destructive">
            {problem}
          </p>
        )}
        <DialogFooter>
          <Button variant="soft" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant={blocked ? 'destructive' : 'default'}
            disabled={busy || !preview.data || !phraseOk}
            onClick={() => void apply()}
          >
            {busy && <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" />}
            {blocked ? 'Apply anyway' : 'Apply'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
