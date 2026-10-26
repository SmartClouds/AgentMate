import { z } from 'zod';
import { LEGACY_HEALTH_CHECK_KEY } from '../legacyNames.js';
import { redactHealthText } from './redact.js';
import type {
  HealthCheckStatus,
  HealthProbeState,
  HealthReport,
  HealthServiceError,
  HealthServiceResult,
} from './types.js';

/**
 * Turns an endpoint's answer into a `HealthReport`. The body follows the IETF draft "Health Check
 * Response Format for HTTP APIs" with a `runova` extension per check for error details.
 *
 * The parser is strict about what decides the verdict (the top-level `status`) and lenient about
 * everything else: one malformed check entry is skipped, not allowed to hide the rest. Every
 * string is redacted and trimmed here, so nothing downstream ever holds the raw text.
 */

const MAX_MESSAGE = 2_000;
const MAX_DETAIL = 4_000;
const MAX_STACK = 8_000;
const MAX_SHORT = 200;
const MAX_HINT = 1_000;
const MAX_RAW = 64_000;
const MAX_SERVICES = 200;

const STATUS_WORDS: Record<string, HealthCheckStatus> = {
  pass: 'pass',
  ok: 'pass',
  up: 'pass',
  warn: 'warn',
  fail: 'fail',
  error: 'fail',
  down: 'fail',
};

const RANK: Record<HealthCheckStatus, number> = { pass: 0, warn: 1, fail: 2 };

function statusOf(value: unknown): HealthCheckStatus | null {
  return typeof value === 'string' ? (STATUS_WORDS[value.trim().toLowerCase()] ?? null) : null;
}

const text = z.string().optional();

const extraSchema = z
  .object({
    errorCode: z.union([z.string(), z.number()]).optional(),
    detail: text,
    stack: text,
    hint: text,
    since: text,
  })
  .partial()
  .optional()
  .catch(undefined);

const checkEntrySchema = z.object({
  componentId: text,
  componentType: text,
  status: z.string(),
  time: text,
  observedValue: z.union([z.string(), z.number(), z.boolean()]).nullable().optional(),
  observedUnit: text,
  output: text,
  runova: extraSchema,
  // Endpoints built before the app was renamed put the details under the old name.
  [LEGACY_HEALTH_CHECK_KEY]: extraSchema,
});

export interface HealthResponseInput {
  httpStatus: number;
  contentType: string | null;
  body: string;
  latencyMs: number | null;
  checkedAt: number;
  /** Literal secrets to mask wherever they show up, such as the key that was sent. */
  knownSecrets?: readonly string[];
}

