import type {
  FilesCertificateInfo,
  FilesTestResult,
  FilesTestStep,
  FilesTestStepResult,
} from '@shared/deployFilesTypes';
import { formatHostKeyFingerprint } from '@shared/sshHostKey';
import { CircleCheck, CircleX, Key, Lock, Minus, TriangleAlert } from '@/components/icons';
import { Notice, SECTION_WELL } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { filesProblemText } from './messages';

/**
 * What Test connection found, one plain line per step (E23). A failure says why, and the ones
 * with a fix offer it right there: trust a host key seen for the first time or changed, use the
 * name a certificate was made out to, or trust a certificate this computer doesn't.
 */

type StepStatus = FilesTestStepResult['status'];

export const TEST_STEPS: readonly FilesTestStep[] = [
  'reach',
  'login',
  'folder',
  'write',
  'replace',
  'time',
  'cleanup',
];

/** What a step is, before it ran or when it was skipped. */
const STEP_TODO: Record<FilesTestStep, string> = {
  reach: 'Reach the server',
  login: 'Sign in',
  folder: 'Find the folder',
  write: 'Write a test file',
  replace: 'Replace a file in one step',
  time: 'Check how changes on the server can be seen',
  cleanup: 'Remove the test file',
};

const STEP_OK: Record<FilesTestStep, string> = {
  reach: 'Reached the server',
  login: 'Signed in',
  folder: 'Found the folder',
  write: 'Can write files',
  replace: 'Replaces files in one step',
  time: 'Can see when files change on the server',
  cleanup: 'Removed the test file',
};

const STEP_WARNING: Partial<Record<FilesTestStep, string>> = {
  replace: 'Replaces files in two steps',
  time: 'Can only compare file sizes on the server',
  cleanup: "Couldn't remove the test file",
};

const STEP_FAILED: Record<FilesTestStep, string> = {
  reach: "Couldn't reach the server",
  login: "Couldn't sign in",
  folder: "Couldn't find the folder",
  write: "Can't write files there",
  replace: "Couldn't replace a file",
  time: "Couldn't read file times",
  cleanup: "Couldn't remove the test file",
};

export function stepLabel(step: FilesTestStep, status: StepStatus): string {
  if (status === 'ok') return STEP_OK[step];
  if (status === 'warning') return STEP_WARNING[step] ?? STEP_OK[step];
  if (status === 'failed') return STEP_FAILED[step];
  return STEP_TODO[step];
}

const STATUS_ICON: Record<
  StepStatus,
  { Icon: React.ComponentType<{ className?: string }>; tone: string; word: string }
> = {
  ok: { Icon: CircleCheck, tone: 'text-success', word: 'Passed' },
  warning: { Icon: TriangleAlert, tone: 'text-warning', word: 'Warning' },
  failed: { Icon: CircleX, tone: 'text-destructive', word: 'Failed' },
  skipped: { Icon: Minus, tone: 'text-muted-foreground/50', word: 'Skipped' },
};

