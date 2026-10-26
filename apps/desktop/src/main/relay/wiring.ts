import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type AppNotification,
  type EffortLevel,
  getCliDefinition,
  type RelayRunChoice,
  recommendationFromAssessment,
  targetAIForCliId,
} from '@runova/core';
import { IPC } from '../../shared/ipcChannels';
import type { RelayLegTabEvent } from '../../shared/relayTypes';
import { relayArmedDir } from '../agents/claudeHooks';
import { agentStatus } from '../agents/statusTracker';
import { appNotificationInbox } from '../deploy/watcher';
import { assessRun } from '../ipc/ai';
import { broadcastToWindows } from '../ipc/send';
import {
  attachForTracking,
  runningSessionIds,
  subscribeTerminalExit,
  subscribeTerminalOutput,
  writeToShell,
} from '../ipc/terminal';
import { setRelayHttpHandlers } from '../notifications/hookServer';
import { showOsNotification } from '../notifications/osNotification';
import { store } from '../store';
import { projectFor } from './board';
import { contextWindowFor, readContextTokens } from './contextMeter';
import { launchRelayLeg } from './launch';
import { handleRelayMcp } from './mcp/tools';
import { setRelayRuntime } from './runtime';
import { createRelayDriver, type RelayDriver } from './service';
import { addLegRecord, allRelayStates, relaySettings, saveRelayState } from './store';
import {
  applyProposalFiles,
  readBoardFiles,
  readHandoff,
  relayFolder,
  setTaskStatusFile,
} from './taskFiles';
import { createRelayWatcher } from './watcher';

const TICK_MS = 5_000;
const TRIGGER_MS = 30_000;
/** Enough of a session's screen to find the plan menu in. */
const SCREEN_CHARS = 4096;
// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape sequences
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g;

const inbox = appNotificationInbox({
  list: () => store.getAppNotifications(),
  save: (items) => store.setAppNotifications(items),
  changed: () => broadcastToWindows(IPC.appNotifications.onChanged),
});

let driver: RelayDriver | null = null;
let watcher: ReturnType<typeof createRelayWatcher> | null = null;

async function folderOf(projectId: string, docsFolder?: string) {
  const project = await projectFor(projectId);
  const docs = docsFolder ?? (await relaySettings(projectId)).docsFolder;
  return relayFolder(project.folderPath, docs);
}

