/**
 * What the fake bridge answers for the calls pages make in the background (the sidebar, status
 * bar and settings cards all fetch on mount), so a test that only stubs what it is about still
 * renders those parts the way a fresh install would. Without these the calls resolve to
 * undefined, React Query rejects that, and every render logs "Query data cannot be undefined".
 *
 * Each answer is the "nothing here yet" state: no projects, no tools found, nothing installed.
 * A test's own answers replace these.
 */

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
function defaults<M>(map: { [P in keyof M]: P extends string ? Default<Answer<RunovaApi, P>> : never }) {
  return map as Record<string, unknown>;
}

/** A fresh copy per bridge, so one test changing an answer cannot reach the next. */
export function bridgeDefaults(): Record<string, unknown> {
  return defaults({
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
    'docker.availability': async () => false,
    'ssh.listServers': [],
    'skills.listRepositories': [],
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
    'android.sdk': {
      status: 'missing',
      root: null,
      source: null,
      checked: [],
      tools: { adb: false, emulator: false, avdmanager: false, sdkmanager: false },
      adbVersion: null,
    },
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
    'pet.getSnooze': { until: null },
    'pet.customDataUrls': {},
    'deploy.coreRelease': async () => null,
    'studioRender.jobs': [],
    'studioAi.generations': [],
    'studioAudio.engines': [],
  });
}
