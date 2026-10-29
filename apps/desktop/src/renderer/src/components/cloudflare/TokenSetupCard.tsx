import { tokenProblem, tokenTemplateUrl } from '@shared/cloudflare/permissions';
import { cloudflareErrorMessage } from '@shared/cloudflareErrors';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { ExternalLink, Key, Spinner } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SecretInput } from '@/components/ui/secret-input';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { PermissionList } from './PermissionList';

function Step({
  number,
  title,
  className,
  children,
}: {
  number: number;
  title: string;
  className?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <li className={cn('flex gap-3', className)}>
      <span
        aria-hidden="true"
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/12 text-xs font-semibold text-primary ring-1 ring-inset ring-primary/20"
      >
        {number}
      </span>
      <div className="min-w-0 flex-1 space-y-3">
        <p className="text-sm font-medium text-foreground">{title}</p>
        {children}
      </div>
    </li>
  );
}

function setupCopy(
  account: { label: string } | undefined,
  additional: boolean,
): { title: string; description: string } {
  return {
    title: account
      ? `Replace the token for ${account.label}`
      : additional
        ? 'Connect another Cloudflare account'
        : 'Connect Cloudflare',
    description: additional
      ? 'Each Cloudflare account gets its own API token, made on that account. Its domains then show up beside the others. The token stays on this computer, sealed like your server passwords, and is never shown again.'
      : 'Runova manages your domains with an API token that can only do what is listed below. The token stays on this computer, sealed like your server passwords, and is never shown again.',
  };
}

/**
 * Connecting Cloudflare with a token limited to what Runova uses. The token page opens with
 * those permissions chosen; the token pasted back goes to the main process once, to be checked
 * and sealed, and the field is emptied right after.
 *
 * It draws straight onto whatever holds it (a card on the Cloudflare page), with no card of its
 * own. Given room it puts the two steps side by side, so the field to
 * paste into is in view without scrolling; in a narrow place they stack.
 */
export function TokenSetupCard({
  account,
  additional = false,
  onCancel,
  onSaved,
}: {
  /** Replacing this account's token, rather than connecting an account. */
  account?: { id: string; label: string };
  /** Connecting one more account while others are already connected. */
  additional?: boolean;
  /** When an account is already connected: go back to it without saving anything. */
  onCancel?: () => void;
  onSaved?: () => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const headingId = useId();
  const fieldId = useId();
  const nameId = useId();
  const [token, setToken] = useState('');
  const [name, setName] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const pasted = token.trim();
    const local = tokenProblem(pasted);
    if (local) {
      setProblem(local);
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      const typedName = name.trim();
      const status = await window.runova.cloudflare.saveToken({
        token: pasted,
        ...(account ? { accountId: account.id } : {}),
        ...(!account && typedName !== '' ? { label: typedName } : {}),
      });
      setToken('');
      setName('');
      queryClient.setQueryData(queryKeys.cloudflareStatus, status);
      // A different token can see different zones.
      queryClient.removeQueries({ queryKey: queryKeys.cloudflareData });
      toast.success(
        account ? `Replaced the token for ${account.label}.` : 'Cloudflare account connected.',
      );
      onSaved?.();
    } catch (error) {
      setProblem(cloudflareErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  const copy = setupCopy(account, additional);
  // Connecting for the first time, the guide lists every permission. Adding another account or
  // swapping a token is a repeat, so the list folds away and the form stays in view.
  const firstTime = !account && !additional;

  return (
    <section aria-labelledby={headingId} className="@container min-w-0">
      <h3 id={headingId} className="text-base font-semibold leading-tight tracking-tight">
        {copy.title}
      </h3>
      <p className="mt-1.5 max-w-prose text-sm text-muted-foreground">{copy.description}</p>
      <ol className="mt-5 grid gap-6 @3xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] @3xl:gap-0">
        <Step number={1} title="Create a token on Cloudflare" className="@3xl:pr-8">
          <p className="text-sm text-muted-foreground">
            The page opens with these permissions already chosen. Under Zone Resources, include all
            zones or just the domains Runova should manage, then create the token and copy it.
          </p>
          {firstTime ? (
            <PermissionList />
          ) : (
            <details>
              <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                Permissions the token needs
              </summary>
              <div className="mt-2">
                <PermissionList />
              </div>
            </details>
          )}
          <Button
            type="button"
            variant="soft"
            size="sm"
            onClick={() => void window.runova.shell.openExternal(tokenTemplateUrl())}
          >
            <ExternalLink className="h-3.5 w-3.5" /> Open Cloudflare's token page
          </Button>
        </Step>
        <Step
          number={2}
          title="Paste the token here"
          // The divider between the columns is a 1px element, not an inset shadow: a shadow bleeds
          // a faint line along the bottom edge when the window is scaled to a fractional size.
          className="@3xl:relative @3xl:pl-8 @3xl:before:absolute @3xl:before:inset-y-0 @3xl:before:left-0 @3xl:before:w-px @3xl:before:bg-foreground/[0.08] @3xl:before:content-['']"
        >
          <form onSubmit={(event) => void save(event)} className="space-y-3">
            {!account && (
              <div className="space-y-1.5">
                <Label htmlFor={nameId}>Name (optional)</Label>
                <Input
                  id={nameId}
                  value={name}
                  maxLength={60}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="For example Work, or the client's name"
                />
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor={fieldId}>API token</Label>
              <SecretInput
                id={fieldId}
                value={token}
                onChange={(value) => {
                  setToken(value);
                  setProblem(null);
                }}
                placeholder="The token Cloudflare showed you"
              />
            </div>
            {problem && (
              <p role="alert" className="text-sm text-destructive">
                {problem}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-1.5">
              <Button type="submit" size="sm" disabled={busy || token.trim() === ''}>
                {busy ? (
                  <>
                    <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" /> Checking with
                    Cloudflare…
                  </>
                ) : (
                  <>
                    <Key className="h-3.5 w-3.5" /> Save and check
                  </>
                )}
              </Button>
              {onCancel && (
                <Button type="button" variant="soft" size="sm" onClick={onCancel}>
                  {account ? 'Keep the current token' : 'Cancel'}
                </Button>
              )}
            </div>
          </form>
        </Step>
      </ol>
    </section>
  );
}
