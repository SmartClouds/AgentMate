import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  ActivityEvent,
  ActivityEventType,
  AppNotification,
  AppSettings,
  BlueprintPreset,
  McpRepository,
  Project,
  ProjectBlueprint,
  ProjectDraft,
  PromptTemplate,
  RunnerMachineLink,
  ScheduledTask,
  SkillRepository,
  WorktreeRecord,
} from '@runova/core';
import {
  blueprintPresetSeed,
  clampDesktopPetClickArea,
  clampDesktopPetScale,
  DASHBOARD_CHART_IDS,
  DEFAULT_DASHBOARD,
  DEFAULT_TERMINAL_BACKGROUND_COLOR,
  isMenuPosition,
  isPipelineFailureOpen,
  isRunDockerStopMode,
  isStartupPage,
  isThemeMode,
  normalizeCliArgs,
  normalizeCliLaunchDefaults,
  normalizeCommitMessageSettings,
  normalizeCustomDesktopPets,
  normalizeDesktopPetActionSpeeds,
  normalizeDesktopPetCardView,
  normalizeDesktopPetId,
  normalizeDesktopPetName,
  normalizeDevSetupStacks,
  normalizeGrammarSettings,
  normalizeHelpEmbeddingModels,
  normalizeIdleResourceMinutes,
  normalizeProjectColor,
  normalizeProjectGithubActions,
  normalizeProjectNotifications,
  normalizeProjectRunCommands,
  normalizeProjectWorktreeSetup,
  normalizeProxySettings,
  normalizeReviewCommands,
  normalizeStatusBarUsage,
  normalizeUsageResetAlerts,
  normalizeUsageThresholdAlerts,
  normalizeVaultAutoLockMinutes,
  normalizeVaultClipboardClearSeconds,
  normalizeWorktreeRecord,
  normalizeWorktreeSettings,
  withBlueprintDefaults,
} from '@runova/core';
import { app } from 'electron';
import type {
  FavoriteSkillRecord,
  LastRunInfoByCli,
  RemoteSavedServer,
  SshAgentHistoryRun,
  SshVaultRecord,
  StoredProjectEnvironment,
  StoredRdpServer,
  StoredSshServer,
} from '../shared/apiTypes';
import type { AutoFixSession } from '../shared/ciAutoFixTypes';
import { DEFAULT_SETTINGS, ORIGINAL_CHART_IDS } from '../shared/defaultSettings';
import { referencedAttachmentFiles, removeOrphanAttachments } from './blueprintFileStore';
import { blueprintRevisionDb } from './blueprintRevisionDb';
import {
  DEFAULT_PING_TARGETS_IPV6,
  isPingIpVersion,
  isPingMethod,
  normalizePingUrlInterval,
  normalizePingUrls,
} from './network/pingProbe';
import { hydrateProjectIcons, persistProjectIcons } from './projectIconStore';

/** Backup import reads the defaults from here. */
export { DEFAULT_SETTINGS };

function dataDir(): string {
  return join(app.getPath('userData'), 'data');
}

async function readJsonFile<T>(fileName: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(join(dataDir(), fileName), 'utf-8');
    return JSON.parse(raw) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw error;
  }
}

async function writeJsonFile<T>(fileName: string, data: T): Promise<void> {
  await mkdir(dataDir(), { recursive: true });
  const filePath = join(dataDir(), fileName);
  const tmpPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
  await rename(tmpPath, filePath);
}

async function readSettings(): Promise<AppSettings> {
  return withSettingsMigrations({
    ...DEFAULT_SETTINGS,
    ...(await readJsonFile<Partial<AppSettings>>('settings.json', FIRST_RUN_SETTINGS)),
  });
}

/**
 * settings.json is changed by a read, a merge and a write, from a dozen places. Run side by side,
 * a later read could miss an earlier write and put the old value back, so every write waits its
 * turn here.
 */
let settingsQueue: Promise<unknown> = Promise.resolve();

function inSettingsQueue<T>(work: () => Promise<T>): Promise<T> {
  const run = settingsQueue.then(work, work);
  settingsQueue = run.catch(() => undefined);
  return run;
}

