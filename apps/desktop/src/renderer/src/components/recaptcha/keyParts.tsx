import type {
  RecaptchaChallenge,
  RecaptchaKeyRef,
  RecaptchaKeyType,
} from '@shared/deployRecaptchaTypes';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { Check, Copy, Eye, EyeOff, Key, Spinner } from '@/components/icons';
import { Chip, type ChipTone } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { queryKeys } from '@/lib/queryKeys';
import { useRecaptchaError } from '@/lib/recaptcha/feedback';
import { cn } from '@/lib/utils';

/** Small pieces the reCAPTCHA page's key list and dialog share. */

export const TYPE_NAMES: Record<RecaptchaKeyType, string> = {
  score: 'Score',
  checkbox: 'Checkbox',
  invisible: 'Invisible',
};

const TYPE_TONES: Record<RecaptchaKeyType, ChipTone> = {
  score: 'primary',
  checkbox: 'success',
  invisible: 'neutral',
};

export const CHALLENGE_NAMES: Record<RecaptchaChallenge, string> = {
  usability: 'Easier',
  balance: 'Balanced',
  security: 'Harder',
};

export function TypeChip({ type }: { type: RecaptchaKeyType }): React.JSX.Element {
  return <Chip tone={TYPE_TONES[type]}>{TYPE_NAMES[type]}</Chip>;
}

/** Copies `text`, and shows a tick for a moment so the click is seen to have worked. */
export function CopyButton({
  text,
  label,
  className,
}: {
  text: string;
  label: string;
  className?: string;
}): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error('Could not copy. Select the text and copy it yourself.');
    }
  }
  return (
    <SimpleTooltip label={copied ? 'Copied' : label}>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={label}
        className={className}
        onClick={() => void copy()}
      >
        {copied ? <Check className="text-success" /> : <Copy />}
      </Button>
    </SimpleTooltip>
  );
}

const MASK = '••••••••••••••••';

/**
 * A key's secret, read from Google only when asked (or at once, right after the key is made).
 * It stays masked until shown, and can be copied either way.
 */
export function SecretReveal({
  keyRef,
  autoFetch = false,
}: {
  keyRef: RecaptchaKeyRef;
  autoFetch?: boolean;
}): React.JSX.Element {
  const [asked, setAsked] = useState(autoFetch);
  const [shown, setShown] = useState(false);
  const secret = useQuery({
    queryKey: queryKeys.recaptchaSecret(keyRef.accountId, keyRef.projectId, keyRef.keyId),
    queryFn: () => window.runova.deployRecaptcha.secret(keyRef),
    enabled: asked,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const problem = useRecaptchaError(secret.error);

  if (!asked) {
    return (
      <Button type="button" variant="soft" size="sm" onClick={() => setAsked(true)}>
        <Key className="h-3.5 w-3.5" /> Get secret
      </Button>
    );
  }
  if (secret.isPending) {
    return (
      <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
        <Spinner className="h-3.5 w-3.5" /> Getting the secret from Google
      </span>
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
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      <code className={cn('truncate font-mono text-xs', !shown && 'tracking-widest')}>
        {shown ? secret.data : MASK}
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
      <CopyButton text={secret.data} label="Copy secret" />
    </span>
  );
}
