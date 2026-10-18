import type {
  HealthAuthMode,
  HealthDayBucket,
  HealthIncident,
  HealthLatencyPoint,
  HealthReport,
  HealthSample,
  HealthState,
} from '@agentmat/core';

/**
 * Project health checks (E22): what crosses IPC between the Health page and the main process.
 *
 * A stored key or password never appears in any of these. The renderer sees `hasSecret`, and the
 * plaintext only once, in a `HealthSecretReveal`, right after it was generated.
 */

/** A saved server or site the target runs on, for a link to it. Deploy servers share SSH ids. */
export interface HealthServerLink {
  kind: 'ssh' | 'wordpress';
  id: string;
}

/** What the user edits in the target dialog. */
export interface HealthTargetInput {
  projectId: string;
  /** One of the project's environments (Environments tab), or none. */
  environmentId: string | null;
  /** What the target is called on the page, such as "API" or "Storefront". */
  name: string;
  /** The server it runs on, as the user names it ("web-1"). */
  serverLabel: string | null;
  serverLink: HealthServerLink | null;
  url: string;
  intervalSec: number;
  timeoutSec: number;
  authMode: HealthAuthMode;
  /** The username for HTTP Basic; ignored for a Bearer key. */
  basicUser: string | null;
  /** Lets an http:// URL that is not loopback be probed. The UI warns before it is turned on. */
  allowInsecure: boolean;
  /** Runs the read-only AI analysis when an incident opens. */
  autoDiagnose: boolean;
}

/** One target as the page lists it. */
export interface HealthTargetSummary extends HealthTargetInput {
  id: string;
  createdAt: number;
  updatedAt: number;
  paused: boolean;
  hasSecret: boolean;
  secretRotatedAt: number | null;
  state: HealthState;
  lastCheckedAt: number | null;
  nextCheckAt: number | null;
  latencyMs: number | null;
  /** Share of good checks over the last 24 hours (0 to 1), or null with no checks yet. */
  uptime24h: number | null;
  /** The last 30 calendar days, oldest first, for the availability chart. */
  daily: HealthDayBucket[];
  /** The most recent samples, oldest first, at most 50, for the card's strip. */
  samples: HealthSample[];
  servicesTotal: number;
  servicesFailing: number;
  /** A short line for the card: the problem, or the first failing service's error. */
  headline: string | null;
  openIncident: HealthIncident | null;
}

/** Everything the detail panel shows for one target. */
export interface HealthTargetDetail {
  target: HealthTargetSummary;
  /** The last report, already redacted. */
  report: HealthReport | null;
  /** Newest first, at most 50. */
  incidents: HealthIncident[];
  /** Every stored sample, oldest first, at most 200. */
  samples: HealthSample[];
  /** The last 24 hours, one point per hour, oldest first, for the response time chart. */
  latency: HealthLatencyPoint[];
}

/** The key or password, shown once after it is generated. */
export interface HealthSecretReveal {
  targetId: string;
  authMode: HealthAuthMode;
  /** The plaintext: a Bearer key, or the Basic password. */
  secret: string;
  /** Its SHA-256 as lowercase hex, which is what the server stores. */
  sha256: string;
  basicUser: string | null;
  /** The variable the server reads the hash from. */
  hashEnvVar: string;
}

export interface HealthCreateResult {
  target: HealthTargetSummary;
  secret: HealthSecretReveal;
}

export interface HealthSetupPrompt {
  /** The ask plus the spec, for an agent tab or the clipboard. */
  prompt: string;
  /** The protocol document on its own. */
  spec: string;
}

/** Main to renderer: these targets changed (a probe finished, a target was edited). */
export interface HealthChangedEvent {
  targetIds: string[];
}
