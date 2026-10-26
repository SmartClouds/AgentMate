import { describe, expect, it } from 'vitest';
import { buildHeadlessCliArgs } from './headlessArgs.js';
import { CLI_REGISTRY, type CliDefinition, getCliDefinition } from './registry.js';

const HEADLESS_CLIS = CLI_REGISTRY.filter((cli) => cli.promptCommand);

function cli(id: string): CliDefinition {
  const found = getCliDefinition(id);
  if (!found) throw new Error(`no CLI ${id}`);
  return found;
}

/** True when `sub` appears in `args` as one contiguous run. */
function containsRun(args: readonly string[], sub: readonly string[]): boolean {
  return args.some((_, i) => sub.every((part, j) => args[i + j] === part));
}

describe('buildHeadlessCliArgs: every CLI in the registry', () => {
  // A background run that drops the user's settings for any one CLI is the bug this guards.
  it.each(HEADLESS_CLIS.map((c) => [c.id, c] as const))(
    '%s keeps the saved arguments where the CLI reads them',
    (_id, definition) => {
      const saved = ['--runova-saved', 'value with space'];
      const args = buildHeadlessCliArgs({
        cli: definition,
        savedArgs: '--runova-saved "value with space"',
      });
      expect(containsRun(args, saved)).toBe(true);

      const promptArgs = definition.promptCommand?.args ?? [];
      if (definition.promptInputMode === 'stdin') {
        // Subcommand first (`codex exec`), the user's flags after it.
        expect(args.slice(0, promptArgs.length)).toEqual(promptArgs);
      } else {
        // The prompt becomes the value of the last flag, so that flag must end the list.
        expect(args.slice(-promptArgs.length)).toEqual(promptArgs);
      }
    },
  );
});

describe('buildHeadlessCliArgs: Claude Code', () => {
  const claude = cli('claude-code');

  it('runs bare when nothing is set', () => {
    expect(buildHeadlessCliArgs({ cli: claude })).toEqual(['-p']);
  });

  it('uses the model saved in the Arguments box', () => {
    expect(buildHeadlessCliArgs({ cli: claude, savedArgs: '--model haiku' })).toEqual([
      '-p',
      '--model',
      'haiku',
    ]);
  });

  it('lets a model picked for this run replace the saved one, never doubling a flag', () => {
    const args = buildHeadlessCliArgs({
      cli: claude,
      savedArgs: '--model sonnet --verbose',
      runArgs: ['--model', 'fable', '--effort', 'max'],
    });
    expect(args).toEqual(['-p', '--verbose', '--model', 'fable', '--effort', 'max']);
    expect(args.filter((a) => a === '--model')).toHaveLength(1);
  });

  it('adds write flags only when the run may write, next to the user settings', () => {
    expect(
      buildHeadlessCliArgs({
        cli: claude,
        allowWrites: true,
        savedArgs: '--verbose',
      }),
    ).toEqual(['-p', '--permission-mode', 'acceptEdits', '--verbose']);
  });
});

describe('buildHeadlessCliArgs: argument-mode CLIs', () => {
  it('puts the user settings before the prompt flag', () => {
    const cursor = cli('cursor-cli');
    const args = buildHeadlessCliArgs({
      cli: cursor,
      savedArgs: '--verbose',
      allowWrites: true,
    });
    expect(args.at(-1)).toBe('-p');
    expect(args.indexOf('--verbose')).toBeLessThan(args.indexOf('-p'));
  });

  it('returns nothing for a CLI with no headless mode', () => {
    const interactiveOnly = CLI_REGISTRY.find((c) => !c.promptCommand);
    if (!interactiveOnly) return;
    expect(buildHeadlessCliArgs({ cli: interactiveOnly, savedArgs: '--x' })).toEqual([]);
  });
});

describe('buildHeadlessCliArgs: a folder the app made for the run', () => {
  // Found by running each CLI in a fresh Studio work folder (E32 spike S2): Codex refuses to run
  // outside a git repository, and Cursor and Gemini stop to ask whether to trust the folder,
  // which nothing can answer with no terminal.
  it('tells Codex to run outside a git repository, after its subcommand', () => {
    expect(buildHeadlessCliArgs({ cli: cli('codex-cli'), trustCwd: true })).toEqual([
      'exec',
      '--skip-git-repo-check',
    ]);
  });

  it('tells Cursor to trust the folder, before the prompt flag', () => {
    expect(buildHeadlessCliArgs({ cli: cli('cursor-cli'), trustCwd: true })).toEqual([
      '--trust',
      '-p',
    ]);
  });

  it('tells Gemini to trust the folder through its environment, which older versions ignore', () => {
    expect(cli('gemini-cli').promptTrustEnv).toEqual({ GEMINI_CLI_TRUST_WORKSPACE: 'true' });
    expect(buildHeadlessCliArgs({ cli: cli('gemini-cli'), trustCwd: true })).not.toContain(
      '--skip-trust',
    );
  });

  it('adds nothing for a folder the user works in, or a CLI that never asks', () => {
    expect(buildHeadlessCliArgs({ cli: cli('codex-cli') })).toEqual(['exec']);
    expect(buildHeadlessCliArgs({ cli: cli('claude-code'), trustCwd: true })).toEqual(['-p']);
  });
});

describe('buildHeadlessCliArgs: Gemini', () => {
  // Gemini's -p takes a value and appends it to what came on stdin; a bare -p fails with
  // "Not enough arguments following: p" before the model is asked anything.
  it('gives -p a value, so the prompt on stdin is read', () => {
    const args = buildHeadlessCliArgs({ cli: cli('gemini-cli') });
    const at = args.indexOf('-p');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(args[at + 1]?.trim()).toBeTruthy();
    expect(args[at + 1]?.startsWith('-')).toBe(false);
  });
});
