import {
  HEALTH_INTERVAL_DEFAULT_SEC,
  HEALTH_INTERVAL_MAX_SEC,
  HEALTH_INTERVAL_MIN_SEC,
  HEALTH_INTERVAL_PRESETS,
  HEALTH_TIMEOUT_DEFAULT_SEC,
  HEALTH_TIMEOUT_MAX_SEC,
  HEALTH_TIMEOUT_MIN_SEC,
  type HealthAuthMode,
  type HealthCheckStatus,
  type HealthState,
  type Project,
} from '@runova/core';
import type { ProjectEnvironment } from '@shared/apiTypes';
import type { HealthServerLink, HealthTargetInput, HealthTargetSummary } from '@shared/healthTypes';
import type { ChipTone } from '@/components/pageKit';

/**
 * What the Health page shows for a target, worked out from the summaries the main process sends.
 * Kept free of React so every rule here is tested on its own.
 */

export interface HealthStateMeta {
  /** The word the chip and the tooltips say. Status is never told by colour alone. */
  label: string;
  tone: ChipTone;
  /** One sentence for the detail panel. */
  hint: string;
}

export const HEALTH_STATE_META: Record<HealthState, HealthStateMeta> = {
  pass: { label: 'Healthy', tone: 'success', hint: 'Every check passed.' },
  warn: { label: 'Degraded', tone: 'warning', hint: 'It answers, but a check reported a warning.' },
  fail: { label: 'Down', tone: 'destructive', hint: 'The endpoint reported a failing check.' },
  unreachable: {
    label: 'Unreachable',
    tone: 'destructive',
    hint: 'No answer came back before the timeout.',
  },
  unauthorized: {
    label: 'Key rejected',
    tone: 'destructive',
    hint: 'The endpoint turned the key down. Check the hash on the server.',
  },
  invalid: {
    label: 'Bad response',
    tone: 'destructive',
    hint: 'An answer came back, but not in the health format.',
  },
  pending: { label: 'Waiting', tone: 'neutral', hint: 'The first check has not run yet.' },
  paused: { label: 'Paused', tone: 'neutral', hint: 'Checks are paused for this target.' },
  locked: {
    label: 'Locked',
    tone: 'neutral',
    hint: 'The vault is locked, so the key cannot be read. Unlock it to resume checks.',
  },
};

/** A single check's own status, as the services table words it. */
export const SERVICE_STATUS_META: Record<HealthCheckStatus, { label: string; tone: ChipTone }> = {
  pass: { label: 'Pass', tone: 'success' },
  warn: { label: 'Warn', tone: 'warning' },
  fail: { label: 'Fail', tone: 'destructive' },
};

/** "3 ms", "true", "128 connections": an observed value with its unit, or nothing. */
export function formatObserved(
  value: string | number | boolean | null,
  unit: string | null,
): string | null {
  if (value === null || value === '') return null;
  return unit ? `${String(value)} ${unit}` : String(value);
}

export type HealthBucket = 'healthy' | 'degraded' | 'down' | 'paused' | 'pending';

/** What the status filter can narrow the page to. Waiting targets only show under all. */
export type HealthStatusFilter = 'all' | Exclude<HealthBucket, 'pending'>;

export function healthBucket(state: HealthState): HealthBucket {
  switch (state) {
    case 'pass':
      return 'healthy';
    case 'warn':
      return 'degraded';
    case 'paused':
    case 'locked':
      return 'paused';
    case 'pending':
      return 'pending';
    default:
      return 'down';
  }
}

export interface HealthSummary {
  healthy: number;
  degraded: number;
  down: number;
  paused: number;
  pending: number;
  total: number;
  /** The average 24 hour uptime of the targets that have samples, or null with none. */
  uptime24h: number | null;
  /** Targets with an incident still open. */
  incidents: number;
}

export function summarizeHealth(targets: readonly HealthTargetSummary[]): HealthSummary {
  const summary: HealthSummary = {
    healthy: 0,
    degraded: 0,
    down: 0,
    paused: 0,
    pending: 0,
    total: targets.length,
    uptime24h: null,
    incidents: 0,
  };
  let uptimeSum = 0;
  let uptimeCount = 0;
  for (const one of targets) {
    summary[healthBucket(one.state)] += 1;
    if (one.openIncident) summary.incidents += 1;
    if (one.uptime24h !== null) {
      uptimeSum += one.uptime24h;
      uptimeCount += 1;
    }
  }
  summary.uptime24h = uptimeCount > 0 ? uptimeSum / uptimeCount : null;
  return summary;
}

/** How many targets have an incident open, for the menu badge and the project tab. */
export function openIncidentCount(targets: readonly HealthTargetSummary[] | undefined): number {
  return (targets ?? []).filter((one) => one.openIncident !== null).length;
}

