import type { AppSettings } from '@runova/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * runHeadlessCliPrompt() is the one way every background AI task (commit messages, PR text, tag
 * suggestions, version bumps, run sizing, skill reviews, SSH tasks) starts a CLI. These pin that
 * it always starts it with the user's CLI settings, read fresh from the store on each run.
 */

interface Spawned {
  command: string;
  args: string[];
  stdin: string | null;
  env: Record<string, string | undefined> | undefined;
}

const spawned: Spawned[] = [];
const settings = { current: {} as Partial<AppSettings> };
/** CLI ids whose `--version` probe succeeds, i.e. that count as installed. */
const installed = new Set<string>(['claude']);

vi.mock('node:child_process', () => ({
  execFile: vi.fn(
    (
      file: string,
      argv: string[],
      options: { env?: Record<string, string | undefined> },
      done: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      // Windows goes through `cmd.exe /d /s /c <command> ...args`.
      const [command, ...args] = file === 'cmd.exe' ? argv.slice(3) : [file, ...argv];
      const entry: Spawned = { command: command ?? '', args, stdin: null, env: options?.env };
      spawned.push(entry);
      setTimeout(() => done(null, 'an answer', ''), 0);
      return {
        pid: 1,
        kill: vi.fn(),
        stdin: {
          end: (payload?: string) => {
            entry.stdin = payload ?? null;
          },
        },
      };
    },
  ),
}));
vi.mock('../packageManagers/execUtils', () => ({
  runCli: vi.fn(async (command: string) => {
    if (!installed.has(command)) throw new Error('not found');
    return { stdout: '1.0.0', stderr: '' };
  }),
}));
/** Commands the next PATH refresh makes findable, like a CLI installed after the app started. */
const appearsAfterPathRefresh = new Set<string>();
vi.mock('../shellPath', () => ({
  refreshShellPath: vi.fn(async () => {
    for (const command of appearsAfterPathRefresh) installed.add(command);
  }),
}));
/** Commands whose file sits in a folder only the extra tool path covers, like ~/.local/bin. */
const foundInToolDirs = new Set<string>();
// The real lookup would find whatever CLIs the machine running the tests has installed.
vi.mock('../installMethod', () => ({
  resolveExecutable: vi.fn(async (names: string[]) => {
    const name = names.find((candidate) => foundInToolDirs.has(candidate));
    return name ? `/home/me/.local/bin/${name}` : null;
  }),
}));
// The real one starts Python to find its Scripts folder, which would land in `spawned` too.
vi.mock('../toolPaths', () => ({
  withToolPath: vi.fn(async (env?: NodeJS.ProcessEnv) => ({ ...(env ?? process.env) })),
}));
vi.mock('../store', () => ({
  store: {
    getSettings: async () => ({
      defaultCliId: null,
      cliArgs: {},
      cliLaunchDefaults: {},
      ...settings.current,
    }),
  },
}));

async function run(options: Parameters<typeof import('./headlessPrompt').runHeadlessCliPrompt>[2]) {
  const { runHeadlessCliPrompt } = await import('./headlessPrompt');
  const result = await runHeadlessCliPrompt('write a commit message', '/repo', options);
  expect(result.ok).toBe(true);
  const last = spawned.at(-1);
  if (!last) throw new Error('no CLI was started');
  return last;
}

beforeEach(() => {
  spawned.length = 0;
  installed.clear();
  installed.add('claude');
  settings.current = { defaultCliId: 'claude-code' };
});

