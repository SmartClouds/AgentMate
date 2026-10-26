import type { ErrorReportingLevel } from './deploy/errorReportingValidation';
import type {
  ErrorReportingStatus,
  ErrorReportingTestResult,
} from './deploy/protocol/generated/Runova.ServerCore.Contracts';

/**
 * Error reporting (E29): a server core sends its own warnings and errors to a Sentry project as
 * OpenTelemetry logs. The DSN only ever goes in, from the form to the core, which seals it and never
 * returns it; the status says where logs go (host and project), never the key.
 */

/** How reporting stands on a server, as the core describes it. */
export type DeployErrorReportingStatus = ErrorReportingStatus;

/** What a test event came to: whether Sentry took it, and what it said. */
export type DeployErrorReportingTestResult = ErrorReportingTestResult;

/** The password or authenticator code a step-up needs, when the core asked for one. */
export interface DeployErrorReportingProof {
  password?: string;
  totpCode?: string;
}

/**
 * Sets reporting up or changes it (an Owner, with a step-up). Leave `dsn` out to keep the one the
 * core already has, so the level or environment can change without pasting the key again.
 */
export interface DeployErrorReportingSaveInput extends DeployErrorReportingProof {
  serverId: string;
  dsn?: string;
  enabled: boolean;
  /** Empty means production. */
  environment: string;
  /** Empty means the machine's own name. */
  serverName: string;
  level: ErrorReportingLevel;
}

export interface DeployErrorReportingRemoveInput extends DeployErrorReportingProof {
  serverId: string;
}

/** Saved when `problems` is empty (and `status` says how it stands); otherwise nothing was saved. */
export interface DeployErrorReportingSaveResult {
  problems: string[];
  status: DeployErrorReportingStatus | null;
}
