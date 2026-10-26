import { coreErrorMessage } from '@shared/coreErrors';
import { normalizeRegistry, registryCredentialProblem } from '@shared/deploy/registries';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { Package, Spinner } from '@/components/icons';
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
import { SecretInput } from '@/components/ui/secret-input';

/**
 * Docker Hub or a custom registry (E08 T5): a user name and an access token (or password). The
 * same rules the core uses are checked while typing; the secret goes to the main process once,
 * is sealed there, and never comes back.
 */
export function RegistryCredentialDialog({
  kind,
  onClose,
  onSaved,
}: {
  /** null keeps the dialog closed. */
  kind: 'dockerhub' | 'custom' | null;
  onClose: () => void;
  onSaved: () => void;
}): React.JSX.Element {
  const ids = { registry: useId(), username: useId(), secret: useId() };
  const [registry, setRegistry] = useState('');
  const [username, setUsername] = useState('');
  const [secret, setSecret] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function close(): void {
    setRegistry('');
    setUsername('');
    setSecret('');
    setProblem(null);
    onClose();
  }

  async function save(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!kind) return;
    const local =
      kind === 'custom' && !normalizeRegistry(registry.trim())
        ? 'Enter the registry host, such as registry.example.com:5000.'
        : registryCredentialProblem(username, secret);
    if (local) {
      setProblem(local);
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      await window.runova.deployRegistry.saveCredential({
        kind,
        ...(kind === 'custom' ? { registry: registry.trim() } : {}),
        username,
        secret,
      });
      toast.success(
        kind === 'dockerhub'
          ? 'The Docker Hub sign-in is saved.'
          : 'The registry sign-in is saved.',
      );
      close();
      onSaved();
    } catch (error) {
      setProblem(coreErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={kind !== null} onOpenChange={(next) => !next && !busy && close()}>
      <DialogContent className="max-w-md">
        <form className="space-y-4" onSubmit={(event) => void save(event)}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Package className="h-4 w-4 text-primary" />
              {kind === 'dockerhub' ? 'Docker Hub' : 'Custom registry'}
            </DialogTitle>
            <DialogDescription>
              {kind === 'dockerhub'
                ? 'Use a Docker Hub access token with read-only access rather than your password.'
                : 'Any registry that speaks the Docker registry API, such as GitLab, Harbor or your own registry:2.'}
            </DialogDescription>
          </DialogHeader>
          {kind === 'custom' && (
            <div className="space-y-1.5">
              <Label htmlFor={ids.registry}>Registry host</Label>
              <Input
                id={ids.registry}
                value={registry}
                onChange={(event) => setRegistry(event.target.value)}
                placeholder="registry.example.com:5000"
                className="font-mono"
              />
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor={ids.username}>User name</Label>
            <Input
              id={ids.username}
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="off"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={ids.secret}>Access token or password</Label>
            <SecretInput id={ids.secret} value={secret} onChange={setSecret} />
          </div>
          {problem && (
            <p role="alert" className="text-sm text-destructive">
              {problem}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="soft" disabled={busy} onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !username || !secret}>
              {busy && <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" />} Save sign-in
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
