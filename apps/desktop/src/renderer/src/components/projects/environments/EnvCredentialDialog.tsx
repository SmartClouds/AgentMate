import type { EnvCredentialSummary, ProjectEnvironment } from '@shared/apiTypes';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Spinner } from '@/components/icons';
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
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { ipcErrorMessage } from './ipcError';

export interface EnvCredentialDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  environment: ProjectEnvironment;
  initial?: EnvCredentialSummary;
  onSaved: () => void;
}

export function EnvCredentialDialog({
  open,
  onOpenChange,
  environment,
  initial,
  onSaved,
}: EnvCredentialDialogProps): React.JSX.Element {
  const [label, setLabel] = useState('');
  const [username, setUsername] = useState('');
  const [url, setUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [notes, setNotes] = useState('');
  // What was stored when the dialog opened, so only real changes are sent back.
  const [loaded, setLoaded] = useState({ secret: '', notes: '' });
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: load once per open, not on every environment refetch
  useEffect(() => {
    if (!open) return;
    setLabel(initial?.label ?? '');
    setUsername(initial?.username ?? '');
    setUrl(initial?.url ?? '');
    setSecret('');
    setNotes('');
    setLoaded({ secret: '', notes: '' });
    setSubmitting(false);
    if (!initial || (!initial.hasSecret && !initial.hasNotes)) return;

    let cancelled = false;
    setLoading(true);
    window.runova.environments
      .revealCredential(environment.id, initial.id)
      .then((values) => {
        if (cancelled) return;
        setSecret(values.secret);
        setNotes(values.notes);
        setLoaded(values);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        toast.error(ipcErrorMessage(error, 'Could not open that credential.'));
        onOpenChange(false);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, initial?.id]);

  const canSubmit = label.trim().length > 0 && !loading && !submitting;

  async function handleSubmit(): Promise<void> {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      await window.runova.environments.saveCredential({
        environmentId: environment.id,
        id: initial?.id,
        label: label.trim(),
        username,
        url,
        // Unchanged values are left out so the stored ones are kept as they are.
        secret: secret === loaded.secret && initial ? undefined : secret,
        notes: notes === loaded.notes && initial ? undefined : notes,
      });
      onOpenChange(false);
      onSaved();
    } catch (error) {
      toast.error(ipcErrorMessage(error, 'Could not save that credential.'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{initial ? `Edit ${initial.label}` : 'Add credential'}</DialogTitle>
          <DialogDescription>
            A login or key for {environment.name} that doesn't live in an env file, like a database,
            hosting dashboard or server.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="credential-label">Label</Label>
            <Input
              id="credential-label"
              value={label}
              maxLength={120}
              placeholder="e.g. Postgres admin"
              onChange={(event) => setLabel(event.target.value)}
              autoFocus
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="credential-username">Username</Label>
              <Input
                id="credential-username"
                value={username}
                spellCheck={false}
                autoComplete="off"
                onChange={(event) => setUsername(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="credential-url">URL or host</Label>
              <Input
                id="credential-url"
                value={url}
                spellCheck={false}
                placeholder="https://..."
                onChange={(event) => setUrl(event.target.value)}
              />
            </div>
          </div>
          {loading ? (
            <>
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-24 w-full" />
            </>
          ) : (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="credential-secret">Password, token or key</Label>
                <SecretInput id="credential-secret" value={secret} onChange={setSecret} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="credential-notes">Notes</Label>
                <Textarea
                  id="credential-notes"
                  value={notes}
                  rows={4}
                  placeholder="Recovery codes, connection string, who owns it..."
                  onChange={(event) => setNotes(event.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  The password and notes are stored encrypted.
                </p>
              </div>
            </>
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!canSubmit} onClick={() => void handleSubmit()}>
            {submitting && <Spinner className="h-4 w-4 animate-spin" />}
            {initial ? 'Save' : 'Add credential'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
