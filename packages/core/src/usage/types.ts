import { CLAUDE_WEEKLY_METERED_MODEL } from '../models/catalog.js';

// Shared types for the Token Usage feature (CodexBar-style). These describe the
// provider catalog, the normalized usage snapshot every data source returns, and
// the desktop-widget instances the user pins to their screen.

/** How AgentMate obtains usage data for a provider. */
export type UsageDataSource =
  | 'local-log' // parse local CLI logs on disk (no credentials): Claude Code, Codex
  | 'local-session' // reuse the vendor app's own signed-in session on disk: Cursor
  | 'api-key' // call the provider's usage/billing API with a stored key
  | 'unsupported'; // registered for completeness; live wiring not implemented yet

/** Loose grouping used only to organize the provider picker UI. */
export type UsageProviderCategory =
  | 'coding-agent'
  | 'api-provider'
  | 'ide'
  | 'router'
  | 'cloud'
  | 'audio'
  | 'other';

export interface UsageProviderDefinition {
  /** Stable kebab-case id, also the settings/widget key. */
  id: string;
  name: string;
  category: UsageProviderCategory;
  dataSource: UsageDataSource;
  /** True when the data source can attribute a $ cost (needs a pricing contract). */
  supportsCost: boolean;
  /** Marketing/site link, shown on the "Connect" state. */
  homepageUrl?: string;
  /** What kind of key the provider wants, when "API key" is too vague. */
  keyHint?: string;
  /** Brand accent used by the monogram logo fallback and the Colorful widget style. */
  accentColor: string;
}

export interface UsageTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Grand total across all token kinds. */
  total: number;
}

