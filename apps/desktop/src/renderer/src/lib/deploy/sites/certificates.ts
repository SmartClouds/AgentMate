import type { CertificateInfo } from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';

/**
 * A certificate in words: how long it has left, whether it renews by itself and how its last
 * renewal went. Every state reads on its own, so a badge never leans on its colour alone.
 */

export const DAY_MS = 24 * 60 * 60_000;
const SOON_DAYS = 14;

export type CertificateTone = 'ok' | 'warn' | 'bad';

export interface CertificateBadge {
  label: string;
  tone: CertificateTone;
  /** A sentence for a tooltip or a screen reader. */
  description: string;
}

/** Whole days left; negative once it has run out. */
export function daysLeft(certificate: CertificateInfo, now: number): number {
  return Math.floor((certificate.notAfterUnixMs - now) / DAY_MS);
}

export function formatDay(unixMs: number): string {
  return new Date(unixMs).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

export function certificateBadge(
  certificate: CertificateInfo | undefined,
  now: number,
): CertificateBadge {
  if (!certificate) {
    return { label: 'No SSL', tone: 'warn', description: 'Served over plain HTTP only.' };
  }
  if (certificate.state === 'revoked') {
    return {
      label: 'Revoked',
      tone: 'bad',
      description: 'The certificate was revoked. Issue a new one.',
    };
  }
  const days = daysLeft(certificate, now);
  if (certificate.state === 'expired' || days < 0) {
    return {
      label: 'Expired',
      tone: 'bad',
      description: `The certificate ran out on ${formatDay(certificate.notAfterUnixMs)}.`,
    };
  }
  const staging = certificate.staging
    ? ' It comes from the staging CA, so browsers will not trust it.'
    : '';
  const label = days === 0 ? 'SSL, last day' : `SSL, ${plural(days, 'day')}`;
  const soon = certificate.state === 'expiringSoon' || days <= SOON_DAYS;
  return {
    label: certificate.staging ? `${label} (staging)` : label,
    tone: soon || certificate.staging ? 'warn' : 'ok',
    description: `Valid until ${formatDay(certificate.notAfterUnixMs)}.${staging}`,
  };
}

/** What the renewal service will do next, or why it is not doing anything. */
export function renewalText(certificate: CertificateInfo, now: number): string {
  if (certificate.source === 'uploaded') {
    return 'Uploaded by hand, so it does not renew by itself. Upload a new one before it runs out.';
  }
  if (certificate.source === 'cloudflareOrigin') {
    return 'A Cloudflare Origin CA certificate: valid for years, trusted by Cloudflare only. Make a new one from here before it runs out.';
  }
  if (!certificate.autoRenew) return 'Automatic renewal is off.';
  if (certificate.failedAttempts > 0) {
    const next = certificate.nextAttemptAtUnixMs
      ? ` Next try ${relative(certificate.nextAttemptAtUnixMs, now)}.`
      : '';
    return `The last ${plural(certificate.failedAttempts, 'renewal attempt')} failed.${next}`;
  }
  if (certificate.renewAtUnixMs) {
    return certificate.renewAtUnixMs <= now
      ? 'Renews automatically within the next few hours.'
      : `Renews automatically around ${formatDay(certificate.renewAtUnixMs)}.`;
  }
  return 'Renews automatically before it runs out.';
}

/** "in 3 hours", "in 2 days", "5 minutes ago". */
export function relative(unixMs: number, now: number): string {
  const delta = unixMs - now;
  const minutes = Math.round(Math.abs(delta) / 60_000);
  const amount =
    minutes < 1
      ? 'less than a minute'
      : minutes < 60
        ? plural(minutes, 'minute')
        : minutes < 48 * 60
          ? plural(Math.round(minutes / 60), 'hour')
          : plural(Math.round(minutes / (24 * 60)), 'day');
  return delta >= 0 ? `in ${amount}` : `${amount} ago`;
}
