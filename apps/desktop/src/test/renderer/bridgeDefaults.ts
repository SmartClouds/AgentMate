/**
 * What the fake bridge answers for the calls pages make in the background (the sidebar, status
 * bar and settings cards all fetch on mount), so a test that only stubs what it is about still
 * renders those parts the way a fresh install would. Without these the calls resolve to
 * undefined, React Query rejects that, and every render logs "Query data cannot be undefined".
 *
 * Each answer is the "nothing here yet" state: no projects, no tools found, nothing installed.
 * A test's own answers replace these.
 */

import { DEFAULT_SETTINGS } from '@shared/defaultSettings';

type RunovaApi = Window['runova'];

/** What calling a dotted path on the real bridge resolves to. */
type Answer<T, P extends string> = P extends `${infer Head}.${infer Rest}`
  ? Head extends keyof T
    ? Answer<T[Head], Rest>
    : never
  : P extends keyof T
    ? T[P] extends (...args: never[]) => infer R
      ? Awaited<R>
      : never
    : never;

/**
 * The bridge hands back a non-object answer as a plain property (that is how `platform` works),
 * so anything that is not an object has to be written as the call itself.
 */
type Default<A> = [A] extends [object] ? A : () => Promise<A>;

/** Checks every path against the real bridge, so a renamed call or a changed shape fails tsc. */
function defaults<M>(
  map: { [P in keyof M]: P extends string ? Default<Answer<RunovaApi, P>> : never },
) {
  return map as Record<string, unknown>;
}

/** A fresh copy per bridge, so one test changing an answer cannot reach the next. */
export function bridgeDefaults(): Record<string, unknown> {
  const androidSdk = {
    status: 'missing',
    root: null,
    source: null,
    checked: [],
    tools: { adb: false, emulator: false, avdmanager: false, sdkmanager: false },
    adbVersion: null,
  } as const;
  const noGithubCli = { ok: false, cliAvailable: false, authenticated: false } as const;

  return defaults({
    'settings.get': structuredClone(DEFAULT_SETTINGS),
    'app.getVersion': async () => '0.0.0',
    'appNotifications.list': [],
    'appNotifications.unreadCount': async () => 0,
    'projects.list': [],
    'projectDrafts.listByProject': [],
    'scheduledTasks.listByProject': [],
    'worktrees.list': [],
    'git.stashList': [],
    'git.githubAccount': { cliAvailable: false, authenticated: false, login: null, owners: [] },
    'cli.detectAll': [],
    'tools.detectAll': [],
    'ssh.listServers': [],
    'ssh.vaultStatus': { hasPasskey: false, unlocked: false },
    'remote.listSavedServers': [],
    'skills.listRepositories': [],
    'skills.checkForUpdates': [],
    'mcp.listRepositories': [],
    'skills.listInstalled': [],
    'skills.listOnDiskSkills': [],
    'skills.listFavorites': [],
    'skills.latestAuditPerSkill': [],
    'mcp.listInstalled': [],
    'blueprints.listPresets': [],
    'security.latest': async () => null,
    'security.codeqlStatus': {
      installed: false,
      path: null,
      version: null,
      onPath: false,
      installDir: '',
      progress: null,
    },
    'usage.list': [],
    'promptHistory.list': [],
    'pipelines.runners': { ok: true, runners: [], waiting: [], hiddenOrgs: [] },
    'pipelines.dashboardActivity': {
      ...noGithubCli,
      days: [],
      runs: [],
      weekPassed: 0,
      weekFailed: 0,
      runningCount: 0,
      repoCount: 0,
    },
    'git.githubActivity': { ...noGithubCli, login: null, yearCount: 0, days: [] },
    'git.githubNotifications': { ...noGithubCli, notifications: [] },
    'android.sdk': { ...androidSdk, checked: [] },
    'android.refresh': {
      sdk: { ...androidSdk, checked: [] },
      emulators: [],
      physical: [],
      broken: [],
    },
    'android.availableSystemImages': { images: [], error: null },
    'grammar.localStatus': {
      toolsDir: '',
      installPath: null,
      version: null,
      javaVersion: null,
      javaMajor: null,
      serverState: 'stopped',
      port: 8081,
      error: null,
    },
    'help.status': { chunks: 0, embedded: 0, backend: 'js', embedder: null },
    'help.embeddingModels': [],
    'ai.listOllamaModels': [],
    'proxy.status': { mode: 'direct', effectiveServer: null, systemServer: null },
    'vault.status': {
      state: 'uninitialized',
      retryAfterMs: 0,
      autoLockMinutes: 15,
      clipboardClearSeconds: 30,
    },
    'vault.listCategories': [],
    'pet.getSnooze': { until: null },
    'pet.customDataUrls': {},
    'deploy.coreRelease': async () => null,
    'studio.settings': {
      defaultRoot: '',
      defaultRootIsCustom: false,
      standaloneRoot: '',
      cacheDir: '',
      cacheCapGb: 10,
      autoResumeRenders: true,
      hwEncode: false,
    },
    'studioRender.jobs': [],
    'studioAi.generations': [],
    'studioAudio.engines': [],
    'studioAi.recipes': [],
    'studio.list': [],
    'studioRender.tools': {
      ffmpeg: { found: false, version: null },
      ffprobe: { found: false },
      codecs: { h264: 'ffmpeg not found', h265: 'ffmpeg not found', vp9: 'ffmpeg not found' },
    },
    'docker.availability': async () => false,
    'resourceActivity.snapshot': {
      generatedAt: 0,
      watchingSince: 0,
      idleMinutes: 20,
      docker: 'unavailable',
      emulators: 'unavailable',
      resources: [],
      history: [],
    },
    'news.list': { items: [], page: 1, totalPages: 1, total: 0, stale: false, checkedAt: null },
    'fs.listDirectory': [],
    'projects.listClaudeHooks': [],
    'environments.list': [],
    'security.activeScan': async () => null,
    'security.history': [],
    'security.preflight': [],
    'pipelines.runAnnotations': {
      ok: true,
      annotations: [],
      counts: { failure: 0, warning: 0, notice: 0 },
    },
    'pipelines.jobLog': { ok: true, steps: [] },
    'ciAutoFix.list': [],
    'deploySystem.services': [],
    'deployRegistry.plan': { sendSignIns: false, entries: [] },
    'cloudflareServer.dnsTokens': [],
    'cloudflareServer.originLock': {
      enabled: false,
      authenticatedOriginPulls: false,
      state: 'off',
      ports: [],
      missingRules: [],
      openRules: [],
      staleRules: [],
      warnings: [],
    },
  });
}
