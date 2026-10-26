import type { SaveSshServerInput, SshAuthMethod, SshSavedServer } from '@shared/apiTypes';
import { useEffect, useId, useState } from 'react';
import { toast } from 'sonner';
import { FolderOpen, Spinner } from '@/components/icons';
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
import { cn } from '@/lib/utils';

/** One labelled control with its optional hint, matching the projects form's convention. */
function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && <p className="text-xs leading-relaxed text-muted-foreground">{hint}</p>}
    </div>
  );
}

export interface SshServerFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial?: SshSavedServer;
  onSaved: (server: SshSavedServer) => void;
}

export function SshServerFormDialog({
  open,
  onOpenChange,
  initial,
  onSaved,
}: SshServerFormDialogProps): React.JSX.Element {
  const ids = useId();
  const [nickname, setNickname] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('22');
  const [username, setUsername] = useState('');
  const [authMethod, setAuthMethod] = useState<SshAuthMethod>('password');
  const [privateKeyPath, setPrivateKeyPath] = useState('');
  const [secret, setSecret] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setNickname(initial?.nickname ?? '');
    setHost(initial?.host ?? '');
    setPort(String(initial?.port ?? 22));
    setUsername(initial?.username ?? '');
    setAuthMethod(initial?.authMethod ?? 'password');
    setPrivateKeyPath(initial?.privateKeyPath ?? '');
    setSecret('');
    setSubmitting(false);
  }, [open, initial]);

  // Switching auth method drops the old secret server-side (it meant something different),
  // so the "leave blank to keep it" hint only makes sense while the method is unchanged.
  const keepsExistingSecret =
    initial != null && initial.authMethod === authMethod && initial.hasSecret;
  const portNumber = Number.parseInt(port, 10);
  const canSubmit =
    nickname.trim().length > 0 &&
    host.trim().length > 0 &&
    username.trim().length > 0 &&
    Number.isInteger(portNumber) &&
    portNumber > 0 &&
    portNumber < 65536 &&
    (authMethod === 'password' || privateKeyPath.trim().length > 0);

  async function pickPrivateKey(): Promise<void> {
    const path = await window.runova.ssh.pickPrivateKeyFile();
    if (path) setPrivateKeyPath(path);
  }

  async function handleSubmit(): Promise<void> {
    if (!canSubmit || submitting) return;
    if (secret) {
      const status = await window.runova.ssh.vaultStatus();
      if (status.hasPasskey && !status.unlocked) {
        toast.error('Unlock your Servers passkey first (see the lock button above the list).');
        return;
      }
    }
    setSubmitting(true);
    try {
      const input: SaveSshServerInput = {
        id: initial?.id,
        nickname: nickname.trim(),
        host: host.trim(),
        port: portNumber,
        username: username.trim(),
        authMethod,
        privateKeyPath: authMethod === 'privateKey' ? privateKeyPath.trim() : undefined,
        secret: secret || undefined,
      };
      const saved = await window.runova.ssh.saveServer(input);
      onOpenChange(false);
      onSaved(saved);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not save this server.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-md gap-0 overflow-hidden p-0"
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void handleSubmit();
          }
        }}
      >
        <DialogHeader className="border-b border-border/70 px-6 py-5">
          <DialogTitle>{initial ? 'Edit server' : 'Add server'}</DialogTitle>
          <DialogDescription>
            Saved servers connect with one click from a terminal tab.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4 px-6 py-5">
          <Field label="Nickname" htmlFor={`${ids}-nickname`}>
            <Input
              id={`${ids}-nickname`}
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              placeholder="Production box"
            />
          </Field>
          <div className="grid grid-cols-[1fr_5.5rem] gap-3">
            <Field label="Host" htmlFor={`${ids}-host`}>
              <Input
                id={`${ids}-host`}
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="192.168.1.10"
                spellCheck={false}
                autoComplete="off"
              />
            </Field>
            <Field label="Port" htmlFor={`${ids}-port`}>
              <Input
                id={`${ids}-port`}
                value={port}
                onChange={(e) => setPort(e.target.value)}
                inputMode="numeric"
              />
            </Field>
          </div>
          <Field label="Username" htmlFor={`${ids}-username`}>
            <Input
              id={`${ids}-username`}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              spellCheck={false}
              autoComplete="off"
            />
          </Field>

          <div className="flex gap-1 rounded-md bg-secondary/50 p-1">
            <button
              type="button"
              onClick={() => setAuthMethod('password')}
              className={cn(
                'flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors',
                authMethod === 'password'
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              Password
            </button>
            <button
              type="button"
              onClick={() => setAuthMethod('privateKey')}
              className={cn(
                'flex-1 rounded px-3 py-1.5 text-xs font-medium transition-colors',
                authMethod === 'privateKey'
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              Private key
            </button>
          </div>

          {authMethod === 'password' ? (
            <Field
              label="Password"
              htmlFor={`${ids}-secret`}
              hint={keepsExistingSecret ? 'Leave blank to keep the current password.' : undefined}
            >
              <SecretInput
                id={`${ids}-secret`}
                value={secret}
                onChange={setSecret}
                placeholder={keepsExistingSecret ? 'Unchanged' : undefined}
              />
            </Field>
          ) : (
            <>
              <Field label="Private key file" htmlFor={`${ids}-key-path`}>
                <div className="flex gap-2">
                  <Input
                    id={`${ids}-key-path`}
                    value={privateKeyPath}
                    onChange={(e) => setPrivateKeyPath(e.target.value)}
                    placeholder="~/.ssh/id_ed25519"
                    spellCheck={false}
                    className="flex-1"
                  />
                  <Button
                    type="button"
                    variant="soft"
                    className="h-9"
                    onClick={() => void pickPrivateKey()}
                  >
                    <FolderOpen className="h-3.5 w-3.5" /> Browse
                  </Button>
                </div>
              </Field>
              <Field
                label="Key passphrase"
                htmlFor={`${ids}-secret`}
                hint={
                  keepsExistingSecret
                    ? 'Leave blank to keep the current passphrase (or if the key has none).'
                    : 'Only needed if the key itself is passphrase-protected.'
                }
              >
                <SecretInput
                  id={`${ids}-secret`}
                  value={secret}
                  onChange={setSecret}
                  placeholder={keepsExistingSecret ? 'Unchanged' : undefined}
                />
              </Field>
            </>
          )}
        </div>
        <DialogFooter className="items-center border-t border-border/70 bg-muted/20 px-6 py-4 sm:justify-between">
          <p className="text-xs text-muted-foreground">Ctrl+Enter to save</p>
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button disabled={!canSubmit || submitting} onClick={() => void handleSubmit()}>
              {submitting && <Spinner className="h-4 w-4 animate-spin" />}
              {initial ? 'Save changes' : 'Add server'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
