/**
 * Project health checks (E22). A project's app or site exposes one secured endpoint per
 * environment and server that answers in the Runova Health Protocol, and Runova polls it.
 * These are the shapes both sides of the app share.
 */

/** The protocol id a compliant endpoint puts in `runova.protocol`. */
export const HEALTH_PROTOCOL = 'runova-health/1';

/** The media type a compliant endpoint answers with (from the IETF health check draft). */
export const HEALTH_MEDIA_TYPE = 'application/health+json';

/** The path the setup prompt suggests when the user does not pick one. */
export const HEALTH_DEFAULT_PATH = '/_runova/health';

/** What a check or the whole endpoint reports about itself. */
export type HealthCheckStatus = 'pass' | 'warn' | 'fail';

/**
 * What Runova makes of one probe. The first three come from the endpoint itself; the rest
 * describe a probe that never got a usable report back.
 */
export type HealthProbeState =
  | 'pass'
  | 'warn'
  | 'fail'
  | 'unreachable'
  | 'unauthorized'
  | 'invalid';

/** What a target shows, which adds the states where no probe ran. */
export type HealthState = HealthProbeState | 'pending' | 'paused' | 'locked';

export type HealthAuthMode = 'bearer' | 'basic';

/** A failing service's error, as the endpoint described it (already redacted). */
export interface HealthServiceError {
  message: string;
  code: string | null;
  detail: string | null;
  stack: string | null;
  hint: string | null;
  /** When the endpoint says the problem started (ISO time), if it said. */
  since: string | null;
}

/** One entry under `checks`, such as `postgres:connection`. */
export interface HealthServiceResult {
  /** The full check key, unique within a report. */
  key: string;
  /** The component part of the key ("postgres"). */
  name: string;
  /** The measurement part of the key ("connection"), when there is one. */
  measurement: string | null;
  componentId: string | null;
  componentType: string | null;
  status: HealthCheckStatus;
  observedValue: string | number | boolean | null;
  observedUnit: string | null;
  time: string | null;
  error: HealthServiceError | null;
}

/** One probe's result, normalized and redacted. Safe to store and to show. */
export interface HealthReport {
  state: HealthProbeState;
  httpStatus: number | null;
  latencyMs: number | null;
  checkedAt: number;
  serviceId: string | null;
  description: string | null;
  releaseId: string | null;
  version: string | null;
  /** The endpoint's own top-level `output`, when it failed as a whole. */
  output: string | null;
  services: HealthServiceResult[];
  /** What went wrong from Runova's side, in a sentence, when the probe got no good report. */
  problem: string | null;
  /** The response body, pretty printed when it was JSON, redacted and trimmed. */
  raw: string | null;
}

/** A point on a target's timeline. */
export interface HealthSample {
  at: number;
  state: HealthProbeState;
  latencyMs: number | null;
}

/** A stretch of time a target was confirmed down. */
export interface HealthIncident {
  id: string;
  targetId: string;
  openedAt: number;
  resolvedAt: number | null;
  /** The state that opened it. */
  state: HealthProbeState;
  /** A one-line summary of what was failing. */
  summary: string;
  /** The keys of the services that were failing when it opened. */
  failingServices: string[];
  diagnosis: HealthDiagnosis | null;
}

export type HealthDiagnosisStatus = 'running' | 'done' | 'failed' | 'cancelled' | 'skipped';

/** The read-only AI analysis that runs when an incident opens. */
export interface HealthDiagnosis {
  status: HealthDiagnosisStatus;
  startedAt: number;
  finishedAt: number | null;
  cliName: string | null;
  /** The analysis (redacted), or why it could not run. */
  text: string | null;
}
