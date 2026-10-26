import type { CliArgsMap } from '../cli/args.js';
import type { GrammarSettings } from '../grammar/languagetool.js';
import type { DesktopPromptBuildWidgetInstance } from '../promptBuilder/types.js';
import type {
  DesktopWidgetInstance,
  UsageProviderConfig,
  UsageResetAlertSettings,
  UsageThresholdAlertSettings,
  WidgetMode,
} from '../usage/types.js';

export type ThemeMode = 'light' | 'dark' | 'system';

export type AiProvider = 'openai' | 'ollama' | 'gemini';

export const DESKTOP_PET_IDS = [
  'claude',
  'gremlin',
  'opencode',
  'tide',
  'pip',
  'brick',
  'ember',
  'nori',
  'bolt',
  'moss',
  'cocoa',
  'hex',
] as const;
export type DesktopPetId = (typeof DESKTOP_PET_IDS)[number];

export const CUSTOM_PET_ID_PREFIX = 'custom-';

export interface CustomDesktopPet {
  id: string;
  name: string;
  /** File name under the app's pets folder, e.g. custom-….webp */
  fileName: string;
}

/** Longest nickname the user can give their pet. */
export const DESKTOP_PET_NAME_MAX = 24;

/**
 * Cleans up a nickname typed in Settings. Empty means the user has not named the
 * pet, so callers fall back to the character's own name.
 */
export function normalizeDesktopPetName(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, DESKTOP_PET_NAME_MAX);
}

export const DESKTOP_PET_SCALE_MIN = 50;
export const DESKTOP_PET_SCALE_MAX = 160;
export const DESKTOP_PET_SCALE_DEFAULT = 100;

export function isDesktopPetId(value: unknown): value is DesktopPetId {
  return DESKTOP_PET_IDS.includes(value as DesktopPetId);
}

export function isCustomPetId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.startsWith(CUSTOM_PET_ID_PREFIX) &&
    value.length > CUSTOM_PET_ID_PREFIX.length
  );
}

export function normalizeCustomDesktopPets(value: unknown): CustomDesktopPet[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const pets: CustomDesktopPet[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    if (
      !isCustomPetId(rec.id) ||
      typeof rec.name !== 'string' ||
      typeof rec.fileName !== 'string'
    ) {
      continue;
    }
    if (seen.has(rec.id)) continue;
    if (!/^custom-[0-9a-f-]+\.(png|gif|webp)$/i.test(rec.fileName)) continue;
    seen.add(rec.id);
    const name = rec.name.trim().slice(0, 40) || 'My pet';
    pets.push({ id: rec.id, name, fileName: rec.fileName });
  }
  return pets;
}

export function normalizeDesktopPetId(value: unknown, customIds: readonly string[] = []): string {
  if (isDesktopPetId(value)) return value;
  if (typeof value === 'string' && customIds.includes(value)) return value;
  return 'tide';
}

export function isAnimatedPetFile(fileName: string): boolean {
  const ext = fileName.split('.').pop()?.toLowerCase();
  return ext === 'gif' || ext === 'webp';
}

export function clampDesktopPetScale(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : DESKTOP_PET_SCALE_DEFAULT;
  return Math.round(Math.min(DESKTOP_PET_SCALE_MAX, Math.max(DESKTOP_PET_SCALE_MIN, n)));
}

export function petBoxSize(scalePercent: number): number {
  return Math.round(120 * (clampDesktopPetScale(scalePercent) / 100));
}

/** How much of the sprite counts as the character for clicks and the token card. */
export const DESKTOP_PET_CLICK_AREA_MIN = 40;
export const DESKTOP_PET_CLICK_AREA_MAX = 100;
export const DESKTOP_PET_CLICK_AREA_DEFAULT = 100;

export function clampDesktopPetClickArea(value: unknown): number {
  const n =
    typeof value === 'number' && Number.isFinite(value) ? value : DESKTOP_PET_CLICK_AREA_DEFAULT;
  return Math.round(Math.min(DESKTOP_PET_CLICK_AREA_MAX, Math.max(DESKTOP_PET_CLICK_AREA_MIN, n)));
}

export interface PetClickRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Clickable / card-anchor box inside the pet hit square. Sprites sit on the
 * bottom of that square; `clickAreaPercent` then shrinks toward the sprite
 * center so empty padding around the drawing is ignored.
 */
