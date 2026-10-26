import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  ScannerRunResult,
  ScanPhase,
  SecurityFinding,
  SecurityScannerId,
  SecurityScanOptions,
  SecurityScanProgress,
  SecurityScanRecord,
} from '@runova/core';
import {
  maskKnownSecrets,
  redactSecretFindings,
  SECURITY_SCANNERS,
  scoreSecurityFindings,
  sortSecurityFindings,
} from '@runova/core';
import { app } from 'electron';
import type { ActiveScan } from '../../shared/apiTypes';
import { IPC } from '../../shared/ipcChannels';
import { broadcastToWindows } from '../ipc/send';
import { securityScanDb } from '../securityScanDb';
import { SCANNER_ADAPTERS, type SecurityScannerConfig } from './adapters';
import type { ScanCancelToken } from './exec';
import { trimLog } from './exec';
import { checkAllPreflight, clearPreflightCache } from './preflight';

/**
 * Orchestrates one security scan.
 *
 * Scanners run in three phases rather than through a scheduler, because the ordering is a real
 * decision rather than a resource-allocation problem:
 *   1. Fast native scanners in parallel, so the report has something in it within about a minute.
 *   2. Docker-backed scanners one at a time, because they bind-mount the same project and on
 *      Windows the mount is the bottleneck, not the CPU.
 *   3. The heavy ones last, so a user who has already seen most of the value can cancel before
 *      CodeQL spends half an hour or Strix spends real money.
 */

interface RunState {
  cancelled: boolean;
  /**
   * One token per scanner, not one per run. Phase 1 runs two scanners at once, and a shared
   * token has a single `child` slot: the second spawn would overwrite the first's handle, and
   * cancelling would kill only one of them while the other kept running.
   */
  tokens: Set<ScanCancelToken>;
  containers: Set<string>;
  workspaceDir: string;
}

/** Keyed by project: one scan per project at a time, which is all the UI can start anyway. */
const activeScans = new Map<string, ActiveScan>();

/** How many output lines to keep per scanner for a rejoining view. */
const MAX_ACTIVE_LINES = 200;

export function getActiveScan(projectId: string): ActiveScan | null {
  return activeScans.get(projectId) ?? null;
}

const runningScans = new Map<string, RunState>();
/** Cancel can arrive before the run has spawned anything, and it has to still take effect. */
const cancelledBeforeStart = new Set<string>();

const GLOBAL_BUDGET_MS = 90 * 60_000;

export interface RunScanInput {
  projectId: string;
  projectName: string;
  projectPath: string;
  options: SecurityScanOptions;
  config: SecurityScannerConfig;
}

export function cancelSecurityScan(runId: string): boolean {
  const state = runningScans.get(runId);
  if (!state) {
    cancelledBeforeStart.add(runId);
    return true;
  }
  state.cancelled = true;
  for (const token of state.tokens) {
    token.cancelled = true;
    const child = token.child;
    if (!child) continue;
    // Kill the whole tree: scanners spawn Python workers, JVMs and docker clients, and killing
    // only the direct child would leave all of them running.
    if (process.platform === 'win32' && child.pid) {
      execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {
        // Best effort: the tree may already have exited on its own.
      });
    } else {
      child.kill('SIGTERM');
    }
  }
  removeContainers(state);
  return true;
}

/**
 * Killing `docker run` does not stop the container it started, which is why every container gets
 * an explicit name rather than being anonymous.
 */
function removeContainers(state: RunState): void {
  for (const name of state.containers) {
    execFile('docker', ['rm', '-f', name], { windowsHide: true }, () => {
      // Best effort: the container may already be gone.
    });
  }
  state.containers.clear();
}

/** Sweeps containers left behind by a crash, so a stale one never blocks the next run. */
export function sweepOrphanScanContainers(): void {
  execFile(
    'docker',
    ['ps', '-aq', '--filter', 'name=runova-scan-'],
    { windowsHide: true },
    (error, stdout) => {
      if (error) return;
      const ids = stdout.trim().split('\n').filter(Boolean);
      if (ids.length > 0) {
        execFile('docker', ['rm', '-f', ...ids], { windowsHide: true }, () => {
          // Best effort: this is a startup sweep, not something to report on.
        });
      }
    },
  );
}

