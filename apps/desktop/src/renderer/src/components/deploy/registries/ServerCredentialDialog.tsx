import { coreErrorMessage } from '@shared/coreErrors';
import {
  normalizeRegistry,
  registryCredentialProblem,
  registryLabel,
} from '@shared/deploy/registries';
import type {
  DeployRegistryCredential,
  DeployServerCredentialInput,
} from '@shared/deployRegistryTypes';
import type { DeployServer } from '@shared/deployTypes';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { Server, Spinner } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
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
import type { ProofStepUp } from '../overview/useProofStepUp';

/**
 * Stores a credential on the server (E08 T4), copied from a sign-in on this computer or typed
 * in. The core seals it with its own keys and never shows it again; it is for deploys and pulls
 * that run without this computer. Admins only, with a step-up.
 */
export function ServerCredentialDialog({
  server,
  open,
  local,
  proof,
  onClose,
  onSaved,
}: {
  server: DeployServer;
  open: boolean;
  local: DeployRegistryCredential[];
  proof: ProofStepUp;
  onClose: () => void;
  onSaved: () => void;
}): React.JSX.Element {
  const ids = { from: useId(), registry: useId(), username: useId(), secret: useId() };
  const usable = local.filter((credential) => !credential.locked);
  const [from, setFrom] = useState<string>('');
  const [registry, setRegistry] = useState('');
  const [username, setUsername] = useState('');
  const [secret, setSecret] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const chosen = from || (usable[0]?.id ?? 'typed');

  function close(): void {
    setFrom('');
    setRegistry('');
    setUsername('');
    setSecret('');
    setProblem(null);
    onClose();
  }

  async function save(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    let input: DeployServerCredentialInput;
    if (chosen === 'typed') {
      const host = normalizeRegistry(registry.trim());
      const local = host
        ? registryCredentialProblem(username, secret)
        : 'Enter the registry host, such as ghcr.io.';
      if (local || !host) {
        setProblem(local);
        return;
      }
      input = { serverId: server.id, registry: host, username, secret };
    } else {
      input = { serverId: server.id, credentialId: chosen };
    }
    setBusy(true);
    setProblem(null);
    try {
      const saved = await proof.run(
        (step) => window.agentmat.deployRegistry.serverSave({ ...input, ...step }),
        'Storing a registry credential',
      );
      if (saved) {
        toast.success(`${registryLabel(saved.registry)} is stored on ${server.nickname}.`);
        close();
        onSaved();
      }
    } catch (error) {
      setProblem(coreErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !busy && close()}>
      <DialogContent className="max-w-md">
        <form className="space-y-4" onSubmit={(event) => void save(event)}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Server className="h-4 w-4 text-primary" /> Store a credential on {server.nickname}
            </DialogTitle>
            <DialogDescription>
              The server keeps it encrypted with its own keys and uses it when a deploy or pull
              brings no sign-in. Nobody can read it back, you included; replace it or remove it.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor={ids.from}>Credential</Label>
            <Combobox
              id={ids.from}
              searchable={false}
              options={[
                ...usable.map((credential) => ({
                  value: credential.id,
                  label: `${registryLabel(credential.registry)} (${credential.username}), from this computer`,
                })),
                { value: 'typed', label: 'Type one in' },
              ]}
              value={chosen}
              onChange={setFrom}
            />
          </div>
          {chosen === 'typed' && (
            <>
              <div className="space-y-1.5">
                <Label htmlFor={ids.registry}>Registry host</Label>
                <Input
                  id={ids.registry}
                  value={registry}
                  onChange={(event) => setRegistry(event.target.value)}
                  placeholder="ghcr.io"
                  className="font-mono"
                />
              </div>
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
                <Label htmlFor={ids.secret}>Token or password</Label>
                <SecretInput id={ids.secret} value={secret} onChange={setSecret} />
              </div>
            </>
          )}
          {problem && (
            <p role="alert" className="text-sm text-destructive">
              {problem}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="soft" disabled={busy} onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy && <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" />} Store on the
              server
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