export function petClickRect(
  actorX: number,
  actorY: number,
  box: number,
  spriteW: number,
  spriteH: number,
  clickAreaPercent: number,
): PetClickRect {
  const area = clampDesktopPetClickArea(clickAreaPercent) / 100;
  const fullW = Math.max(8, spriteW > 0 ? Math.min(spriteW, box) : box);
  const fullH = Math.max(8, spriteH > 0 ? Math.min(spriteH, box) : box);
  const w = Math.max(8, fullW * area);
  const h = Math.max(8, fullH * area);
  const spriteLeft = actorX + (box - fullW) / 2;
  const spriteTop = actorY + box - fullH;
  return {
    x: spriteLeft + (fullW - w) / 2,
    y: spriteTop + (fullH - h) / 2,
    w,
    h,
  };
}

/** Which chart the companion's card opens on. */
export type DesktopPetCardView = 'tokens' | 'system' | 'network';

export const DESKTOP_PET_CARD_VIEWS = ['tokens', 'system', 'network'] as const;

export function normalizeDesktopPetCardView(value: unknown): DesktopPetCardView {
  return DESKTOP_PET_CARD_VIEWS.includes(value as DesktopPetCardView)
    ? (value as DesktopPetCardView)
    : 'tokens';
}

export const DESKTOP_PET_SPEED_MIN = 40;
export const DESKTOP_PET_SPEED_MAX = 200;
export const DESKTOP_PET_SPEED_DEFAULT = 100;

export interface DesktopPetActionSpeeds {
  /** How fast it walks the floor and the top edge. */
  walk: number;
  /** How fast it climbs the rope. */
  climb: number;
  /** How fast it rappels back down. */
  descend: number;
  /** How fast it floats under a parachute. */
  parachute: number;
}

export const DEFAULT_DESKTOP_PET_ACTION_SPEEDS: DesktopPetActionSpeeds = {
  walk: DESKTOP_PET_SPEED_DEFAULT,
  climb: DESKTOP_PET_SPEED_DEFAULT,
  descend: DESKTOP_PET_SPEED_DEFAULT,
  parachute: DESKTOP_PET_SPEED_DEFAULT,
};

export function clampDesktopPetSpeed(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : DESKTOP_PET_SPEED_DEFAULT;
  return Math.round(Math.min(DESKTOP_PET_SPEED_MAX, Math.max(DESKTOP_PET_SPEED_MIN, n)));
}

export function normalizeDesktopPetActionSpeeds(value: unknown): DesktopPetActionSpeeds {
  const rec = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return {
    walk: clampDesktopPetSpeed(rec.walk),
    climb: clampDesktopPetSpeed(rec.climb),
    descend: clampDesktopPetSpeed(rec.descend),
    parachute: clampDesktopPetSpeed(rec.parachute),
  };
}

/** A GitHub Actions workflow the user connected on a project's Git tab. */
export interface ProjectGithubAction {
  workflowId: number;
  /** Path like `.github/workflows/ci.yml`, used if the numeric id changes. */
  path: string;
  name: string;
}

export function normalizeProjectGithubActions(value: unknown): ProjectGithubAction[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<number>();
  const actions: ProjectGithubAction[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const workflowId = typeof rec.workflowId === 'number' ? rec.workflowId : Number(rec.workflowId);
    if (!Number.isInteger(workflowId) || workflowId <= 0 || seen.has(workflowId)) continue;
    if (typeof rec.path !== 'string' || typeof rec.name !== 'string') continue;
    const path = rec.path.trim();
    const name = rec.name.trim();
    if (!path || !name) continue;
    seen.add(workflowId);
    actions.push({ workflowId, path, name });
  }
  return actions;
}

export type AppNotificationKind = 'pipeline-failure';

/** In-app inbox item, currently pipeline failures from watched GitHub Actions. */
export interface AppNotification {
  id: string;
  kind: AppNotificationKind;
  title: string;
  body: string;
  projectId: string | null;
  projectName: string;
  htmlUrl: string | null;
  createdAt: string;
  read: boolean;
}