describe('runHeadlessCliPrompt uses the user CLI settings', () => {
  it('starts the CLI bare when nothing is set', async () => {
    const started = await run({});
    expect(started.command).toBe('claude');
    expect(started.args).toEqual(['-p']);
    expect(started.stdin).toBe('write a commit message');
  });

  it('passes the saved Arguments box', async () => {
    settings.current = { defaultCliId: 'claude-code', cliArgs: { 'claude-code': '--verbose' } };
    expect((await run({})).args).toEqual(['-p', '--verbose']);
  });

  it('leaves Launch defaults out, those are for terminals only', async () => {
    settings.current = {
      defaultCliId: 'claude-code',
      cliLaunchDefaults: { 'claude-code': { model: 'opus', effort: 'high', mode: 'auto' } },
    };
    expect((await run({})).args).toEqual(['-p']);
  });

  it('reads the settings again on every run, so a change applies right away', async () => {
    settings.current = { defaultCliId: 'claude-code', cliArgs: { 'claude-code': '--model opus' } };
    expect((await run({})).args).toContain('opus');
    settings.current = {
      defaultCliId: 'claude-code',
      cliArgs: { 'claude-code': '--model sonnet' },
    };
    expect((await run({})).args).toContain('sonnet');
  });

  it('uses the settings of the project CLI when a project picks one', async () => {
    installed.add('codex');
    settings.current = {
      defaultCliId: 'claude-code',
      cliArgs: { 'claude-code': '--verbose', 'codex-cli': '--skip-git-repo-check' },
    };
    const started = await run({ preferredCliId: 'codex-cli' });
    expect(started.command).toBe('codex');
    expect(started.args).toContain('--skip-git-repo-check');
    expect(started.args).not.toContain('--verbose');
  });

  it('uses the settings of the CLI it falls back to', async () => {
    settings.current = {
      defaultCliId: 'claude-code',
      cliArgs: { 'claude-code': '--verbose', 'codex-cli': '--nope' },
    };
    // The project asked for Codex, which is not installed, so Claude Code answers instead.
    const started = await run({ preferredCliId: 'codex-cli' });
    expect(started.command).toBe('claude');
    expect(started.args).toEqual(['-p', '--verbose']);
  });

  it('lets a model picked for the run replace the saved one without doubling flags', async () => {
    settings.current = {
      defaultCliId: 'claude-code',
      cliArgs: { 'claude-code': '--model haiku --verbose' },
    };
    const { args } = await run({
      preferredCliId: 'claude-code',
      strictCli: true,
      runArgs: ['--model', 'sonnet', '--effort', 'high'],
    });
    expect(args).toEqual(['-p', '--verbose', '--model', 'sonnet', '--effort', 'high']);
  });

  it('ignores run args meant for a different CLI', async () => {
    settings.current = {
      defaultCliId: 'claude-code',
      cliArgs: { 'claude-code': '--model opus' },
    };
    const { args } = await run({ preferredCliId: 'codex-cli', runArgs: ['--model', 'gpt-x'] });
    expect(args).toEqual(['-p', '--model', 'opus']);
  });

  it('keeps the user settings on a run that may write files', async () => {
    settings.current = {
      defaultCliId: 'claude-code',
      cliArgs: { 'claude-code': '--verbose' },
      cliLaunchDefaults: { 'claude-code': { model: 'opus', mode: 'plan' } },
    };
    const { args } = await run({ allowWrites: true });
    expect(args).toEqual(['-p', '--permission-mode', 'acceptEdits', '--verbose']);
  });
});