function trim(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}\n(trimmed)`;
}

function baseReport(input: {
  httpStatus: number | null;
  latencyMs: number | null;
  checkedAt: number;
}) {
  return {
    httpStatus: input.httpStatus,
    latencyMs: input.latencyMs,
    checkedAt: input.checkedAt,
    serviceId: null,
    description: null,
    releaseId: null,
    version: null,
    output: null,
    services: [],
  } satisfies Omit<HealthReport, 'state' | 'problem' | 'raw'>;
}

/** A report for a probe that never got an answer to read (a timeout, a refused connection). */
export function probeFailureReport(
  problem: string,
  checkedAt: number,
  state: Extract<HealthProbeState, 'unreachable' | 'invalid'> = 'unreachable',
): HealthReport {
  return {
    ...baseReport({ httpStatus: null, latencyMs: null, checkedAt }),
    state,
    problem: redactHealthText(problem),
    raw: null,
  };
}

export function parseHealthResponse(input: HealthResponseInput): HealthReport {
  const secrets = input.knownSecrets ?? [];
  const clean = (value: string, max: number) => trim(redactHealthText(value, secrets), max);
  const optional = (value: string | number | undefined, max: number) =>
    value === undefined || value === '' ? null : clean(String(value), max);
  const base = baseReport(input);
  const status = input.httpStatus;

  if (status === 401 || status === 403) {
    return {
      ...base,
      state: 'unauthorized',
      problem: `The endpoint rejected Runova's credentials (HTTP ${status}). Check that the key or password on the server matches this target.`,
      raw: null,
    };
  }
  if (status >= 300 && status < 400) {
    return {
      ...base,
      state: 'invalid',
      problem: `The endpoint answered with a redirect (HTTP ${status}). Runova does not follow redirects, so its credentials are never sent to another address. Use the final URL.`,
      raw: null,
    };
  }

  const raw = input.body.trim() === '' ? null : clean(input.body, MAX_RAW);
  let json: unknown;
  try {
    json = raw === null ? undefined : JSON.parse(input.body);
  } catch {
    json = undefined;
  }

  if (json === undefined) {
    if (status >= 500) {
      return {
        ...base,
        state: 'fail',
        problem: `The endpoint failed with HTTP ${status}${raw === null ? ' and no health report' : ' and a body that is not JSON'}.`,
        raw,
      };
    }
    if (status >= 400) {
      return {
        ...base,
        state: 'invalid',
        problem: `There is no healthcheck at this address (HTTP ${status}).`,
        raw,
      };
    }
    return {
      ...base,
      state: 'invalid',
      problem:
        raw === null
          ? `The endpoint answered HTTP ${status} with an empty body.`
          : 'The endpoint answered, but the body is not JSON, so it does not follow the Runova Health Protocol.',
      raw,
    };
  }

  const pretty = clean(JSON.stringify(json, null, 2), MAX_RAW);
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    return {
      ...base,
      state: 'invalid',
      problem: 'The report must be a JSON object with a "status" field.',
      raw: pretty,
    };
  }

  const record = json as Record<string, unknown>;
  const declared = statusOf(record.status);
  if (declared === null) {
    return {
      ...base,
      state: 'invalid',
      problem:
        record.status === undefined
          ? 'The report has no "status" field. It must be "pass", "warn" or "fail".'
          : `The report's status "${clean(String(record.status), MAX_SHORT)}" is not one of "pass", "warn" or "fail".`,
      raw: pretty,
    };
  }

  const services = readServices(record.checks, clean, optional);
  let worst: HealthCheckStatus = declared;
  if (declared === 'pass' && services.some((service) => service.status !== 'pass')) worst = 'warn';
  if (status >= 500 && worst !== 'fail') worst = 'fail';

  const top = (key: string, max = MAX_SHORT) =>
    typeof record[key] === 'string' ? optional(record[key] as string, max) : null;

  return {
    ...base,
    state: worst,
    serviceId: top('serviceId'),
    description: top('description'),
    releaseId: top('releaseId'),
    version: top('version'),
    output: top('output', MAX_MESSAGE),
    services,
    problem: null,
    raw: pretty,
  };
}

function readServices(
  checks: unknown,
  clean: (value: string, max: number) => string,
  optional: (value: string | number | undefined, max: number) => string | null,
): HealthServiceResult[] {
  if (typeof checks !== 'object' || checks === null || Array.isArray(checks)) return [];
  const services: HealthServiceResult[] = [];
  for (const [key, entries] of Object.entries(checks)) {
    if (!Array.isArray(entries)) continue;
    const valid = entries.flatMap((entry) => {
      const parsed = checkEntrySchema.safeParse(entry);
      if (!parsed.success) return [];
      const status = statusOf(parsed.data.status);
      return status ? [{ entry: parsed.data, status }] : [];
    });
    const [name, ...rest] = key.split(':');
    for (const { entry, status } of valid) {
      if (services.length >= MAX_SERVICES) return services;
      const suffix = valid.length > 1 && entry.componentId ? `#${entry.componentId}` : '';
      const extra = entry.runova ?? entry[LEGACY_HEALTH_CHECK_KEY] ?? {};
      const error: HealthServiceError | null =
        RANK[status] === 0
          ? null
          : {
              message: entry.output
                ? clean(entry.output, MAX_MESSAGE)
                : status === 'fail'
                  ? 'Reported as failing with no error message.'
                  : 'Reported as degraded with no message.',
              code: optional(extra.errorCode, MAX_SHORT),
              detail: optional(extra.detail, MAX_DETAIL),
              stack: optional(extra.stack, MAX_STACK),
              hint: optional(extra.hint, MAX_HINT),
              since: optional(extra.since, MAX_SHORT),
            };
      const observed = entry.observedValue;
      services.push({
        key: clean(`${key}${suffix}`, MAX_SHORT),
        name: clean(name, MAX_SHORT),
        measurement: rest.length > 0 ? clean(rest.join(':'), MAX_SHORT) : null,
        componentId: optional(entry.componentId, MAX_SHORT),
        componentType: optional(entry.componentType, MAX_SHORT),
        status,
        observedValue:
          observed === undefined || observed === null
            ? null
            : typeof observed === 'string'
              ? clean(observed, MAX_SHORT)
              : observed,
        observedUnit: optional(entry.observedUnit, MAX_SHORT),
        time: optional(entry.time, MAX_SHORT),
        error,
      });
    }
  }
  return services;
}
