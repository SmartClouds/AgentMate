import type { CliArgsMap } from '../cli/args.js';
import type { CliLaunchDefaultsMap } from '../cli/launchDefaults.js';
import type { CommitMessageSettings } from '../git/commitMessage.js';
import type { ProjectWorktreeSetup, WorktreeSettings } from '../git/worktrees.js';
import type { GrammarSettings } from '../grammar/languagetool.js';
import type { ProxySettings } from '../network/proxy.js';
import type { EffortLevel } from '../promptBuilder/runRecommendation.js';
import type { DesktopPromptBuildWidgetInstance } from '../promptBuilder/types.js';
import { runCommandSummary } from '../run/runInputs.js';
import type {
  DesktopWidgetInstance,
  StatusBarUsageSettings,
  UsageProviderConfig,
  UsageResetAlertSettings,
  UsageThresholdAlertSettings,
  WidgetMode,
} from '../usage/types.js';

export const THEME_MODES = ['light', 'dark', 'system', 'vscode-dark', 'vs2026'] as const;
export type ThemeMode = (typeof THEME_MODES)[number];

export type PingMethod = 'icmp' | 'http' | 'auto';
export type PingIpVersion = 'ipv4' | 'ipv6';
export function isThemeMode(value: unknown): value is ThemeMode {
  return THEME_MODES.includes(value as ThemeMode);
}

/** Where the main menu sits: a sidebar down the left edge, or a menu bar under the title bar. */
export const MENU_POSITIONS = ['left', 'top'] as const;
export type MenuPosition = (typeof MENU_POSITIONS)[number];

export function isMenuPosition(value: unknown): value is MenuPosition {
  return MENU_POSITIONS.includes(value as MenuPosition);
}

/**
 * How a Workspace agent tab shows its CLI: the CLI itself in a terminal, or a chat view drawn from
 * the transcript the CLI writes while the same CLI keeps running underneath.
 */
export const AGENT_TAB_MODES = ['cli', 'chat'] as const;
export type AgentTabMode = (typeof AGENT_TAB_MODES)[number];

export function isAgentTabMode(value: unknown): value is AgentTabMode {
  return AGENT_TAB_MODES.includes(value as AgentTabMode);
}

/**
 * Where the main window opens. 'last' reopens the page the app was on when it closed; the rest
 * are the sidebar's pages, so the list has to follow the sidebar when a page is added there.
 */
export const STARTUP_PAGES = [
  'last',
  '/',
  '/usage',
  '/prompt-builder',
  '/projects',
  '/workspace',
  '/api-client',
  '/studio',
  '/pipelines',
  '/deploy',
  '/monitoring',
  '/skills',
  '/mcp',
  '/tools',
  '/docker',
  '/android',
  '/cli-manager',
  '/ask-ai',
  '/remote',
  '/vault',
  '/help',
  '/settings',
] as const;
export type StartupPage = (typeof STARTUP_PAGES)[number];

export function isStartupPage(value: unknown): value is StartupPage {
  return STARTUP_PAGES.includes(value as StartupPage);
}

/**
 * Where clicking a pipeline failure alert (the toast's Open button, a Recent messages row or the
 * pet's bubble) takes you: the Pipelines section of that project's Workspace, the all-projects
 * Pipelines page, or nowhere.
 */
export const PIPELINE_FAILURE_OPEN_TARGETS = ['workspace', 'pipelines', 'none'] as const;
export type PipelineFailureOpen = (typeof PIPELINE_FAILURE_OPEN_TARGETS)[number];

export function isPipelineFailureOpen(value: unknown): value is PipelineFailureOpen {
  return PIPELINE_FAILURE_OPEN_TARGETS.includes(value as PipelineFailureOpen);
}

export type AiProvider = 'openai' | 'ollama' | 'gemini';