/**
 * A brand new install opens with DEFAULT_DASHBOARD. It only applies while settings.json doesn't
 * exist, so a profile from an older build that is missing some of these keys keeps the plain
 * DEFAULT_SETTINGS (and its legacy card order still migrates) instead of being rearranged.
 */
const FIRST_RUN_DASHBOARD: Partial<AppSettings> = {
  ...structuredClone(DEFAULT_DASHBOARD),
  // Every chart is already placed, so none of them should be appended again on first load.
  dashboardIntroducedCharts: [...DASHBOARD_CHART_IDS],
};

const FIRST_RUN_SETTINGS: AppSettings = {
  ...DEFAULT_SETTINGS,
  ...FIRST_RUN_DASHBOARD,
};

/**
 * The weekly bucket above Pro was keyed 'week-opus' before Fable took that slot.
 * A saved alert still naming it would match no window and quietly never fire.
 *
 * Normalizing first is what keeps a half-written block (no `windows` array, say)
 * from reaching either process as something that throws on first access.
 */
/**
 * A user-typed path reaches a command line, so anything that is not a non-empty string becomes
 * null and detection takes over again. Blank is the same as unset on purpose: clearing the field
 * in Settings is how you go back to auto-detection.
 */
function normalizeOptionalPath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** Capped so one stray paste cannot build a command line the OS refuses to run. */
const MAX_EMULATOR_LAUNCH_FLAGS = 500;

function normalizeEmulatorLaunchFlags(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, MAX_EMULATOR_LAUNCH_FLAGS);
}

/** Server ids the user put on the Deploy page. Anything else in the file is a damaged entry. */
function normalizeDeployServerIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((id): id is string => typeof id === 'string' && id !== ''))];
}

/** Runner links whose shape still makes sense. A link to a server that was since removed is kept. */
function normalizeRunnerMachineLinks(value: unknown): Record<string, RunnerMachineLink> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const links: Record<string, RunnerMachineLink> = {};
  for (const [key, link] of Object.entries(value)) {
    if (key === '' || !link || typeof link !== 'object') continue;
    const { kind, serverId } = link as { kind?: unknown; serverId?: unknown };
    if (kind === 'local') links[key] = { kind: 'local' };
    else if (kind === 'ssh' && typeof serverId === 'string' && serverId !== '') {
      links[key] = { kind: 'ssh', serverId };
    }
  }
  return links;
}

