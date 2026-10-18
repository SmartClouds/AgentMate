import type { DeployPreflight } from '@shared/deployTypes';
import { useEffect, useState } from 'react';
import { CircleCheck, CircleInfo, CircleX } from '@/components/icons';
import { Skeleton } from '@/components/ui/skeleton';

type Verdict = 'ok' | 'blocked' | 'note';

interface Row {
  label: string;
  value: string;
  verdict: Verdict;
}

const VERDICT_TEXT: Record<Verdict, string> = {
  ok: 'ready',
  blocked: 'blocks the install',
  note: 'note',
};

function sudoValue(preflight: DeployPreflight): Pick<Row, 'value' | 'verdict'> {
  switch (preflight.sudo) {
    case 'root':
      return { value: 'Signed in as root', verdict: 'ok' };
    case 'passwordless':
      return { value: 'sudo, no password needed', verdict: 'ok' };
    case 'password':
      return {
        value: preflight.hasSavedPassword
          ? 'sudo, with the saved login password'
          : 'sudo, asks for a password',
        verdict: 'ok',
      };
    default:
      return { value: 'sudo is not installed', verdict: 'blocked' };
  }
}

function rows(preflight: DeployPreflight): Row[] {
  const list: Row[] = [
    {
      label: 'Operating system',
      value: preflight.os || 'Unknown',
      verdict: preflight.supported ? 'ok' : 'blocked',
    },
    {
      label: 'Processor',
      value: preflight.architecture || 'Unknown',
      verdict: preflight.architectureSupported ? 'ok' : 'blocked',
    },
    {
      label: 'Service manager',
      value: preflight.systemd ? 'systemd' : 'Not systemd',
      verdict: preflight.systemd ? 'ok' : 'blocked',
    },
    {
      label: 'Free space',
      value:
        preflight.freeDiskMb === null
          ? 'Could not tell'
          : `${(preflight.freeDiskMb / 1024).toFixed(1)} GB under /opt and /var`,
      verdict:
        preflight.freeDiskMb === null ? 'note' : preflight.freeDiskMb >= 300 ? 'ok' : 'blocked',
    },
    { label: 'Root access', ...sudoValue(preflight) },
  ];
  // Only certain when sshd said no outright; otherwise the install finds out by trying.
  if (preflight.transport === 'bridge') {
    list.push({
      label: 'Connection',
      value: "The core's own bridge, since this server's SSH does not allow tunnels",
      verdict: 'note',
    });
  }
  if (preflight.selinux === 'enforcing' || preflight.selinux === 'permissive') {
    list.push({
      label: 'SELinux',
      value: `${preflight.selinux === 'enforcing' ? 'Enforcing' : 'Permissive'}, so the files get labelled`,
      verdict: 'note',
    });
  }
  if (preflight.installed) {
    list.push({
      label: 'Installed now',
      value: `Server core ${preflight.installed.version}`,
      verdict: 'note',
    });
  }
  return list;
}

function VerdictIcon({ verdict }: { verdict: Verdict }): React.JSX.Element {
  if (verdict === 'ok') return <CircleCheck className="h-4 w-4 text-success" />;
  if (verdict === 'blocked') return <CircleX className="h-4 w-4 text-destructive" />;
  return <CircleInfo className="h-4 w-4 text-muted-foreground" />;
}

/** What the preflight found, one fact per row, each marked ready, blocking, or just a note. */
export function PreflightChecklist({
  preflight,
}: {
  preflight: DeployPreflight;
}): React.JSX.Element {
  return (
    <dl className="grid gap-x-6 gap-y-2.5 sm:grid-cols-2" aria-label="What the check found">
      {rows(preflight).map((row) => (
        <div key={row.label} className="flex items-start gap-2.5">
          <span className="mt-0.5 shrink-0">
            <VerdictIcon verdict={row.verdict} />
          </span>
          <div className="min-w-0">
            <dt className="text-xs text-muted-foreground">
              {row.label}
              <span className="sr-only"> ({VERDICT_TEXT[row.verdict]})</span>
            </dt>
            <dd className="break-words text-sm text-foreground">{row.value}</dd>
          </div>
        </div>
      ))}
    </dl>
  );
}

/** How long the check runs before the panel says the server is slow instead of only shimmering. */
const SLOW_CHECK_MS = 8_000;

export function PreflightSkeleton({ serverName }: { serverName: string }): React.JSX.Element {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), SLOW_CHECK_MS);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div className="space-y-3">
      <div
        className="grid gap-x-6 gap-y-3 sm:grid-cols-2"
        aria-busy="true"
        aria-label="Checking the server"
      >
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index} className="flex items-start gap-2.5">
            <Skeleton className="h-4 w-4 rounded-full" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-4 w-40" />
            </div>
          </div>
        ))}
      </div>
      <p className="text-xs text-muted-foreground" role="status">
        {slow
          ? `${serverName} is slow to answer. The check stops by itself if the server stops answering, and you can check again then.`
          : `Checking ${serverName}.`}
      </p>
    </div>
  );
}