/** Starts the Relay driver, its routes and its timers. Called once at startup. */
export async function startRelayService(): Promise<void> {
  if (driver) return;
  const screens = new Map<string, { text: string; stop: () => void }>();

  const followScreen = (tabId: string): void => {
    if (screens.has(tabId)) return;
    const entry: { text: string; stop: () => void } = { text: '', stop: () => undefined };
    entry.stop = subscribeTerminalOutput(tabId, (data) => {
      entry.text = (entry.text + data.replace(ANSI, '')).slice(-SCREEN_CHARS);
    });
    screens.set(tabId, entry);
  };
  const dropScreen = (tabId: string): void => {
    screens.get(tabId)?.stop();
    screens.delete(tabId);
  };
  const emitLegTab = (event: RelayLegTabEvent): void => {
    followScreen(event.tabId);
    broadcastToWindows(IPC.relay.onLegTab, event);
  };

  const created = createRelayDriver({
    now: Date.now,
    loadRelays: allRelayStates,
    saveRelay: saveRelayState,
    addLegRecord,
    settings: relaySettings,
    boardFiles: async (projectId, docsFolder) =>
      (await readBoardFiles(await folderOf(projectId, docsFolder))).files,
    setTaskStatus: async (projectId, docsFolder, taskId, status) => {
      await setTaskStatusFile(await folderOf(projectId, docsFolder), taskId, status);
    },
    readHandoff: async (projectId, docsFolder, taskId) =>
      readHandoff(await folderOf(projectId, docsFolder), taskId),
    launch: (relay, effect) => launchRelayLeg({ relay, ...effect }),
    assess: async (relay, taskId, choice): Promise<RelayRunChoice | null> => {
      const folder = await folderOf(relay.projectId, relay.docsFolder);
      const file = (await readBoardFiles(folder)).files.find((entry) => entry.task.id === taskId);
      const targetAI = targetAIForCliId(choice.cliId);
      if (!file || !targetAI) return null;
      const result = await assessRun({ prompt: file.content, targetAI });
      if (!result.ok || !result.assessment) return null;
      const recommended = recommendationFromAssessment(targetAI, result.assessment).recommended;
      return {
        cliId: choice.cliId,
        model: recommended.model.modelArg ?? choice.model,
        effort: (recommended.effort as EffortLevel | undefined) ?? choice.effort,
        autoSize: false,
      };
    },
    armGuard: async (tabId, armed) => {
      const path = join(relayArmedDir(), tabId);
      if (armed) {
        await mkdir(relayArmedDir(), { recursive: true });
        await writeFile(path, '');
      } else {
        await rm(path, { force: true });
      }
    },
    screenText: (tabId) => screens.get(tabId)?.text ?? '',
    typeIntoSession: (tabId, data) => writeToShell(tabId, data),
    forwardStop: (tabId) => {
      agentStatus.hook(tabId, 'stop');
    },
    sessionStatus: (tabId) => agentStatus.status(tabId) ?? 'gone',
    transcriptPath: (tabId) => agentStatus.transcriptPath(tabId),
    sessionModel: (tabId) => agentStatus.model(tabId),
    readContext: readContextTokens,
    contextWindow: contextWindowFor,
    watchExit: (tabId, listener) => subscribeTerminalExit(tabId, listener),
    liveSessions: runningSessionIds,
    adoptSession: async (leg, relay) => {
      if (!leg.tabId) return null;
      const project = await projectFor(relay.projectId).catch(() => null);
      if (!project) return null;
      const cliName = getCliDefinition(leg.choice.cliId)?.name ?? leg.choice.cliId;
      const title = `${leg.taskId} · ${cliName}`;
      agentStatus.pin({
        sessionId: leg.tabId,
        projectId: project.id,
        cliId: leg.choice.cliId,
        title,
      });
      await attachForTracking({
        sessionId: leg.tabId,
        projectId: project.id,
        cliId: leg.choice.cliId,
        title,
      });
      followScreen(leg.tabId);
      return {
        projectId: project.id,
        tabId: leg.tabId,
        legId: leg.legId,
        cliId: leg.choice.cliId,
        title,
        runLabel: `Leg ${leg.legNo}`,
        cwd: project.folderPath,
      };
    },
    releaseSession: (tabId) => {
      agentStatus.unpin(tabId);
      dropScreen(tabId);
    },
    notify: (relay, notice) => {
      void (async () => {
        const project = await projectFor(relay.projectId).catch(() => null);
        const route = `/workspace/${relay.projectId}`;
        const finished = notice.title === 'Relay finished';
        const notification: AppNotification = {
          id: `relay:${relay.id}:${Date.now().toString(36)}:${notice.taskId ?? 'run'}`,
          kind: finished && notice.level === 'info' ? 'relay-finished' : 'relay-attention',
          title: notice.title,
          body: notice.body,
          projectId: relay.projectId,
          projectName: project?.name ?? '',
          htmlUrl: null,
          route,
          createdAt: new Date().toISOString(),
          read: false,
        };
        await inbox.add(notification).catch(() => undefined);
        showOsNotification({
          title: notice.title,
          body: project ? `${project.name}: ${notice.body}` : notice.body,
          route,
        });
      })();
    },
    emitRun: (view) => {
      broadcastToWindows(IPC.relay.onRun, view);
      watcher?.setLive(created.liveProjects());
    },
    emitChanged: (event) => broadcastToWindows(IPC.relay.onChanged, event),
    emitContext: (event) => broadcastToWindows(IPC.relay.onContext, event),
    emitLegTab,
    emitCloseTab: (event) => broadcastToWindows(IPC.relay.onCloseTab, event),
    emitProposal: (proposal) => broadcastToWindows(IPC.relay.onProposal, proposal),
    applyProposal: async (projectId, proposal) =>
      applyProposalFiles(await folderOf(projectId), proposal),
  });
  driver = created;

  watcher = createRelayWatcher({
    resolve: async (projectId) => {
      const folder = await folderOf(projectId).catch(() => null);
      return folder ? { tasksDir: folder.tasksDir, handoffsDir: folder.handoffsDir } : null;
    },
    onChange: (projectId, change) => {
      broadcastToWindows(IPC.relay.onChanged, { projectId, reason: 'files' });
      void created.onFilesChanged(projectId, change.handoffs, change.tasks);
    },
  });

  setRelayRuntime(created);
  setRelayHttpHandlers({
    gate: (body) => created.gate(body),
    mcp: (body) =>
      handleRelayMcp(
        {
          driver: created,
          projectFolder: async (projectId) => {
            const project = await projectFor(projectId).catch(() => null);
            return project ? { folderPath: project.folderPath, name: project.name } : null;
          },
        },
        body,
      ),
    agentEvent: (tabId, event, permissionMode) =>
      created.onAgentEvent(tabId, event, permissionMode),
  });
  agentStatus.subscribe((tabId, status) => created.onAgentStatus(tabId, status));

  await created.startup().catch(() => undefined);
  watcher.setLive(created.liveProjects());
  setInterval(() => void created.tick(), TICK_MS).unref();
  setInterval(() => void created.checkTriggers(), TRIGGER_MS).unref();
}

export function relayWatcher() {
  return watcher;
}
