import { describe, expect, it } from 'vitest';
import { buildAgentLaunchCommand } from './launchCommand.js';

describe('buildAgentLaunchCommand', () => {
  it('starts a CLI with nothing saved exactly as typed by hand', () => {
    // The Haiku regression: no model anywhere in Settings must mean no --model on the line.
    expect(buildAgentLaunchCommand({ cliId: 'claude-code', shellKind: 'powershell' })).toBe(
      'claude',
    );
    expect(
      buildAgentLaunchCommand({
        cliId: 'claude-code',
        shellKind: 'powershell',
        launchDefaults: {},
      }),
    ).toBe('claude');
  });

  it('adds only the status hook settings when that is all there is', () => {
    expect(
      buildAgentLaunchCommand({
        cliId: 'claude-code',
        shellKind: 'powershell',
        hookSettingsPath: 'C:\\Users\\me\\AppData\\Roaming\\Runova\\agent-hooks\\claude.json',
      }),
    ).toBe('claude --settings C:\\Users\\me\\AppData\\Roaming\\Runova\\agent-hooks\\claude.json');
  });

  it('quotes a hook settings path with spaces for the shell it is typed into', () => {
    const path = 'C:\\Users\\A B\\hooks.json';
    expect(
      buildAgentLaunchCommand({
        cliId: 'claude-code',
        shellKind: 'powershell',
        hookSettingsPath: path,
      }),
    ).toBe("claude --settings 'C:\\Users\\A B\\hooks.json'");
    expect(
      buildAgentLaunchCommand({ cliId: 'claude-code', shellKind: 'cmd', hookSettingsPath: path }),
    ).toBe('claude --settings "C:\\Users\\A B\\hooks.json"');
  });

  it('puts launch defaults before the run arguments', () => {
    expect(
      buildAgentLaunchCommand({
        cliId: 'claude-code',
        shellKind: 'posix',
        launchDefaults: { model: 'opus', effort: 'high', mode: 'auto' },
        runArgs: ['--resume', 'abc'],
      }),
    ).toBe('claude --model opus --effort high --permission-mode auto --resume abc');
  });

  it('lets a model and effort picked for this launch replace the launch defaults', () => {
    expect(
      buildAgentLaunchCommand({
        cliId: 'claude-code',
        shellKind: 'posix',
        launchDefaults: { model: 'haiku', mode: 'plan' },
        runArgs: ['--model', 'opus', '--effort', 'high'],
      }),
    ).toBe('claude --permission-mode plan --model opus --effort high');
  });

  it('skips launch defaults for a bare start', () => {
    expect(
      buildAgentLaunchCommand({
        cliId: 'claude-code',
        shellKind: 'posix',
        launchDefaults: { model: 'opus', mode: 'auto' },
        hookSettingsPath: '/tmp/hooks.json',
        skipLaunchDefaults: true,
      }),
    ).toBe('claude --settings /tmp/hooks.json');
  });

  it('keeps leading words right after the executable', () => {
    expect(
      buildAgentLaunchCommand({
        cliId: 'codex-cli',
        shellKind: 'posix',
        leadingArgs: ['resume', 'abc-123'],
        launchDefaults: { mode: 'read-only' },
      }),
    ).toBe('codex resume abc-123 --sandbox read-only');
  });

  it('keeps the effort for Haiku, which takes the same levels as the other Claude models', () => {
    expect(
      buildAgentLaunchCommand({
        cliId: 'claude-code',
        shellKind: 'posix',
        launchDefaults: { model: 'haiku', effort: 'high' },
      }),
    ).toBe('claude --model haiku --effort high');
  });

  it('leaves a launch default effort off when the picked model has none', () => {
    expect(
      buildAgentLaunchCommand({
        cliId: 'gemini-cli',
        shellKind: 'posix',
        launchDefaults: { effort: 'high' },
        runArgs: ['--model', 'gemini-3.8-flash'],
      }),
    ).toBe('gemini --model gemini-3.8-flash');
  });

  it('returns null for a CLI it does not know', () => {
    expect(buildAgentLaunchCommand({ cliId: 'nope', shellKind: 'posix' })).toBeNull();
  });
});
