import { formatHostKeyFingerprint } from '@shared/sshHostKey';
import { useRef } from 'react';
import { TriangleAlert } from '@/components/icons';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { answerHostKeyPrompt, useHostKeyPromptStore } from '@/stores/hostKeyPromptStore';

function FingerprintRow({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <code className="select-all break-all rounded-md border border-border/60 bg-muted/40 px-2.5 py-1.5 font-mono text-xs text-foreground">
        {value}
      </code>
    </div>
  );
}

/**
 * Asks whether to trust a server whose host key changed. Mount once near the app root; it opens
 * whenever `withHostKeyTrust` needs an answer. "Don't connect" is the default: a changed key is
 * how a machine in the middle looks too.
 */
export function HostKeyChangedDialogHost(): React.JSX.Element {
  const request = useHostKeyPromptStore((state) => state.request);
  const safeChoice = useRef<HTMLButtonElement>(null);

  return (
    <Dialog open={request !== null} onOpenChange={(open) => !open && answerHostKeyPrompt(false)}>
      <DialogContent
        className="max-w-lg"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          safeChoice.current?.focus();
        }}
      >
        {request && (
          <>
            <div className="flex items-start gap-4">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-destructive/15 text-destructive">
                <TriangleAlert className="h-4 w-4" />
              </div>
              <DialogHeader className="min-w-0 pr-6 pt-1">
                <DialogTitle className="break-words leading-snug">
                  {request.nickname}’s identity changed
                </DialogTitle>
                <DialogDescription>
                  {request.host}:{request.port} presented a different host key than the one Runova
                  trusted before. That is expected after you reinstall or replace the server. If you
                  did neither, someone may be intercepting the connection: check the new fingerprint
                  with your hosting provider before you trust it.
                </DialogDescription>
              </DialogHeader>
            </div>
            <div className="flex min-w-0 flex-col gap-3">
              <FingerprintRow
                label="Trusted before"
                value={request.stored ? formatHostKeyFingerprint(request.stored) : 'Not recorded'}
              />
              <FingerprintRow
                label="Presented now"
                value={formatHostKeyFingerprint(request.presented)}
              />
              <p className="text-xs text-muted-foreground">
                On the server,{' '}
                <code className="font-mono">ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</code>{' '}
                prints the fingerprint to compare.
              </p>
            </div>
            <DialogFooter>
              <Button ref={safeChoice} variant="soft" onClick={() => answerHostKeyPrompt(false)}>
                Don't connect
              </Button>
              <Button variant="destructive" onClick={() => answerHostKeyPrompt(true)}>
                Trust the new key
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