/** Column counts a single dashboard row can be switched between. */
export const DASHBOARD_COLUMN_OPTIONS = [1, 2, 3, 4] as const;
export type DashboardColumns = (typeof DASHBOARD_COLUMN_OPTIONS)[number];

/**
 * One horizontal band of the dashboard. Each row carries its own column count,
 * so a 4-across row of small cards can sit above a 2-across row of charts.
 */
export interface DashboardRow {
  /** Stable across reorders so React keys and drop targets survive edits. */
  id: string;
  columns: DashboardColumns;
  /**
   * Card ids in display order: chart ids, `stat:<id>` built-in stat tiles,
   * `usage:<providerId>` Token Usage cards, and `summary:<id>` usage-summary tiles.
   * Charts can be hidden from the dashboard the same way as the other cards.
   */
  items: string[];
}

/** Built-in Dashboard charts, movable and hideable like any other dashboard card. */
export const DASHBOARD_CHART_IDS = [
  'cpu',
  'memory',
  'disk',
  'gpu',
  'network',
  'pings',
  'github',
  'github-actions',
] as const;
export type DashboardChartId = (typeof DASHBOARD_CHART_IDS)[number];

/** Built-in Dashboard stat tiles, movable and hideable like any other dashboard card. */
export const DASHBOARD_STAT_IDS = [
  'installed-clis',
  'active-projects',
  'skill-repos',
  'location',
] as const;
export type DashboardStatId = (typeof DASHBOARD_STAT_IDS)[number];

/** Token Usage's aggregate summary tiles, pinnable to the dashboard from that page. */
export const DASHBOARD_USAGE_SUMMARY_IDS = [
  'tokens-today',
  'tokens-week',
  'cost-today',
  'providers-tracked',
] as const;
export type DashboardUsageSummaryId = (typeof DASHBOARD_USAGE_SUMMARY_IDS)[number];

