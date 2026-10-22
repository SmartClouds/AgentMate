import { checkEnvironment, checkServerName, parseSentryDsn } from '../errorReportingValidation';
import type {
  ErrorReportingRequest,
  ErrorReportingSaveResult,
  ErrorReportingStatus,
  ErrorReportingTestResult,
} from '../protocol/generated/AgentMate.ServerCore.Contracts';

/**
 * Error reporting on the pretend server (E29): what the core keeps about it and how a test event
 * goes. Like the real core it holds the DSN without ever returning it, and checks a request the
 * way the form does. Tests play Sentry's answer by setting `testAnswer`.
 */

export const FAKE_MACHINE_NAME = 'fake-server';

export class FakeErrorReporting {
  status: ErrorReportingStatus = {
    configured: false,
    enabled: false,
    environment: 'production',
    serverName: FAKE_MACHINE_NAME,
    minLevel: 'warning',
    defaultServerName: FAKE_MACHINE_NAME,
    sentCount: 0,
  };

  /** The DSN the pretend core holds. It is never part of an answer. */
  dsn: string | null = null;

  /** What the next test event comes to. */
  testAnswer: ErrorReportingTestResult = {
    delivered: true,
    httpStatus: 200,
    message:
      'Sentry accepted the test event (HTTP 200). It should show up in the project’s Logs within a minute.',
  };

  constructor(private readonly deps: { now: () => number; userName: () => string }) {}

  save(request: ErrorReportingRequest): ErrorReportingSaveResult {
    const problems: string[] = [];
    let dsn = this.dsn;
    if (request.dsn?.trim()) {
      const parsed = parseSentryDsn(request.dsn);
      if (parsed.ok) dsn = request.dsn.trim();
      else problems.push(parsed.reason);
    } else if (!dsn) {
      problems.push('Paste the DSN from your Sentry project (Project settings, then Client Keys).');
    }
    const environment = checkEnvironment(request.environment);
    if (!environment.ok) problems.push(environment.reason);
    const serverName = checkServerName(request.serverName);
    if (!serverName.ok) problems.push(serverName.reason);
    const level = (request.minLevel ?? 'warning').toLowerCase();
    if (level !== 'warning' && level !== 'error') {
      problems.push('The level must be Warning (warnings and errors) or Error (errors only).');
    }
    const parsedDsn = dsn ? parseSentryDsn(dsn) : null;
    if (problems.length > 0 || !environment.ok || !serverName.ok || !parsedDsn?.ok) {
      return { problems };
    }
    this.dsn = dsn;
    this.status = {
      configured: true,
      enabled: request.enabled,
      host: parsedDsn.value.authority,
      projectId: parsedDsn.value.projectId,
      environment: environment.value,
      serverName: serverName.value || FAKE_MACHINE_NAME,
      minLevel: level,
      defaultServerName: FAKE_MACHINE_NAME,
      sentCount: 0,
      changedAtUnixMs: this.deps.now(),
      changedBy: this.deps.userName(),
    };
    return { problems: [], status: { ...this.status } };
  }

  remove(): ErrorReportingStatus {
    this.dsn = null;
    this.status = {
      configured: false,
      enabled: false,
      environment: 'production',
      serverName: FAKE_MACHINE_NAME,
      minLevel: 'warning',
      defaultServerName: FAKE_MACHINE_NAME,
      sentCount: 0,
    };
    return { ...this.status };
  }

  test(): ErrorReportingTestResult {
    if (!this.status.configured) {
      return { delivered: false, message: 'Error reporting is not set up on this server yet.' };
    }
    if (!this.status.enabled) {
      return {
        delivered: false,
        message: 'Error reporting is paused. Turn it on, then send the test again.',
      };
    }
    if (this.testAnswer.delivered) {
      this.status = {
        ...this.status,
        sentCount: this.status.sentCount + 1,
        lastSentAtUnixMs: this.deps.now(),
      };
      delete this.status.lastError;
    } else {
      this.status = {
        ...this.status,
        lastFailedAtUnixMs: this.deps.now(),
        lastError: this.testAnswer.message,
      };
    }
    return { ...this.testAnswer };
  }
}