export const DESKTOP_PET_IDS = [
  'fandi',
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
  return 'fandi';
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

/** A GitHub Actions workflow of a project's repo, as listed on its Git tab. */
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

export type AppNotificationKind =
  | 'pipeline-failure'
  | 'pipeline-success'
  | 'tool-update-available'
  /** A server core's alert, by severity (the Deploy section's watcher raises these). */
  | 'deploy-critical'
  | 'deploy-warning'
  | 'deploy-info'
  /** A project healthcheck confirmed down, and back up (E22). */
  | 'health-failure'
  | 'health-recovered'
  /** A Relay task needs the user (blocked, failing tests, a stalled session), and a relay ended (E26). */
  | 'relay-attention'
  | 'relay-finished'
  /** CI auto-fix made a run pass, needs the user, or ran out of attempts. */
  | 'pipeline-autofix-fixed'
  | 'pipeline-autofix-attention'
  | 'pipeline-autofix-gave-up';

/** In-app inbox item: pipeline results from watched GitHub Actions, or a CLI/tool update. */
export interface AppNotification {
  id: string;
  kind: AppNotificationKind;
  title: string;
  body: string;
  projectId: string | null;
  projectName: string;
  htmlUrl: string | null;
  /** A page in the app that clicking it opens, such as a Deploy server's Overview. */
  route?: string;
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
  'resource-usage',
  'idle-resources',
] as const;
export type DashboardChartId = (typeof DASHBOARD_CHART_IDS)[number];

/**
 * Charts added after the first release. A profile saved before one existed does not list it as
 * introduced, so it gets appended to that dashboard once instead of being treated as hidden.
 */
export const LATE_DASHBOARD_CHART_IDS: readonly DashboardChartId[] = [
  'github-actions',
  'resource-usage',
  'idle-resources',
];

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

/**
 * The dashboard a brand new install opens with, and what "Reset to default" in the dashboard's
 * edit mode puts back. Every card listed in the category lists has a cell in `dashboardLayout`,
 * so nothing gets appended after it on load.
 */
export const DEFAULT_DASHBOARD: {
  dashboardChartCards: DashboardChartId[];
  dashboardStatCards: DashboardStatId[];
  dashboardUsageCards: string[];
  dashboardUsageSummaryCards: DashboardUsageSummaryId[];
  dashboardLayout: DashboardRow[];
} = {
  dashboardChartCards: [...DASHBOARD_CHART_IDS],
  dashboardStatCards: ['location'],
  dashboardUsageCards: ['claude-code'],
  dashboardUsageSummaryCards: ['tokens-today', 'tokens-week', 'cost-today'],
  dashboardLayout: [
    {
      id: 'default-row-1',
      columns: 4,
      items: ['summary:tokens-today', 'summary:tokens-week', 'summary:cost-today', 'stat:location'],
    },
    { id: 'default-row-2', columns: 2, items: ['network', 'pings', 'cpu', 'gpu'] },
    { id: 'default-row-3', columns: 3, items: ['usage:claude-code', 'memory', 'disk'] },
    { id: 'default-row-4', columns: 2, items: ['github', 'github-actions'] },
    { id: 'default-row-5', columns: 2, items: ['resource-usage', 'idle-resources'] },
  ],
};

export interface SecurityScannerSettings {
  sonarToken?: string | null;
  sonarUrl?: string | null;
  sonarProjectKey?: string | null;
  strixModel?: string | null;
  strixApiKey?: string | null;
  codeqlLanguage?: string | null;
  codeqlBuildCommand?: string | null;
  semgrepConfig?: string | null;
  trivyScanners?: string[] | null;
}

/**
 * Sleep policy. 'agent' is the middle ground: the machine stays awake while something is
 * actually running and sleeps normally the rest of the time.
 */
export type KeepAwakeMode = 'on' | 'agent' | 'off';

/**
 * What to do about a project's Docker containers when its run is stopped and they are still
 * running: ask each time, stop them without asking, or leave them alone.
 */
export const RUN_DOCKER_STOP_MODES = ['ask', 'stop', 'keep'] as const;
export type RunDockerStopMode = (typeof RUN_DOCKER_STOP_MODES)[number];

export function isRunDockerStopMode(value: unknown): value is RunDockerStopMode {
  return RUN_DOCKER_STOP_MODES.includes(value as RunDockerStopMode);
}

export interface AppSettings {
  defaultCliId: string | null;
  /**
   * Extra arguments per CLI id, typed as a command line (e.g. "--model sonnet").
   * Added wherever the app runs that CLI: headless prompts (commit messages, tag
   * suggestions, version bumps, skill audits) and terminal launches.
   */
  cliArgs: CliArgsMap;
  /**
   * Model, effort, and permission mode per CLI id, added only when Runova opens that CLI in a
   * terminal. A field left unset adds no flag, so the CLI keeps its own default.
   */
  cliLaunchDefaults: CliLaunchDefaultsMap;
  /**
   * CLI_REGISTRY ids in the order agents are listed wherever the user picks one to launch
   * (the Workspace launcher and pane tiles). CLIs missing from it follow in registry order.
   * Empty keeps the default order, with the project's own agent first.
   */
  cliOrder: string[];
  /** Which CLI writes AI commit messages and the rules it follows. */
  commitMessage: CommitMessageSettings;
  /** Where new worktrees go and what they start with. */
  worktrees: WorktreeSettings;
  /** PR comments offered as one-click review requests in the workspace Pull request tab. */
  reviewCommands: string[];
  theme: ThemeMode;
  /** Whether the main menu is the left sidebar or a menu bar along the top of the window. */
  menuPosition: MenuPosition;
  /** The page the main window opens on: the one it was on when the app closed, or a fixed page. */
  startupPage: StartupPage;
  /** How a Workspace agent tab shows its CLI until the user switches that tab's view. */
  defaultAgentTabMode: AgentTabMode;
  /** Folder that holds the user's projects; folder pickers open here instead of the OS default. */
  projectsRootPath: string | null;
  skillRepositoryIds: string[];
  /** Hosts/IPs pinged for the dashboard's Network Status graph. */
  pingTargets: string[];
  /** Whether the ping command uses IPv4 or IPv6. */
  pingIpVersion: PingIpVersion;
  /** Hosts/IPs pinged when `pingIpVersion` is `ipv6`. */
  pingTargetsIpv6: string[];
  /** How connection quality is measured: the ping command, HTTP requests to `pingUrls`, or ping with an HTTP fallback. */
  pingMethod: PingMethod;
  /** URLs requested when `pingMethod` is `http` or `auto`. */
  pingUrls: string[];
  /** Seconds between URL requests, however often the app samples. */
  pingUrlIntervalSeconds: number;
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
  /**
   * Embedding model per provider for the help chat's search index. A provider left out uses the
   * default from the model catalog. Changing one makes the index embed the articles again.
   */
  helpEmbeddingModels: Partial<Record<AiProvider, string>>;
  /** AI provider used to generate prompts in Prompt Builder; model comes from that provider's configured model above. */
  promptBuilderProvider: AiProvider;
  /**
   * Whether the Build Prompt dialog sizes the model and effort as soon as Generate or Translate
   * finishes. When off, the dialog's Recommended run chip starts the sizing when it is opened.
   */
  promptBuilderAutoSize: boolean;
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
  /**
   * Where the app's outgoing requests go: straight out, through this machine's
   * own proxy settings, or through a server typed in by hand. Covers the main
   * process, the update check, and the CLIs and git commands Runova spawns.
   */
  proxy: ProxySettings;
  /** Per-provider config for the Token Usage page (enabled flag + optional API key), keyed by provider id. */
  usageProviderConfigs: Record<string, UsageProviderConfig>;
  /**
   * Per-project security scanner settings for the Security tab: the SonarQube token and project
   * key, the Strix model and LLM key, and the CodeQL language. Keyed by project id, because the
   * language and the Sonar project key are genuinely per-project rather than machine-wide.
   *
   * Secrets sit here in plaintext, which is the same convention usageProviderConfigs already
   * uses. They are passed to scanners through the environment, never argv, and are stripped out
   * of scan logs and reports before either crosses IPC.
   */
  securityScannerConfigs: Record<string, SecurityScannerSettings>;
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
  /** Which providers show their plan limits in the bottom status bar; switched in Settings. */
  statusBarUsage: StatusBarUsageSettings;
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
  /**
   * Characters whose sprite is drawn facing the other way, so the pet is
   * mirrored to face the direction it walks.
   */
  desktopPetFlippedIds: string[];
  /** When false the companion stays put (idle pose) instead of wandering. */
  desktopPetCanMove: boolean;
  /** When false it never climbs a rope to the top of the screen. */
  desktopPetCanClimb: boolean;
  /** When true it floats down under a parachute instead of rappelling. */
  desktopPetCanParachute: boolean;
  /**
   * When true the rope and the parachute are drawn with depth (shaded gores, a
   * lit cord) instead of the flat pixel look, so they sit with a pet uploaded
   * as a 3D render.
   */
  desktopPetGear3d: boolean;
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
   * When true a watched GitHub Actions run that fails raises a notice: a toast, a row in Recent
   * messages and an unread mark on Pipelines. Off keeps failures out of the inbox, the pet has
   * its own switch (`desktopPetPipelineOnFail`).
   */
  pipelineFailureNotify: boolean;
  /**
   * What clicking a failure alert (the toast's Open button, a Recent messages row or the pet's
   * bubble) opens. 'pipelines' is the all-projects page on the failed run, 'workspace' the
   * Pipelines section of that project's Workspace, 'none' leaves the click as a plain dismiss.
   */
  pipelineFailureOpen: PipelineFailureOpen;
  /**
   * The agent CLI CI auto-fix runs when a watched run fails. Null falls back to the project's own
   * CLI, then the default CLI. Each run can still pick another when auto-fix is switched on.
   */
  ciAutoFixCliId: string | null;
  /** Model for `ciAutoFixCliId`. Null leaves it to the CLI's launch defaults. */
  ciAutoFixModel: string | null;
  ciAutoFixEffort: EffortLevel | null;
  /** How many fixes auto-fix pushes for one run before it gives up and tells the user (1 to 5). */
  ciAutoFixMaxAttempts: number;
  /**
   * When true the desktop pet speaks if internet quality changes (offline,
   * back online, or a clear drop or improvement).
   */
  desktopPetNetworkQuality: boolean;
  /**
   * When true the desktop pet speaks when a workspace CLI needs your input or
   * finishes a run, as long as you are not already looking at that tab.
   */
  desktopPetAgentStatus: boolean;
  /**
   * When true, terminal sessions keep running in the background after Runova quits and
   * reappear, output included, the next time it opens. Restarts for an update always keep
   * them, whatever this is set to.
   */
  keepTerminalsRunning: boolean;
  /**
   * What happens to a project's Docker containers when its run is stopped and they are still
   * running. The run itself always stops straight away; this only decides about the containers.
   */
  stopDockerWithRun: RunDockerStopMode;
  /**
   * When true, a project's runs are paused while an agent works in the same folder and resumed
   * a few seconds after it stops, so hot reload does not rebuild on every file the agent writes.
   */
  autoPauseRunsWhileAgentWorks: boolean;
  /**
   * When true, an agent in a Workspace tab that finishes or asks a question while you are
   * looking elsewhere raises a system notification.
   */
  workspaceNotifications: boolean;
  /**
   * When true, an AI task in a terminal tab that asks a question or waits for a command to be
   * approved raises a system notification while that terminal isn't in front of you.
   */
  terminalAiNotifications: boolean;
  /**
   * Whether Runova keeps this computer from going to sleep: always, only while an agent
   * (or a shell) is busy, or never.
   */
  keepAwake: KeepAwakeMode;
  /**
   * When true, Runova checks once a day whether a newer version of an installed CLI or tool
   * has been published, and drops a bell notification in the app when one has.
   */
  checkToolUpdatesEnabled: boolean;
  /**
   * Off by default: a Workspace terminal pane leaves colors alone, so whatever CLI is running
   * in it (Claude Code's own gray, say) looks the way it would in any ordinary terminal. On
   * paints `workspaceTerminalBackgroundColor` instead, with foreground and ANSI colors
   * recomputed to stay readable against it.
   */
  workspaceTerminalCustomBackground: boolean;
  /** Background used for Workspace terminal panes when `workspaceTerminalCustomBackground` is on. */
  workspaceTerminalBackgroundColor: string;
  /** Minutes without vault activity before the Vault locks itself. 0 means never. */
  vaultAutoLockMinutes: number;
  /** Seconds before a password copied from the Vault is cleared from the clipboard. 0 means never. */
  vaultClipboardClearSeconds: number;
  /** Locks the Vault when the computer locks its screen or goes to sleep. */
  vaultLockOnSystemLock: boolean;
  /**
   * Android SDK root. Null auto-detects from ANDROID_HOME, ANDROID_SDK_ROOT and the usual
   * per-OS install paths. Set it when detection picks the wrong SDK or finds none.
   */
  androidSdkPath: string | null;
  /**
   * Extra flags added to every `emulator -avd` launch, typed as a command line
   * (for example "-gpu host -no-boot-anim"). They are appended last, so they win.
   */
  androidEmulatorLaunchFlags: string;
  /**
   * Send `adb emu kill` to the emulators Runova started when the app quits. Off by default:
   * an emulator is a window the user can close themselves, and it is slow to boot again.
   */
  androidStopEmulatorsOnQuit: boolean;
  /** Where Android screenshots and recordings are written. Null uses Pictures and Videos. */
  androidCapturePath: string | null;
  /**
   * Minutes a Docker container or Android emulator can sit quiet before the Dashboard lists it
   * as idle. Clamped to 1..1440 when read.
   */
  idleResourceMinutes: number;
  /** Send a system notification when a container or emulator first goes idle. */
  idleResourceNotify: boolean;
  /**
   * The stacks shown in Agent Tools > Dev Setup, as `DevStackId`s. Essentials is always first and
   * always present; the rest are the ones the user switched on.
   */
  devSetupStacks: string[];
  /**
   * The saved servers the Deploy page lists, in the order the user arranged them. Deploy shows
   * only these, so a server saved in Remote stays out of it until the user picks it.
   */
  deployServerIds: string[];
  /**
   * The machine each self-hosted runner runs on, so the Pipelines page can show its CPU, memory
   * and disk. Keyed by the runner's scope and name (`owner/repo/name` or `org/name`).
   */
  runnerMachineLinks: Record<string, RunnerMachineLink>;
}

/** Which machine a self-hosted runner runs on: a saved SSH server, or this computer. */
export type RunnerMachineLink = { kind: 'ssh'; serverId: string } | { kind: 'local' };

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
  return entry.label.trim() || runCommandSummary(entry.command);
}

