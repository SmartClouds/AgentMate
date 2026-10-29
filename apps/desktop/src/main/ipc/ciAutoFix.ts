import { ipcMain } from 'electron';
import type {
  AutoFixSession,
  AutoFixStartInput,
  AutoFixStartResult,
} from '../../shared/ciAutoFixTypes';
import { IPC } from '../../shared/ipcChannels';
import { safeBranchName } from '../git/plumbing';
import { ciAutoFixService } from '../pipelines/autoFix/wiring';

const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;
const INVALID: AutoFixStartResult = { ok: false, error: 'That auto-fix request was not valid.' };

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isBranch(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    // safeBranchName tidies spaces into dashes, which would push to some other branch.
    return safeBranchName(value) === value;
  } catch {
    return false;
  }
}

/** The request with only the fields auto-fix knows, or null when one of them is not right. */
export function parseStartInput(raw: unknown): AutoFixStartInput | null {
  if (!raw || typeof raw !== 'object') return null;
  const input = raw as Record<string, unknown>;
  if (typeof input.projectId !== 'string' || !input.projectId) return null;
  if (typeof input.repo !== 'string' || !REPO_PATTERN.test(input.repo)) return null;
  if (!isPositiveInt(input.workflowId)) return null;
  if (typeof input.workflowName !== 'string') return null;
  if (!isBranch(input.branch)) return null;
  const parsed: AutoFixStartInput = {
    projectId: input.projectId,
    repo: input.repo,
    workflowId: input.workflowId,
    workflowName: input.workflowName || 'CI',
    branch: input.branch,
  };
  if (input.runId !== undefined) {
    if (!isPositiveInt(input.runId)) return null;
    parsed.runId = input.runId;
  }
  if (input.runNumber !== undefined) {
    if (!isPositiveInt(input.runNumber)) return null;
    parsed.runNumber = input.runNumber;
  }
  if (input.cliId !== undefined) {
    if (input.cliId !== null && typeof input.cliId !== 'string') return null;
    parsed.cliId = input.cliId;
  }
  if (input.runArgs !== undefined) {
    if (!Array.isArray(input.runArgs) || !input.runArgs.every((arg) => typeof arg === 'string')) {
      return null;
    }
    parsed.runArgs = input.runArgs.slice(0, 20);
  }
  if (input.runLabel !== undefined) {
    if (input.runLabel !== null && typeof input.runLabel !== 'string') return null;
    parsed.runLabel = input.runLabel;
  }
  if (input.maxAttempts !== undefined) {
    if (typeof input.maxAttempts !== 'number' || !Number.isFinite(input.maxAttempts)) return null;
    parsed.maxAttempts = input.maxAttempts;
  }
  return parsed;
}

export function registerCiAutoFixHandlers(): void {
  ipcMain.handle(IPC.ciAutoFix.list, (): AutoFixSession[] => ciAutoFixService().list());

  ipcMain.handle(IPC.ciAutoFix.start, async (_event, raw: unknown): Promise<AutoFixStartResult> => {
    const input = parseStartInput(raw);
    return input ? ciAutoFixService().enable(input) : INVALID;
  });

  ipcMain.handle(
    IPC.ciAutoFix.stop,
    async (_event, id: unknown): Promise<AutoFixSession | null> =>
      typeof id === 'string' ? ciAutoFixService().stop(id) : null,
  );

  ipcMain.handle(
    IPC.ciAutoFix.commitNow,
    async (_event, id: unknown): Promise<AutoFixSession | null> =>
      typeof id === 'string' ? ciAutoFixService().commitNow(id) : null,
  );

  ipcMain.handle(
    IPC.ciAutoFix.retry,
    async (_event, id: unknown): Promise<AutoFixSession | null> =>
      typeof id === 'string' ? ciAutoFixService().retry(id) : null,
  );

  ipcMain.handle(
    IPC.ciAutoFix.dismiss,
    async (_event, id: unknown): Promise<boolean> =>
      typeof id === 'string' ? ciAutoFixService().dismiss(id) : false,
  );
}
