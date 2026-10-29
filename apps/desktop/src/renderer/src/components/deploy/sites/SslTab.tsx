import { coreErrorMessage } from '@shared/coreErrors';
import type {
  JobInfo,
  SiteInfo,
} from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { DeployServer } from '@shared/deployTypes';
import { useState } from 'react';
import { toast } from 'sonner';
import { CloudflareMark } from '@/components/cloudflare/CloudflareMark';
import { GuidedFix } from '@/components/cloudflare/server/GuidedFix';
import {
  FileText,
  Lock,
  LockOpen,
  RefreshCw,
  Spinner,
  Trash2,
  TriangleAlert,
  Upload,
} from '@/components/icons';
import { Button } from '@/components/ui/button';
import {
  certificateBadge,
  formatDay,
  relative,
  renewalText,
} from '@/lib/deploy/sites/certificates';
import { cn } from '@/lib/utils';
import { confirmDialog } from '@/stores/confirmStore';
import { useFinishedOnce, useFollowedJob } from '@/stores/deployFollowedJobStore';
import { JobLogDialog } from '../overview/JobLogDialog';
import { useProofStepUp } from '../overview/useProofStepUp';
import { IssueDialog, UploadDialog } from './CertificateDialogs';
import { FieldError, Section, TextField, ToggleRow } from './fields';
import { RemoveCertificateDialog } from './RemoveCertificateDialog';
import type { SiteTabProps } from './tabTypes';

/**
 * A site's certificate: its state and countdown, renewal, the last attempt and its log, issuing,
 * uploading and removing one, and the HTTPS options that need a certificate to mean anything.
 */

const TONE = { ok: 'text-success', warn: 'text-warning', bad: 'text-destructive' } as const;

/** The certificate's icon tile, tinted like the page kit's chips. */
const TILE = {
  ok: 'bg-success/12 text-success',
  warn: 'bg-warning/12 text-warning',
  bad: 'bg-destructive/12 text-destructive',
} as const;