function withSettingsMigrations(settings: AppSettings): AppSettings {
  const alerts = normalizeUsageResetAlerts(settings.usageResetAlerts);
  const windows = alerts.windows.map((key) =>
    String(key) === 'week-opus' ? ('week-fable' as const) : key,
  );
  const customs = normalizeCustomDesktopPets(settings.desktopPetCustoms);
  return {
    ...settings,
    androidSdkPath: normalizeOptionalPath(settings.androidSdkPath),
    androidCapturePath: normalizeOptionalPath(settings.androidCapturePath),
    androidEmulatorLaunchFlags: normalizeEmulatorLaunchFlags(settings.androidEmulatorLaunchFlags),
    androidStopEmulatorsOnQuit: settings.androidStopEmulatorsOnQuit === true,
    idleResourceMinutes: normalizeIdleResourceMinutes(settings.idleResourceMinutes),
    idleResourceNotify: settings.idleResourceNotify !== false,
    devSetupStacks: normalizeDevSetupStacks(settings.devSetupStacks),
    deployServerIds: normalizeDeployServerIds(settings.deployServerIds),
    runnerMachineLinks: normalizeRunnerMachineLinks(settings.runnerMachineLinks),
    cliArgs: normalizeCliArgs(settings.cliArgs),
    cliLaunchDefaults: normalizeCliLaunchDefaults(settings.cliLaunchDefaults),
    commitMessage: normalizeCommitMessageSettings(settings.commitMessage),
    worktrees: normalizeWorktreeSettings(settings.worktrees),
    reviewCommands: normalizeReviewCommands(settings.reviewCommands),
    cliOrder: Array.isArray(settings.cliOrder)
      ? [...new Set(settings.cliOrder.filter((id): id is string => typeof id === 'string'))]
      : [],
    grammar: normalizeGrammarSettings(settings.grammar),
    proxy: normalizeProxySettings(settings.proxy),
    helpEmbeddingModels: normalizeHelpEmbeddingModels(settings.helpEmbeddingModels),
    promptBuilderAutoSize: settings.promptBuilderAutoSize !== false,
    desktopPetCustoms: customs,
    desktopPetCharacterId: normalizeDesktopPetId(
      settings.desktopPetCharacterId,
      customs.map((pet) => pet.id),
    ),
    desktopPetName: normalizeDesktopPetName(settings.desktopPetName),
    desktopPetFlippedIds: Array.isArray(settings.desktopPetFlippedIds)
      ? [
          ...new Set(
            settings.desktopPetFlippedIds.filter((id): id is string => typeof id === 'string'),
          ),
        ]
      : [],
    desktopPetCanMove: settings.desktopPetCanMove !== false,
    desktopPetCanClimb: settings.desktopPetCanClimb !== false,
    desktopPetCanParachute: settings.desktopPetCanParachute === true,
    desktopPetGear3d: settings.desktopPetGear3d === true,
    desktopPetActionSpeeds: normalizeDesktopPetActionSpeeds(settings.desktopPetActionSpeeds),
    desktopPetScale: clampDesktopPetScale(settings.desktopPetScale),
    desktopPetClickArea: clampDesktopPetClickArea(settings.desktopPetClickArea),
    desktopPetCardView: normalizeDesktopPetCardView(settings.desktopPetCardView),
    desktopPetPipelineOnFail: settings.desktopPetPipelineOnFail === true,
    desktopPetPipelineOnPass: settings.desktopPetPipelineOnPass === true,
    pipelineFailureNotify: settings.pipelineFailureNotify !== false,
    // This was an on/off switch before it became a choice, and an off one meant "do nothing".
    pipelineFailureOpen: isPipelineFailureOpen(settings.pipelineFailureOpen)
      ? settings.pipelineFailureOpen
      : (settings.pipelineFailureOpen as unknown) === false
        ? 'none'
        : 'pipelines',
    pingIpVersion: isPingIpVersion(settings.pingIpVersion) ? settings.pingIpVersion : 'ipv4',
    pingTargetsIpv6: Array.isArray(settings.pingTargetsIpv6)
      ? settings.pingTargetsIpv6.filter((host) => typeof host === 'string')
      : [...DEFAULT_PING_TARGETS_IPV6],
    pingMethod: isPingMethod(settings.pingMethod) ? settings.pingMethod : 'icmp',
    pingUrls: normalizePingUrls(settings.pingUrls),
    pingUrlIntervalSeconds: normalizePingUrlInterval(settings.pingUrlIntervalSeconds),
    desktopPetNetworkQuality:
      settings.desktopPetNetworkQuality === true ||
      (settings as AppSettings & { networkQualityAlerts?: boolean }).networkQualityAlerts === true,
    desktopPetAgentStatus: settings.desktopPetAgentStatus === true,
    dashboardIntroducedCharts: Array.isArray(settings.dashboardIntroducedCharts)
      ? settings.dashboardIntroducedCharts.filter((id) => typeof id === 'string')
      : ORIGINAL_CHART_IDS,
    usageResetAlerts: { ...alerts, windows: [...new Set(windows)] },
    usageThresholdAlerts: normalizeUsageThresholdAlerts(settings.usageThresholdAlerts),
    statusBarUsage: normalizeStatusBarUsage(settings.statusBarUsage),
    keepTerminalsRunning: settings.keepTerminalsRunning !== false,
    stopDockerWithRun: isRunDockerStopMode(settings.stopDockerWithRun)
      ? settings.stopDockerWithRun
      : 'ask',
    autoPauseRunsWhileAgentWorks: settings.autoPauseRunsWhileAgentWorks === true,
    workspaceNotifications: settings.workspaceNotifications !== false,
    terminalAiNotifications: settings.terminalAiNotifications !== false,
    checkToolUpdatesEnabled: settings.checkToolUpdatesEnabled !== false,
    keepAwake:
      settings.keepAwake === 'on' || settings.keepAwake === 'off' ? settings.keepAwake : 'agent',
    theme: isThemeMode(settings.theme) ? settings.theme : 'system',
    menuPosition: isMenuPosition(settings.menuPosition) ? settings.menuPosition : 'left',
    startupPage: isStartupPage(settings.startupPage) ? settings.startupPage : 'last',
    workspaceTerminalCustomBackground: settings.workspaceTerminalCustomBackground === true,
    workspaceTerminalBackgroundColor:
      normalizeProjectColor(settings.workspaceTerminalBackgroundColor) ??
      DEFAULT_TERMINAL_BACKGROUND_COLOR,
    vaultAutoLockMinutes: normalizeVaultAutoLockMinutes(settings.vaultAutoLockMinutes),
    vaultClipboardClearSeconds: normalizeVaultClipboardClearSeconds(
      settings.vaultClipboardClearSeconds,
    ),
    vaultLockOnSystemLock: settings.vaultLockOnSystemLock !== false,
  };
}