describe('runHeadlessCliPrompt finds a CLI the startup PATH missed', () => {
  const realPlatform = process.platform;

  // A Mac opened from Finder starts with no shell PATH at all, which is the case that hid Claude
  // Code there; Windows misses whatever was installed after the app started.
  it.each(['win32', 'darwin'])(
    'reads PATH again on %s before calling the chosen CLI missing',
    async (platform) => {
      Object.defineProperty(process, 'platform', { value: platform });
      try {
        installed.clear();
        appearsAfterPathRefresh.add('claude');
        const started = await run({ preferredCliId: 'claude-code', strictCli: true });
        expect(started.command).toBe('claude');
      } finally {
        appearsAfterPathRefresh.clear();
        Object.defineProperty(process, 'platform', { value: realPlatform });
      }
    },
  );

  it('picks a natively installed CLI whose folder only the extra tool path covers', async () => {
    installed.clear();
    foundInToolDirs.add('claude');
    try {
      const started = await run({ preferredCliId: 'claude-code', strictCli: true });
      expect(started.command).toBe('claude');
    } finally {
      foundInToolDirs.clear();
    }
  });

  it('says how to fix it when the CLI really is missing', async () => {
    installed.clear();
    const { runHeadlessCliPrompt } = await import('./headlessPrompt');
    const result = await runHeadlessCliPrompt('hi', '/repo', {
      preferredCliId: 'claude-code',
      strictCli: true,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/^Claude Code.* wasn't found\. .*CLI Manager/);
  });
});

describe('runHeadlessCliPrompt keeps terminal settings out', () => {
  // Regression guard, the mirror of the terminal one in lib/workspace/launch.test.ts: Launch
  // defaults are for terminals only and must never change a background run, for any CLI.
  it('uses the Arguments box and never the Launch defaults, for every headless CLI', async () => {
    const { CLI_REGISTRY, cliLaunchOptions } = await import('@runova/core');
    // Only CLIs that can run on this OS are ever picked for a background run.
    const headless = CLI_REGISTRY.filter(
      (cli) => cli.promptCommand && (cli.supportedOS as string[]).includes(process.platform),
    );
    expect(headless.length).toBeGreaterThan(0);

    for (const cli of headless) {
      installed.add(cli.versionCommand.command);
      const mode = cliLaunchOptions(cli.id)?.modes[0];
      settings.current = {
        defaultCliId: cli.id,
        cliArgs: { [cli.id]: '--runova-background-arg' },
        cliLaunchDefaults: {
          [cli.id]: { model: 'terminal-only-model', effort: 'max', mode: mode?.id },
        },
      };
      const { args } = await run({ preferredCliId: cli.id, strictCli: true });
      expect(args, cli.id).toContain('--runova-background-arg');
      expect(args, cli.id).not.toContain('terminal-only-model');
      if (mode) {
        const joined = args.join(' ');
        expect(joined, `${cli.id} mode`).not.toContain(mode.args.join(' '));
      }
    }
  });
});

describe('runHeadlessCliPrompt attaches screenshots', () => {
  it('adds an image flag per screenshot for Codex, after the usual args', async () => {
    installed.add('codex');
    settings.current = { defaultCliId: 'codex-cli', cliArgs: { 'codex-cli': '--verbose' } };
    const started = await run({
      preferredCliId: 'codex-cli',
      strictCli: true,
      images: ['frame.png'],
    });
    expect(started.command).toBe('codex');
    expect(started.args).toEqual([
      'exec',
      '--verbose',
      '--skip-git-repo-check',
      '--image',
      'frame.png',
    ]);
    expect(started.stdin).toBe('write a commit message');
  });

  it('mentions the screenshot in the prompt for Gemini and trusts the temp folder', async () => {
    installed.add('gemini');
    const started = await run({
      preferredCliId: 'gemini-cli',
      strictCli: true,
      images: ['frame.png'],
    });
    // -p carries a short value: current Gemini refuses a bare -p and appends the value to stdin.
    expect(started.args).toEqual(['-p', 'Answer the prompt above.']);
    expect(started.stdin).toBe('@frame.png write a commit message');
    expect(started.env?.GEMINI_CLI_TRUST_WORKSPACE).toBe('true');
    // The usual env still goes in.
    expect(started.env?.CLINE_NO_AUTO_UPDATE).toBe('1');
  });

  it('lets Claude Code use its Read tool and tells it which file to open', async () => {
    const started = await run({
      preferredCliId: 'claude-code',
      strictCli: true,
      images: ['frame.png'],
    });
    expect(started.args).toEqual(['-p', '--allowedTools', 'Read']);
    expect(started.stdin).toContain('./frame.png');
    expect(started.stdin?.endsWith('write a commit message')).toBe(true);
    expect(started.env?.GEMINI_CLI_TRUST_WORKSPACE).toBeUndefined();
  });

  it('refuses a CLI that cannot look at screenshots without starting it', async () => {
    installed.add('opencode');
    const { runHeadlessCliPrompt } = await import('./headlessPrompt');
    const result = await runHeadlessCliPrompt('click something', '/tmp/run', {
      preferredCliId: 'opencode',
      strictCli: true,
      images: ['frame.png'],
    });
    expect(result.ok).toBe(false);
    expect(result.cliName).toBe('OpenCode');
    expect(result.error).toMatch(/^OpenCode can't look at screenshots\. Pick .+ or .+\.$/);
    for (const label of ['Claude Code', 'Codex', 'Gemini']) expect(result.error).toContain(label);
    expect(spawned).toHaveLength(0);
  });

  it('starts the CLI exactly as before when no images are given', async () => {
    installed.add('codex');
    settings.current = { defaultCliId: 'codex-cli' };
    for (const images of [undefined, []]) {
      const started = await run({ preferredCliId: 'codex-cli', strictCli: true, images });
      expect(started.args).toEqual(['exec']);
      expect(started.stdin).toBe('write a commit message');
      expect(started.env?.GEMINI_CLI_TRUST_WORKSPACE).toBeUndefined();
    }
  });
});

describe('runHeadlessCliPrompt in a folder the app made for the run', () => {
  it('tells Codex to run outside a git repository, once even when an image asks too', async () => {
    installed.add('codex');
    const started = await run({ preferredCliId: 'codex-cli', strictCli: true, trustCwd: true });
    expect(started.args.filter((a) => a === '--skip-git-repo-check')).toHaveLength(1);
    const withImage = await run({
      preferredCliId: 'codex-cli',
      strictCli: true,
      trustCwd: true,
      images: ['shot.png'],
    });
    expect(withImage.args.filter((a) => a === '--skip-git-repo-check')).toHaveLength(1);
  });

  it('trusts the folder for Gemini through its environment', async () => {
    installed.add('gemini');
    const started = await run({ preferredCliId: 'gemini-cli', strictCli: true, trustCwd: true });
    expect(started.env?.GEMINI_CLI_TRUST_WORKSPACE).toBe('true');
  });

  it('leaves a folder the user works in untouched', async () => {
    installed.add('codex');
    const started = await run({ preferredCliId: 'codex-cli', strictCli: true });
    expect(started.args).not.toContain('--skip-git-repo-check');
  });
});
