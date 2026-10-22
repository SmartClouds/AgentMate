/**
 * Checks for the error reporting form (as the user types) and its IPC handler. They follow the
 * core's own rules for a Sentry DSN and the options, case for case (see SentryDsnTests.cs), so the
 * form says "fine" and "no" where the server does. The core checks everything again.
 */

export type ErrorReportingCheck<T> = { ok: true; value: T } | { ok: false; reason: string };

export const MAX_DSN_LENGTH = 512;
export const MAX_ENVIRONMENT_LENGTH = 64;
export const MAX_SERVER_NAME_LENGTH = 128;
export const DEFAULT_ENVIRONMENT = 'production';

const MAX_PROJECT_ID_LENGTH = 18;

/** The lowest level the core sends: what the form offers, in order. */
export const ERROR_REPORTING_LEVELS = [
  { value: 'warning', label: 'Warnings and errors', hint: 'Warnings, errors and crashes.' },
  { value: 'error', label: 'Errors only', hint: 'Errors and crashes, no warnings.' },
] as const;

export type ErrorReportingLevel = (typeof ERROR_REPORTING_LEVELS)[number]['value'];

/** A Sentry DSN taken apart. Printing it with `dsnDestination` never shows the key. */
export interface ParsedSentryDsn {
  scheme: 'https' | 'http';
  publicKey: string;
  /** The host as typed (an IPv6 address keeps its brackets). */
  host: string;
  port: number | null;
  /** Empty, or a path before the project id, such as `/sentry`. */
  pathPrefix: string;
  projectId: string;
  /** The host and port: where logs go. */
  authority: string;
  /** Where OpenTelemetry logs for this project are posted. */
  logsUrl: string;
}

const PUBLIC_KEY = /^[A-Za-z0-9]{6,64}$/;
const PROJECT_ID = /^[0-9]+$/;
const PATH_SEGMENT = /^[A-Za-z0-9._~-]+$/;
const HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const ENVIRONMENT = /^[A-Za-z0-9._-]{1,64}$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

function fail<T>(reason: string): ErrorReportingCheck<T> {
  return { ok: false, reason };
}

function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(host);
}

function validHost(host: string): boolean {
  if (host.startsWith('[')) return /^\[[0-9a-f:.]+\]$/.test(host) && host.includes(':');
  return HOSTNAME.test(host);
}

function hostAndPort(
  authority: string,
): ErrorReportingCheck<{ host: string; port: number | null }> {
  const badHost = 'The DSN has no valid host after the @.';
  let hostText: string;
  let portText: string | null = null;
  if (authority.startsWith('[')) {
    const close = authority.indexOf(']');
    if (close < 0) return fail(badHost);
    hostText = authority.slice(0, close + 1);
    const after = authority.slice(close + 1);
    if (after.length > 0) {
      if (!after.startsWith(':')) return fail(badHost);
      portText = after.slice(1);
    }
  } else {
    const colon = authority.indexOf(':');
    hostText = colon < 0 ? authority : authority.slice(0, colon);
    portText = colon < 0 ? null : authority.slice(colon + 1);
  }
  hostText = hostText.toLowerCase();
  if (hostText.length === 0 || !validHost(hostText)) return fail(badHost);
  if (portText === null) return { ok: true, value: { host: hostText, port: null } };
  const port = /^\d{1,5}$/.test(portText) ? Number(portText) : Number.NaN;
  if (!(port >= 1 && port <= 65535))
    return fail('The port in the DSN must be a number from 1 to 65535.');
  return { ok: true, value: { host: hostText, port } };
}

function projectPath(path: string): ErrorReportingCheck<{ prefix: string; projectId: string }> {
  const segments = path.length === 0 ? [] : path.slice(1).split('/');
  const last = segments.at(-1) ?? '';
  if (last.length === 0 || last.length > MAX_PROJECT_ID_LENGTH || !PROJECT_ID.test(last)) {
    return fail('The DSN needs the project id (a number) at the end.');
  }
  const parts = segments.slice(0, -1);
  if (parts.some((part) => !PATH_SEGMENT.test(part))) {
    return fail('The path in the DSN has characters a web address cannot hold.');
  }
  return {
    ok: true,
    value: { prefix: parts.length === 0 ? '' : `/${parts.join('/')}`, projectId: last },
  };
}