export function SslTab({
  server,
  site,
  admin,
  onChanged,
  ...tab
}: SiteTabProps & {
  server: DeployServer;
  site: SiteInfo | undefined;
  admin: boolean;
  onChanged: () => void;
}): React.JSX.Element {
  const { draft, set, error, readOnly } = tab;
  const [issuing, setIssuing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [busy, setBusy] = useState<'renew' | 'remove' | 'log' | 'origin' | null>(null);
  const [originError, setOriginError] = useState<unknown>(null);
  const [job, setJob] = useFollowedJob(server.id, `ssl:${site?.settings.id ?? 'new'}`);
  const jobFinished = useFinishedOnce(server.id, onChanged);
  const [problem, setProblem] = useState<string | null>(null);
  const proof = useProofStepUp(server);
  const now = Date.now();
  const certificate = site?.certificate;
  const badge = certificateBadge(certificate, now);
  const Mark = certificate ? Lock : LockOpen;

  async function attempt(kind: 'renew' | 'log', work: () => Promise<JobInfo>): Promise<void> {
    setBusy(kind);
    setProblem(null);
    try {
      setJob(await work());
    } catch (failure) {
      setProblem(coreErrorMessage(failure));
    } finally {
      setBusy(null);
    }
  }

  async function remove(revoke: boolean): Promise<void> {
    if (!site) return;
    setBusy('remove');
    setProblem(null);
    try {
      const result = await proof.run(
        (stepUp) =>
          window.runova.deployCerts.remove({
            serverId: server.id,
            siteId: site.settings.id,
            revoke,
            reason: revoke ? 'keyCompromise' : 'unspecified',
            ...stepUp,
          }),
        'Removing a certificate',
      );
      if (result) {
        setRemoving(false);
        set({ redirectToHttps: false, hsts: false });
        toast.success(
          result.applied ? 'Certificate removed.' : 'Certificate removed. Apply to finish.',
        );
        onChanged();
      }
    } catch (failure) {
      setProblem(coreErrorMessage(failure));
    } finally {
      setBusy(null);
    }
  }

  /**
   * A Cloudflare Origin CA certificate (E14 T5): the core makes the key, Cloudflare signs it
   * with the account token, the core installs it. Trusted by Cloudflare's edge only.
   */
  async function originCertificate(): Promise<void> {
    if (!site) return;
    const confirmed = await confirmDialog({
      title: 'Install a Cloudflare Origin CA certificate?',
      description:
        "Cloudflare signs a certificate for a key this server makes; the key never leaves it. Only Cloudflare trusts it, so keep the site's records proxied and set SSL/TLS to Full (strict). It replaces the current certificate.",
      confirmLabel: 'Make and install it',
    });
    if (!confirmed) return;
    setBusy('origin');
    setOriginError(null);
    setProblem(null);
    try {
      const result = await window.runova.cloudflareServer.originCertificate({
        serverId: server.id,
        siteId: site.settings.id,
      });
      if (result.problems.length > 0) {
        setProblem(result.problems.join(' '));
      } else {
        toast.success('Origin CA certificate installed and live.');
        onChanged();
      }
    } catch (failure) {
      setOriginError(failure);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-2">
      <Section title="Certificate">
        {!site ? (
          <p className="text-sm text-muted-foreground">
            Save the site first, then issue a certificate for it.
          </p>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2.5">
              <span
                className={cn(
                  'flex h-8 w-8 shrink-0 items-center justify-center rounded-xl',
                  TILE[badge.tone],
                )}
              >
                <Mark className="h-4 w-4" />
              </span>
              <span className={cn('text-sm font-semibold', TONE[badge.tone])}>{badge.label}</span>
              <span className="text-sm text-muted-foreground">{badge.description}</span>
            </div>
            {certificate && (
              <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
                <dt className="text-muted-foreground">Covers</dt>
                <dd className="font-mono text-xs leading-5">{certificate.domains.join(', ')}</dd>
                <dt className="text-muted-foreground">Issued by</dt>
                <dd>
                  {certificate.issuer}
                  {certificate.source === 'uploaded'
                    ? ' (uploaded)'
                    : certificate.source === 'cloudflareOrigin'
                      ? ' (Cloudflare Origin CA, trusted by Cloudflare only)'
                      : ''}
                </dd>
                <dt className="text-muted-foreground">Valid</dt>
                <dd>
                  {formatDay(certificate.notBeforeUnixMs)} to{' '}
                  {formatDay(certificate.notAfterUnixMs)}
                </dd>
                <dt className="text-muted-foreground">Renewal</dt>
                <dd>{renewalText(certificate, now)}</dd>
                {certificate.lastAttemptAtUnixMs && (
                  <>
                    <dt className="text-muted-foreground">Last attempt</dt>
                    <dd className="flex flex-wrap items-center gap-2">
                      {relative(certificate.lastAttemptAtUnixMs, now)}
                      {certificate.lastError ? (
                        <span className="flex items-center gap-1 text-destructive">
                          <TriangleAlert className="h-3 w-3" /> {certificate.lastError}
                        </span>
                      ) : (
                        <span className="text-success">succeeded</span>
                      )}
                      {certificate.lastJobId && (
                        <Button
                          type="button"
                          variant="link"
                          size="sm"
                          className="h-auto p-0"
                          disabled={busy === 'log'}
                          onClick={() =>
                            void attempt('log', () =>
                              window.runova.deployJobs.get(
                                server.id,
                                certificate.lastJobId as string,
                              ),
                            )
                          }
                        >
                          <FileText className="h-3 w-3" /> Show its log
                        </Button>
                      )}
                    </dd>
                  </>
                )}
              </dl>
            )}
            {admin && (
              <div className="flex flex-wrap gap-2">
                <Button type="button" size="sm" onClick={() => setIssuing(true)}>
                  <Lock className="h-3.5 w-3.5" />
                  {certificate ? 'Issue a new certificate' : 'Issue a certificate'}
                </Button>
                {certificate?.source === 'acme' && (
                  <Button
                    type="button"
                    size="sm"
                    variant="soft"
                    disabled={busy === 'renew'}
                    onClick={() =>
                      void attempt('renew', () =>
                        window.runova.deployCerts.renew(server.id, site.settings.id),
                      )
                    }
                  >
                    {busy === 'renew' ? (
                      <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" />
                    ) : (
                      <RefreshCw className="h-3.5 w-3.5" />
                    )}
                    Renew now
                  </Button>
                )}
                <Button type="button" size="sm" variant="soft" onClick={() => setUploading(true)}>
                  <Upload className="h-3.5 w-3.5" /> Upload a certificate
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="soft"
                  disabled={busy === 'origin'}
                  onClick={() => void originCertificate()}
                >
                  {busy === 'origin' ? (
                    <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" />
                  ) : (
                    <CloudflareMark className="h-3.5 w-3.5" />
                  )}
                  Cloudflare Origin CA
                </Button>
                {certificate && (
                  <Button
                    type="button"
                    size="sm"
                    variant="danger"
                    onClick={() => setRemoving(true)}
                  >
                    <Trash2 className="h-3.5 w-3.5" /> Remove
                  </Button>
                )}
              </div>
            )}
            <FieldError message={problem ?? undefined} />
            <GuidedFix error={originError} />
          </div>
        )}
      </Section>
      <Section title="HTTPS" description="Takes effect once the site has a certificate.">
        <ToggleRow
          label="Force HTTPS"
          description="Sends every plain HTTP visitor to the HTTPS address."
          checked={draft.redirectToHttps}
          onChange={(redirectToHttps) => set({ redirectToHttps })}
          disabled={readOnly || !certificate}
          disabledReason={certificate ? undefined : 'Needs a certificate first.'}
        />
        <ToggleRow
          label="HSTS"
          description="Tells browsers to use HTTPS only, for as long as the max-age says. Hard to take back."
          checked={draft.hsts}
          onChange={(hsts) => set({ hsts })}
          disabled={readOnly || !certificate}
          disabledReason={certificate ? undefined : 'Needs a certificate first.'}
        />
        {draft.hsts && (
          <div className="space-y-2 pl-1">
            <TextField
              label="Max-age"
              value={draft.hstsMaxAge}
              onChange={(hstsMaxAge) => set({ hstsMaxAge })}
              suffix="seconds"
              inputMode="numeric"
              disabled={readOnly || !certificate}
            />
            <ToggleRow
              label="Include subdomains"
              checked={draft.hstsSubdomains}
              onChange={(hstsSubdomains) => set({ hstsSubdomains })}
              disabled={readOnly || !certificate}
            />
            <ToggleRow
              label="Preload"
              description="Asks to be built into browsers. Needs subdomains included and a year or more."
              checked={draft.hstsPreload}
              onChange={(hstsPreload) => set({ hstsPreload })}
              disabled={readOnly || !certificate}
            />
          </div>
        )}
        <FieldError message={error('hsts')} />
        <ToggleRow
          label="HTTP/2"
          description="Faster page loads over HTTPS."
          checked={draft.http2}
          onChange={(http2) => set({ http2 })}
          disabled={readOnly}
        />
      </Section>
      {site && (
        <>
          <IssueDialog
            serverId={server.id}
            site={site}
            open={issuing}
            onClose={() => setIssuing(false)}
            onStarted={(started) => {
              setIssuing(false);
              setJob(started);
            }}
          />
          <UploadDialog
            serverId={server.id}
            site={site}
            open={uploading}
            onClose={() => setUploading(false)}
            onUploaded={() => {
              setUploading(false);
              toast.success('Certificate uploaded and live.');
              onChanged();
            }}
          />
          <RemoveCertificateDialog
            certificate={removing && certificate ? certificate : null}
            domain={site.settings.domains[0] ?? site.settings.id}
            busy={busy === 'remove'}
            onCancel={() => setRemoving(false)}
            onConfirm={(revoke) => void remove(revoke)}
          />
        </>
      )}
      <JobLogDialog
        serverId={server.id}
        job={job}
        canCancel={admin}
        onClose={() => setJob(null)}
        onFinished={jobFinished}
      />
      {proof.dialog}
    </div>
  );
}
