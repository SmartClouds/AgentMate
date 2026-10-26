import type { ErrorReportingStatus } from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';

/** Error reporting as a core describes it, for the card's tests. */

/** A server nobody has set up yet. */
export function notSetUp(fields: Partial<ErrorReportingStatus> = {}): ErrorReportingStatus {
  return {
    configured: false,
    enabled: false,
    environment: 'production',
    serverName: 'prod-box',
    minLevel: 'warning',
    defaultServerName: 'prod-box',
    sentCount: 0,
    ...fields,
  };
}

/** A server reporting to a project, waiting for its first warning unless the fields say more. */
export function reporting(fields: Partial<ErrorReportingStatus> = {}): ErrorReportingStatus {
  return {
    configured: true,
    enabled: true,
    host: 'o1.ingest.sentry.io',
    projectId: '42',
    environment: 'staging',
    serverName: 'web-1',
    minLevel: 'warning',
    defaultServerName: 'prod-box',
    sentCount: 0,
    changedAtUnixMs: Date.now() - 3_600_000,
    changedBy: 'maria',
    ...fields,
  };
}

/** The key the tests paste, and a DSN made from it. */
export const KEY = 'd4e5f60718293a4b5c6d7e8f90a1b2c3';
export const DSN = `https://${KEY}@o1.ingest.sentry.io/42`;
