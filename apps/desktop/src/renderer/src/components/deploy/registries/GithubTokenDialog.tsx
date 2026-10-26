import { coreErrorMessage } from '@shared/coreErrors';
import { githubNewTokenUrl } from '@shared/deploy/registries';
import type { DeployGithubTokenCheck } from '@shared/deployRegistryTypes';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { Check, ExternalLink, Github, Key, Spinner } from '@/components/icons';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { SecretInput } from '@/components/ui/secret-input';
import { ScopeWarning } from './ScopeWarning';

/**
 * A GitHub token for ghcr.io, made for packages only (E08 T1). GitHub's page opens with just
 * read:packages ticked; the pasted token is checked with GitHub first, which says what it can
 * do, and a broader one is saved only after the warning is accepted. The field empties after.
 */
export function GithubTokenDialog({
  open,
  onClose,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}): React.JSX.Element {
  const fieldId = useId();
  const [token, setToken] = useState('');
  const [check, setCheck] = useState<DeployGithubTokenCheck | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState<'check' | 'save' | null>(null);

  function reset(): void {
    setToken('');
    setCheck(null);
    setAccepted(false);
    setProblem(null);
  }

  async function runCheck(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!token.trim()) return;
    setBusy('check');
    setProblem(null);
    try {
      setCheck(await window.runova.deployRegistry.checkGithubToken(token.trim()));
    } catch (error) {
      setProblem(coreErrorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function save(): Promise<void> {
    setBusy('save');
    setProblem(null);
    try {
      await window.runova.deployRegistry.saveGithubToken({
        token: token.trim(),
        acceptBroaderScopes: accepted,
      });
      toast.success('The GitHub packages token is saved on this computer.');
      reset();
      onSaved();
    } catch (error) {
      setProblem(coreErrorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  const broader = check?.broaderScopes ?? [];
  const canSave = !!check && check.canPull && (broader.length === 0 || accepted) && busy === null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && busy === null) {
          reset();
          onClose();
        }
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Github className="h-4 w-4" /> GitHub packages token
          </DialogTitle>
          <DialogDescription>
            A classic token with just read:packages lets a server pull your images from ghcr.io and
            nothing else. It stays on this computer, sealed like your server passwords, and goes to
            a server only for the length of a deploy.
          </DialogDescription>
        </DialogHeader>
        <ol className="space-y-4 text-sm">
          <li className="space-y-2">
            <p className="font-medium text-foreground">1. Create the token on GitHub</p>
            <p className="text-muted-foreground">
              The page opens with read:packages already ticked. Pick an expiry, create the token and
              copy it.
            </p>
            <Button
              type="button"
              variant="soft"
              size="sm"
              onClick={() => void window.runova.shell.openExternal(githubNewTokenUrl())}
            >
              <ExternalLink className="h-3.5 w-3.5" /> Open GitHub's token page
            </Button>
          </li>
          <li className="space-y-2">
            <p className="font-medium text-foreground">2. Paste it here</p>
            <form className="space-y-2" onSubmit={(event) => void runCheck(event)}>
              <Label htmlFor={fieldId}>Token</Label>
              <SecretInput
                id={fieldId}
                value={token}
                onChange={(value) => {
                  setToken(value);
                  setCheck(null);
                  setAccepted(false);
                  setProblem(null);
                }}
                placeholder="ghp_..."
              />
              <Button
                type="submit"
                size="sm"
                variant="soft"
                disabled={!token.trim() || busy !== null}
              >
                {busy === 'check' ? (
                  <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" />
                ) : (
                  <Key className="h-3.5 w-3.5" />
                )}{' '}
                Check with GitHub
              </Button>
            </form>
          </li>
        </ol>
        {check && !check.problem && (
          <p role="status" className="flex items-center gap-2 text-sm text-foreground">
            <Check className="h-3.5 w-3.5 text-success" aria-hidden="true" />
            Pulls packages{check.username ? ` as ${check.username}` : ''}. Scopes:{' '}
            <span className="font-mono text-xs">{check.scopes.join(', ')}</span>
          </p>
        )}
        {check?.problem && (
          <p role="alert" className="text-sm text-destructive">
            {check.problem}
          </p>
        )}
        {check?.canPull && broader.length > 0 && (
          <ScopeWarning scopes={broader} accepted={accepted} onAccept={setAccepted} />
        )}
        {problem && (
          <p role="alert" className="text-sm text-destructive">
            {problem}
          </p>
        )}
        <DialogFooter>
          <Button
            type="button"
            variant="soft"
            disabled={busy !== null}
            onClick={() => {
              reset();
              onClose();
            }}
          >
            Cancel
          </Button>
          <Button type="button" disabled={!canSave} onClick={() => void save()}>
            {busy === 'save' && <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" />} Save
            token
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
