import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every place Runova starts an AI CLI has to use the settings the user gave that CLI, and only
 * the ones meant for that kind of launch. The two never mix:
 *
 *   - buildAgentLaunchCommand(): terminal tabs and "open in terminal" (lib/workspace/launch.ts,
 *     lib/openCli.ts in the renderer). These take Launch defaults from Settings only.
 *   - buildHeadlessCliArgs(): background tasks such as commit messages, tag suggestions, version
 *     bumps, run sizing, skill reviews, and SSH tasks (main/cli/headlessPrompt.ts). These take the
 *     Arguments box from AI CLI Manager only.
 *
 * These checks read the source and fail when new code reaches around them. If one fails, route the
 * new launch through runHeadlessCliPrompt() or cliLaunchCommand()/launchAgentTab() instead of
 * adding the file to the list below.
 */

const SRC = __dirname;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === 'node_modules' || entry.name.startsWith('out') ? [] : sourceFiles(path);
    }
    const isSource = /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name);
    return isSource && !path.includes(`${sep}testing${sep}`) ? [path] : [];
  });
}

const files = sourceFiles(SRC).map((path) => ({
  path: relative(SRC, path).split(sep).join('/'),
  text: readFileSync(path, 'utf-8'),
}));

function filesMatching(area: 'main' | 'renderer', pattern: RegExp): string[] {
  return files
    .filter((file) => file.path.startsWith(`${area}/`) && pattern.test(file.text))
    .map((file) => file.path)
    .sort();
}

describe('AI CLI launches use the user CLI settings', () => {
  it('has source files to check', () => {
    expect(files.some((file) => file.path === 'main/cli/headlessPrompt.ts')).toBe(true);
    expect(files.some((file) => file.path === 'renderer/src/lib/workspace/launch.ts')).toBe(true);
  });

  it('starts background CLI runs only through runHeadlessCliPrompt', () => {
    // promptCommand is how a CLI is run without a terminal. Anything else reading it is a second
    // runner that would skip the user's settings.
    expect(filesMatching('main', /\.promptCommand\b/)).toEqual(['main/cli/headlessPrompt.ts']);
  });

  it('builds background CLI arguments from the Arguments box only', () => {
    const runner = files.find((file) => file.path === 'main/cli/headlessPrompt.ts')?.text ?? '';
    expect(runner).toMatch(/buildHeadlessCliArgs\(\{/);
    expect(runner).toMatch(/savedArgs:\s*getCliArgsFor\(settings\.cliArgs,\s*cli\.id\)/);
    expect(runner).not.toMatch(/\bcliLaunchDefaults\b/);
  });

  it('reads saved CLI settings in the main process only where launches are built', () => {
    expect(filesMatching('main', /\bcliArgs\b/)).toEqual([
      'main/backup/envelope.ts',
      'main/cli/headlessPrompt.ts',
      'main/store.ts',
    ]);
    // A Relay leg's terminal is started by main, so its launch line is built there.
    expect(filesMatching('main', /\bcliLaunchDefaults\b/)).toEqual([
      'main/relay/launch.ts',
      'main/store.ts',
    ]);
  });

  it('runs no registry CLI from the main process outside detection and the headless runner', () => {
    const spawnsAndKnowsClis = filesMatching('main', /\b(execFile|spawn)\s*\(/).filter((path) =>
      /\b(CLI_REGISTRY|getCliDefinition|executableNames|versionCommand)\b/.test(
        files.find((file) => file.path === path)?.text ?? '',
      ),
    );
    expect(spawnsAndKnowsClis).toEqual(['main/cli/headlessPrompt.ts', 'main/ipc/cliDetection.ts']);
  });

  it('builds terminal launch commands in the renderer only through the core builder', () => {
    // Terminals never read the background task arguments. A renderer file that does is how a
    // `--model haiku` saved in AI CLI Manager ended up starting every new tab on Haiku.
    expect(filesMatching('renderer', /\b(getCliArgsFor|getCliArgvFor)\b/)).toEqual([]);
    // The low-level pieces put together a command that can miss a setting or send a flag twice.
    // Scheduled prompts only use it to turn their own model and effort into run args, which then
    // go through cliLaunchCommand() like every other launch.
    expect(filesMatching('renderer', /\blaunchDefaultArgs\b/)).toEqual([
      'renderer/src/lib/runScheduledPrompt.ts',
    ]);
    expect(filesMatching('renderer', /\bbuildAgentLaunchCommand\b/)).toEqual([
      'renderer/src/lib/openCli.ts',
      'renderer/src/lib/workspace/launch.ts',
    ]);
  });

  it('reads saved CLI settings in the renderer only to launch or edit them', () => {
    expect(filesMatching('renderer', /\bcliLaunchDefaults\b/)).toEqual([
      'renderer/src/components/settings/CliLaunchDefaultsSettings.tsx',
      // These two only check whether any are set, for the "Alt+click skips them" hint.
      'renderer/src/components/workspace/LauncherMenu.tsx',
      'renderer/src/components/workspace/PaneLauncher.tsx',
      'renderer/src/lib/openCli.ts',
      'renderer/src/lib/workspace/launch.ts',
      // Tab tooltips fall back to the launch default model when the agent never reports one.
      'renderer/src/stores/agentStatusStore.ts',
      'renderer/src/stores/cliStore.ts',
    ]);
    // Terminal launches never read the background task arguments, so only the field that edits
    // them and the store that saves them know about them.
    expect(filesMatching('renderer', /\bcliArgs\b/)).toEqual([
      'renderer/src/components/CliArgsField.tsx',
      'renderer/src/stores/cliStore.ts',
    ]);
  });

  it('types a CLI executable into a terminal only as a fallback to cliLaunchCommand', () => {
    const typesExecutable = files.filter(
      (file) =>
        file.path.startsWith('renderer/') &&
        /executableNames\[0\]/.test(file.text) &&
        /\b(openSession|initialInput|launchInput)\b/.test(file.text),
    );
    for (const file of typesExecutable) {
      const uses = file.text.match(/.*executableNames\[0\].*/g) ?? [];
      for (const line of uses) {
        expect(
          /cliLaunchCommand\(|buildAgentLaunchCommand\(|cli\.executableNames\[0\],$/.test(
            line.trim(),
          ),
          `${file.path}: "${line.trim()}" starts a CLI without the user settings`,
        ).toBe(true);
      }
    }
  });
});
