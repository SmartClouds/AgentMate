import { describe, expect, it } from 'vitest';
import { buildLegCommand, type LegCommandInput } from './launch';

/** The command line a Relay leg's terminal types, per CLI. */

function input(overrides: Partial<LegCommandInput> = {}): LegCommandInput {
  return {
    cliId: 'claude-code',
    shellKind: 'powershell',
    choice: { cliId: 'claude-code', model: 'opus', effort: 'high', autoSize: false },
    planFirst: false,
    afterPlanMode: 'auto',
    hookSettingsPath: 'C:/Users/me/AppData/agent-hooks/claude-relay-settings.json',
    mcpArgs: ['--mcp-config', 'C:/data/relay/mcp.json', '--allowedTools', 'mcp__runova_relay__*'],
    prompt: 'Runova Relay: task T001 (Login), session 1. Read docs/tasks/RELAY.md first.',
    ...overrides,
  };
}

describe('buildLegCommand', () => {
  it('starts Claude Code in the after-plan mode with the prompt as its last argument', () => {
    const { command, promptInCommand } = buildLegCommand(input());
    expect(promptInCommand).toBe(true);
    expect(command).toBe(
      "claude --settings C:/Users/me/AppData/agent-hooks/claude-relay-settings.json --mcp-config C:/data/relay/mcp.json --allowedTools 'mcp__runova_relay__*' --permission-mode auto --model opus --effort high 'Runova Relay: task T001 (Login), session 1. Read docs/tasks/RELAY.md first.'",
    );
  });

  it('never puts the prompt straight after a flag that takes a list', () => {
    // --allowedTools and --mcp-config take every word after them, so a prompt that followed one
    // became another allowed tool and the session started with no prompt at all.
    for (const choice of [
      { cliId: 'claude-code', model: null, effort: null, autoSize: false },
      { cliId: 'claude-code', model: 'opus', effort: 'high', autoSize: false },
    ]) {
      for (const planFirst of [false, true]) {
        const { command } = buildLegCommand(input({ choice, planFirst }));
        const beforePrompt = command?.replace(/ '[^']*'$/, '') ?? '';
        expect(beforePrompt).toMatch(/--(permission-mode|model|effort) \S+$/);
      }
    }
  });

  it('starts Claude Code in plan mode when the leg plans first', () => {
    const { command } = buildLegCommand(input({ planFirst: true }));
    expect(command).toContain('--permission-mode plan');
    expect(command).not.toContain('--permission-mode auto');
  });

  it('never applies a saved launch mode to Claude Code', () => {
    const { command } = buildLegCommand(
      input({ launchDefaults: { mode: 'plan', model: 'haiku' } }),
    );
    expect(command).not.toContain('haiku');
    expect(command?.match(/--permission-mode/g)).toHaveLength(1);
  });

  it('quotes an apostrophe in the prompt for PowerShell', () => {
    const { command } = buildLegCommand(input({ prompt: "Fix the user's login" }));
    expect(command?.endsWith("'Fix the user''s login'")).toBe(true);
  });

  it('keeps another CLI on its saved defaults and pastes the prompt later', () => {
    const { command, promptInCommand } = buildLegCommand(
      input({
        cliId: 'codex-cli',
        choice: { cliId: 'codex-cli', model: null, effort: null, autoSize: false },
        hookSettingsPath: null,
        mcpArgs: ['-c', 'mcp_servers.runova_relay.command="node"'],
        launchDefaults: { model: 'gpt-6-sol' },
      }),
    );
    expect(promptInCommand).toBe(false);
    expect(command).toContain('codex');
    expect(command).toContain('gpt-6-sol');
    expect(command).toContain('mcp_servers.runova_relay.command');
    expect(command).not.toContain('Runova Relay');
  });

  it('adds the plan flag of a CLI that has one', () => {
    const { command } = buildLegCommand(
      input({
        cliId: 'gemini-cli',
        choice: { cliId: 'gemini-cli', model: null, effort: null, autoSize: false },
        planFirst: true,
        hookSettingsPath: null,
        mcpArgs: [],
      }),
    );
    expect(command).toContain('--approval-mode plan');
  });
});
