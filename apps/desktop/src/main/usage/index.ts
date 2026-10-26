import {
  getUsageProvider,
  type ProviderUsage,
  USAGE_PROVIDER_REGISTRY,
  type UsageProviderConfig,
} from '@runova/core';
import { fetchApiProviderUsage } from './apiProviders';
import { clearLiveWindowCache } from './claudeAccount';
import { fetchCopilotUsage } from './copilot';
import { clearCursorAccountCache } from './cursorAccount';
import { fetchCursorSessionUsage } from './cursorSession';
import { loadKnownProjects } from './knownProjects';
import { createLimitsMemory } from './lastLimits';
import { scanLocalProvider } from './localScanner';
import type { LocalLogProvider } from './logParsers';
import { connectUsage, errorFromReason, PartialUsageError } from './shared';

const CACHE_TTL_MS = 30_000;

const LOCAL_LOG_PROVIDERS = new Set<string>([
  'claude-code',
  'codex',
  'copilot',
  'opencode',
  'gemini-cli',
]);

interface CacheEntry {
  at: number;
  promise: Promise<ProviderUsage>;
}
const cache = new Map<string, CacheEntry>();
/** The plan limits each provider last reported, so a failed read can still show them. */
const limitsMemory = createLimitsMemory();

async function computeUsage(
  providerId: string,
  config: UsageProviderConfig | undefined,
): Promise<ProviderUsage> {
  const def = getUsageProvider(providerId);
  if (!def) return connectUsage(providerId);

  switch (def.dataSource) {
    case 'local-log':
      if (!LOCAL_LOG_PROVIDERS.has(providerId)) return connectUsage(providerId);
      // OpenCode keeps its totals in a SQLite database rather than JSONL
      // transcripts, so it has its own driver with the same card shape.
      if (providerId === 'opencode') {
        const { scanOpencodeUsage } = await import('./opencode');
        return scanOpencodeUsage({ knownProjects: loadKnownProjects });
      }
      // Copilot reads the metrics API first when a token + org are set, and its
      // CLI logs otherwise, so it goes through its own driver either way.
      if (providerId === 'copilot') {
        return fetchCopilotUsage(config, {
          scanLocal: () => scanLocalProvider('copilot', { knownProjects: loadKnownProjects }),
        });
      }
      return scanLocalProvider(providerId as LocalLogProvider, {
        knownProjects: loadKnownProjects,
      });
    case 'local-session':
      if (providerId !== 'cursor') return connectUsage(providerId);
      // A team Admin key still wins when the user has entered one: it reports
      // the per-call Auto/API split, which the dashboard session cannot.
      if (config?.apiKey) return fetchApiProviderUsage(providerId, config);
      return fetchCursorSessionUsage();
    case 'api-key':
      return fetchApiProviderUsage(providerId, config);
    default:
      return connectUsage(providerId);
  }
}

/** Cached per-provider usage. Local-log scans and API calls are memoized ~30s. */
export function getProviderUsage(
  providerId: string,
  config: UsageProviderConfig | undefined,
  force = false,
): Promise<ProviderUsage> {
  const cached = cache.get(providerId);
  if (!force && cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.promise;
  }
  const promise = computeUsage(providerId, config).then(
    (usage) => {
      limitsMemory.observe(providerId, usage);
      // Start the TTL when the scan finishes, not when it started. Otherwise a
      // scan slower than the TTL is stale the moment it lands and we rescan
      // on every single poll.
      const entry = cache.get(providerId);
      if (entry?.promise === promise) entry.at = Date.now();
      return usage;
    },
    (err: unknown) => {
      // A partial read still got the plan limits, so they are remembered even though the read fails.
      if (err instanceof PartialUsageError) {
        limitsMemory.observe(providerId, errorFromReason(providerId, err));
      }
      // Only the newest entry may be dropped. An older read that fails late must not evict a fresher one.
      if (cache.get(providerId)?.promise === promise) cache.delete(providerId); // don't cache a hard failure
      throw err;
    },
  );
  cache.set(providerId, { at: Date.now(), promise });
  return promise;
}

/**
 * The snapshot a list or a refresh hands out for one provider: its read, or the failure folded into
 * an error card, with the last known limits attached when this read could not get its own.
 */
function snapshotOf(
  providerId: string,
  outcome: PromiseSettledResult<ProviderUsage>,
): ProviderUsage {
  if (outcome.status === 'fulfilled') return limitsMemory.attach(providerId, outcome.value);
  // biome-ignore lint/suspicious/noConsole: surfaces provider scan failures so they aren't silent
  console.warn(`[usage] ${providerId} failed:`, outcome.reason);
  return limitsMemory.attach(providerId, errorFromReason(providerId, outcome.reason));
}

/**
 * Usage for every provider the user has enabled. Local-log providers
 * (Claude Code, Codex, Copilot, OpenCode, Gemini CLI) are always included since they need no config.
 * One provider failing must not blank out the others, so failures are folded
 * into that provider's own card as an error state.
 */
export async function getAllUsage(
  configs: Record<string, UsageProviderConfig>,
  force = false,
): Promise<ProviderUsage[]> {
  const targets = USAGE_PROVIDER_REGISTRY.filter((def) => {
    // Credential-free sources need no setup, so they're always on. That's what
    // makes these cards appear by themselves.
    if (def.dataSource === 'local-log' || def.dataSource === 'local-session') return true;
    return configs[def.id]?.enabled;
  });

  const settled = await Promise.allSettled(
    targets.map((def) => getProviderUsage(def.id, configs[def.id], force)),
  );

  return settled.map((outcome, i) => snapshotOf(targets[i].id, outcome));
}

export function clearUsageCache(): void {
  cache.clear();
  clearLiveWindowCache();
  clearCursorAccountCache();
}

/** Same as {@link clearUsageCache}, scoped to one provider. Used by per-card refresh. */
export function clearProviderUsageCache(providerId: string): void {
  cache.delete(providerId);
  if (providerId === 'claude-code') clearLiveWindowCache();
  if (providerId === 'cursor') clearCursorAccountCache();
}

/**
 * Re-reads one provider from scratch: its cache, and the account and quota caches behind it, are
 * dropped first. A failure comes back as an error card, so the caller never has to catch.
 */
export async function refreshProviderUsage(
  providerId: string,
  config: UsageProviderConfig | undefined,
): Promise<ProviderUsage> {
  clearProviderUsageCache(providerId);
  const [outcome] = await Promise.allSettled([getProviderUsage(providerId, config, true)]);
  return snapshotOf(providerId, outcome);
}