export function projectRunCommandHint(entry: ProjectRunCommand): string {
  const title = entry.label.trim();
  const command = runCommandSummary(entry.command);
  return title ? `${title}: ${command}` : command;
}

/** Where a WordPress item lives: wp-content/themes, wp-content/plugins or wp-content/mu-plugins. */
export type ProjectWordPressItemKind = 'theme' | 'plugin' | 'mu-plugin';

/** A theme, plugin or mu-plugin by its folder (or single file) name under its root. */
export interface ProjectWordPressItem {
  kind: ProjectWordPressItemKind;
  slug: string;
}

/**
 * A project that mirrors part of a WordPress site connected through the Runova Connector
 * plugin (E21). The folder keeps the site's layout (`wp-content/themes/<slug>/...`), and only
 * these items are ever pulled or deployed, so anything else in the folder (agent settings,
 * Runova's own files, notes) never reaches the site. What was last synced is kept by the app,
 * outside the folder.
 */
export interface ProjectWordPressLink {
  /** The connected site in Deploy (deploy-wordpress.json), on this computer. */
  siteId: string;
  items: ProjectWordPressItem[];
  linkedAt: string;
  /**
   * What the user chose to leave out of pulls and deploys, as gitignore-like lines relative to an
   * item's root: under `*` for every item, or under `theme:slug` for one. Saved so the choice is
   * not made again at every deploy. Absent when nothing is ignored.
   */
  ignore?: Record<string, string[]>;
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
   * The project's own icon as a data URL, either picked from disk or grabbed
   * from `websiteUrl`'s favicon. Null falls back to the generic folder glyph.
   *
   * This is the form the UI works in and the form a backup carries, so an icon
   * never depends on a file that moves. On disk the image itself lives in
   * `iconFile` instead, and this is filled back in when projects are read.
   */
  iconDataUrl: string | null;
  /**
   * Name of the image file under the app data folder (data/project-icons) that
   * holds this project's icon. Written and cleaned up by the app; null when the
   * project has no icon.
   */
  iconFile: string | null;
  /**
   * Colour of the tile the icon sits on, as a `#rrggbb` string. Null keeps the
   * theme's default tint, so a project only carries a colour once one is picked.
   */
  iconBgColor: string | null;
  /**
   * Colour of the folder glyph shown when the project has no icon image, as a
   * `#rrggbb` string. Null keeps the theme's accent.
   */
  iconColor: string | null;
  /** Site this project lives at, and the source its favicon is fetched from. Empty when unset. */
  websiteUrl: string;
  /**
   * Where the project's code is hosted, e.g. "https://github.com/me/my-app". Filled in
   * on the create form (detected from the folder's origin remote when there is one).
   * A GitHub address is cloned into the folder on create, and while the folder isn't a
   * repo the Git tab offers to clone it from here. Empty when unset.
   */
  repoUrl: string;
  /**
   * GitHub Actions workflows the user switched off on the Git tab. Every workflow in
   * the repo is watched by default, so this is the opt-out list: empty means all of
   * them report failures, and a workflow added to the repo later starts watched too.
   */
  githubActionsMuted: ProjectGithubAction[];
  /** What a new git worktree of this project gets: a setup command and files to copy. */
  worktreeSetup: ProjectWorktreeSetup;
  /** Pinned projects are sorted first on the Projects page, above the drag-ordered rest. */
  pinned: boolean;
  /**
   * Archived projects are kept out of the Projects page and live behind its
   * Archived toggle instead. Nothing about the project changes, it just stops
   * competing for space with the ones being worked on. Archiving also unpins.
   */
  archived: boolean;
  /**
   * Set when the project mirrors a WordPress site (E21). Only the WordPress channels set or
   * change it; a plain project update leaves it alone. Not carried by backups, since the site's
   * keys belong to this computer.
   */
  wordpress?: ProjectWordPressLink;
  createdAt: string;
  updatedAt: string;
}

