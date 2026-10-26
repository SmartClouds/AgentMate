import type { NginxProblemInfo } from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';

/**
 * Where a problem the core reported belongs. The core names fields the way its validator walks
 * the settings (`sites[blog].domains[2]`, `streams[pg].listenPort`, `sites[blog].locationSnippet`
 * with a line), so each one can be shown next to the field it is about, on the right tab.
 */

export type SiteTab =
  | 'domains'
  | 'proxy'
  | 'ssl'
  | 'performance'
  | 'security'
  | 'advanced'
  | 'logs';

export interface PlacedProblem {
  scope: 'site' | 'stream' | 'general';
  /** The site or stream proxy id, when the field names one. */
  id?: string;
  /** The field below the site or proxy, such as `domains[2]` or `timeouts.readSeconds`. */
  path: string;
  tab: SiteTab;
  message: string;
  line?: number;
}

const FIELD = /^(sites|streams)\[([^\]]*)\]\.?(.*)$/;

const TABS: ReadonlyArray<[RegExp, SiteTab]> = [
  [/^(id|domains)\b/, 'domains'],
  [/^(upstream|websocket)\b/, 'proxy'],
  [/^(certificate|hsts|redirectToHttps|http2)\b/, 'ssl'],
  [/^(gzip|proxyCache|clientMaxBodySizeMegabytes|timeouts)\b/, 'performance'],
  [/^(responseHeaders|securityHeaders|ipRules|basicAuth|rateLimit)\b/, 'security'],
  [/^(serverSnippet|locationSnippet)\b/, 'advanced'],
];

export function tabOf(path: string): SiteTab {
  return TABS.find(([pattern]) => pattern.test(path))?.[1] ?? 'domains';
}

export function placeProblem(problem: NginxProblemInfo): PlacedProblem {
  const match = FIELD.exec(problem.field);
  const line = problem.line === undefined ? {} : { line: problem.line };
  if (!match) {
    return {
      scope: problem.siteId ? 'site' : 'general',
      ...(problem.siteId ? { id: problem.siteId } : {}),
      path: problem.field,
      tab: tabOf(problem.field),
      message: problem.message,
      ...line,
    };
  }
  const [, kind, id, path] = match;
  return {
    scope: kind === 'sites' ? 'site' : 'stream',
    id,
    path,
    tab: tabOf(path),
    message: problem.message,
    ...line,
  };
}

/** The problems of one site (or one stream proxy), by the field each is about. */
export function problemsFor(
  problems: readonly NginxProblemInfo[],
  scope: 'site' | 'stream',
  id: string,
): PlacedProblem[] {
  return problems.map(placeProblem).filter((placed) => placed.scope === scope && placed.id === id);
}

/** The first message about `path` itself or anything below it (`upstream` covers `upstream.port`). */
export function messageAt(problems: readonly PlacedProblem[], path: string): string | undefined {
  return problems.find(
    (problem) =>
      problem.path === path ||
      problem.path.startsWith(`${path}.`) ||
      problem.path.startsWith(`${path}[`),
  )?.message;
}

/** How many problems each tab has, to mark the tabs that need a look. */
export function problemsByTab(
  problems: readonly PlacedProblem[],
): Partial<Record<SiteTab, number>> {
  const counts: Partial<Record<SiteTab, number>> = {};
  for (const problem of problems) counts[problem.tab] = (counts[problem.tab] ?? 0) + 1;
  return counts;
}

/** Problems on snippet lines, for the editor's inline marks. */
export function snippetMarks(
  problems: readonly PlacedProblem[],
  snippet: 'serverSnippet' | 'locationSnippet',
): Array<{ line: number; message: string }> {
  return problems
    .filter((problem) => problem.path === snippet)
    .map((problem) => ({ line: problem.line ?? 1, message: problem.message }));
}