export interface AppSettings {
  defaultCliId: string | null;
  /**
   * Extra arguments per CLI id, typed as a command line (e.g. "--model sonnet").
   * Added wherever the app runs that CLI: headless prompts (commit messages, tag
   * suggestions, version bumps, skill audits) and terminal launches.
   */
  cliArgs: CliArgsMap;
  theme: ThemeMode;
  /** Folder that holds the user's projects; folder pickers open here instead of the OS default. */
  projectsRootPath: string | null;
  skillRepositoryIds: string[];
  /** Hosts/IPs pinged for the dashboard's Network Status graph. */
  pingTargets: string[];
  /** Bot token from @BotFather, used to send notification-hook messages. */
  telegramBotToken: string | null;
  /** Chat/user ID the bot should message; also where confirmation replies are read from. */
  telegramChatId: string | null;
  /** Chat/group ID scheduled tasks are posted to and kept in sync with as their status changes. */
  telegramScheduledTasksChatId: string | null;
  /** API key for OpenAI's Chat Completions API, used by the Ask AI page. */
  openaiApiKey: string | null;
  /** Model id sent with OpenAI requests, e.g. "gpt-4o-mini". */
  openaiModel: string;
  /** Base URL of a local Ollama server, e.g. "http://localhost:11434". */
  ollamaBaseUrl: string;
  /** Last model selected for Ollama requests on the Ask AI page, and the default the pickers start on. */
  ollamaModel: string;
  /** Context window size (num_ctx) sent with Ollama requests; null keeps whatever the model ships with. */
  ollamaContextLength: number | null;
  /** How long Ollama keeps a model in RAM after a request: "5m", "1h", "0" to unload right away, "-1" to keep it loaded. */
  ollamaKeepAlive: string;
  /** API key for Google's Gemini API, used by the Ask AI page. */
  geminiApiKey: string | null;
  /** Model id sent with Gemini requests, e.g. "gemini-2.0-flash". */
  geminiModel: string;
  /** AI provider used to generate prompts in Prompt Builder; model comes from that provider's configured model above. */
  promptBuilderProvider: AiProvider;
  /**
   * Legacy flat display order for the dashboard's cards. Superseded by
   * `dashboardLayout`, and only read once to build rows for users upgrading.
   */
  dashboardChartOrder: string[];
  /** Which built-in Dashboard charts (see `DASHBOARD_CHART_IDS`) are shown; hidden ones can be brought back from the Dashboard's edit mode. */
  dashboardChartCards: string[];
  /** Provider ids whose Token Usage card is shown on the dashboard. */
  dashboardUsageCards: string[];
  /** Which built-in Dashboard stat tiles (see `DASHBOARD_STAT_IDS`) are shown; hidden ones can be brought back from the Dashboard's edit mode. */
  dashboardStatCards: string[];
  /** Which Token Usage summary tiles (see `DASHBOARD_USAGE_SUMMARY_IDS`) are pinned to the dashboard; toggled from the Token Usage page. */
  dashboardUsageSummaryCards: string[];
  /** The dashboard's rows, each with its own column count and cards. */
  dashboardLayout: DashboardRow[];
  /**
   * Chart ids already auto-inserted into the dashboard once. New built-in charts
   * that are not in this list are added on upgrade; hiding one afterwards sticks.
   */
  dashboardIntroducedCharts: string[];
  /** How many extra attempts Prompt Builder's translate action makes after an initial failure. */
  translateMaxRetries: number;
  /** Local Whisper model used for Prompt Builder voice input: 'tiny' | 'base' | 'small'. Larger is more accurate but slower and bigger to download. */
  speechModel: string;
  /** Spoken language for voice input as a Whisper code (e.g. "en", "fa"), or "auto" to detect it. */
  speechLanguage: string;
  /** LanguageTool-backed grammar, spelling, and style checking in the app's text fields. */
  grammar: GrammarSettings;
  /** Per-provider config for the Token Usage page (enabled flag + optional API key), keyed by provider id. */
  usageProviderConfigs: Record<string, UsageProviderConfig>;
  /** Floating desktop usage widgets the user has pinned; recreated on app launch. */
  usageWidgets: DesktopWidgetInstance[];
  /** Floating desktop Build Prompt widgets the user has pinned; recreated on app launch. */
  promptBuildWidgets: DesktopPromptBuildWidgetInstance[];
  /** User-defined display order for the Usage page's provider cards (provider ids). */
  usageCardOrder: string[];
  /**
   * Which view each Usage page card shows, keyed by provider id. Only providers
   * the user switched to plan limits appear here; anything absent shows tokens.
   */
  usageCardModes: Record<string, WidgetMode>;
  /** Telegram announcement when a Claude Code rate-limit window resets; toggled on the Token Usage page. */
  usageResetAlerts: UsageResetAlertSettings;
  /** OS notification (in-app toast fallback) when a rate-limit window crosses a percent threshold. */
  usageThresholdAlerts: UsageThresholdAlertSettings;
  /**
   * Floating pixel companion that walks around the desktop while Runova is
   * open. Off until the user turns it on in Settings.
   */
  desktopPetEnabled: boolean;
  /** Built-in id or a custom-… id from desktopPetCustoms. */
  desktopPetCharacterId: string;
  /** Pets the user added from a PNG, GIF, or WebP. */
  desktopPetCustoms: CustomDesktopPet[];
  /**
   * Nickname the user gave the pet. It replaces the character's own name in the
   * stats card, the right-click menu, and anything the pet says. Empty means the
   * character keeps its own name.
   */
  desktopPetName: string;
  /** When false the companion stays put (idle pose) instead of wandering. */
  desktopPetCanMove: boolean;
  /** When false it never climbs a rope to the top of the screen. */
  desktopPetCanClimb: boolean;
  /** When true it floats down under a parachute instead of rappelling. */
  desktopPetCanParachute: boolean;
  /** Walk, climb, rappel, and parachute speed as a percent of the default (40-200). */
  desktopPetActionSpeeds: DesktopPetActionSpeeds;
  /** Display size as a percent of the default (50–160). */
  desktopPetScale: number;
  /**
   * How much of the sprite is clickable and used to place the token card
   * (40–100). Lower ignores empty padding around the drawing.
   */
  desktopPetClickArea: number;
  /** Chart the companion's card shows: token report, system state, or network. */
  desktopPetCardView: DesktopPetCardView;
  /** When true the desktop pet speaks if a watched GitHub Actions run fails. */
  desktopPetPipelineOnFail: boolean;
  /** When true the desktop pet speaks if a watched GitHub Actions run passes. */
  desktopPetPipelineOnPass: boolean;
  /**
   * When true the desktop pet speaks if internet quality changes (offline,
   * back online, or a clear drop or improvement).
   */
  desktopPetNetworkQuality: boolean;
}