/**
 * Reads a DSN the way the core will use it. Plain http is only for this machine; everything else
 * must be https. The old secret part of a DSN is dropped: nothing uses it.
 */
export function parseSentryDsn(
  input: string | undefined | null,
): ErrorReportingCheck<ParsedSentryDsn> {
  const text = (input ?? '').trim();
  if (text.length === 0) {
    return fail('Paste the DSN from your Sentry project (Project settings, then Client Keys).');
  }
  if (text.length > MAX_DSN_LENGTH) return fail('That DSN is too long.');
  const schemeEnd = text.indexOf('://');
  if (schemeEnd <= 0) {
    return fail(
      'That is not a Sentry DSN. It looks like https://<public key>@<host>/<project id>.',
    );
  }
  const scheme = text.slice(0, schemeEnd).toLowerCase();
  if (scheme !== 'https' && scheme !== 'http') return fail('The DSN must start with https://.');

  const rest = text.slice(schemeEnd + 3);
  if (/[?#]/.test(rest)) {
    return fail('A DSN has no query or fragment part. Copy it again from Client Keys.');
  }
  const slash = rest.indexOf('/');
  const authority = slash < 0 ? rest : rest.slice(0, slash);
  const path = slash < 0 ? '' : rest.slice(slash);

  const at = authority.lastIndexOf('@');
  if (at < 0) return fail('The DSN has no public key before the host.');
  const publicKey = authority.slice(0, at).split(':')[0] ?? '';
  if (!PUBLIC_KEY.test(publicKey)) return fail('The DSN has no valid public key before the host.');

  const where = hostAndPort(authority.slice(at + 1));
  if (!where.ok) return where;
  const { host, port } = where.value;
  if (scheme === 'http' && !isLoopback(host)) {
    return fail('Use an https DSN. Plain http is only allowed for this machine (localhost).');
  }

  const parts = projectPath(path);
  if (!parts.ok) return parts;
  const { prefix, projectId } = parts.value;

  const defaultPort = scheme === 'https' ? 443 : 80;
  const shown = port === null ? host : `${host}:${port}`;
  const address = port === null || port === defaultPort ? host : shown;
  return {
    ok: true,
    value: {
      scheme,
      publicKey,
      host,
      port,
      pathPrefix: prefix,
      projectId,
      authority: shown,
      logsUrl: `${scheme}://${address}${prefix}/api/${projectId}/integration/otlp/v1/logs`,
    },
  };
}

/** "o1.ingest.sentry.io, project 42": where logs go, never the key. */
export function dsnDestination(dsn: Pick<ParsedSentryDsn, 'authority' | 'projectId'>): string {
  return `${dsn.authority}, project ${dsn.projectId}`;
}

/** An empty environment means production, Sentry's own default. */
export function checkEnvironment(input: string | undefined | null): ErrorReportingCheck<string> {
  const value = (input ?? '').trim();
  if (value.length === 0) return { ok: true, value: DEFAULT_ENVIRONMENT };
  if (!ENVIRONMENT.test(value)) {
    return fail(
      `Environment can only use letters, digits, dots, dashes and underscores, up to ${MAX_ENVIRONMENT_LENGTH} characters.`,
    );
  }
  return { ok: true, value };
}

/** An empty name stays empty: the core then uses the machine's own name. */
export function checkServerName(input: string | undefined | null): ErrorReportingCheck<string> {
  const value = (input ?? '').trim();
  if (value.length > MAX_SERVER_NAME_LENGTH) {
    return fail(`Server name is too long (${MAX_SERVER_NAME_LENGTH} characters at most).`);
  }
  if (CONTROL_CHARACTER.test(value)) {
    return fail('Server name cannot hold line breaks, tabs or other control characters.');
  }
  return { ok: true, value };
}
