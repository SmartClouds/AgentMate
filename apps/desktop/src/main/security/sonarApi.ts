import type { SonarHotspot, SonarIssue } from '@runova/core';
import type { ScanCancelToken } from './exec';

/**
 * The SonarQube web API, the half of the integration that does not go through Docker.
 *
 * The important thing here is the wait: `sonar-scanner` exiting 0 only means the report was
 * uploaded. The server analyzes it asynchronously, and asking for issues before that finishes
 * returns the *previous* analysis. That is a silently wrong answer, which is worse than an error,
 * so every fetch is gated behind the compute-engine task completing.
 */

/** Sonar caps issue paging at 10k regardless of what you ask for. */
const PAGE_SIZE = 500;
const MAX_PAGES = 20;
const TASK_POLL_INTERVAL_MS = 3000;
const TASK_POLL_TIMEOUT_MS = 10 * 60_000;

function authHeader(token: string): Record<string, string> {
  // Sonar takes the token as the basic-auth username with an empty password.
  return { Authorization: 'Basic ' + Buffer.from(token + ':').toString('base64') };
}

async function getJson(
  url: string,
  token: string,
  timeoutMs = 15_000,
): Promise<{ ok: boolean; data: Record<string, unknown> | null; status: number }> {
  try {
    const response = await fetch(url, {
      headers: authHeader(token),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { ok: false, data: null, status: response.status };
    return { ok: true, data: (await response.json()) as Record<string, unknown>, status: 200 };
  } catch {
    return { ok: false, data: null, status: 0 };
  }
}

/** Is the server up and finished migrating? Used by preflight and before a scan. */
export async function getSonarStatus(url: string): Promise<'up' | 'starting' | 'down'> {
  try {
    const response = await fetch(url.replace(/\/$/, '') + '/api/system/status', {
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return 'down';
    const data = (await response.json()) as { status?: string };
    if (data.status === 'UP') return 'up';
    // STARTING and the DB_MIGRATION_* states all mean "give it a minute".
    return data.status ? 'starting' : 'down';
  } catch {
    return 'down';
  }
}

/**
 * Validating beats merely checking that a token is present. A token revoked by a container reset
 * would otherwise only surface twenty minutes into a run.
 */
export async function validateSonarToken(url: string, token: string): Promise<boolean> {
  const result = await getJson(url.replace(/\/$/, '') + '/api/authentication/validate', token);
  return result.ok && result.data?.valid === true;
}

/**
 * The scanner prints the compute-engine task URL as it finishes. Reading the id out of its log is
 * more reliable than reading report-task.txt, which lives inside the container's filesystem.
 */
function taskIdFromLog(log: string): string | null {
  const direct = /ce-task-url=.*\bid=([\w-]+)/i.exec(log) ?? /taskId=([\w-]+)/i.exec(log);
  return direct ? direct[1] : null;
}

export async function waitForSonarTask(
  url: string,
  token: string,
  projectKey: string,
  scannerLog: string,
  cancel: ScanCancelToken,
): Promise<{ ok: boolean; error?: string }> {
  const base = url.replace(/\/$/, '');
  const taskId = taskIdFromLog(scannerLog);
  const deadline = Date.now() + TASK_POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (cancel.cancelled) return { ok: false, error: 'Cancelled.' };

    const endpoint = taskId
      ? `${base}/api/ce/task?id=${encodeURIComponent(taskId)}`
      : `${base}/api/ce/component?component=${encodeURIComponent(projectKey)}`;
    const result = await getJson(endpoint, token);

    if (result.ok && result.data) {
      // The two endpoints answer differently: /task returns one task, /component returns the
      // current queue plus the last finished task.
      const task = (result.data.task ?? result.data.current) as { status?: string } | undefined;
      const queue = (result.data.queue ?? []) as unknown[];
      const status = task?.status;

      if (status === 'SUCCESS' && queue.length === 0) return { ok: true };
      if (status === 'FAILED')
        return { ok: false, error: 'SonarQube failed to analyze this project.' };
      if (status === 'CANCELED')
        return { ok: false, error: 'The SonarQube analysis was cancelled.' };
    }

    await new Promise((resolve) => setTimeout(resolve, TASK_POLL_INTERVAL_MS));
  }

  return { ok: false, error: 'Timed out waiting for SonarQube to finish analyzing.' };
}

export async function fetchSonarFindings(
  url: string,
  token: string,
  projectKey: string,
): Promise<{
  issues: SonarIssue[];
  hotspots: SonarHotspot[];
  truncated: boolean;
  error?: string;
}> {
  const base = url.replace(/\/$/, '');
  const issues: SonarIssue[] = [];
  const hotspots: SonarHotspot[] = [];
  let truncated = false;

  // Filter server-side rather than locally: Sonar reports every code smell it can find, and the
  // 10k paging ceiling is only ever reached when unfiltered.
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const endpoint =
      `${base}/api/issues/search?componentKeys=${encodeURIComponent(projectKey)}` +
      `&types=VULNERABILITY&resolved=false&ps=${PAGE_SIZE}&p=${page}`;
    const result = await getJson(endpoint, token);
    if (!result.ok) {
      if (page === 1)
        return { issues, hotspots, truncated, error: 'Could not read issues from SonarQube.' };
      truncated = true;
      break;
    }
    const batch = (result.data?.issues ?? []) as SonarIssue[];
    issues.push(...batch);
    const total = Number((result.data?.paging as { total?: number } | undefined)?.total ?? 0);
    if (batch.length < PAGE_SIZE || issues.length >= total) break;
    if (page === MAX_PAGES) truncated = true;
  }

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const endpoint =
      `${base}/api/hotspots/search?projectKey=${encodeURIComponent(projectKey)}` +
      `&status=TO_REVIEW&ps=${PAGE_SIZE}&p=${page}`;
    const result = await getJson(endpoint, token);
    if (!result.ok) break;
    const batch = (result.data?.hotspots ?? []) as SonarHotspot[];
    hotspots.push(...batch);
    if (batch.length < PAGE_SIZE) break;
    if (page === MAX_PAGES) truncated = true;
  }

  return { issues, hotspots, truncated };
}