function skippedRun(scannerId: SecurityScannerId, reason: string): ScannerRunResult {
  return {
    scannerId,
    status: 'skipped',
    transport: 'native',
    toolVersion: null,
    findingCount: 0,
    durationMs: 0,
    exitCode: null,
    truncated: false,
    error: reason,
    warnings: [],
    log: null,
  };
}

export async function runSecurityScan(
  runId: string,
  input: RunScanInput,
): Promise<SecurityScanRecord> {
  const startedAt = Date.now();
  // A short id keeps the CodeQL database path well clear of the Windows path length limit, since
  // it nests several levels under AppData.
  const shortId = runId.slice(0, 8);
  const workspaceDir = join(app.getPath('userData'), 'security-scans', shortId);

  const state: RunState = {
    cancelled: cancelledBeforeStart.delete(runId),
    tokens: new Set(),
    containers: new Set(),
    workspaceDir,
  };
  runningScans.set(runId, state);

  const runs: ScannerRunResult[] = [];
  const findings: SecurityFinding[] = [];
  const selected = SECURITY_SCANNERS.filter((s) => input.options.scannerIds.includes(s.id));
  const secrets = [input.config.strixApiKey, input.config.sonarToken];

  const active: ActiveScan = {
    runId,
    projectId: input.projectId,
    startedAt,
    scannerIds: selected.map((s) => s.id),
    scanners: [],
    completedScanners: 0,
    totalScanners: selected.length,
  };
  activeScans.set(input.projectId, active);

  const emit = (
    scannerId: SecurityScannerId | null,
    phase: ScanPhase,
    message: string,
    run?: ScannerRunResult,
  ): void => {
    // A scanner can echo its own environment on failure, so nothing reaches the renderer
    // without the known secrets stripped out of it first.
    const safeMessage = maskKnownSecrets(message, secrets).slice(0, 400);

    if (scannerId) {
      let entry = active.scanners.find((e) => e.scannerId === scannerId);
      if (!entry) {
        entry = { scannerId, phase, message: safeMessage, startedAt: Date.now(), lines: [] };
        active.scanners.push(entry);
      }
      entry.phase = phase;
      entry.message = safeMessage;
      entry.lines.push(safeMessage);
      if (entry.lines.length > MAX_ACTIVE_LINES) {
        entry.lines.splice(0, entry.lines.length - MAX_ACTIVE_LINES);
      }
    }
    active.completedScanners = runs.length;

    const progress: SecurityScanProgress = {
      runId,
      projectId: input.projectId,
      scannerId,
      phase,
      message: safeMessage,
      completedScanners: runs.length,
      totalScanners: selected.length,
      elapsedMs: Date.now() - startedAt,
      run,
    };
    // Broadcast rather than reply to the invoking sender: the view that started the scan may be
    // long gone, and a window reload would destroy that sender entirely.
    broadcastToWindows(IPC.security.onScanProgress, progress);
  };

  try {
    await mkdir(workspaceDir, { recursive: true });

    emit(null, 'preflight', 'Checking requirements');
    const preflight = await checkAllPreflight({
      projectPath: input.projectPath,
      config: input.config,
      codeqlLanguage: input.options.codeqlLanguage,
      codeqlBuildCommand: input.options.codeqlBuildCommand,
      sonarProjectKey: input.options.sonarProjectKey,
    });

    for (const phase of [1, 2, 3] as const) {
      if (state.cancelled) break;
      const inPhase = selected.filter((s) => s.phase === phase);
      if (inPhase.length === 0) continue;

      const runOne = async (scannerId: SecurityScannerId): Promise<void> => {
        if (state.cancelled) {
          runs.push(skippedRun(scannerId, 'Cancelled before this scanner started.'));
          return;
        }
        if (Date.now() - startedAt > GLOBAL_BUDGET_MS) {
          runs.push(skippedRun(scannerId, 'The overall time budget for this scan ran out.'));
          return;
        }

        // Re-check right before starting rather than trusting the top-of-run result: Docker can
        // be stopped, and the Sonar container can die, during a 45-minute CodeQL phase.
        const check = preflight.find((p) => p.scannerId === scannerId);
        const blocker = check?.requirements.find((r) => r.status === 'unmet' && r.blocking);
        if (blocker) {
          const run = skippedRun(scannerId, blocker.remedy);
          runs.push(run);
          emit(scannerId, 'skipped', blocker.remedy, run);
          return;
        }

        const scannerStart = Date.now();
        const adapter = SCANNER_ADAPTERS[scannerId];
        const workDir = join(workspaceDir, scannerId);
        await mkdir(workDir, { recursive: true });

        emit(scannerId, 'queued', 'Starting');
        // This scanner's own token, so a cancel reaches it even while a sibling runs alongside.
        const token: ScanCancelToken = { cancelled: state.cancelled, child: null };
        state.tokens.add(token);

        const outcome = await adapter.run({
          scannerId,
          projectPath: input.projectPath,
          workDir,
          options: input.options,
          token,
          emit: (p, message) => emit(scannerId, p, message),
          config: input.config,
          registerContainer: (name) => state.containers.add(name),
          runId: shortId,
        });

        // Nearly every one of these tools uses a non-zero exit to mean "found something", so a
        // parsed report with findings in it is success regardless of the exit code. Discarding a
        // 900-finding report because one file failed to parse would be the worst outcome here.
        const succeeded = outcome.findings.length > 0 || !outcome.error;
        const status: ScannerRunResult['status'] = outcome.cancelled
          ? 'cancelled'
          : outcome.timedOut
            ? 'timed-out'
            : succeeded
              ? 'ok'
              : 'failed';

        const run: ScannerRunResult = {
          scannerId,
          status,
          transport: outcome.transport,
          toolVersion: outcome.toolVersion,
          findingCount: outcome.findings.length,
          durationMs: Date.now() - scannerStart,
          exitCode: outcome.exitCode,
          truncated: outcome.truncated,
          error: status === 'ok' ? null : outcome.error,
          warnings: outcome.warnings,
          log: outcome.log ? trimLog(maskKnownSecrets(outcome.log, secrets)) : null,
        };
        runs.push(run);
        findings.push(...outcome.findings);
        emit(scannerId, status === 'ok' ? 'done' : 'failed', run.error ?? 'Done', run);
      };

      // Phase 1 is the only one that overlaps; everything after it is serialized on purpose.
      if (phase === 1) await Promise.all(inPhase.map((s) => runOne(s.id)));
      else for (const scanner of inPhase) await runOne(scanner.id);
    }

    // Secret scanners put the matched credential in the finding text, and this report has a copy
    // button, so masking happens here, before anything crosses IPC.
    const safe = redactSecretFindings(findings);
    const { score, verdict, counts } = scoreSecurityFindings(safe);

    const anyFailed = runs.some((r) => r.status === 'failed' || r.status === 'timed-out');
    const anySkipped = runs.some((r) => r.status === 'skipped');
    const status: SecurityScanRecord['status'] = state.cancelled
      ? 'cancelled'
      : runs.every((r) => r.status !== 'ok')
        ? 'failed'
        : anyFailed || anySkipped
          ? 'partial'
          : 'complete';

    const record: SecurityScanRecord = {
      id: runId,
      projectId: input.projectId,
      projectName: input.projectName,
      status,
      verdict,
      score,
      findings: sortSecurityFindings(safe),
      runs,
      counts,
      durationMs: Date.now() - startedAt,
      options: input.options,
      createdAt: new Date().toISOString(),
    };

    // Saved here rather than by the caller so the record is on disk before the active-scan
    // snapshot is dropped. A view watching for that snapshot to disappear is then guaranteed to
    // find the finished report, and a scan whose caller walked away is still recorded.
    if (record.status !== 'cancelled' || record.findings.length > 0) {
      securityScanDb.add(record);
    }
    return record;
  } finally {
    runningScans.delete(runId);
    activeScans.delete(input.projectId);
    removeContainers(state);
    clearPreflightCache();
    // CodeQL databases are gigabytes, so the workspace always goes, even on failure.
    await rm(workspaceDir, { recursive: true, force: true }).catch(() => {
      // A locked file (an antivirus scan mid-delete, say) is not worth failing the scan over;
      // the startup sweep picks up anything left behind.
    });
  }
}

/**
 * Stops every in-flight scan. Called on quit: a scan owns real child processes and, for the
 * dockerized scanners, real containers, and leaving those behind after the window closes would
 * keep chewing CPU with nothing to report back to.
 */
export function cancelAllSecurityScans(): void {
  for (const runId of [...runningScans.keys()]) cancelSecurityScan(runId);
}

export function newScanRunId(): string {
  return randomUUID();
}
