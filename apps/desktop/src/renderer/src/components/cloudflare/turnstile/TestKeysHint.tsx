import {
  TURNSTILE_TEST_SECRETS,
  TURNSTILE_TEST_SITE_KEYS,
  type TurnstileTestKey,
} from '@shared/cloudflare/turnstile';
import { useId, useState } from 'react';
import { ChevronDown, Flask } from '@/components/icons';
import { CopyButton } from '@/components/ui/copy-button';
import { cn } from '@/lib/utils';

function KeyTable({ title, keys }: { title: string; keys: readonly TurnstileTestKey[] }) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-foreground">{title}</p>
      <ul className="divide-y divide-foreground/[0.06] rounded-lg bg-background/60 ring-1 ring-inset ring-foreground/[0.06]">
        {keys.map((key) => (
          <li key={key.value} className="flex items-center gap-2 px-2.5 py-1.5">
            <code className="min-w-0 flex-1 truncate font-mono text-[11px]">{key.value}</code>
            <span className="shrink-0 text-[11px] text-muted-foreground">{key.effect}</span>
            <CopyButton text={key.value} label={`Copy ${key.value}`} alwaysVisible />
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Cloudflare's dummy keys for local work and automated tests, folded away under the code: most
 * people only need them once, and a real key on a test box is easy to leave in by mistake.
 */
export function TestKeysHint(): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return (
    <div className="rounded-xl bg-foreground/[0.03] ring-1 ring-inset ring-foreground/[0.06]">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Flask className="h-3.5 w-3.5" />
        <span className="flex-1">Testing on localhost? Use Cloudflare's test keys</span>
        <ChevronDown className={cn('h-3 w-3 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div id={panelId} className="space-y-3 px-3 pb-3">
          <p className="text-xs text-muted-foreground">
            They never challenge anyone for real, so a form can be tried on your own machine or in
            automated tests. Pair a test site key with a test secret.
          </p>
          <KeyTable title="Site keys" keys={TURNSTILE_TEST_SITE_KEYS} />
          <KeyTable title="Secrets" keys={TURNSTILE_TEST_SECRETS} />
        </div>
      )}
    </div>
  );
}
