import {
  type HealthReport,
  type HealthState,
  healthDays,
  healthHoursFromSamples,
  healthLatencyHours,
  healthUptimeSince,
} from '@runova/core';
import type { HealthTargetDetail, HealthTargetSummary } from '../../shared/healthTypes';
import type { HealthResultRecord, StoredHealthTarget } from './store';

const CHART_DAYS = 30;
const CHART_HOURS = 24;

/**
 * Turns a stored target and its results into what the Health page shows. The sealed key never
 * leaves here: the page only learns whether there is one.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const STRIP_SAMPLES = 50;
const MAX_HEADLINE = 200;

export interface HealthSummaryContext {
  now: number;
  /** The key is sealed under the Servers passkey, which is locked right now. */
  locked: boolean;
}

function firstLine(text: string): string {
  const line = text.split('\n', 1)[0].trim();
  return line.length > MAX_HEADLINE ? `${line.slice(0, MAX_HEADLINE - 3)}...` : line;
}

/** A short line for a report: the probe problem, or the first failing service's error. */
export function healthHeadline(report: HealthReport | null): string | null {
  if (!report) return null;
  if (report.problem) return firstLine(report.problem);
  const failing =
    report.services.find((service) => service.status === 'fail') ??
    report.services.find((service) => service.status === 'warn');
  if (failing?.error) return firstLine(`${failing.key}: ${failing.error.message}`);
  if (report.output) return firstLine(report.output);
  return null;
}

/** The hourly roll-up; a record made in memory without one gets it from its samples. */
function hoursOf(result: HealthResultRecord | undefined) {
  if (!result) return [];
  return result.hours?.length ? result.hours : healthHoursFromSamples(result.samples);
}

function stateOf(
  target: StoredHealthTarget,
  result: HealthResultRecord | undefined,
  locked: boolean,
): HealthState {
  if (target.paused) return 'paused';
  if (locked) return 'locked';
  return result?.report?.state ?? 'pending';
}

export function toHealthSummary(
  target: StoredHealthTarget,
  result: HealthResultRecord | undefined,
  context: HealthSummaryContext,
): HealthTargetSummary {
  const { secretEnvelope, ...setup } = target;
  const samples = result?.samples ?? [];
  const hours = hoursOf(result);
  const report = result?.report ?? null;
  return {
    ...setup,
    hasSecret: secretEnvelope !== null,
    state: stateOf(target, result, context.locked),
    lastCheckedAt: result?.lastCheckedAt ?? null,
    nextCheckAt: result?.nextCheckAt ?? null,
    latencyMs: report?.latencyMs ?? null,
    uptime24h: healthUptimeSince(hours, context.now - DAY_MS),
    daily: healthDays(hours, { days: CHART_DAYS, now: context.now }),
    samples: samples.slice(-STRIP_SAMPLES),
    servicesTotal: report?.services.length ?? 0,
    servicesFailing: report?.services.filter((service) => service.status === 'fail').length ?? 0,
    headline: healthHeadline(report),
    openIncident: result?.incidents.find((incident) => incident.resolvedAt === null) ?? null,
  };
}

export function toHealthDetail(
  target: StoredHealthTarget,
  result: HealthResultRecord | undefined,
  context: HealthSummaryContext,
): HealthTargetDetail {
  return {
    target: toHealthSummary(target, result, context),
    report: result?.report ?? null,
    incidents: result?.incidents ?? [],
    samples: result?.samples ?? [],
    latency: healthLatencyHours(hoursOf(result), { hoursBack: CHART_HOURS, now: context.now }),
  };
}
