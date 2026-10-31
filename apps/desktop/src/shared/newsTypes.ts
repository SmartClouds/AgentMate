/**
 * News from runovahq.com (E42). The list and detail shapes mirror the website API's
 * `NewsListItemDto` and `NewsItemDto` (docs/website/api-contract.md); the views add what only this
 * machine knows: whether the item was read or dismissed, and whether it affects a tool installed here.
 */

export const NEWS_CATEGORIES = [
  'security',
  'release',
  'deprecation',
  'end-of-life',
  'ai',
  'tooling',
  'industry',
] as const;
export type NewsCategory = (typeof NEWS_CATEGORIES)[number];

/** Lowest to highest, the order `minSeverity` filters by. */
export const NEWS_SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'] as const;
export type NewsSeverity = (typeof NEWS_SEVERITIES)[number];

/**
 * The technologies whose installed version the app can read. Any other slug in the contract can
 * appear on an item but never matches this machine.
 */
export const DETECTABLE_TECHNOLOGIES = [
  'runova',
  'electron',
  'nodejs',
  'git',
  'dotnet',
  'docker',
  'claude-code',
  'codex-cli',
  'gemini-cli',
  'grok-cli',
  'cursor-cli',
  'opencode',
  'openclaude',
  'copilot-cli',
  'aider',
  'goose',
  'cline-cli',
  'continue-cli',
  'pi',
  'muse-code',
  'freebuff-cli',
  'qwen-cli',
] as const;
export type TechnologySlug = (typeof DETECTABLE_TECHNOLOGIES)[number];

export interface NewsTechnology {
  technology: string;
  name: string;
  versionRange: string;
  fixedIn: string | null;
}

export interface NewsListItem {
  id: number;
  slug: string;
  url: string;
  title: string;
  summary: string;
  category: NewsCategory;
  severity: NewsSeverity;
  technologies: NewsTechnology[];
  cveIds: string[];
  cvssScore: number | null;
  tags: string[];
  publishedAt: string;
  updatedAt: string;
}

export interface NewsSourceLink {
  title: string;
  url: string;
}

export interface NewsItemDetail extends NewsListItem {
  bodyHtml: string;
  sourceLinks: NewsSourceLink[];
}

/** A tool found on this machine, in the form the matcher reads. */
export interface InstalledTool {
  slug: TechnologySlug;
  version: string;
  label: string;
}

/** One technology of an item that matched an installed tool. */
export interface AffectedMatch {
  slug: string;
  label: string;
  version: string;
  versionRange: string;
  fixedIn: string | null;
}

export interface NewsItemView extends NewsListItem {
  read: boolean;
  dismissed: boolean;
  /** The first match, for the badge. Null when nothing installed here is affected. */
  affected: AffectedMatch | null;
}

export interface NewsItemDetailView extends NewsItemDetail {
  read: boolean;
  dismissed: boolean;
  affected: AffectedMatch | null;
  /** Every affected technology, for the detail sheet. */
  affectedAll: AffectedMatch[];
}

export interface NewsListQuery {
  category?: NewsCategory[];
  minSeverity?: NewsSeverity;
  page?: number;
  pageSize?: number;
}

export interface NewsListResult {
  items: NewsItemView[];
  page: number;
  totalPages: number;
  /** True when the last poll failed and these are the cached items. */
  stale: boolean;
  /** When the API last answered (200 or 304). Null before it ever has. */
  checkedAt: string | null;
}

export interface NewsChangedEvent {
  /** Null only when the API has never answered on this machine. */
  checkedAt: string | null;
  stale: boolean;
}
