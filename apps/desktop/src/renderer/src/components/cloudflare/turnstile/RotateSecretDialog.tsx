import type { CloudflareZone, TurnstileWidget } from '@shared/cloudflareTypes';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { Clock, RotateCw, Spinner, TriangleAlert } from '@/components/icons';
import { Notice } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cloudflareFailureText } from '@/lib/cloudflare/feedback';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { SecretValue } from './widgetParts';

const CHOICES = [
  {
    now: false,
    title: 'Keep the old secret working for 2 hours',
    text: 'Time to put the new secret on your servers before the old one stops.',
    icon: Clock,
  },
  {
    now: true,
    title: 'Stop the old secret now',
    text: 'For a secret that leaked. Forms fail until your servers have the new one.',
    icon: TriangleAlert,
  },
] as const;

/**
 * A new secret for a widget. The site key does not change, so the page code stays as it is; only
 * the servers that check tokens need the new secret, which is shown at once.
 */
export function RotateSecretDialog({
  open,
  zone,
  widget,
  onOpenChange,
}: {
  open: boolean;
  zone: CloudflareZone;
  widget: TurnstileWidget;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const name = useId();
  const [now, setNow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);

  async function rotate(): Promise<void> {
    setBusy(true);
    setProblem(null);
    try {
      const rotated = await window.runova.cloudflare.rotateTurnstileSecret(
        zone.id,
        widget.sitekey,
        now,
      );
      queryClient.setQueryData(
        queryKeys.cloudflareTurnstileSecret(zone.cloudflareAccountId, widget.sitekey),
        rotated.secret,
      );
      setSecret(rotated.secret);
      toast.success(`Made a new secret for ${widget.name}.`);
    } catch (error) {
      setProblem(cloudflareFailureText(error, queryClient));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Rotate the secret of {widget.name}</DialogTitle>
          <DialogDescription>
            The site key stays the same, so the code in your pages does not change. Only your
            servers need the new secret.
          </DialogDescription>
        </DialogHeader>

        {secret ? (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3 rounded-xl bg-foreground/[0.03] px-3 py-2 ring-1 ring-inset ring-foreground/[0.06]">
              <span className="text-xs text-muted-foreground">New secret</span>
              <SecretValue secret={secret} />
            </div>
            <Notice tone="primary">
              Set TURNSTILE_SECRET to the new secret on every server that checks tokens for this
              widget{now ? ', right away.' : ' within 2 hours.'}
            </Notice>
          </div>
        ) : (
          <div className="space-y-3">
            <div role="radiogroup" aria-label="The old secret" className="grid gap-2">
              {CHOICES.map((choice) => {
                const checked = choice.now === now;
                const Icon = choice.icon;
                return (
                  <label
                    key={String(choice.now)}
                    className={cn(
                      'flex cursor-pointer items-start gap-3 rounded-xl p-3 ring-1 ring-inset transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring',
                      checked
                        ? choice.now
                          ? 'bg-destructive/8 ring-destructive/40'
                          : 'bg-primary/10 ring-primary/40'
                        : 'bg-foreground/[0.03] ring-foreground/[0.08] hover:bg-foreground/[0.06]',
                    )}
                  >
                    <input
                      type="radio"
                      name={name}
                      checked={checked}
                      onChange={() => setNow(choice.now)}
                      className="sr-only"
                    />
                    <span
                      className={cn(
                        'mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg',
                        checked
                          ? choice.now
                            ? 'bg-destructive/15 text-destructive'
                            : 'bg-primary/15 text-primary'
                          : 'bg-foreground/[0.06] text-foreground/70',
                      )}
                    >
                      <Icon className="h-3.5 w-3.5" />
                    </span>
                    <span className="min-w-0 space-y-0.5">
                      <span className="block text-sm font-medium text-foreground">
                        {choice.title}
                        {!choice.now && (
                          <span className="ml-2 rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-semibold text-primary">
                            Recommended
                          </span>
                        )}
                      </span>
                      <span className="block text-xs text-muted-foreground">{choice.text}</span>
                    </span>
                  </label>
                );
              })}
            </div>
            {problem && <Notice tone="destructive">{problem}</Notice>}
          </div>
        )}

        <DialogFooter>
          {secret ? (
            <Button type="button" onClick={() => onOpenChange(false)}>
              Done
            </Button>
          ) : (
            <>
              <Button
                type="button"
                variant="soft"
                onClick={() => onOpenChange(false)}
                disabled={busy}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant={now ? 'destructive' : 'default'}
                disabled={busy}
                onClick={() => void rotate()}
              >
                {busy ? <Spinner className="h-3.5 w-3.5" /> : <RotateCw className="h-3.5 w-3.5" />}
                Rotate secret
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