/**
 * Older projects.json entries predate notifications, prompt, pinned, archived, cliId, icon,
 * repository, and the runCommands list (they used a single `runCommand` string). They also
 * carry `githubActions`, the list of workflows the user had opted in to back when watching
 * was opt-in. Every workflow is watched now, so that list is dropped on read.
 */
function withProjectDefaults(
  project: Project & { runCommand?: string; githubActions?: unknown },
): Project {
  const rest = { ...project };
  delete rest.runCommand;
  delete rest.githubActions;
  return {
    ...rest,
    runCommands: normalizeProjectRunCommands(project),
    notifications: normalizeProjectNotifications(project.notifications),
    prompt: project.prompt ?? '',
    pinned: project.pinned ?? false,
    archived: project.archived ?? false,
    cliId: project.cliId ?? null,
    iconDataUrl: project.iconDataUrl ?? null,
    iconFile: project.iconFile ?? null,
    iconBgColor: normalizeProjectColor(project.iconBgColor),
    iconColor: normalizeProjectColor(project.iconColor),
    websiteUrl: project.websiteUrl ?? '',
    repoUrl: project.repoUrl ?? '',
    githubActionsMuted: normalizeProjectGithubActions(project.githubActionsMuted),
    worktreeSetup: normalizeProjectWorktreeSetup(project.worktreeSetup),
  };
}

