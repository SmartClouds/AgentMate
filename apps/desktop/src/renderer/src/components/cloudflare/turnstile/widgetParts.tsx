import type { CloudflareZone, TurnstileClearance, TurnstileMode } from '@shared/cloudflareTypes';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Eye, EyeOff, Key, Spinner } from '@/components/icons';
import { Chip, type ChipTone } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { useCloudflareError } from '@/lib/cloudflare/feedback';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';

/** Small pieces the Turnstile tab's list and dialogs share. */

export const MODE_NAMES: Record<TurnstileMode, string> = {
  managed: 'Managed',
  'non-interactive': 'Non-interactive',
  invisible: 'Invisible',
};

const MODE_TONES: Record<TurnstileMode, ChipTone> = {
  managed: 'primary',
  'non-interactive': 'success',
  invisible: 'neutral',
};

export const CLEARANCE_NAMES: Record<TurnstileClearance, string> = {
  no_clearance: 'Off',
  jschallenge: 'Non-interactive',
  managed: 'Managed',
  interactive: 'Interactive',
};

export function ModeChip({ mode }: { mode: TurnstileMode }): React.JSX.Element {
  return <Chip tone={MODE_TONES[mode]}>{MODE_NAMES[mode]}</Chip>;
}

const MASK = '••••••••••••••••';

/** A secret on show or masked, with a toggle and a copy button. */
export function SecretValue({ secret }: { secret: string }): React.JSX.Element {
  const [shown, setShown] = useState(false);
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      <code className={cn('truncate font-mono text-xs', !shown && 'tracking-widest')}>
        {shown ? secret : MASK}
      </code>
      <SimpleTooltip label={shown ? 'Hide secret' : 'Show secret'}>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={shown ? 'Hide secret' : 'Show secret'}
          onClick={() => setShown((value) => !value)}
        >
          {shown ? <EyeOff /> : <Eye />}
        </Button>
      </SimpleTooltip>
      <CopyButton text={secret} label="Copy secret" alwaysVisible />
    </span>
  );
}

/**
 * A widget's secret, read from Cloudflare only when asked (or at once, right after the widget is
 * made, when the dialog has already put it in the cache). It stays masked until shown.
 */
export function TurnstileSecret({
  zone,
  sitekey,
  autoFetch = false,
}: {
  zone: CloudflareZone;
  sitekey: string;
  autoFetch?: boolean;
}): React.JSX.Element {
  const [asked, setAsked] = useState(autoFetch);
  const secret = useQuery({
    queryKey: queryKeys.cloudflareTurnstileSecret(zone.cloudflareAccountId, sitekey),
    queryFn: () => window.runova.cloudflare.turnstileSecret(zone.id, sitekey),
    enabled: asked,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const problem = useCloudflareError(secret.error);

  if (!asked && secret.data === undefined) {
    return (
      <Button type="button" variant="soft" size="sm" onClick={() => setAsked(true)}>
        <Key className="h-3.5 w-3.5" /> Get secret
      </Button>
    );
  }
  if (secret.isError) {
    return (
      <span className="inline-flex flex-wrap items-center gap-2 text-xs text-destructive">
        {problem}
        <Button type="button" variant="link" size="xs" onClick={() => void secret.refetch()}>
          Try again
        </Button>
      </span>
    );
  }
  if (secret.data === undefined) {
    return (
      <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
        <Spinner className="h-3.5 w-3.5" /> Getting the secret from Cloudflare
      </span>
    );
  }
  return <SecretValue secret={secret.data} />;
}