/**
 * Colours are stored as hex, the one form the pickers produce and every consumer
 * can drop straight into a style: `#rrggbb` when opaque, `#rrggbbaa` once the
 * opacity slider has been moved. A fully opaque value keeps the short form so the
 * two never disagree about the same colour. Anything else (a stray value in a
 * backup, an older field) reads back as "no colour picked".
 */
/** The app's own tint, offered as the starting point once a custom terminal background is turned on. */
export const DEFAULT_TERMINAL_BACKGROUND_COLOR = '#0a1210';

export function normalizeProjectColor(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const hex = value.trim().toLowerCase();
  if (!/^#([0-9a-f]{6}|[0-9a-f]{8})$/.test(hex)) return null;
  return hex.length === 9 && hex.endsWith('ff') ? hex.slice(0, 7) : hex;
}

export interface InstalledCli {
  id: string;
  installed: boolean;
  version: string | null;
  executablePath: string | null;
  lastCheckedAt: string;
  /**
   * Set when the executable was found but its version command failed outright, which is what a
   * half-finished update or a wrong-platform binary looks like. Holds the first line it printed.
   */
  runError?: string;
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

/** `missed` is an automatic task whose time passed while the app was closed. */
export type ScheduledTaskStatus = 'pending' | 'completed' | 'cancelled' | 'missed';

/**
 * `manual` tasks wait for Run now. `auto` tasks open in a terminal on their own at `runAt`
 * while the app is running.
 */
export type ScheduledTaskRunMode = 'manual' | 'auto';

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
  /** Missing on tasks saved before run modes existed, which read as manual. */
  runMode?: ScheduledTaskRunMode;
  /** CLI to run the prompt in. Missing falls back to the default CLI, then the target AI's CLI. */
  cliId?: string;
  /** Value for the CLI's model flag, e.g. "opus". */
  model?: string;
  effort?: EffortLevel;
  /** ISO datetime the task was last started, by hand or by the scheduler. */
  ranAt?: string | null;
}

/**
 * The Blueprint's fixed steps, in the order the wizard walks them. The final
 * Review step is deliberately not here: it edits blueprint-level fields rather
 * than a section, and leaving it out is what lets `sections` be exhaustive.
 */
export const BLUEPRINT_STEP_IDS = [
  'idea',
  'architecture',
  'backend',
  'frontend',
  'cicd',
  'quality',
] as const;

export type BlueprintStepId = (typeof BLUEPRINT_STEP_IDS)[number];

export function isBlueprintStepId(value: unknown): value is BlueprintStepId {
  return BLUEPRINT_STEP_IDS.includes(value as BlueprintStepId);
}

/** A file the user attached to one step: a mockup, a spec, a screenshot. */
export interface BlueprintAttachment {
  id: string;
  /**
   * Name of the file under the app data folder (data/blueprint-files). App
   * generated, never user input, and read back through `basename` so a doctored
   * blueprints.json can't point outside that folder.
   */
  fileName: string;
  /** What the user calls it. Editable, display only, never touches the filesystem. */
  displayName: string;
  mime: string;
  /** Bytes on disk, kept here so the UI and the backup can decide without stat-ing every file. */
  size: number;
  createdAt: string;
}

export interface BlueprintSection {
  stepId: BlueprintStepId;
  /** What the user typed, in whatever language they typed it. The source of truth. */
  text: string;
  /** English copy used to build the prompt. Null until a generate run produces it. */
  textEn: string | null;
  /**
   * Hash of `text` at the moment `textEn` was produced, so an unchanged section
   * skips the network on the next generate. Hashing the source rather than
   * stamping a time means an edit-then-undo doesn't force a re-translation.
   */
  textEnHash: string | null;
  attachments: BlueprintAttachment[];
  /** Mirrors this section into the project's agent instruction file (CLAUDE.md, AGENTS.md, ...). */
  includeInAgentFile: boolean;
  updatedAt: string;
}

/** One project's blueprint: the stepped description behind its Product Manager prompt. */
export interface ProjectBlueprint {
  id: string;
  projectId: string;
  /** Project-relative folder the generated prompt tells the agent to write its plan into. */
  docsFolder: string;
  /** Exactly one entry per BLUEPRINT_STEP_IDS, in order. Guaranteed by `withBlueprintDefaults`. */
  sections: BlueprintSection[];
  /** The Product Manager prompt, in English, editable. Empty until it has been generated once. */
  finalPrompt: string;
  finalPromptUpdatedAt: string | null;
  /** Have the agent list the phases and epics it intends to write before it writes any files. */
  confirmBeforeWriting: boolean;
  /**
   * Relay (E26): write the backlog as task files sized to fit one AI session under this context
   * budget. Always set once `withBlueprintDefaults` has read the record.
   */
  relay?: BlueprintRelaySetting;
  createdAt: string;
  updatedAt: string;
}

export interface BlueprintRelaySetting {
  enabled: boolean;
  /** Context tokens one session may use on a task. */
  budgetTokens: number;
}

/** A reusable snippet defined in Settings and pulled into a step with one click. */
export interface BlueprintPreset {
  id: string;
  stepId: BlueprintStepId;
  /** Chip text, e.g. "React 19 + Vite + Tailwind". */
  label: string;
  /** Appended to that step's box when the chip is clicked. */
  text: string;
  createdAt: string;
}

export type BlueprintRevisionTarget = 'section' | 'final-prompt';

/**
 * One saved state of a section or of the final prompt, written after the edit
 * lands. Storing the new value rather than the old one is what makes "what did
 * Backend say on Tuesday" a single row lookup, and leaves the newest row equal
 * to what's on screen.
 */
export interface BlueprintRevision {
  id: string;
  blueprintId: string;
  /** Denormalized so the history query never has to join back to blueprints.json. */
  projectId: string;
  target: BlueprintRevisionTarget;
  /** The step for a section revision; null for the final prompt. */
  stepId: BlueprintStepId | null;
  text: string;
  /** Attachment names as they stood, so a revision reads like a snapshot rather than a diff. */
  attachmentNames: string[];
  createdAt: string;
}
