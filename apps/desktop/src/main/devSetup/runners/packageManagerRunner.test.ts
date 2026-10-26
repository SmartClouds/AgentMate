import type { DevRecipe } from '@runova/core';
import { describe, expect, it, vi } from 'vitest';
import type {
  CancelToken,
  SpawnStreamingOptions,
  SpawnStreamingResult,
} from '../../process/spawnStreaming';
import { createPackageManagerRunner, type RunHooks } from './packageManagerRunner';

/**
 * Runs one winget / Homebrew / npm / dotnet command and turns what comes back into progress and a
 * sentence a person can read. The process itself is faked: what matters here is the command that
 * would have run, how its output is read, and what each way of ending is called.
 */

const DONE: SpawnStreamingResult = {
  code: 0,
  log: '',
  timedOut: false,
  cancelled: false,
  notFound: false,
};

/** A spawn that prints `lines` through onLine and then ends with `result`. */
function fakeSpawn(lines: string[] = [], result: Partial<SpawnStreamingResult> = {}) {
  return vi.fn(async (options: SpawnStreamingOptions): Promise<SpawnStreamingResult> => {
    for (const line of lines) options.onLine?.(line);
    return { ...DONE, ...result };
  });
}

function hooks() {
  const token: CancelToken = { cancelled: false, child: null };
  const onProgress = vi.fn<RunHooks['onProgress']>();
  const onLine = vi.fn<RunHooks['onLine']>();
  return { token, onProgress, onLine };
}

const WINGET = { kind: 'winget', id: 'GitHub.cli' } as const;

