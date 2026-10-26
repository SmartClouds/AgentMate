import type {
  WpAuditEvent,
  WpDeployState,
  WpRollbackReason,
  WpScope,
  WpUnixSeconds,
} from '@runova/core';
import type {
  DeployWordPressPhase,
  DeployWordPressProgressEvent,
  DeployWordPressSite,
  DeployWordPressSiteInfo,
} from '@shared/deployWordPressTypes';
import {
  type WordPressErrorCode,
  wordPressErrorCode,
  wordPressErrorMessage,
} from '@shared/wordpressErrors';
import { ago } from '@/components/deploy/security/format';

/**
 * Words for WordPress sites in Deploy: what each failure means and what to do about it, what a
 * deploy's state and rollback reason mean, and what the site's audit events are. Everything a
 * site sends (its name, item names, audit details) is shown as text next to these, never as markup.
 */

/** Where the fix for a problem lives, which changes a few of the messages. */
export type WpProblemContext = 'connect' | 'site';

const PROBLEMS: Record<WordPressErrorCode, string> = {
  badRequest:
    "The site didn't understand the request. Update the Runova Connector plugin on the site, then try again.",
  unauthorized:
    "The site didn't accept this computer's signature. Disconnect the site and connect it again with a new key.",
  badSignature:
    "The site couldn't verify this computer's signature. Disconnect the site and connect it again with a new key.",
  staleTimestamp:
    "This computer's clock and the site's clock are too far apart. Check the time on both, then try again.",
  replayed: 'The site saw the same request twice and refused the second one. Try again.',
  unknownConnection:
    'The site no longer knows this computer. It may have been removed in wp-admin. Disconnect it here and connect again with a new key.',
  revoked:
    "This computer's access was revoked on the site. Make a new key in Tools > Runova Connector and connect again.",
  readOnly: 'Read-only key. You can pull files from this site but not deploy to it.',
  fileModsDisabled:
    'File changes are switched off on this site (DISALLOW_FILE_MODS in wp-config.php), so nothing can be deployed. Pulling still works.',
  notDirect:
    'WordPress can\'t write files directly on this host (its filesystem method isn\'t "direct"), so nothing can be deployed. Pulling still works.',
  disabled:
    'The connector is switched off on this site (RUNOVA_CONNECTOR_DISABLED in wp-config.php).',
  pathRejected:
    'The site refused a file path. Only theme, plugin and mu-plugin files are ever written, and agent or Runova files never are.',
  itemUnknown: "The site doesn't have that theme or plugin anymore.",
  itemProtected: "That's the connector itself, which is never pulled or deployed.",
  deployUnknown: "The site doesn't know that deploy anymore. Its snapshot may have been cleared.",
  conflict:
    'Files on the site changed since you last pulled. Pull first, or review the changes again.',
  syntaxError:
    'A PHP file has a syntax error, so the site refused the deploy. Nothing was changed.',
  busy: 'Another deploy is still running on this site. Wait for it to finish, then try again.',
  invalidState: "That deploy can't do this in the state it's in now.",
  tooLarge: 'A file is larger than the site accepts.',
  rateLimited:
    'Too many failed attempts came from this network, so the site locked it out for 15 minutes. Try again later.',
  pairingInvalid:
    "The site didn't accept this key. It may have been used already or deleted. Make a new key in Tools > Runova Connector.",
  pairingExpired:
    'This key has expired. Keys work once, for 15 minutes. Make a new one in Tools > Runova Connector.',
  protocolMismatch:
    'The connector on the site and this app speak different versions. Update whichever one is older.',
  updateRefused:
    'The site would not take the connector update. Download the plugin and upload it in wp-admin instead.',
  internal: 'Something went wrong on the site. Its PHP error log may say more.',
  vaultLocked:
    "Your saved servers are locked with a passkey, and this site's key with them. Unlock them, then try again.",
  foreignResponse:
    'Something other than the connector answered: a firewall, a CDN challenge or a host error page. Allow requests to /wp-json/runova/v1 and admin-ajax.php through the firewall (on Cloudflare, a rule that skips the challenge for them), then try again.',
  badResponseSignature:
    "A reply claimed to come from the connector, but its signature didn't check out, so it was ignored. Something between you and the site may be changing replies.",
  siteKeyMismatch:
    "The site's identity doesn't match the key. If the connector was reinstalled, make a new key. If not, something may be pretending to be your site, so don't connect.",
  redirected:
    "The site answered with a redirect, and Runova never follows redirects on signed calls. Make the key again from the site's final address (https, with or without www).",
  plainHttpRefused:
    'This site uses plain HTTP, which Runova refuses unless you allow it for this site. Without HTTPS, anyone on the network can read the files. Allow it under Access.',
  tlsUntrusted:
    "This computer doesn't trust the site's HTTPS certificate (self-signed, expired, or made out to another name). Fix the certificate on the host or trust it in your system.",
  httpAuthRequired:
    'The site asks for an HTTP sign-in, as staging sites often do. Add its user name and password in Access.',
  unreachable: "Couldn't reach the site. Check its address and your connection.",
  timeout: 'The site took too long to answer. Try again in a moment.',
  cancelled: 'Cancelled.',
  keyInvalid:
    "This isn't a connection key Runova can read. Copy the whole key again from Tools > Runova Connector; it starts with amwp1.",
  keyExpired:
    'This key has expired. Keys work once, for 15 minutes. Make a new one in Tools > Runova Connector.',
  connectorOutdated:
    'The connector on this site is older than this app needs. Download the latest plugin and upload it in wp-admin.',
  bodyTooLarge:
    "The site's web server refused even small requests. Raise client_max_body_size (nginx) or post_max_size (PHP) on the host.",
  localChanged:
    'Files changed on this computer after the review was made. Review the changes again.',
  planExpired: 'The review expired after 15 minutes. Review the changes again.',
  operationBusy: 'Another pull or deploy for this site is still running.',
  folderNotEmpty: "The project's theme or plugin folders already hold files.",
  siteUnknown: "Runova doesn't know this site anymore. It may have been disconnected.",
  projectNotLinked: "This project isn't linked to a WordPress site.",
};