export function emptyUsageTokens(): UsageTokens {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

/** A rolling quota window (e.g. weekly limit) when the provider exposes one. */
export interface UsageWindow {
  label: string;
  used: number;
  total: number;
  /** 0–100. */
  percent: number;
  /** ISO datetime the window resets, when known. */
  resetAt: string | null;
}

/**
 * A named slice of one period's consumption, e.g. Cursor's Auto-mode vs API usage,
 * for example. Segments are a partition: they sum to the period they hang off,
 * so a card can show the split without a second fetch or a second period.
 */
export interface UsageSegment {
  /** Stable id within the provider ('auto', 'api'). */
  key: string;
  /** Display label: 'Auto', 'API'. */
  label: string;
  tokens: UsageTokens;
  /** Cost attributed to this slice, or null when the source can't price it. */
  costUsd: number | null;
  /** Request count, for sources that bill per request rather than per token. */
  requests?: number;
}

/** Per-period tokens + cost, keyed today / last 7d / last 30d. */
export interface UsagePeriod {
  tokens: UsageTokens;
  /** Estimated cost in `currency`, or null when it can't be priced. */
  costUsd: number | null;
  /** Optional breakdown of this period; omitted when the provider has no split. */
  segments?: UsageSegment[];
}

// --- Subscription (non-API) accounts --------------------------------------

/** How the account pays for inference. Drives which widget mode makes sense. */
export type UsageAccountMode = 'subscription' | 'api';

/** The plan a subscription account is on. */
export interface SubscriptionPlan {
  /** Raw id as the CLI records it ('pro', 'max', 'team'…). */
  id: string;
  /** Display label: 'Pro', 'Max 5×', 'Team'. */
  label: string;
}

/**
 * Which rate-limit window a `SubscriptionWindow` describes. `month-auto` and
 * `month-api` are the two halves of a Cursor usage-based plan's monthly limit.
 */
export type SubscriptionWindowKey =
  | 'session'
  | 'week'
  | 'week-fable'
  | 'month'
  | 'month-auto'
  | 'month-api';

/**
 * Label for the weekly bucket that meters Claude's top model on top of the shared one. The model
 * name comes from the catalog, so it follows when that model changes.
 */
export const FABLE_WEEK_LABEL = `Weekly (${CLAUDE_WEEKLY_METERED_MODEL.family})`;

/**
 * True when the plan meters Fable in its own weekly window, on top of the
 * weekly limit every subscription has. Only plans above Pro do; Pro gets a
 * single weekly limit, so the second bar would be an empty row.
 *
 * Matched by id rather than an exhaustive list so a new Max tier (or a seat
 * tier we haven't seen) still gets the window instead of silently losing it.
 */
export function metersFableWeekly(plan: SubscriptionPlan | null | undefined): boolean {
  const id = plan?.id.trim().toLowerCase();
  if (!id) return false;
  return id.startsWith('max') || id === 'team' || id === 'enterprise';
}

/** One rolling rate-limit window on a subscription plan. */
export interface SubscriptionWindow {
  key: SubscriptionWindowKey;
  /** Display label: 'Session (5h)', 'Weekly', 'Weekly (Fable)'. */
  label: string;
  /** 0–100 consumed. */
  percent: number;
  /** ISO datetime the window resets, when known. */
  resetAt: string | null;
  /** Tokens spent in the window; only set when derived from local logs. */
  usedTokens?: number;
  /** API-equivalent value of those tokens, which is what the percent is based on. */
  usedUsd?: number;
}

/**
 * Subscription state for a provider: which plan, and how much of each rolling
 * limit is spent. `source` says whether the numbers are authoritative
 * (fetched from the account) or reconstructed from local logs.
 */
export interface SubscriptionUsage {
  mode: UsageAccountMode;
  /** Null when the plan can't be determined (API mode, or not signed in). */
  plan: SubscriptionPlan | null;
  windows: SubscriptionWindow[];
  source: 'account' | 'estimate';
  /** Why the authoritative fetch was skipped/failed, for the estimate footnote. */
  estimateReason?: string;
  /**
   * ISO datetime the windows were read, when that is not the snapshot's `updatedAt`. An account
   * answer is held for a while between reads, and Codex reports its limits only on its own turns,
   * so the numbers can be older than the scan that carries them.
   */
  readAt?: string;
}

/** Plan limits read on an earlier attempt, kept while the provider cannot be read now. */
export interface LastKnownLimits {
  plan: SubscriptionPlan | null;
  windows: SubscriptionWindow[];
  /** ISO datetime the limits were read. */
  readAt: string;
}

/**
 * What one project (or one folder that is not a project) spent on each of the last days. The arrays
 * are index-aligned with `ProjectDaily.endDay`: the last entry is that day, the first the oldest.
 */
export interface ProjectDailyUsage {
  /** `project:<id>` for a registered AgentMate project, `folder:<path>` for any other folder. */
  key: string;
  name: string;
  /** The folder the sessions ran in, when there is one. */
  path: string | null;
  /** Tokens of every kind, per local day. */
  tokens: number[];
  /** Estimated cost in USD of the priced tokens, per local day. */
  costUsd: number[];
  /** Tokens on models with no known price, per local day. */
  unpricedTokens: number[];
}

/** Per-project daily usage over a fixed window of local days ending at `endDay`. */
export interface ProjectDaily {
  /** `YYYY-MM-DD` in local time: the last day of the window, which is today. */
  endDay: string;
  projects: ProjectDailyUsage[];
}

export type ProviderUsageStatus = 'ok' | 'connect' | 'error';

/** Normalized snapshot returned by every data source, rendered by one card. */
export interface ProviderUsage {
  providerId: string;
  status: ProviderUsageStatus;
  /** Present when status === 'error'. */
  error?: string;
  today: UsagePeriod;
  last7d: UsagePeriod;
  last30d: UsagePeriod;
  /** Optional quota window (limit bar + reset countdown). */
  window?: UsageWindow;
  /** Plan + rolling-limit state, when the provider is on a subscription. */
  subscription?: SubscriptionUsage;
  /**
   * The plan limits this provider last reported, attached only when this snapshot has no current
   * ones because the read failed, or has only an estimate from local logs because the account did
   * not answer. Kept apart from `subscription` so nothing that treats limits as
   * current (the Usage page, widgets, the alert watchers) mistakes them for fresh numbers.
   */
  lastLimits?: LastKnownLimits;
  /** Set when the plan limits could not be read this time, which is not the same as having none. */
  limitsError?: string;
  /** Recent per-hour (or per-day) token totals for the burn-rate sparkline. */
  series?: number[];
  /** Daily cost totals aligned with `series`, when the source can price calls. */
  costSeries?: number[];
  /**
   * Usage split by project and day, for the local-log sources whose logs name a folder. Absent when
   * the source cannot say which folder a session ran in, or when the split could not be built.
   */
  projectDaily?: ProjectDaily;
  /** Currency code for the cost figures (only 'USD' for now). */
  currency: string;
  /** ISO datetime this snapshot was computed. */
  updatedAt: string;
}

export type WidgetSize = 'small' | 'medium' | 'large';
export type WidgetStyle = 'mono' | 'colorful';
/** Which period the tokens/cost headline and averages use. */
export type WidgetPeriod = 'day' | 'week' | 'month';

/**
 * What a widget shows. These are two separate widgets a user can pin side by
 * side, not two states of one: 'tokens' is the original tokens/cost card, and
 * 'subscription' is the plan's rolling limits. Never infer one from the other;
 * a pinned widget keeps showing what it was pinned to show.
 */
export type WidgetMode = 'tokens' | 'subscription';

/** Options the pin dialog and in-widget settings send when creating or updating a widget. */
export interface OpenWidgetOptions {
  size?: WidgetSize;
  mode?: WidgetMode;
  style?: WidgetStyle;
  /** 0–100 frost amount for the glass background. */
  blurPercent?: number;
  /** Hex fill for the glass, or null to use the app theme. */
  backgroundColor?: string | null;
  /** True keeps the widget above other windows; false leaves it on the desktop. */
  alwaysOnTop?: boolean;
  period?: WidgetPeriod;
}

export const DEFAULT_WIDGET_BLUR_PERCENT = 50;
export const DEFAULT_WIDGET_ALWAYS_ON_TOP = true;
export const DEFAULT_WIDGET_PERIOD: WidgetPeriod = 'day';

/** A floating desktop widget the user has pinned; persisted in AppSettings. */
export interface DesktopWidgetInstance {
  id: string;
  providerId: string;
  x: number;
  y: number;
  size: WidgetSize;
  style: WidgetStyle;
  /** Absent on widgets pinned before modes existed; those are token widgets. */
  mode?: WidgetMode;
  /** 0–100 frost amount. Absent on older widgets; treated as 50. */
  blurPercent?: number;
  /** Hex fill for the glass. Absent or null uses the app theme. */
  backgroundColor?: string | null;
  /** Absent on older widgets; treated as true (always on top). */
  alwaysOnTop?: boolean;
  /** Headline period. Absent on older widgets; treated as day. */
  period?: WidgetPeriod;
  /** Last dragged size, when the user resized past the S/M/L preset. */
  width?: number;
  height?: number;
}

export function clampWidgetBlurPercent(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_WIDGET_BLUR_PERCENT;
  return Math.min(100, Math.max(0, Math.round(value)));
}

export function widgetAlwaysOnTop(widget: Pick<DesktopWidgetInstance, 'alwaysOnTop'>): boolean {
  return widget.alwaysOnTop !== false;
}

export function widgetPeriod(widget: Pick<DesktopWidgetInstance, 'period'>): WidgetPeriod {
  return widget.period === 'week' || widget.period === 'month'
    ? widget.period
    : DEFAULT_WIDGET_PERIOD;
}

/** A 3- or 6-digit hex, or null when the widget should use the app theme. */
export function widgetBackgroundColor(value: string | null | undefined): string | null {
  if (value == null || typeof value !== 'string') return null;
  const hex = value.trim();
  const six = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (six) return `#${six[1].toLowerCase()}`;
  const three = /^#([0-9a-fA-F]{3})$/.exec(hex);
  if (!three) return null;
  const [r, g, b] = three[1];
  return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
}

// --- Rate-limit reset alerts ----------------------------------------------

/**
 * Telegram announcements fired when a subscription window rolls over. The
 * schedule isn't user-authored: a window's reset moment is already known from
 * `SubscriptionWindow.resetAt`, so all the user picks is which of those moments
 * are worth a message.
 */
export interface UsageResetAlertSettings {
  enabled: boolean;
  /** Provider whose windows are watched: Claude Code, Codex or Cursor. */
  providerId: string;
  /** Windows to announce; a window missing from the account's plan is skipped. */
  windows: SubscriptionWindowKey[];
  /**
   * Chat/group the reset message goes to. Null reuses the notification chat
   * configured in Settings, which is what most users want.
   */
  chatId: string | null;
}

export function defaultUsageResetAlerts(): UsageResetAlertSettings {
  return { enabled: false, providerId: 'claude-code', windows: ['session'], chatId: null };
}

/**
 * A reset-alert block that is safe to read fields off. settings.json is written
 * by whichever build ran last (and can be hand-edited), so a saved block may be
 * missing pieces this one dereferences without asking: `windows` above all,
 * which is filtered and mapped on sight. Anything unusable falls back to the
 * default rather than reaching the UI as `undefined`.
 */
export function normalizeUsageResetAlerts(
  alerts: Partial<UsageResetAlertSettings> | null | undefined,
): UsageResetAlertSettings {
  const defaults = defaultUsageResetAlerts();
  if (!alerts || typeof alerts !== 'object') return defaults;
  return {
    enabled: alerts.enabled === true,
    providerId: alerts.providerId || defaults.providerId,
    windows: Array.isArray(alerts.windows) ? alerts.windows : defaults.windows,
    chatId: alerts.chatId ?? null,
  };
}

// --- Usage threshold alerts ------------------------------------------------

/**
 * OS notification fired the moment a subscription window's consumption
 * crosses a percentage the user picked (e.g. 90%). Unlike reset alerts there
 * is no schedule to reconstruct; each poll just compares the window's
 * current `percent` against `threshold`.
 */
export interface UsageThresholdAlertSettings {
  enabled: boolean;
  /** Provider whose windows are watched: Claude Code, Codex or Cursor. */
  providerId: string;
  /** Windows to watch; a window missing from the account's plan is skipped. */
  windows: SubscriptionWindowKey[];
  /** 0–100. Fires once a watched window's percent reaches this value. */
  threshold: number;
}

export function defaultUsageThresholdAlerts(): UsageThresholdAlertSettings {
  return { enabled: false, providerId: 'claude-code', windows: ['session'], threshold: 90 };
}

/**
 * A threshold-alert block that is safe to read fields off, for the same
 * reason `normalizeUsageResetAlerts` exists: settings.json can be hand-edited
 * or written by an older build, so anything unusable falls back to the
 * default rather than reaching the UI or the watcher as `undefined`.
 */
export function normalizeUsageThresholdAlerts(
  alerts: Partial<UsageThresholdAlertSettings> | null | undefined,
): UsageThresholdAlertSettings {
  const defaults = defaultUsageThresholdAlerts();
  if (!alerts || typeof alerts !== 'object') return defaults;
  const threshold = Number(alerts.threshold);
  return {
    enabled: alerts.enabled === true,
    providerId: alerts.providerId || defaults.providerId,
    windows: Array.isArray(alerts.windows) ? alerts.windows : defaults.windows,
    threshold: Number.isFinite(threshold)
      ? Math.min(100, Math.max(1, threshold))
      : defaults.threshold,
  };
}

// --- Status bar limits -----------------------------------------------------

/**
 * Providers that can show their plan limits in the bottom status bar, in the
 * order the bar and the Settings switches list them.
 */
export const STATUS_BAR_USAGE_PROVIDERS = ['claude-code', 'codex', 'cursor'] as const;

export type StatusBarUsageProviderId = (typeof STATUS_BAR_USAGE_PROVIDERS)[number];

/** Whether each provider's limits item shows in the status bar, keyed by provider id. */
export type StatusBarUsageSettings = Record<StatusBarUsageProviderId, boolean>;

export function defaultStatusBarUsage(): StatusBarUsageSettings {
  return { 'claude-code': true, codex: true, cursor: true };
}

/**
 * Every provider gets an explicit on or off, and anything that isn't a plain
 * `false` counts as on, so a provider added later shows up for everyone.
 */
export function normalizeStatusBarUsage(value: unknown): StatusBarUsageSettings {
  const saved = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const next = defaultStatusBarUsage();
  for (const id of STATUS_BAR_USAGE_PROVIDERS) next[id] = saved[id] !== false;
  return next;
}

/** Per-provider user configuration (enabled + optional API key). */
export interface UsageProviderConfig {
  enabled: boolean;
  apiKey?: string | null;
  /** Optional base URL override for self-hosted gateways (LiteLLM, LLM Proxy…). */
  baseUrl?: string | null;
}
