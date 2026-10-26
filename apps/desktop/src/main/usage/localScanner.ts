import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { ProjectDaily, ProviderUsage, SubscriptionUsage, UsageWindow } from '@runova/core';
import { app } from 'electron';
import { getLiveWindows, readClaudeAccount } from './claudeAccount';
import { codexSubscription } from './codexLimits';
import {
  type LocalLogProvider,
  retentionSinceMs,
  type ScanCache,
  type ScanResult,
  scanProviderLogs,
} from './logParsers';
import { buildProjectDaily, type KnownProjects } from './projectDaily';
import { buildUsageFromEntries, makeTokens, type UsageEntry } from './shared';
import { estimateSubscriptionWindows } from './subscriptionEstimate';
import type { ScanWorkerInput, ScanWorkerMessage } from './usageScanWorker';

// Main-process driver for the local-log providers. Two things keep this cheap:
// the actual parsing runs in a worker thread (see usageScanWorker.ts), and the
// per-file byte offsets + extracted events are cached on disk so a restart
// doesn't re-read hundreds of MB of transcripts.

// 2: Codex files also keep their full rate-limit snapshot (`limits`).
// 3: Codex output no longer counts reasoning tokens twice, so cached Codex events were wrong.
// 4: Copilot reads the CLI's session.usage_record events, so cached Copilot events were wrong.
const CACHE_VERSION = 4;
const WORKER_TIMEOUT_MS = 120_000;

interface CacheFile {
  version: number;
  providers: Partial<Record<LocalLogProvider, ScanCache>>;
}

function cachePath(): string {
  return join(app.getPath('userData'), 'usage-scan-cache.json');
}

let cachesPromise: Promise<CacheFile> | null = null;

function loadCaches(): Promise<CacheFile> {
  cachesPromise ??= readFile(cachePath(), 'utf-8')
    .then((raw) => {
      const parsed = JSON.parse(raw) as CacheFile;
      if (parsed.version !== CACHE_VERSION) throw new Error('stale cache');
      return { version: CACHE_VERSION, providers: parsed.providers ?? {} };
    })
    .catch(() => ({ version: CACHE_VERSION, providers: {} }));
  return cachesPromise;
}

async function saveCache(provider: LocalLogProvider, cache: ScanCache): Promise<void> {
  const caches = await loadCaches();
  caches.providers[provider] = cache;
  try {
    await mkdir(dirname(cachePath()), { recursive: true });
    await writeFile(cachePath(), JSON.stringify(caches), 'utf-8');
  } catch {
    /* cache is an optimization, a failed write just means a slower next scan */
  }
}

/**
 * Resolve the bundled worker script. Packaged builds unpack it from the asar
 * archive (see `asarUnpack` in electron-builder.yml) because the Node worker
 * loader reads it straight off disk.
 */
function workerScriptPath(): string | null {
  const bundled = join(__dirname, 'usageScanWorker.mjs');
  const unpacked = bundled.replace(`app.asar${sep}`, `app.asar.unpacked${sep}`);
  if (unpacked !== bundled && existsSync(unpacked)) return unpacked;
  return existsSync(bundled) ? bundled : null;
}

function runInWorker(input: ScanWorkerInput): Promise<ScanResult> {
  const script = workerScriptPath();
  if (!script) return Promise.reject(new Error('scan worker not found'));

  return new Promise<ScanResult>((resolve, reject) => {
    const worker = new Worker(script, { workerData: input });
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      fn();
    };
    const timer = setTimeout(
      () => settle(() => reject(new Error('usage scan timed out'))),
      WORKER_TIMEOUT_MS,
    );

    worker.on('message', (msg: ScanWorkerMessage) => {
      settle(() => (msg.ok ? resolve(msg.result) : reject(new Error(msg.error))));
    });
    worker.on('error', (err) => settle(() => reject(err)));
    worker.on('exit', (code) => {
      settle(() => reject(new Error(`scan worker exited before reporting (code ${code})`)));
    });
  });
}

function toUsageWindow(window: ScanResult['window']): UsageWindow | undefined {
  if (!window) return undefined;
  // Drop `at`, which only exists so the freshest snapshot wins during the scan.
  return {
    label: window.label,
    used: window.used,
    total: window.total,
    percent: window.percent,
    resetAt: window.resetAt,
  };
}

/**
 * The folder of every raw entry, in order. `sources` runs parallel to `entries`, so the expanded
 * list lines up index for index. A result without sources leaves every folder unknown.
 */