/** Where a problem is fixed in the Connect dialog instead of on the site's Access page. */
const CONNECT_PROBLEMS: Partial<Record<WordPressErrorCode, string>> = {
  vaultLocked:
    "Your saved servers are locked with a passkey. Unlock them on the Deploy page, then connect again with the same key; it hasn't been used yet.",
  httpAuthRequired:
    'The site asks for an HTTP sign-in, as staging sites often do. Turn on "HTTP sign-in" below and add its user name and password.',
  plainHttpRefused:
    'This site uses plain HTTP, which Runova refuses unless you allow it below. Without HTTPS, anyone on the network can read the files.',
};

/**
 * Codes whose message from the main process is more specific than the fixed wording here: it says
 * whether Cloudflare answered, whether the connector is missing (404), or where a redirect went.
 */
const SPECIFIC_FROM_MAIN: ReadonlySet<string> = new Set([
  'foreignResponse',
  'redirected',
  'updateRefused',
]);

/** The human version of a failure from a WordPress call; unknown failures keep their own words. */
export function wpProblem(error: unknown, context: WpProblemContext = 'site'): string {
  const code = wordPressErrorCode(error);
  if (code && SPECIFIC_FROM_MAIN.has(code)) {
    // The main process always writes these as whole sentences; anything shorter is not one.
    const own = wordPressErrorMessage(error).trim();
    if (own.length >= 40) return own;
  }
  if (code) return (context === 'connect' ? CONNECT_PROBLEMS[code] : undefined) ?? PROBLEMS[code];
  return wordPressErrorMessage(error) || 'Something went wrong.';
}

/** Times the app records are milliseconds; `lastSeenAt` is one of them. */
export function lastSeenText(site: Pick<DeployWordPressSite, 'lastSeenAt'>, now = Date.now()) {
  return site.lastSeenAt === null ? 'Not reached yet' : `Seen ${ago(site.lastSeenAt, now)}`;
}

/**
 * Compares dotted version numbers ("1.0.10" is newer than "1.0.9"). Anything after a `-` or `+`
 * is ignored, and a part that is not a number counts as 0.
 */
