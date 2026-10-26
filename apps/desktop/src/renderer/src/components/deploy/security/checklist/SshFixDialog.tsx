import { coreErrorMessage } from '@shared/coreErrors';
import type { SshHardeningChangeInfo } from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { DeploySshHardeningInput } from '@shared/deployHardeningTypes';
import type { DeployServer } from '@shared/deployTypes';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { CircleCheck, Key, RefreshCw, Spinner, TriangleAlert } from '@/components/icons';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Notice } from '../../deployKit';
import { CODE_WELL } from '../SecurityCard';
import type { StepUp } from '../useStepUp';
import { SshStepList, type SshSteps } from './SshChangeBanner';

/**
 * The preview of an SSH fix: the exact drop-in file and commands, and whether the core could prove
 * that this computer signs in with a key (asked over a connection opened just for it). Apply stays
 * off without that proof, and the core refuses anyway. After apply the change waits to be kept.
 */
export function SshFixDialog({
  server,
  request,
  stepUp,
  steps,
  onOpenChange,
  onApplied,
}: {
  server: DeployServer;
  /** The change to preview; null when the dialog is closed. */
  request: Omit<DeploySshHardeningInput, 'serverId'> | null;
  stepUp: StepUp;
  steps: SshSteps;
  onOpenChange: (open: boolean) => void;
  onApplied: (change: SshHardeningChangeInfo) => void;
}): React.JSX.Element {
  const [applying, setApplying] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const input = request ? { serverId: server.id, ...request } : null;
  const preview = useQuery({
    queryKey: ['deploy', 'security', server.id, 'ssh-preview', request],
    queryFn: () => window.runova.deployHardening.previewSsh(input as DeploySshHardeningInput),
    enabled: input !== null,
    retry: false,
    gcTime: 0,
  });

  async function apply(): Promise<void> {
    if (!input) return;
    setApplying(true);
    setProblem(null);
    try {
      const change = await stepUp.run(() => window.runova.deployHardening.applySsh(input));
      if (change) onApplied(change);
    } catch (error) {
      setProblem(coreErrorMessage(error));
    } finally {
      setApplying(false);
    }
  }

  const data = preview.data;
  let body: React.ReactNode;
  if (preview.isPending) {
    body = (
      <div className="space-y-2" aria-busy="true">
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-24 w-full rounded-md" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    );
  } else if (preview.isError) {
    body = (
      <div className="space-y-2">
        <p role="alert" className="text-sm text-destructive">
          {coreErrorMessage(preview.error)}
        </p>
        <Button size="sm" variant="soft" onClick={() => void preview.refetch()}>
          <RefreshCw className="h-3.5 w-3.5" /> Try again
        </Button>
      </div>
    );
  } else if (data) {
    const proven = data.proof.keyLoginProven;
    body = (
      <div className="space-y-3">
        <Notice
          tone={proven ? 'success' : 'destructive'}
          icon={proven ? CircleCheck : TriangleAlert}
        >
          <p>
            <span className="font-medium">
              {proven ? 'Key login proven. ' : 'Key login not proven. '}
            </span>
            {data.proof.explanation}
          </p>
        </Notice>
        <div>
          <p className="mb-1.5 text-xs font-medium text-muted-foreground">
            The file the core writes: <span className="font-mono">{data.path}</span>
          </p>
          <pre aria-label="File contents" className={CODE_WELL}>
            {data.content}
          </pre>
        </div>
        <div>
          <p className="mb-1.5 text-xs font-medium text-muted-foreground">Then, in order</p>
          <ol
            aria-label="Commands"
            className="list-decimal space-y-0.5 pl-5 font-mono text-xs text-foreground"
          >
            {data.commands.map((command) => (
              <li key={command}>{command}</li>
            ))}
          </ol>
        </div>
        <ul className="space-y-1 text-xs text-muted-foreground">
          {data.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
        <SshStepList steps={steps} />
        {problem && (
          <p role="alert" className="text-sm text-destructive">
            {problem}
          </p>
        )}
      </div>
    );
  }

  return (
    <Dialog open={request !== null} onOpenChange={(open) => !applying && onOpenChange(open)}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{data?.summary ?? 'Review the SSH change'}</DialogTitle>
          <DialogDescription>
            On {server.nickname}. Open SSH sessions stay open; only new logins get the new settings.
          </DialogDescription>
        </DialogHeader>
        {body}
        <DialogFooter>
          <Button variant="soft" disabled={applying} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!data?.allowed || applying} onClick={() => void apply()}>
            {applying ? (
              <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" />
            ) : (
              <Key className="h-3.5 w-3.5" />
            )}
            Apply
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