function foldersOf(result: ScanResult): (string | null | undefined)[] {
  const folders: (string | null | undefined)[] = [];
  for (const source of result.sources ?? []) {
    for (let i = 0; i < source.count; i += 1) folders.push(source.folder);
  }
  return folders;
}

/** Flatten worker output into priced entries, dropping duplicates. */
function toEntries(result: ScanResult): UsageEntry[] {
  // Dedupe by message id: the same assistant message can appear in both the
  // main transcript and a summary/compact file. The first copy wins, folder included.
  const seen = new Set<string>();
  const folders = foldersOf(result);
  const entries: UsageEntry[] = [];
  for (const [index, raw] of result.entries.entries()) {
    if (raw.id) {
      if (seen.has(raw.id)) continue;
      seen.add(raw.id);
    }
    entries.push({
      at: new Date(raw.at),
      model: raw.model,
      tokens: makeTokens(raw.input, raw.output, raw.cacheRead, raw.cacheWrite),
      folder: folders[index] ?? null,
    });
  }
  return entries;
}

/** What a scan may ask the app about its projects. Optional, and a failure never fails the scan. */
export interface LocalScanOptions {
  knownProjects?: () => Promise<KnownProjects>;
}

/**
 * The per-project split for the chart. Asking for the project list and building the split can
 * both fail: the split then falls back to folder names, or is left out. The totals never depend
 * on either.
 */
async function projectDailyFor(
  entries: UsageEntry[],
  options: LocalScanOptions,
): Promise<ProjectDaily | undefined> {
  let known: KnownProjects | undefined;
  try {
    known = await options.knownProjects?.();
  } catch {
    known = undefined;
  }
  try {
    return buildProjectDaily(entries, { now: Date.now(), known });
  } catch (err) {
    // biome-ignore lint/suspicious/noConsole: a broken project split should be visible, not silently missing
    console.warn('[usage] project split failed:', err);
    return undefined;
  }
}

/**
 * Plan + rolling-limit state for Claude Code. Prefers the account's own numbers
 * and falls back to reconstructing the windows from the transcripts we just
 * scanned, so a signed-in user offline still sees where they stand.
 */
async function claudeSubscription(entries: UsageEntry[]): Promise<SubscriptionUsage> {
  const account = await readClaudeAccount();

  if (account.mode === 'api') {
    return { mode: 'api', plan: null, windows: [], source: 'account' };
  }

  if (account.accessToken) {
    const live = await getLiveWindows(account.accessToken, account.plan);
    if (live) {
      return {
        mode: 'subscription',
        plan: account.plan,
        windows: live.windows,
        source: 'account',
        readAt: live.readAt,
      };
    }
  }

  return {
    mode: 'subscription',
    plan: account.plan,
    windows: estimateSubscriptionWindows(entries, account.plan, account.weeklyAnchor),
    source: 'estimate',
    estimateReason: account.tokenExpired
      ? 'signed out of the CLI'
      : account.accessToken
        ? 'account unreachable'
        : 'no CLI login found',
  };
}

/**
 * Usage for a local-log provider. Runs the scan off-thread; if the worker can't
 * start (unexpected packaging layout, for instance) it falls back to scanning
 * in-process, which is still incremental and streamed rather than slurping every
 * file into memory.
 */
export async function scanLocalProvider(
  provider: LocalLogProvider,
  options: LocalScanOptions = {},
): Promise<ProviderUsage> {
  const caches = await loadCaches();
  const input: ScanWorkerInput = {
    provider,
    cache: caches.providers[provider] ?? {},
    sinceMs: retentionSinceMs(),
  };

  let result: ScanResult;
  try {
    result = await runInWorker(input);
  } catch (err) {
    // biome-ignore lint/suspicious/noConsole: surfaces the fallback so a worker scan failure isn't silent
    console.warn(`[usage] worker scan failed for ${provider}, falling back in-process:`, err);
    result = await scanProviderLogs(input.provider, input.cache, input.sinceMs);
  }

  await saveCache(provider, result.cache);

  const entries = toEntries(result);
  const usage = buildUsageFromEntries(provider, entries, toUsageWindow(result.window));
  if (provider === 'claude-code') {
    usage.subscription = await claudeSubscription(entries);
  } else if (provider === 'codex') {
    usage.subscription = codexSubscription(result.limits);
  }
  const projectDaily = await projectDailyFor(entries, options);
  if (projectDaily) usage.projectDaily = projectDaily;
  return usage;
}
