import type {
  RdpCertificateCheck,
  RdpCertificateDetails,
  RdpCertificateInfo,
  RdpSavedServer,
} from '@shared/apiTypes';
import { useState } from 'react';
import { toast } from 'sonner';
import { RefreshCw, Spinner, Trash2 } from '@/components/icons';
import { Notice } from '@/components/pageKit';
import { RdpFailureBody } from '@/components/rdp/RdpFailureCard';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { describeProxyFailure, type RdpFailure } from '@/lib/rdp/failure';
import { confirmDialog } from '@/stores/confirmStore';

type CheckState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'done'; check: RdpCertificateCheck }
  | { kind: 'failed'; failure: RdpFailure };

function CertificateFacts({
  details,
  fingerprint,
}: {
  details?: RdpCertificateDetails;
  fingerprint: string;
}): React.JSX.Element {
  return (
    <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1.5 text-xs">
      {details && (
        <>
          <dt className="text-muted-foreground">Issued to</dt>
          <dd className="break-all">{details.subject || 'Unknown'}</dd>
          <dt className="text-muted-foreground">Issued by</dt>
          <dd className="break-all">{details.issuer || 'Unknown'}</dd>
          <dt className="text-muted-foreground">Valid until</dt>
          <dd>{details.validTo}</dd>
        </>
      )}
      <dt className="text-muted-foreground">Fingerprint</dt>
      <dd className="select-text break-all font-mono">{fingerprint}</dd>
    </dl>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className="flex flex-col gap-2.5">
      <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
  );
}

export interface RdpCertificateDialogProps {
  server: RdpSavedServer | null;
  onOpenChange: (open: boolean) => void;
  /** The saved certificate changed, so the server list should be read again. */
  onChanged: () => void;
}

/**
 * The Windows client's "view the certificate, and connect anyway" made into a place of its own:
 * see the certificate saved for a server, fetch what the server presents now, and trust it or
 * forget the saved one. A server reinstalled with a new certificate is sorted out here without
 * having to connect first. Mount it with `key={server.id}` so each server starts from a clean slate.
 */
export function RdpCertificateDialog({
  server,
  onOpenChange,
  onChanged,
}: RdpCertificateDialogProps): React.JSX.Element {
  const [state, setState] = useState<CheckState>({ kind: 'idle' });
  const [saving, setSaving] = useState(false);

  async function fetchCertificate(): Promise<void> {
    if (!server) return;
    setState({ kind: 'checking' });
    try {
      const result = await window.runova.rdp.checkCertificate(server.id);
      setState(
        result.ok
          ? { kind: 'done', check: result.check }
          : { kind: 'failed', failure: describeProxyFailure(result.failure) },
      );
      if (result.ok) onChanged();
    } catch {
      setState({
        kind: 'failed',
        failure: describeProxyFailure({
          code: 'other',
          message: "Runova couldn't read the certificate.",
        }),
      });
    }
  }

  async function trust(certificate: RdpCertificateInfo): Promise<void> {
    if (!server) return;
    setSaving(true);
    try {
      await window.runova.rdp.trustCertificate(server.id, certificate.fingerprint);
      toast.success('Certificate saved');
      setState({ kind: 'idle' });
      onChanged();
    } catch {
      toast.error('That certificate is out of date. Get it from the server again.');
      setState({ kind: 'idle' });
    } finally {
      setSaving(false);
    }
  }

  async function forget(): Promise<void> {
    if (!server) return;
    const confirmed = await confirmDialog({
      title: `Forget the saved certificate for "${server.nickname}"?`,
      description:
        'The next time you connect, Runova accepts the certificate the server shows and saves it, without asking. Only do this if you know the server was reinstalled or its certificate was replaced.',
      confirmLabel: 'Forget certificate',
      variant: 'destructive',
    });
    if (!confirmed) return;
    setSaving(true);
    try {
      await window.runova.rdp.forgetCertificate(server.id);
      toast.success('Saved certificate forgotten');
      setState({ kind: 'idle' });
      onChanged();
    } catch {
      toast.error("Couldn't forget the saved certificate.");
    } finally {
      setSaving(false);
    }
  }

  const checking = state.kind === 'checking';
  const savedFingerprint = server?.certFingerprint;

  return (
    <Dialog open={server !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Certificate for {server?.nickname}</DialogTitle>
          <DialogDescription>
            Runova remembers the certificate a server shows the first time you connect, and asks
            before connecting if it ever changes.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-5">
          <Section title="Saved certificate">
            {savedFingerprint ? (
              <CertificateFacts details={server?.certDetails} fingerprint={savedFingerprint} />
            ) : (
              <Notice tone="neutral" size="sm">
                Nothing is saved yet. Runova saves the certificate on the first connection, or you
                can get it from the server now.
              </Notice>
            )}
          </Section>

          <Section title="Certificate on the server now">
            {state.kind === 'idle' && (
              <p className="text-xs leading-relaxed text-muted-foreground">
                Get the certificate the server presents today and compare it with the saved one.
                Nothing is signed in or changed on the server.
              </p>
            )}
            {checking && (
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <Spinner className="h-3.5 w-3.5 animate-spin" /> Connecting to {server?.host}…
              </p>
            )}
            {state.kind === 'failed' && (
              <Notice tone="destructive" role="alert">
                <RdpFailureBody failure={state.failure} align="start" />
              </Notice>
            )}
            {state.kind === 'done' && (
              <CheckResult check={state.check} saving={saving} onTrust={trust} />
            )}
          </Section>
        </div>

        <DialogFooter className="items-center sm:justify-between">
          <Button
            variant="danger"
            disabled={!savedFingerprint || saving || checking}
            onClick={() => void forget()}
          >
            <Trash2 className="h-3.5 w-3.5" /> Forget saved certificate
          </Button>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Close
            </Button>
            <Button
              variant="soft"
              disabled={checking || saving}
              onClick={() => void fetchCertificate()}
            >
              {checking ? (
                <Spinner className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              Get certificate from server
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CheckResult({
  check,
  saving,
  onTrust,
}: {
  check: RdpCertificateCheck;
  saving: boolean;
  onTrust: (certificate: RdpCertificateInfo) => Promise<void>;
}): React.JSX.Element {
  const { certificate, status } = check;
  if (status === 'same') {
    return (
      <Notice tone="success" role="status">
        The server still presents the saved certificate.
      </Notice>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <Notice tone={status === 'changed' ? 'warning' : 'primary'} role="status">
        {status === 'changed'
          ? "This is not the certificate Runova saved. That's expected after the server was reinstalled or its certificate was renewed. If neither happened, someone could be intercepting the connection."
          : 'This is the certificate the server presents. Save it to be warned if it ever changes.'}
      </Notice>
      <CertificateFacts details={certificate} fingerprint={certificate.fingerprint} />
      <Button className="self-start" disabled={saving} onClick={() => void onTrust(certificate)}>
        {status === 'changed' ? 'Trust this certificate' : 'Save this certificate'}
      </Button>
    </div>
  );
}
