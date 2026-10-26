import { dns01Coverage } from '@shared/cloudflare/dns01';
import { coreErrorMessage } from '@shared/coreErrors';
import type {
  CertificateInfo,
  JobInfo,
  SiteInfo,
} from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useId, useState } from 'react';
import { Spinner } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { queryKeys } from '@/lib/queryKeys';
import { FieldError, TextField, ToggleRow } from './fields';

/** Ordering a certificate from Let's Encrypt, and uploading one made elsewhere. */

export function IssueDialog({
  serverId,
  site,
  open,
  onClose,
  onStarted,
}: {
  serverId: string;
  site: SiteInfo;
  open: boolean;
  onClose: () => void;
  onStarted: (job: JobInfo) => void;
}): React.JSX.Element {
  const terms = useId();
  const [accepted, setAccepted] = useState(false);
  const [staging, setStaging] = useState(false);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [dns01, setDns01] = useState(false);
  const tokens = useQuery({
    queryKey: queryKeys.cloudflareDnsTokens(serverId),
    queryFn: () => window.runova.cloudflareServer.dnsTokens(serverId),
    enabled: open,
    retry: false,
  });
  const coverage = dns01Coverage(
    site.settings.domains,
    (tokens.data ?? []).map((token) => token.zone),
  );
  const useDns01 = coverage.covered && (dns01 || coverage.wildcard);

  useEffect(() => {
    if (!open) return;
    setAccepted(false);
    setStaging(false);
    setProblem(null);
    setDns01(false);
  }, [open]);

  async function issue(): Promise<void> {
    setBusy(true);
    setProblem(null);
    try {
      const job = await window.runova.deployCerts.issue({
        serverId,
        siteId: site.settings.id,
        acceptTermsOfService: accepted,
        staging,
        ...(useDns01 ? { preferDns01: true } : {}),
        ...(email.trim() ? { contactEmail: email.trim() } : {}),
      });
      onStarted(job);
    } catch (error) {
      setProblem(coreErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !busy && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Issue a certificate</DialogTitle>
          <DialogDescription>
            Let's Encrypt checks that {site.settings.domains.join(', ')} reach this server over port
            80, then issues one certificate for all of them. It renews by itself.
          </DialogDescription>
        </DialogHeader>
        <TextField
          label="Contact email (optional)"
          value={email}
          onChange={setEmail}
          hint="Let's Encrypt writes here only about problems with your certificates."
          placeholder="ops@example.com"
          inputMode="email"
        />
        <ToggleRow
          label="Validate over DNS (Cloudflare DNS-01)"
          description={
            coverage.wildcard
              ? "A wildcard is always validated over DNS, with this server's Cloudflare DNS token."
              : 'Works behind the Cloudflare proxy and with port 80 closed.'
          }
          checked={useDns01}
          onChange={setDns01}
          disabled={!coverage.covered || coverage.wildcard}
          disabledReason={
            coverage.covered
              ? undefined
              : `Needs a Cloudflare DNS token on this server for ${coverage.missing.join(', ') || 'the site'}. Send one from Cloudflare: domains and DNS, on the Servers tab.`
          }
        />
        <ToggleRow
          label="Use the staging CA"
          description="A test run: generous limits, but browsers will not trust the certificate."
          checked={staging}
          onChange={setStaging}
        />
        <div className="flex items-start gap-2">
          <Checkbox
            id={terms}
            checked={accepted}
            onCheckedChange={(checked) => setAccepted(checked === true)}
          />
          <Label htmlFor={terms} className="text-sm font-normal leading-snug">
            I accept the Let's Encrypt Subscriber Agreement (letsencrypt.org/repository).
          </Label>
        </div>
        <FieldError message={problem ?? undefined} />
        <DialogFooter>
          <Button type="button" variant="soft" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" disabled={busy || !accepted} onClick={() => void issue()}>
            {busy && <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" />}
            Issue the certificate
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function UploadDialog({
  serverId,
  site,
  open,
  onClose,
  onUploaded,
}: {
  serverId: string;
  site: SiteInfo;
  open: boolean;
  onClose: () => void;
  onUploaded: (certificate: CertificateInfo) => void;
}): React.JSX.Element {
  const certificateId = useId();
  const keyId = useId();
  const [certificatePem, setCertificatePem] = useState('');
  const [privateKeyPem, setPrivateKeyPem] = useState('');
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setCertificatePem('');
    setPrivateKeyPem('');
    setProblems([]);
  }, [open]);

  async function upload(): Promise<void> {
    setBusy(true);
    setProblems([]);
    try {
      const result = await window.runova.deployCerts.upload({
        serverId,
        siteId: site.settings.id,
        certificatePem,
        privateKeyPem,
      });
      const applyProblems =
        result.apply && !result.apply.applied
          ? [
              result.apply.error ?? 'nginx did not take the certificate.',
              ...result.apply.problems.map((p) => p.message),
            ]
          : [];
      if (result.problems.length > 0 || applyProblems.length > 0 || !result.certificate) {
        setProblems([...result.problems, ...applyProblems]);
        return;
      }
      onUploaded(result.certificate);
    } catch (error) {
      setProblems([coreErrorMessage(error)]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !busy && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Upload a certificate</DialogTitle>
          <DialogDescription>
            Paste the certificate with its chain, and its private key, both in PEM form. The key
            goes straight to the server and is not kept on this computer.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor={certificateId}>Certificate and chain</Label>
          <Textarea
            id={certificateId}
            value={certificatePem}
            onChange={(event) => setCertificatePem(event.target.value)}
            placeholder="-----BEGIN CERTIFICATE-----"
            rows={6}
            spellCheck={false}
            className="font-mono text-xs"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={keyId}>Private key</Label>
          <Textarea
            id={keyId}
            value={privateKeyPem}
            onChange={(event) => setPrivateKeyPem(event.target.value)}
            placeholder="-----BEGIN PRIVATE KEY-----"
            rows={5}
            spellCheck={false}
            className="font-mono text-xs"
          />
        </div>
        {problems.map((problem) => (
          <FieldError key={problem} message={problem} />
        ))}
        <DialogFooter>
          <Button type="button" variant="soft" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={busy || !certificatePem.trim() || !privateKeyPem.trim()}
            onClick={() => void upload()}
          >
            {busy && <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" />}
            Upload and apply
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