/** The host a card shows. The path and query never appear, since a query can carry a token. */
export function targetHost(url: string): string {
  try {
    return new URL(url).host || url.split(/[?#]/)[0];
  } catch {
    return url.split(/[?#]/)[0].trim();
  }
}

export function formatUptime(share: number | null): string {
  if (share === null) return 'No data';
  const percent = share * 100;
  if (percent === 100) return '100%';
  return `${percent >= 99 ? percent.toFixed(2) : percent.toFixed(1)}%`;
}

export function formatLatency(ms: number | null): string {
  if (ms === null) return 'No reading';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

function spoken(seconds: number): string {
  if (seconds < 60) return `${seconds} sec`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.floor(hours / 24)} days`;
}

export function formatAgo(at: number, now: number): string {
  const seconds = Math.floor((now - at) / 1000);
  if (seconds < 10) return 'just now';
  return `${spoken(seconds)} ago`;
}

export function formatIn(at: number, now: number): string {
  const seconds = Math.ceil((at - now) / 1000);
  if (seconds <= 0) return 'any moment';
  return `in ${spoken(seconds)}`;
}

export function formatClock(at: number): string {
  return new Date(at).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function formatSpan(fromMs: number, toMs: number): string {
  return spoken(Math.max(0, Math.round((toMs - fromMs) / 1000)));
}

export function matchesHealthSearch(one: HealthTargetSummary, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [one.name, one.serverLabel ?? '', targetHost(one.url)].some((field) =>
    field.toLowerCase().includes(needle),
  );
}

export const NO_ENVIRONMENT = 'No environment';

export interface HealthEnvironmentGroup {
  /** Null for the targets that belong to no environment. */
  environmentId: string | null;
  name: string;
  targets: HealthTargetSummary[];
}

export interface HealthProjectGroup {
  projectId: string;
  projectName: string;
  environments: HealthEnvironmentGroup[];
}

/** Projects by name; inside each, environments in the order the Environments tab keeps. */
export function groupHealthTargets(
  targets: readonly HealthTargetSummary[],
  projects: readonly Project[],
  environments: ReadonlyMap<string, ProjectEnvironment>,
): HealthProjectGroup[] {
  const byProject = new Map<string, HealthTargetSummary[]>();
  for (const one of targets) {
    byProject.set(one.projectId, [...(byProject.get(one.projectId) ?? []), one]);
  }
  const groups = [...byProject].map(([projectId, list]): HealthProjectGroup => {
    const byEnv = new Map<string | null, HealthTargetSummary[]>();
    for (const one of list) {
      const key =
        one.environmentId && environments.has(one.environmentId) ? one.environmentId : null;
      byEnv.set(key, [...(byEnv.get(key) ?? []), one]);
    }
    const envGroups = [...byEnv].map(
      ([environmentId, envTargets]): HealthEnvironmentGroup => ({
        environmentId,
        name: environmentId
          ? (environments.get(environmentId)?.name ?? NO_ENVIRONMENT)
          : NO_ENVIRONMENT,
        targets: [...envTargets].sort((a, b) => a.name.localeCompare(b.name)),
      }),
    );
    envGroups.sort((a, b) => {
      if (a.environmentId === null) return 1;
      if (b.environmentId === null) return -1;
      const orderA = environments.get(a.environmentId)?.order ?? 0;
      const orderB = environments.get(b.environmentId)?.order ?? 0;
      return orderA - orderB || a.name.localeCompare(b.name);
    });
    return {
      projectId,
      projectName: projects.find((p) => p.id === projectId)?.name ?? 'Unknown project',
      environments: envGroups,
    };
  });
  return groups.sort((a, b) => a.projectName.localeCompare(b.projectName));
}

/* The add and edit form. */

export type IntervalChoice = `${(typeof HEALTH_INTERVAL_PRESETS)[number]}` | 'custom';

export interface HealthDraft {
  projectId: string;
  environmentId: string;
  name: string;
  serverLabel: string;
  /** "ssh:<id>" or "wordpress:<id>", or empty for no link. */
  serverLink: string;
  url: string;
  intervalChoice: IntervalChoice;
  customInterval: string;
  timeout: string;
  authMode: HealthAuthMode;
  basicUser: string;
  allowInsecure: boolean;
  autoDiagnose: boolean;
}

export type HealthDraftErrors = Partial<
  Record<'projectId' | 'name' | 'url' | 'interval' | 'timeout' | 'basicUser', string>
>;

const PRESET_SET = new Set<number>(HEALTH_INTERVAL_PRESETS);

export function emptyHealthDraft(projectId: string): HealthDraft {
  return {
    projectId,
    environmentId: '',
    name: '',
    serverLabel: '',
    serverLink: '',
    url: '',
    intervalChoice: `${HEALTH_INTERVAL_DEFAULT_SEC}` as IntervalChoice,
    customInterval: '',
    timeout: String(HEALTH_TIMEOUT_DEFAULT_SEC),
    authMode: 'bearer',
    basicUser: '',
    allowInsecure: false,
    autoDiagnose: true,
  };
}

export function serverLinkValue(link: HealthServerLink | null): string {
  return link ? `${link.kind}:${link.id}` : '';
}

function parseServerLink(value: string): HealthServerLink | null {
  const match = /^(ssh|wordpress):(.+)$/.exec(value);
  return match ? { kind: match[1] as HealthServerLink['kind'], id: match[2] } : null;
}

export function healthDraftFromTarget(one: HealthTargetSummary): HealthDraft {
  const preset = PRESET_SET.has(one.intervalSec);
  return {
    projectId: one.projectId,
    environmentId: one.environmentId ?? '',
    name: one.name,
    serverLabel: one.serverLabel ?? '',
    serverLink: serverLinkValue(one.serverLink),
    url: one.url,
    intervalChoice: preset ? (`${one.intervalSec}` as IntervalChoice) : 'custom',
    customInterval: preset ? '' : String(one.intervalSec),
    timeout: String(one.timeoutSec),
    authMode: one.authMode,
    basicUser: one.basicUser ?? '',
    allowInsecure: one.allowInsecure,
    autoDiagnose: one.autoDiagnose,
  };
}

function draftInterval(draft: HealthDraft): number {
  return Number(draft.intervalChoice === 'custom' ? draft.customInterval : draft.intervalChoice);
}

export function healthDraftToInput(draft: HealthDraft): HealthTargetInput {
  const serverLabel = draft.serverLabel.trim();
  return {
    projectId: draft.projectId,
    environmentId: draft.environmentId || null,
    name: draft.name.trim(),
    serverLabel: serverLabel || null,
    serverLink: parseServerLink(draft.serverLink),
    url: draft.url.trim(),
    intervalSec: draftInterval(draft),
    timeoutSec: Number(draft.timeout),
    authMode: draft.authMode,
    basicUser: draft.authMode === 'basic' ? draft.basicUser.trim() : null,
    allowInsecure: draft.allowInsecure,
    autoDiagnose: draft.autoDiagnose,
  };
}

/** Plain http to this computer never leaves it, so it needs no warning. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host);
}

/** Whether the URL is plain http to another machine, which the insecure switch must allow. */
export function isInsecureRemote(url: string): boolean {
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === 'http:' && !isLoopbackHost(parsed.hostname);
  } catch {
    return false;
  }
}

function wholeIn(value: string, min: number, max: number): boolean {
  if (!/^\d+$/.test(value.trim())) return false;
  const n = Number(value);
  return n >= min && n <= max;
}

export function validateHealthDraft(draft: HealthDraft): HealthDraftErrors {
  const errors: HealthDraftErrors = {};
  if (!draft.projectId) errors.projectId = 'Pick the project this endpoint belongs to.';
  if (!draft.name.trim()) errors.name = 'Give it a short name, like API or Storefront.';

  const url = draft.url.trim();
  let parsed: URL | null = null;
  try {
    parsed = new URL(url);
  } catch {
    parsed = null;
  }
  if (!url) errors.url = 'Paste the address of the health endpoint.';
  else if (!parsed || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) {
    errors.url = 'Use a full address that starts with https://.';
  } else if (parsed.username || parsed.password) {
    errors.url = 'Leave the sign-in out of the address. Runova sends it in a header.';
  } else if (isInsecureRemote(url) && !draft.allowInsecure) {
    errors.url =
      'This is plain http to another machine. Use https, or turn on Allow insecure HTTP.';
  }

  const intervalOk =
    draft.intervalChoice !== 'custom' ||
    wholeIn(draft.customInterval, HEALTH_INTERVAL_MIN_SEC, HEALTH_INTERVAL_MAX_SEC);
  if (!intervalOk) {
    errors.interval = `Enter whole seconds from ${HEALTH_INTERVAL_MIN_SEC} to ${HEALTH_INTERVAL_MAX_SEC.toLocaleString('en-US')}.`;
  }

  if (!wholeIn(draft.timeout, HEALTH_TIMEOUT_MIN_SEC, HEALTH_TIMEOUT_MAX_SEC)) {
    errors.timeout = `Enter whole seconds from ${HEALTH_TIMEOUT_MIN_SEC} to ${HEALTH_TIMEOUT_MAX_SEC}.`;
  } else if (intervalOk && Number(draft.timeout) >= draftInterval(draft)) {
    errors.timeout = 'Keep the timeout shorter than the time between checks.';
  }

  if (draft.authMode === 'basic') {
    const user = draft.basicUser.trim();
    if (!user) errors.basicUser = 'HTTP Basic needs a username.';
    else if (user.includes(':')) errors.basicUser = 'A Basic username cannot contain a colon.';
  }
  return errors;
}