export type AgentType = 'claude-code' | 'gemini' | 'opencode' | 'codex' | 'cursor' | 'generic';

export type NotificationHookKind = 'completion' | 'confirmation' | 'pet';

export const NOTIFICATION_HOOK_KINDS: readonly NotificationHookKind[] = [
  'completion',
  'confirmation',
  'pet',
];

/** Where a notification hook delivers its message. */
export function notificationHookChannel(kind: NotificationHookKind): 'telegram' | 'pet' {
  return kind === 'pet' ? 'pet' : 'telegram';
}

export interface ProjectNotificationHook {
  enabled: boolean;
  /** CLI_REGISTRY id of the installed agent this hook is wired to (e.g. "claude-code"). */
  cliId: string | null;
  message: string;
}

export interface ProjectNotificationSettings {
  completion: ProjectNotificationHook;
  confirmation: ProjectNotificationHook;
  /**
   * Speaks the message through the desktop companion instead of Telegram. It only lands
   * while Runova is running with the companion on screen; any other time the hook
   * quietly does nothing, so the agent's CLI never sees a failure.
   */
  pet: ProjectNotificationHook;
}

/** A single hook entry found in a project's .claude/settings.json or .claude/settings.local.json. */
export interface DetectedClaudeHook {
  /** Stable within one read; re-derived as `${sourceFile}:${event}:${groupIndex}:${hookIndex}`. */
  id: string;
  event: string;
  matcher?: string;
  /** Raw `{ type, command, args?, timeout?, ... }` body, passed through as Claude Code stores it. */
  hook: Record<string, unknown>;
  /** True when this is one of Runova's own Completion/Confirmation hooks (shown elsewhere). */
  managedByRunova: boolean;
  /** CLI_REGISTRY id of the owning agent: 'claude-code', or another agent inferred from the command. */
  cliId: string;
}

/** One launch command, usually tied to an environment (dev, staging, prod). */
export interface ProjectRunCommand {
  id: string;
  /** Environment or display name, e.g. "dev". Empty falls back to the command itself. */
  label: string;
  command: string;
}

/**
 * Older project records stored a single `runCommand` string. Accept either shape
 * so loaders and backups can be normalized in one place.
 */
export type ProjectRunCommandSource = {
  runCommands?: ProjectRunCommand[] | null;
  runCommand?: string | null;
};

export function normalizeProjectRunCommands(source: ProjectRunCommandSource): ProjectRunCommand[] {
  if (Array.isArray(source.runCommands)) {
    return source.runCommands
      .filter((entry) => typeof entry?.command === 'string' && entry.command.trim().length > 0)
      .map((entry, index) => ({
        id: typeof entry.id === 'string' && entry.id.trim() ? entry.id : `run-${index}`,
        label: typeof entry.label === 'string' ? entry.label.trim() : '',
        command: entry.command.trim(),
      }));
  }
  const legacy = typeof source.runCommand === 'string' ? source.runCommand.trim() : '';
  if (!legacy) return [];
  return [{ id: 'legacy', label: '', command: legacy }];
}

export function configuredRunCommands(project: Pick<Project, 'runCommands'>): ProjectRunCommand[] {
  return project.runCommands.filter((entry) => entry.command.trim().length > 0);
}

/** Label shown in pickers and tooltips: the environment name, or the command if unnamed. */
export function projectRunCommandTitle(entry: ProjectRunCommand): string {
  return entry.label.trim() || entry.command;
}

export function projectRunCommandHint(entry: ProjectRunCommand): string {
  const title = entry.label.trim();
  return title ? `${title}: ${entry.command}` : entry.command;
}

