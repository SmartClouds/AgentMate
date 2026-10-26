import type { AgentHistorySession } from '@runova/core';
import { ipcMain } from 'electron';
import type {
  AgentRunInfoMap,
  AgentSessionEntry,
  AgentSessionUsage,
  AgentStatusMap,
  AutoContinuePendingMap,
  LastRunInfoByCli,
  ProjectUsageReport,
} from '../../shared/apiTypes';
import { IPC } from '../../shared/ipcChannels';
import { claudeHookSettingsPath, supportsStatusHooks } from '../agents/claudeHooks';
import { readProjectUsage } from '../agents/projectUsage';
import { listAgentHistory } from '../agents/sessionHistory';
import { readSessionUsage } from '../agents/sessionUsage';
import { agentStatus } from '../agents/statusTracker';
import { store } from '../store';
import { findProjectScope } from '../worktrees/resolve';
import { attachForTracking, autoContinue, SESSION_ID_PATTERN } from './terminal';

function isEntry(value: unknown): value is AgentSessionEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.sessionId === 'string' &&
    SESSION_ID_PATTERN.test(entry.sessionId) &&
    typeof entry.projectId === 'string' &&
    typeof entry.title === 'string' &&
    (entry.cliId === undefined || typeof entry.cliId === 'string') &&
    (entry.autoContinue === undefined || isAutoContinueOptions(entry.autoContinue))
  );
}

function isAutoContinueOptions(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const options = value as Record<string, unknown>;
  return (
    (options.afterLimitReset === undefined || typeof options.afterLimitReset === 'boolean') &&
    (options.afterNetworkError === undefined || typeof options.afterNetworkError === 'boolean')
  );
}

/** A usage period is a whole number of days (ten years at most), or null for everything. */
function isPeriod(value: unknown): value is number | null {
  return (
    value === null ||
    (typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 3650)
  );
}

export function registerAgentHandlers(): void {
  ipcMain.handle(IPC.agents.sync, (_event, entries: unknown): void => {
    const valid = Array.isArray(entries) ? entries.filter(isEntry) : [];
    const added = agentStatus.sync(valid);
    autoContinue.sync(valid);
    // Tabs restored after a restart have not been shown yet, so nothing is reading their
    // output. Attach to them now so their status keeps up while they are off screen.
    for (const id of added) {
      const entry = valid.find((e) => e.sessionId === id);
      if (entry) void attachForTracking(entry).catch(() => undefined);
    }
  });

  ipcMain.handle(IPC.agents.setViewing, (_event, visible: unknown, focused: unknown): void => {
    const ids = Array.isArray(visible)
      ? visible.filter((id): id is string => typeof id === 'string')
      : [];
    agentStatus.setViewing(ids, typeof focused === 'string' ? focused : null);
  });

  ipcMain.handle(IPC.agents.acknowledge, (_event, sessionId: string): void => {
    if (typeof sessionId === 'string') agentStatus.acknowledge(sessionId);
  });

  ipcMain.handle(IPC.agents.list, (): AgentStatusMap => agentStatus.list());

  ipcMain.handle(IPC.agents.runInfos, (): AgentRunInfoMap => agentStatus.runInfos());

  ipcMain.handle(IPC.agents.autoContinuePending, (): AutoContinuePendingMap => autoContinue.list());

  ipcMain.handle(IPC.agents.cancelAutoContinue, (_event, sessionId: unknown): void => {
    if (typeof sessionId === 'string') autoContinue.cancel(sessionId);
  });

  ipcMain.handle(
    IPC.agents.lastRunInfoByCli,
    (): Promise<LastRunInfoByCli> => store.getLastRunInfoByCli(),
  );

  ipcMain.handle(
    IPC.agents.history,
    async (_event, projectId: unknown): Promise<AgentHistorySession[]> => {
      if (typeof projectId !== 'string') return [];
      // CLIs file conversations by folder, so a worktree has its own.
      const project = await findProjectScope(projectId);
      return project ? listAgentHistory(project.folderPath) : [];
    },
  );

  ipcMain.handle(
    IPC.agents.sessionUsage,
    async (_event, provider: unknown, id: unknown): Promise<AgentSessionUsage> =>
      typeof provider === 'string' && typeof id === 'string'
        ? readSessionUsage(provider, id)
        : { status: 'unavailable' },
  );

  ipcMain.handle(
    IPC.agents.projectUsage,
    async (_event, projectId: unknown, days: unknown): Promise<ProjectUsageReport> => {
      if (typeof projectId !== 'string' || !isPeriod(days)) return { status: 'unavailable' };
      const project = await findProjectScope(projectId);
      if (!project) return { status: 'unavailable' };
      // A worktree's own id reads just that worktree; the project's reads its folder and all of
      // its worktrees, since the work in them is the project's spend too.
      const folders = project.worktree
        ? [project.folderPath]
        : [
            project.folderPath,
            ...(await store.getWorktrees())
              .filter((w) => w.projectId === project.id)
              .map((w) => w.path),
          ];
      return readProjectUsage([...new Set(folders)], days);
    },
  );

  ipcMain.handle(
    IPC.agents.statusHookSettings,
    async (_event, cliId: string): Promise<string | null> =>
      typeof cliId === 'string' && supportsStatusHooks(cliId) ? claudeHookSettingsPath() : null,
  );
}
