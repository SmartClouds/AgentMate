import { HEALTH_ENV } from '@runova/core';
import type { HealthSecretReveal } from '@shared/healthTypes';
import { useState } from 'react';
import { toast } from 'sonner';
import { Copy, Eye, EyeOff, Key } from '@/components/icons';
import { FOOTER_HAIRLINE, Notice, SECTION_HEADING, SECTION_WELL } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/**
 * The one time a target's key (or Basic password) is on screen, right after it was made. The
 * plaintext lives only in the `reveal` prop its owner holds in local state and drops on close;
 * it is never cached, stored or logged, and it stays masked until the user asks to see it.
 */

function copy(text: string, what: string): void {
  void navigator.clipboard.writeText(text).then(
    () => toast.success(`${what} copied`),
    () => toast.error(`Could not copy the ${what.toLowerCase()}`),
  );
}

function CopyRow({
  label,
  value,
  display,
  copyLabel,
  copyWhat,
  trailing,
}: {
  label: string;
  value: string;
  /** What the row shows, when it is not the value itself (a masked key). */
  display?: string;
  copyLabel: string;
  copyWhat: string;
  trailing?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="space-y-1">
      <p className={SECTION_HEADING}>{label}</p>
      <div className={cn(SECTION_WELL, 'flex items-center gap-2 px-3 py-2')}>
        <code className="min-w-0 flex-1 break-all font-mono text-xs leading-relaxed text-foreground">
          {display ?? value}
        </code>
        {trailing}
        <SimpleTooltip label={copyLabel}>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={copyLabel}
            onClick={() => copy(value, copyWhat)}
          >
            <Copy />
          </Button>
        </SimpleTooltip>
      </div>
    </div>
  );
}

/** The header, body and footer of the reveal, to sit inside a dialog's content. */
export function HealthSecretStep({
  reveal,
  onDone,
  doneLabel = 'I saved it',
  secondary,
}: {
  reveal: HealthSecretReveal;
  onDone: () => void;
  doneLabel?: string;
  /** A next step beside Done, like connecting the project. */
  secondary?: React.ReactNode;
}): React.JSX.Element {
  const [shown, setShown] = useState(false);
  const basic = reveal.authMode === 'basic';
  const noun = basic ? 'password' : 'key';
  const Noun = basic ? 'Password' : 'Key';

  return (
    <>
      <DialogHeader className="px-5 py-4 pr-12 shadow-[inset_0_-1px_0_hsl(var(--foreground)/0.08)]">
        <DialogTitle className="flex items-center gap-2 text-base">
          <Key className="h-4 w-4 text-primary" />
          Save this {noun} now
        </DialogTitle>
        <DialogDescription className="text-xs">
          Your endpoint checks it on every request. The server keeps only its SHA-256 hash, in an
          environment variable.
        </DialogDescription>
      </DialogHeader>

      <div className="min-h-0 space-y-4 overflow-y-auto px-5 py-4">
        <Notice tone="warning" size="sm">
          This is the only time the {noun} is shown. It will not be shown again, so copy it
          somewhere safe before you close this. If you lose it, rotate it to get a new one.
        </Notice>

        {basic && reveal.basicUser && (
          <CopyRow
            label={HEALTH_ENV.user}
            value={`${HEALTH_ENV.user}=${reveal.basicUser}`}
            display={reveal.basicUser}
            copyLabel="Copy username variable"
            copyWhat="Username variable"
          />
        )}

        <CopyRow
          label={Noun}
          value={reveal.secret}
          display={shown ? reveal.secret : '•'.repeat(32)}
          copyLabel={`Copy ${noun}`}
          copyWhat={Noun}
          trailing={
            <SimpleTooltip label={shown ? `Hide ${noun}` : `Show ${noun}`}>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={shown ? `Hide ${noun}` : `Show ${noun}`}
                aria-pressed={shown}
                onClick={() => setShown((value) => !value)}
              >
                {shown ? <EyeOff /> : <Eye />}
              </Button>
            </SimpleTooltip>
          }
        />

        <CopyRow label="SHA-256" value={reveal.sha256} copyLabel="Copy SHA-256" copyWhat="Hash" />

        <div className="space-y-1.5">
          <CopyRow
            label="Server variable"
            value={`${reveal.hashEnvVar}=${reveal.sha256}`}
            display={reveal.hashEnvVar}
            copyLabel="Copy variable"
            copyWhat="Variable"
          />
          <p className="text-xs text-muted-foreground">
            Set it on the server where the app runs, not in the repository. Runova keeps the {noun}{' '}
            encrypted and sends it only to this endpoint.
          </p>
        </div>
      </div>

      <DialogFooter className={cn(FOOTER_HAIRLINE, 'px-5 py-3')}>
        {secondary}
        <Button size="sm" onClick={onDone}>
          {doneLabel}
        </Button>
      </DialogFooter>
    </>
  );
}

/** The reveal on its own, for a rotated key. Closing it is the last the user sees of it. */
export function HealthSecretDialog({
  reveal,
  onClose,
}: {
  reveal: HealthSecretReveal | null;
  onClose: () => void;
}): React.JSX.Element {
  return (
    <Dialog open={reveal !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[85vh] w-[min(34rem,calc(100vw-2rem))] max-w-none flex-col gap-0 p-0">
        {reveal && <HealthSecretStep reveal={reveal} onDone={onClose} />}
      </DialogContent>
    </Dialog>
  );
}