describe('what is run', () => {
  it("runs the silent winget install, in the home folder, with the run's cancel token", async () => {
    const spawn = fakeSpawn();
    const h = hooks();

    await createPackageManagerRunner({ spawn, cwd: 'C:\\Users\\me' }).run(WINGET, 'install', h);

    const options = spawn.mock.calls[0]?.[0];
    expect(options).toMatchObject({
      command: 'winget',
      args: [
        'install',
        '--id',
        'GitHub.cli',
        '--exact',
        '--source',
        'winget',
        '--silent',
        '--accept-package-agreements',
        '--accept-source-agreements',
      ],
      cwd: 'C:\\Users\\me',
      idle: true,
      timeoutMs: 15 * 60_000,
    });
    expect(options?.token).toBe(h.token);
  });

  it('uses the upgrade command to update', async () => {
    const spawn = fakeSpawn();

    await createPackageManagerRunner({ spawn, cwd: '/home/me' }).run(WINGET, 'update', hooks());

    expect(spawn.mock.calls[0]?.[0].args.slice(0, 3)).toEqual(['upgrade', '--id', 'GitHub.cli']);
  });

  it.each([
    [{ kind: 'brew', formula: 'gh' }, 'brew', 10 * 60_000],
    [{ kind: 'brew-cask', cask: 'android-studio' }, 'brew', 10 * 60_000],
    [{ kind: 'npm-global', pkg: 'pnpm' }, 'npm', 5 * 60_000],
    [{ kind: 'dotnet-tool', pkg: 'dotnet-ef' }, 'dotnet', 5 * 60_000],
  ] as const)('gives %j its own patience', async (recipe, command, timeoutMs) => {
    const spawn = fakeSpawn();

    await createPackageManagerRunner({ spawn, cwd: '/home/me' }).run(recipe, 'install', hooks());

    expect(spawn.mock.calls[0]?.[0]).toMatchObject({ command, idle: true, timeoutMs });
  });

  it('refuses a recipe that is not a package manager command', async () => {
    const spawn = fakeSpawn();

    const result = await createPackageManagerRunner({ spawn, cwd: '/home/me' }).run(
      { kind: 'managed', installer: 'flutter-archive' },
      'install',
      hooks(),
    );

    expect(result).toMatchObject({ ok: false, cancelled: false });
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe('reading the output', () => {
  it('hands the log the real lines and leaves out the spinner and the bar', async () => {
    const spawn = fakeSpawn([
      'Found GitHub CLI [GitHub.cli] Version 2.62.0',
      '   -',
      '   \\',
      '  \u2588\u2588\u2588\u2588\u2592\u2592\u2592\u2592  40%',
      'Successfully installed',
    ]);
    const h = hooks();

    await createPackageManagerRunner({ spawn, cwd: '.' }).run(WINGET, 'install', h);

    expect(h.onLine.mock.calls.map((call) => call[0])).toEqual([
      'Found GitHub CLI [GitHub.cli] Version 2.62.0',
      'Successfully installed',
    ]);
  });

  it('reports the stage and the percentage as they appear', async () => {
    const spawn = fakeSpawn([
      'Found GitHub CLI [GitHub.cli] Version 2.62.0',
      'Downloading https://github.com/cli/cli/releases/download/v2.62.0/gh.msi',
      '  \u2588\u2588\u2588\u2588\u2592\u2592\u2592\u2592  1.00 MB / 4.00 MB',
      'Successfully verified installer hash',
      'Starting package install...',
    ]);
    const h = hooks();

    await createPackageManagerRunner({ spawn, cwd: '.' }).run(WINGET, 'install', h);

    expect(h.onProgress.mock.calls.map((call) => call[0])).toEqual([
      { phase: 'preparing', fraction: null },
      { phase: 'downloading', fraction: null },
      { fraction: 0.25, detail: '1.00 MB of 4.00 MB' },
      { phase: 'verifying', fraction: null },
      { phase: 'installing', fraction: null },
    ]);
  });

  it('reports a stage once, so a repeated line does not reset the bar', async () => {
    const spawn = fakeSpawn([
      'Downloading https://example.com/a',
      '  ██▒▒  60%',
      'Downloading https://example.com/b',
    ]);
    const h = hooks();

    await createPackageManagerRunner({ spawn, cwd: '.' }).run(WINGET, 'install', h);

    expect(h.onProgress.mock.calls.map((call) => call[0])).toEqual([
      { phase: 'downloading', fraction: null },
      { fraction: 0.6, detail: '60%' },
    ]);
  });
});

describe('how it ends', () => {
  const BREW: DevRecipe = { kind: 'brew', formula: 'gh' };
  const run = (result: Partial<SpawnStreamingResult>, recipe: DevRecipe = WINGET) =>
    createPackageManagerRunner({ spawn: fakeSpawn([], result), cwd: '.' }).run(
      recipe,
      'install',
      hooks(),
    );

  it('is fine on exit code 0', async () => {
    expect(await run({ code: 0 })).toEqual({ ok: true, code: 0, cancelled: false });
  });

  it('counts "already installed" as fine, since the check afterwards is what decides', async () => {
    expect(await run({ code: 0x8a150061 })).toMatchObject({
      ok: true,
      message: 'Already installed.',
    });
  });

  it('says a restart is advised when winget does', async () => {
    expect(await run({ code: 0x8a150109 })).toMatchObject({
      ok: true,
      restartAdvised: true,
      message: 'Installed. Restart your computer to finish.',
    });
  });

  it('turns a winget failure into a sentence', async () => {
    expect(await run({ code: 0x8a150102 })).toMatchObject({
      ok: false,
      message: 'Another installer is running. Wait for it to finish, then try again.',
    });
  });

  it('names the code for a failure it has nothing to say about', async () => {
    expect(await run({ code: 1603 })).toMatchObject({
      ok: false,
      message: 'winget could not finish (code 1603).',
    });
  });

  it('points at the log for a failure from another tool', async () => {
    expect(await run({ code: 1 }, BREW)).toMatchObject({
      ok: false,
      message: 'brew stopped with code 1. Open the log for details.',
    });
  });

  it('says so when the tool is not there at all', async () => {
    expect(await run({ code: null, notFound: true }, BREW)).toMatchObject({
      ok: false,
      message: 'brew was not found on this computer.',
    });
  });

  it('says so when it stopped answering and was stopped', async () => {
    expect(await run({ code: null, timedOut: true })).toMatchObject({
      ok: false,
      message: 'The install stopped responding, so it was stopped.',
    });
  });

  it('reports a cancel as a cancel, not as a failure with a message', async () => {
    const result = await run({ code: null, cancelled: true });

    expect(result).toMatchObject({ ok: false, cancelled: true });
    expect(result.message).toBeUndefined();
  });

  it('turns a spawn that throws into a failure instead of an exception', async () => {
    const spawn = vi.fn(async () => {
      throw new Error('Refusing to run a command with a quote in an argument');
    });

    const result = await createPackageManagerRunner({ spawn, cwd: '.' }).run(
      WINGET,
      'install',
      hooks(),
    );

    expect(result).toMatchObject({
      ok: false,
      message: 'Refusing to run a command with a quote in an argument',
    });
  });
});

describe('the environment it runs in', () => {
  it('runs with the environment it was given, when it was given one', async () => {
    const spawn = fakeSpawn();
    const env = { Path: 'C:\sandbox\bin' };

    await createPackageManagerRunner({ spawn, cwd: '.', env }).run(WINGET, 'install', hooks());

    expect(spawn.mock.calls[0]?.[0].env).toBe(env);
  });

  it('leaves the choice to the process otherwise', async () => {
    const spawn = fakeSpawn();

    await createPackageManagerRunner({ spawn, cwd: '.' }).run(WINGET, 'install', hooks());

    expect(spawn.mock.calls[0]?.[0].env).toBeUndefined();
  });
});