export function compareVersions(a: string, b: string): number {
  const parts = (value: string) =>
    value
      .split(/[-+]/)[0]
      .split('.')
      .map((part) => Number.parseInt(part, 10) || 0);
  const left = parts(a);
  const right = parts(b);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

/** The host part of a site address, for the rail; the address itself when it does not parse. */
export function siteHost(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/$/, '')}`;
  } catch {
    return url;
  }
}

export const SCOPE_LABEL: Record<WpScope, string> = {
  read: 'Read-only key',
  write: 'Read and write key',
};

export const SCOPE_SUMMARY: Record<WpScope, string> = {
  read: 'Read-only key. You can pull files from this site but not deploy to it.',
  write: 'Read and write key. You can pull files from this site and deploy to it.',
};

export const TRANSPORT_LABEL: Record<DeployWordPressSite['transport'], string> = {
  https: 'HTTPS',
  'local-http': 'Plain HTTP to this computer',
  'plain-http': 'Plain HTTP over the network',
};

export const DEPLOY_STATE_LABEL: Record<WpDeployState, string> = {
  open: 'Started',
  applying: 'Writing files',
  applied: 'Written, being checked',
  done: 'Deployed',
  rolledBack: 'Rolled back',
  aborted: 'Cancelled',
  expired: 'Expired',
};

/** What a state means for the files on the site, for the deploy's row. */
export const DEPLOY_STATE_DETAIL: Record<WpDeployState, string> = {
  open: 'Files are on their way. Nothing on the site has changed yet.',
  applying: 'The site is writing the new files now.',
  applied: 'The new files are in place and the site is checking that it still works.',
  done: 'The new files are live.',
  rolledBack: 'The files are back to how they were before this deploy.',
  aborted: 'Stopped before any file on the site changed.',
  expired: 'Left unfinished for 30 minutes, so the site dropped it. No file changed.',
};

export const ROLLBACK_REASON: Record<WpRollbackReason, string> = {
  requested: 'Someone asked for it to be rolled back.',
  healthCheck:
    'The site stopped working properly after the deploy, so it put the old files back on its own.',
  fatalError: 'A changed file caused a PHP fatal error, so the site put the old files back.',
  notConfirmed:
    "Runova didn't confirm the deploy in time (the connection may have dropped), so the site put the old files back on its own.",
  interrupted: 'The deploy was interrupted partway, so the site put the old files back.',
};

export const AUDIT_EVENT_LABEL: Record<WpAuditEvent, string> = {
  keyCreated: 'Connection key made',
  paired: 'Computer connected',
  pairFailed: 'Connection attempt failed',
  authFailed: 'Request refused',
  rateLimited: 'Locked out after too many failures',
  revoked: 'Connection revoked',
  pulled: 'Files pulled',
  deployStarted: 'Deploy started',
  deployDone: 'Deploy finished',
  deployRolledBack: 'Deploy rolled back',
  deployAborted: 'Deploy cancelled',
  connectorUpdated: 'Connector updated',
  connectorRolledBack: 'Connector update undone',
  settingsChanged: 'Settings changed',
};

/** Events that point at something going wrong, shown in a warning colour. */
export const AUDIT_EVENT_WARNS: ReadonlySet<WpAuditEvent> = new Set<WpAuditEvent>([
  'pairFailed',
  'authFailed',
  'rateLimited',
  'deployRolledBack',
  'connectorRolledBack',
]);

const PHASE_LABEL: Record<DeployWordPressPhase, string> = {
  connecting: 'Reaching the site',
  manifest: 'Listing files',
  hashing: 'Comparing files',
  download: 'Downloading',
  write: 'Writing files',
  upload: 'Uploading',
  validate: 'Checking PHP syntax',
  apply: 'Writing files on the site',
  verify: 'Checking the site still works',
  finalize: 'Finishing',
  rollback: 'Putting the old files back',
  done: 'Done',
  failed: 'Stopped',
};

/** One line for a running operation: its step, and how far along when that is known. */
export function progressText(event: DeployWordPressProgressEvent): string {
  const label = PHASE_LABEL[event.phase] ?? 'Working';
  return event.total > 0 ? `${label} (${event.done} of ${event.total})` : label;
}

const DATE_TIME: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
};

/** A moment the app recorded, in milliseconds. */
export function dateTimeText(unixMs: number): string {
  return new Date(unixMs).toLocaleString([], DATE_TIME);
}

/** A moment the site reported: the plugin sends Unix seconds. */
export function siteTimeText(seconds: WpUnixSeconds): string {
  return dateTimeText(seconds * 1000);
}

/** A time of day the site reported in Unix seconds, such as a pending deploy's deadline. */
export function siteClockText(seconds: WpUnixSeconds): string {
  return new Date(seconds * 1000).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Whether deploys can write files, and if not, which switch on the site stops them. */
export function fileChangesStatus(
  info: DeployWordPressSiteInfo,
  site: Pick<DeployWordPressSite, 'scope'>,
): { allowed: boolean; text: string } {
  if (info.fileModsDisabled) {
    return {
      allowed: false,
      text: 'Off. DISALLOW_FILE_MODS is set in wp-config.php, so nothing can be deployed. Pulling still works.',
    };
  }
  if (info.readOnlyByConstant) {
    return {
      allowed: false,
      text: 'Off. RUNOVA_CONNECTOR_READ_ONLY is set in wp-config.php, so the connector only reads. Pulling still works.',
    };
  }
  if (info.filesystemMethod !== 'direct') {
    return {
      allowed: false,
      text: `Off. WordPress would write files through "${info.filesystemMethod}" here, and the connector only writes files directly. Pulling still works.`,
    };
  }
  if (site.scope === 'read') {
    return {
      allowed: false,
      text: 'The site allows them, but this key is read-only. You can pull files from this site but not deploy to it.',
    };
  }
  return { allowed: true, text: 'Allowed. Deploys write theme and plugin files directly.' };
}