export const store = {
  getProjects: async (): Promise<Project[]> => {
    const projects = await readJsonFile<Project[]>('projects.json', []);
    return hydrateProjectIcons(projects.map(withProjectDefaults));
  },
  setProjects: async (projects: Project[]): Promise<void> =>
    writeJsonFile('projects.json', await persistProjectIcons(projects)),

  /** Git worktrees Runova made or picked up, so each keeps its workspace between runs. */
  getWorktrees: async (): Promise<WorktreeRecord[]> => {
    const saved = await readJsonFile<unknown>('worktrees.json', []);
    return Array.isArray(saved)
      ? saved.flatMap((entry) => normalizeWorktreeRecord(entry) ?? [])
      : [];
  },
  setWorktrees: (worktrees: WorktreeRecord[]): Promise<void> =>
    writeJsonFile('worktrees.json', worktrees),

  getSettings: readSettings,
  setSettings: (settings: AppSettings): Promise<void> =>
    inSettingsQueue(() => writeJsonFile('settings.json', settings)),
  /**
   * Reads settings.json, changes it and writes it back in one turn of the queue, so a change made
   * at the same moment elsewhere is never lost. Resolves to what was written.
   */
  updateSettings: (
    change: (current: AppSettings) => AppSettings | Promise<AppSettings>,
  ): Promise<AppSettings> =>
    inSettingsQueue(async () => {
      const next = await change(await readSettings());
      await writeJsonFile('settings.json', next);
      return next;
    }),

  getActivity: (): Promise<ActivityEvent[]> => readJsonFile('activity-log.json', []),
  setActivity: (events: ActivityEvent[]): Promise<void> =>
    writeJsonFile('activity-log.json', events),

  getTemplates: (): Promise<PromptTemplate[]> => readJsonFile('templates.json', []),
  setTemplates: (templates: PromptTemplate[]): Promise<void> =>
    writeJsonFile('templates.json', templates),

  getRepositories: (): Promise<SkillRepository[]> => readJsonFile('repositories.json', []),
  setRepositories: (repos: SkillRepository[]): Promise<void> =>
    writeJsonFile('repositories.json', repos),

  getFavoriteSkills: (): Promise<FavoriteSkillRecord[]> => readJsonFile('skill-favorites.json', []),
  setFavoriteSkills: (favorites: FavoriteSkillRecord[]): Promise<void> =>
    writeJsonFile('skill-favorites.json', favorites),

  getMcpRepositories: (): Promise<McpRepository[]> => readJsonFile('mcp-repositories.json', []),
  setMcpRepositories: (repos: McpRepository[]): Promise<void> =>
    writeJsonFile('mcp-repositories.json', repos),

  getProjectDrafts: (): Promise<ProjectDraft[]> => readJsonFile('project-drafts.json', []),
  setProjectDrafts: (drafts: ProjectDraft[]): Promise<void> =>
    writeJsonFile('project-drafts.json', drafts),

  getBlueprints: async (): Promise<ProjectBlueprint[]> =>
    (await readJsonFile<ProjectBlueprint[]>('blueprints.json', [])).map(withBlueprintDefaults),
  setBlueprints: async (blueprints: ProjectBlueprint[]): Promise<void> => {
    // Record first, files second: the other order leaves a crash between them
    // having deleted attachments the stored blueprints still point at.
    await writeJsonFile('blueprints.json', blueprints);
    await removeOrphanAttachments(referencedAttachmentFiles(blueprints));
  },

  getBlueprintPresets: async (): Promise<BlueprintPreset[]> => {
    const stored = await readJsonFile<BlueprintPreset[] | null>('blueprint-presets.json', null);
    if (stored) return stored;
    // Absent means a fresh install, which gets the starter set. It is written out
    // straight away so its ids are stable and editing or deleting one sticks. An
    // empty array is a user who deleted them all, and that sticks too.
    const seeded = blueprintPresetSeed(randomUUID);
    await writeJsonFile('blueprint-presets.json', seeded);
    return seeded;
  },
  setBlueprintPresets: (presets: BlueprintPreset[]): Promise<void> =>
    writeJsonFile('blueprint-presets.json', presets),

  getScheduledTasks: (): Promise<ScheduledTask[]> => readJsonFile('scheduled-tasks.json', []),
  setScheduledTasks: (tasks: ScheduledTask[]): Promise<void> =>
    writeJsonFile('scheduled-tasks.json', tasks),

  getRemoteServers: (): Promise<RemoteSavedServer[]> => readJsonFile('remote-servers.json', []),
  setRemoteServers: (servers: RemoteSavedServer[]): Promise<void> =>
    writeJsonFile('remote-servers.json', servers),

  getSshServers: (): Promise<StoredSshServer[]> => readJsonFile('ssh-servers.json', []),
  setSshServers: (servers: StoredSshServer[]): Promise<void> =>
    writeJsonFile('ssh-servers.json', servers),

  getRdpServers: (): Promise<StoredRdpServer[]> => readJsonFile('rdp-servers.json', []),
  setRdpServers: (servers: StoredRdpServer[]): Promise<void> =>
    writeJsonFile('rdp-servers.json', servers),

  getProjectEnvironments: (): Promise<StoredProjectEnvironment[]> =>
    readJsonFile('project-environments.json', []),
  setProjectEnvironments: (environments: StoredProjectEnvironment[]): Promise<void> =>
    writeJsonFile('project-environments.json', environments),

  getSshVault: (): Promise<SshVaultRecord | null> => readJsonFile('ssh-vault.json', null),
  setSshVault: (vault: SshVaultRecord | null): Promise<void> =>
    writeJsonFile('ssh-vault.json', vault),

  /** The SSH AI task history, read back as is. The runner checks each entry before using it. */
  getSshAgentHistory: (): Promise<unknown> => readJsonFile('ssh-agent-history.json', []),
  setSshAgentHistory: (runs: SshAgentHistoryRun[]): Promise<void> =>
    writeJsonFile('ssh-agent-history.json', runs),

  getAppNotifications: (): Promise<AppNotification[]> => readJsonFile('app-notifications.json', []),
  setAppNotifications: (notifications: AppNotification[]): Promise<void> =>
    writeJsonFile('app-notifications.json', notifications),

  getPipelineWatch: (): Promise<PipelineWatchState> =>
    readJsonFile('pipeline-watch.json', { lastCompletedRunId: {} }),
  setPipelineWatch: (state: PipelineWatchState): Promise<void> =>
    writeJsonFile('pipeline-watch.json', state),
  getAutoFixSessions: (): Promise<AutoFixSession[]> => readJsonFile('ci-autofix.json', []),
  setAutoFixSessions: (sessions: AutoFixSession[]): Promise<void> =>
    writeJsonFile('ci-autofix.json', sessions),

  getToolUpdateWatch: (): Promise<ToolUpdateWatchState> =>
    readJsonFile('tool-update-watch.json', { lastCheckedAt: null }),
  setToolUpdateWatch: (state: ToolUpdateWatchState): Promise<void> =>
    writeJsonFile('tool-update-watch.json', state),

  getLastRunInfoByCli: (): Promise<LastRunInfoByCli> => readJsonFile('last-run-info.json', {}),
  setLastRunInfoByCli: (info: LastRunInfoByCli): Promise<void> =>
    writeJsonFile('last-run-info.json', info),
};