/** The certificate's SHA-256 the way browsers and `openssl x509 -fingerprint` print it. */
function formatCertificateFingerprint(hex: string): string {
  return (hex.toUpperCase().match(/.{1,2}/g) ?? []).join(':');
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

export interface TestConnectionChecklistProps {
  result: FilesTestResult | null;
  testing: boolean;
  /** The test call itself failed (another test running, details main refused). */
  failure?: string | null;
  /** The host the form names, for the certificate name check. */
  host: string;
  onTrustHostKey: (fingerprint: string) => void;
  onUseServername: (name: string) => void;
  onTrustCertificate: (fingerprint256: string) => void;
}

export function TestConnectionChecklist({
  result,
  testing,
  failure,
  host,
  onTrustHostKey,
  onUseServername,
  onTrustCertificate,
}: TestConnectionChecklistProps): React.JSX.Element | null {
  if (testing) {
    return (
      <div className="space-y-2">
        <span role="status" className="sr-only">
          Testing the connection…
        </span>
        <ul
          aria-label="Connection test"
          aria-busy="true"
          className={cn(SECTION_WELL, 'space-y-2.5')}
        >
          {TEST_STEPS.map((step, index) => (
            <li key={step} className="flex items-center gap-2.5">
              <Skeleton className="h-4 w-4 shrink-0 rounded-full" />
              <Skeleton
                className="h-3.5 rounded-full"
                style={{ width: `${[52, 34, 44, 38, 58, 66, 46][index]}%` }}
              />
            </li>
          ))}
        </ul>
      </div>
    );
  }

  if (!result) {
    return failure ? <ProblemLine>{failure}</ProblemLine> : null;
  }

  const steps = TEST_STEPS.flatMap((step) => result.steps.find((one) => one.step === step) ?? []);
  const warnings = steps.filter((one) => one.status === 'warning').length;
  const failedStep = steps.find((one) => one.status === 'failed') ?? null;
  // A fix card explains a host key or certificate on its own, better than the generic words.
  const hasFix = result.hostKey !== null || result.certificate !== null;
  const problem = result.ok
    ? null
    : result.error
      ? filesProblemText(result.error.code, result.error.message)
      : (failedStep?.message ?? 'The test did not pass.');

  return (
    <div className="space-y-3">
      {failure && <ProblemLine>{failure}</ProblemLine>}
      <ul aria-label="Connection test" className={cn(SECTION_WELL, 'space-y-2')}>
        {steps.map((one) => {
          const { Icon, tone, word } = STATUS_ICON[one.status];
          const showMessage =
            one.message &&
            (one.status === 'warning' || one.status === 'failed') &&
            one.message !== problem;
          return (
            <li key={one.step} className="flex items-start gap-2.5 text-sm">
              <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', tone)} />
              <div className="min-w-0 flex-1">
                <p
                  className={cn(
                    'leading-5',
                    one.status === 'skipped' ? 'text-muted-foreground' : 'text-foreground',
                  )}
                >
                  {stepLabel(one.step, one.status)}
                  {one.status !== 'skipped' && <span className="sr-only">: {word}</span>}
                </p>
                {showMessage && (
                  <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                    {one.message}
                  </p>
                )}
              </div>
              {one.status === 'skipped' && (
                <span className="shrink-0 text-[11px] text-muted-foreground/70">Skipped</span>
              )}
            </li>
          );
        })}
      </ul>

      {result.ok ? (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <CircleCheck className="h-3.5 w-3.5 text-success" />
          {warnings === 0
            ? 'Everything works. The site is ready to save.'
            : `Works, with ${plural(warnings, 'thing')} to know. You can save the site.`}
        </p>
      ) : (
        !hasFix && problem && <ProblemLine>{problem}</ProblemLine>
      )}

      {result.hostKey && (
        <HostKeyFix
          presented={result.hostKey.presented}
          stored={result.hostKey.stored}
          onTrust={() => onTrustHostKey(result.hostKey?.presented ?? '')}
        />
      )}
      {result.certificate && (
        <CertificateFix
          certificate={result.certificate}
          host={host}
          onUseServername={onUseServername}
          onTrust={onTrustCertificate}
        />
      )}
    </div>
  );
}

function ProblemLine({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <Notice role="alert" tone="destructive" size="sm">
      <span className="whitespace-pre-wrap break-words">{children}</span>
    </Notice>
  );
}

function Fingerprint({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-[11px] font-medium text-muted-foreground">{label}</span>
      <code className="select-all break-all rounded-lg bg-foreground/[0.05] px-2.5 py-1.5 font-mono text-xs text-foreground">
        {value}
      </code>
    </div>
  );
}

function HostKeyFix({
  presented,
  stored,
  onTrust,
}: {
  presented: string;
  stored: string | null;
  onTrust: () => void;
}): React.JSX.Element {
  const changed = stored !== null;
  return (
    <Notice tone={changed ? 'destructive' : 'warning'} icon={Key} className="gap-y-3">
      <div className="space-y-2.5">
        <div className="space-y-1">
          <p className="font-medium">
            {changed ? "The server's host key changed" : 'First connection to this server'}
          </p>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {changed
              ? "That's expected after the server was rebuilt or moved to a new machine. If neither happened, someone may be listening in between: don't trust it, and ask your host."
              : 'Compare this fingerprint with the one your host shows for the server (in its control panel, or with ssh-keygen -lf on the server). If they match, trust it, and Runova will refuse a server that ever shows a different one.'}
          </p>
        </div>
        {changed && stored && (
          <Fingerprint label="Trusted before" value={formatHostKeyFingerprint(stored)} />
        )}
        <Fingerprint
          label={changed ? 'Presented now' : 'Fingerprint'}
          value={formatHostKeyFingerprint(presented)}
        />
        <Button type="button" size="sm" variant={changed ? 'danger' : 'soft'} onClick={onTrust}>
          Trust this key
        </Button>
      </div>
    </Notice>
  );
}

const CERTIFICATE_REASON: Record<
  Exclude<FilesCertificateInfo['reason'], 'nameMismatch'>,
  string
> = {
  selfSigned:
    'The certificate is self-signed, so no known issuer vouches for it. Many small hosts use one.',
  untrusted: "The certificate comes from an issuer this computer doesn't know.",
  expired: 'The certificate has expired.',
};

function CertificateFix({
  certificate,
  host,
  onUseServername,
  onTrust,
}: {
  certificate: FilesCertificateInfo;
  host: string;
  onUseServername: (name: string) => void;
  onTrust: (fingerprint256: string) => void;
}): React.JSX.Element {
  if (certificate.reason === 'nameMismatch') {
    // A wildcard is not a name to connect to; the user has to pick the host under it.
    const usable = certificate.names.filter((name) => !name.includes('*')).slice(0, 3);
    return (
      <Notice tone="warning" icon={Lock}>
        <div className="space-y-2.5">
          <div className="space-y-1">
            <p className="font-medium">The certificate is for another name</p>
            <p className="text-xs leading-relaxed text-muted-foreground">
              It is made out to {certificate.names.join(', ')}, not {host || 'the host you entered'}
              . That is common on shared hosts.{' '}
              {usable.length > 0
                ? 'Check it against the name the certificate was issued for.'
                : 'Change Host to a name it covers.'}
            </p>
          </div>
          {usable.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {usable.map((name) => (
                <Button
                  key={name}
                  type="button"
                  size="sm"
                  variant="soft"
                  onClick={() => onUseServername(name)}
                >
                  Use {name}
                </Button>
              ))}
            </div>
          )}
        </div>
      </Notice>
    );
  }

  return (
    <Notice tone="warning" icon={Lock}>
      <div className="space-y-2.5">
        <div className="space-y-1">
          <p className="font-medium">This computer doesn't trust the certificate</p>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {CERTIFICATE_REASON[certificate.reason]} Compare the fingerprint with the one your host
            gives you. Trusting it applies to this site only, and a different certificate later is
            refused.
          </p>
        </div>
        <dl
          role="group"
          aria-label="Certificate"
          className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs"
        >
          <dt className="text-muted-foreground">Issued to</dt>
          <dd className="break-all">{certificate.subject}</dd>
          <dt className="text-muted-foreground">Issued by</dt>
          <dd className="break-all">{certificate.issuer}</dd>
          <dt className="text-muted-foreground">
            {certificate.reason === 'expired' ? 'Expired on' : 'Valid until'}
          </dt>
          <dd>{formatDate(certificate.validTo)}</dd>
          <dt className="text-muted-foreground">SHA-256</dt>
          <dd className="select-all break-all font-mono">
            {formatCertificateFingerprint(certificate.fingerprint256)}
          </dd>
        </dl>
        <Button
          type="button"
          size="sm"
          variant="soft"
          onClick={() => onTrust(certificate.fingerprint256)}
        >
          Trust this certificate
        </Button>
      </div>
    </Notice>
  );
}
