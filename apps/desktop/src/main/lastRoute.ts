import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseScopeId, type StartupPage } from '@runova/core';
import { app, type BrowserWindow } from 'electron';
import { store } from './store';

/**
 * The page the main window was on when the app closed, so the next launch can open there instead
 * of on the dashboard. The renderer reports every route change; the file is written a moment
 * later, and straight away when the window closes, the session ends or the app quits.
 */

/** Typing into a search box that lives in the URL changes the route on every key. */
const SAVE_DELAY_MS = 300;

/** Longer than any route the app builds, short enough that junk can't bloat the file. */
const MAX_ROUTE_LENGTH = 2048;

/** The first path segment of every page that renders inside the app shell (see App.tsx). */
const SHELL_PAGES = new Set([
  '',
  'usage',
  'prompt-builder',
  'prompt-history',
  'projects',
  'workspace',
  'api-client',
  'pipelines',
  'skills',
  'mcp',
  'tools',
  'docker',
  'android',
  'cli-manager',
  'ask-ai',
  'remote',
  'remote-files',
  'vault',
  'settings',
]);

/** Params a notification click adds to act once; reopening with them would act again. */
const ONE_SHOT_PARAMS = ['session', 'tag'];

let cached: string | null | undefined;
let pending: string | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

function routeFile(): string {
  return join(app.getPath('userData'), 'data', 'last-route.json');
}

/**
 * A route the main window can be opened on, cleaned of one-shot params, or null for anything
 * else: other windows' pages, unknown pages, and anything that is not an in-app path.
 */
export function normalizeRoute(route: unknown): string | null {
  if (typeof route !== 'string' || route.length > MAX_ROUTE_LENGTH) return null;
  if (!route.startsWith('/') || route.startsWith('//')) return null;
  const queryAt = route.indexOf('?');
  const pathname = queryAt === -1 ? route : route.slice(0, queryAt);
  if (!SHELL_PAGES.has(pathname.split('/')[1] ?? '')) return null;
  if (queryAt === -1) return pathname;
  const params = new URLSearchParams(route.slice(queryAt + 1));
  for (const name of ONE_SHOT_PARAMS) params.delete(name);
  const search = params.toString();
  return search ? `${pathname}?${search}` : pathname;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * The route to open the main window on. A saved route that points at a deleted project falls
 * back to the page that lists them, rather than opening an empty workspace for it.
 */
export function resolveStartupRoute(input: {
  startupPage: StartupPage;
  lastRoute: string | null;
  projectIds: readonly string[];
}): string {
  if (input.startupPage !== 'last') return input.startupPage;
  const route = normalizeRoute(input.lastRoute);
  if (!route) return '/';
  const [, page, id] = route.split('?')[0]?.split('/') ?? [];
  if ((page === 'workspace' || page === 'projects') && id) {
    const { projectId } = parseScopeId(decodeSegment(id));
    if (!input.projectIds.includes(projectId)) return `/${page}`;
  }
  return route;
}

function readRoute(): string | null {
  try {
    const saved = JSON.parse(readFileSync(routeFile(), 'utf-8')) as { route?: unknown } | null;
    return normalizeRoute(saved?.route);
  } catch {
    // Missing on first launch, and a damaged file just means opening on the dashboard.
    return null;
  }
}

function writeRoute(route: string): void {
  try {
    const file = routeFile();
    mkdirSync(join(file, '..'), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ route }), 'utf-8');
    renameSync(tmp, file);
  } catch {
    // Losing the last page is harmless; the next route change tries again.
  }
}

export function loadLastRoute(): string | null {
  if (cached === undefined) cached = readRoute();
  return cached;
}

/** Writes a route that is still waiting on its timer. Safe to call when nothing is waiting. */
export function flushLastRoute(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  if (pending === null) return;
  const route = pending;
  pending = null;
  writeRoute(route);
}

/** Records the page the main window is on now. Anything `normalizeRoute` refuses is ignored. */
export function rememberRoute(route: unknown): void {
  const next = normalizeRoute(route);
  if (!next) return;
  cached = next;
  pending = next;
  if (timer) clearTimeout(timer);
  timer = setTimeout(flushLastRoute, SAVE_DELAY_MS);
}

/** Written right away on close and at logoff/shutdown: a pending timer would never run. */
export function trackLastRoute(win: BrowserWindow): void {
  win.on('close', flushLastRoute);
  win.on('session-end', flushLastRoute);
}

/** Where the main window should open, from the startup page setting and the saved route. */
export async function startupRoute(): Promise<string> {
  const [settings, projects] = await Promise.all([store.getSettings(), store.getProjects()]);
  return resolveStartupRoute({
    startupPage: settings.startupPage,
    lastRoute: loadLastRoute(),
    projectIds: projects.map((project) => project.id),
  });
}

let prepared: string | null = null;

/**
 * Works out the launch route ahead of the window. The window then starts loading the moment it
 * is made, and a deep link that arrives during startup sees it loading and waits its turn (see
 * focusMainWindow) instead of being sent to a window with no page yet.
 */
export async function prepareStartupRoute(): Promise<void> {
  prepared = await startupRoute().catch(() => '/');
}

/**
 * The route for a new main window: the prepared one for the first window of a launch, and after
 * that the page this session was last on, as when macOS makes a new window from the Dock.
 */
export function takeStartupRoute(): string {
  const route = prepared ?? loadLastRoute() ?? '/';
  prepared = null;
  return route;
}