/**
 * Moves icons that older builds inlined in projects.json out into their own
 * files under the app data folder. Runs once at startup; every write after that
 * goes through the icon store anyway, so it finds nothing left to do.
 */
export async function migrateInlineProjectIcons(): Promise<void> {
  try {
    const projects = await store.getProjects();
    if (!projects.some((project) => project.iconDataUrl && !project.iconFile)) return;
    await store.setProjects(projects);
  } catch {
    // A disk error here just leaves the icons where they already were.
  }
}

/**
 * Drops blueprints whose project is gone, along with their revisions and files.
 * Runs at startup, which also catches what a restored backup left behind, and
 * again whenever a project is deleted.
 */
export async function pruneOrphanBlueprints(): Promise<void> {
  try {
    const [projects, blueprints] = await Promise.all([store.getProjects(), store.getBlueprints()]);
    const live = new Set(projects.map((project) => project.id));
    const kept = blueprints.filter((blueprint) => live.has(blueprint.projectId));
    if (kept.length === blueprints.length) return;
    for (const blueprint of blueprints) {
      if (!live.has(blueprint.projectId)) blueprintRevisionDb.removeForProject(blueprint.projectId);
    }
    await store.setBlueprints(kept);
  } catch {
    // A disk error here just leaves the orphans for the next launch.
  }
}

/** Drops saved environments whose project is gone. Runs at startup and on project delete. */
export async function pruneOrphanEnvironments(): Promise<void> {
  try {
    const [projects, environments] = await Promise.all([
      store.getProjects(),
      store.getProjectEnvironments(),
    ]);
    const live = new Set(projects.map((project) => project.id));
    const kept = environments.filter((environment) => live.has(environment.projectId));
    if (kept.length === environments.length) return;
    await store.setProjectEnvironments(kept);
  } catch {
    // A disk error here just leaves the orphans for the next launch.
  }
}

/** `${projectId}:${workflowId}` to the newest completed run already processed. */
export interface PipelineWatchState {
  lastCompletedRunId: Record<string, number>;
}

/** When the CLI/tool update watcher last ran, so it only checks about once a day. */
export interface ToolUpdateWatchState {
  lastCheckedAt: string | null;
}

export async function logActivity(
  type: ActivityEventType,
  message: string,
  metadata?: Record<string, string>,
): Promise<ActivityEvent> {
  const events = await store.getActivity();
  const event: ActivityEvent = {
    id: randomUUID(),
    type,
    message,
    createdAt: new Date().toISOString(),
    metadata,
  };
  events.unshift(event);
  await store.setActivity(events.slice(0, 200));
  return event;
}