export interface Project {
  id: string;
  name: string;
  folderPath: string;
  description: string;
  tags: string[];
  agentType: AgentType;
  notes: string;
  /** Launch commands the Run button can start in the project folder. Empty when none are set. */
  runCommands: ProjectRunCommand[];
  /**
   * The project's standing prompt: the context handed to an agent every time it
   * works on this project. Defined from the Prompt dialog on the project detail
   * page. Empty when not configured.
   */
  prompt: string;
  notifications: ProjectNotificationSettings;
  /**
   * CLI_REGISTRY id this project's AI actions run through. Null (the default) means
   * "use the app-wide default CLI from Settings"; set it to pin this one project to a
   * different agent.
   */
  cliId: string | null;
  /**
   * The project's own icon, stored inline as a data URL so it survives backups
   * and never depends on a file that moves. Either picked from disk or grabbed
   * from `websiteUrl`'s favicon. Null falls back to the generic folder glyph.
   */
  iconDataUrl: string | null;
  /** Site this project lives at, and the source its favicon is fetched from. Empty when unset. */
  websiteUrl: string;
  /**
   * Where the project's code is hosted, e.g. "https://github.com/me/my-app". Filled in
   * on the create form (detected from the folder's origin remote when there is one),
   * and only ever a label to open: nothing here runs git. Empty when unset.
   */
  repoUrl: string;
  /** GitHub Actions workflows connected on the Git tab. Empty when none are watched. */
  githubActions: ProjectGithubAction[];
  /** Pinned projects are sorted first on the Projects page, above the drag-ordered rest. */
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface InstalledCli {
  id: string;
  installed: boolean;
  version: string | null;
  executablePath: string | null;
  lastCheckedAt: string;
}

export interface CliUpdateCheckResult {
  cliId: string;
  /** False when this CLI has no known source to check the latest version against. */
  supported: boolean;
  currentVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  checkedAt: string;
}

export type ActivityEventType =
  | 'cli-installed'
  | 'cli-detected'
  | 'project-created'
  | 'project-bootstrapped'
  | 'skill-installed'
  | 'skill-removed'
  | 'prompt-generated'
  | 'repository-added';

export interface ActivityEvent {
  id: string;
  type: ActivityEventType;
  message: string;
  createdAt: string;
  metadata?: Record<string, string>;
}

export function defaultProjectNotifications(): ProjectNotificationSettings {
  return {
    completion: {
      enabled: false,
      cliId: null,
      message: '✅ {{project}} has finished its work.',
    },
    confirmation: {
      enabled: false,
      cliId: null,
      message:
        '⏸️ {{project}} needs your confirmation to continue. Reply to this message to continue.',
    },
    pet: {
      enabled: false,
      cliId: null,
      message: '{{project}} is done, come take a look.',
    },
  };
}

/**
 * Fills in hooks a stored project has never seen (the pet hook was added after the
 * Telegram ones), so reading an older projects.json never hands back a missing kind.
 */
export function normalizeProjectNotifications(
  value: Partial<ProjectNotificationSettings> | null | undefined,
): ProjectNotificationSettings {
  const defaults = defaultProjectNotifications();
  if (!value) return defaults;
  return {
    completion: { ...defaults.completion, ...value.completion },
    confirmation: { ...defaults.confirmation, ...value.confirmation },
    pet: { ...defaults.pet, ...value.pet },
  };
}

export interface PromptTemplate {
  id: string;
  name: string;
  promptType: string;
  targetAI: string;
  content: string;
  createdAt: string;
}

export type ProjectDraftStatus = 'draft' | 'implemented';

/**
 * A Prompt Builder draft parked against a project. Keeps the parameters the prompt was
 * built with so the project's Overview can show what was planned and whether it shipped.
 */
export interface ProjectDraft {
  id: string;
  projectId: string;
  rawInput: string;
  promptType: string;
  targetAI: string;
  /** The generated prompt as it stood when the draft was saved. */
  content: string;
  status: ProjectDraftStatus;
  createdAt: string;
  /** ISO datetime the draft was marked implemented; null while it's still open. */
  implementedAt: string | null;
}

export type ScheduledTaskStatus = 'pending' | 'completed' | 'cancelled';

export interface ScheduledTask {
  id: string;
  projectId: string;
  rawInput: string;
  promptType: string;
  targetAI: string;
  content: string;
  /** ISO datetime the task is scheduled to run at. */
  runAt: string;
  status: ScheduledTaskStatus;
  createdAt: string;
  /** Telegram chat/group this task's status message was posted to, so edits target the same chat. */
  telegramChatId?: string | null;
  /** message_id of the Telegram message tracking this task, used to edit it in place on status changes. */
  telegramMessageId?: number | null;
}
