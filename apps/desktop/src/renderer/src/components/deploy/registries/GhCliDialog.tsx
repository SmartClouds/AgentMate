import { coreErrorMessage } from '@shared/coreErrors';
import { GH_REFRESH_COMMAND } from '@shared/deploy/registries';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { Copy, RefreshCw, Spinner, TerminalSquare } from '@/components/icons';
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
import { ScopeWarning } from './ScopeWarning';

/**
 * The GitHub CLI's own sign-in for ghcr.io (E08 T2). It always carries repo and workflow, so it
 * is offered only behind the scope warning. When it lacks read:packages, the fix is the gh
 * command that adds it, which runs in a terminal because gh asks the browser for the new scope.
 */
export function GhCliDialog({
  open,
  onClose,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}): React.JSX.Element {
  const [accepted, setAccepted] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const status = useQuery({
    queryKey: ['deploy', 'registries', 'gh-cli'],
    queryFn: () => window.runova.deployRegistry.githubCliStatus(),
    enabled: open,
    retry: false,
    gcTime: 0,
  });
  const data = status.data;

  async function save(): Promise<void> {
    setBusy(true);
    setProblem(null);
    try {
      await window.runova.deployRegistry.saveGithubCli({ acceptBroaderScopes: accepted });
      toast.success("The GitHub CLI's sign-in is saved for ghcr.io.");
      setAccepted(false);
      onSaved();
    } catch (error) {
      setProblem(coreErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !busy && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <TerminalSquare className="h-4 w-4" /> Use the GitHub CLI sign-in
          </DialogTitle>
          <DialogDescription>
            Takes the token gh is signed in with (gh auth token) instead of a packages-only one.
          </DialogDescription>
        </DialogHeader>
        {status.isPending ? (
          <div className="space-y-2" aria-busy="true">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : !data ? (
          <p role="alert" className="text-sm text-destructive">
            {status.error ? coreErrorMessage(status.error) : 'gh did not answer.'}
          </p>
        ) : !data.available ? (
          <p role="alert" className="text-sm text-destructive">
            {data.problem}
          </p>
        ) : (
          <div className="space-y-3 text-sm">
            <p className="text-foreground">
              Signed in{data.username ? ` as ${data.username}` : ''}. Scopes:{' '}
              <span className="font-mono text-xs">{data.scopes.join(', ') || 'none'}</span>
            </p>
            {!data.canPull ? (
              <div role="alert" className="space-y-2">
                <p className="text-destructive">{data.problem}</p>
                <div className="flex flex-wrap items-center gap-2">
                  <code className="rounded-md bg-foreground/[0.06] px-2 py-1 font-mono text-xs">
                    {GH_REFRESH_COMMAND}
                  </code>
                  <Button
                    type="button"
                    size="sm"
                    variant="soft"
                    onClick={() => {
                      void navigator.clipboard.writeText(GH_REFRESH_COMMAND);
                      toast.success('Copied. Run it in a terminal, then check again.');
                    }}
                  >
                    <Copy className="h-3.5 w-3.5" /> Copy
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="soft"
                    onClick={() => void status.refetch()}
                  >
                    <RefreshCw className="h-3.5 w-3.5" /> Check again
                  </Button>
                </div>
              </div>
            ) : (
              <ScopeWarning
                scopes={data.broaderScopes}
                accepted={accepted}
                onAccept={setAccepted}
              />
            )}
          </div>
        )}
        {problem && (
          <p role="alert" className="text-sm text-destructive">
            {problem}
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="soft" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!data?.canPull || !accepted || busy}
            onClick={() => void save()}
          >
            {busy && <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" />} Use this sign-in
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
