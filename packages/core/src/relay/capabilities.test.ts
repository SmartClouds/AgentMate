import { describe, expect, it } from 'vitest';
import { relayCapabilities, relayPlanArgs } from './capabilities.js';

describe('relayCapabilities', () => {
  it('gives Claude Code the whole relay', () => {
    expect(relayCapabilities('claude-code')).toMatchObject({
      planMode: true,
      planAutoSwitch: true,
      afterPlanModes: ['auto', 'acceptEdits'],
      contextGuard: 'hook',
      stopGate: true,
      contextMeter: true,
      mcp: 'claude',
      completion: 'exact',
    });
  });

  it('lets Codex run legs with the MCP bridge but not plan first', () => {
    expect(relayCapabilities('codex-cli')).toMatchObject({
      planMode: false,
      planAutoSwitch: false,
      contextGuard: 'mcp',
      stopGate: false,
      contextMeter: false,
      mcp: 'codex',
      completion: 'heuristic',
    });
  });

  it('hands Copilot the MCP bridge too', () => {
    expect(relayCapabilities('copilot-cli')).toMatchObject({ mcp: 'copilot', contextGuard: 'mcp' });
  });

  it('lets a CLI with a plan flag plan first and then wait for the user', () => {
    for (const cliId of ['gemini-cli', 'grok-cli', 'cursor-cli', 'copilot-cli']) {
      expect(relayCapabilities(cliId)).toMatchObject({
        planMode: true,
        planAutoSwitch: false,
        contextGuard: expect.not.stringMatching('hook'),
        stopGate: false,
      });
    }
  });

  it('knows nothing about an unknown CLI', () => {
    expect(relayCapabilities('nope')).toMatchObject({
      planMode: false,
      planAutoSwitch: false,
      contextGuard: 'none',
      mcp: null,
      completion: 'heuristic',
    });
  });
});

describe('relayPlanArgs', () => {
  it('reads the plan flag from the launch modes', () => {
    expect(relayPlanArgs('claude-code')).toEqual(['--permission-mode', 'plan']);
    expect(relayPlanArgs('gemini-cli')).toEqual(['--approval-mode', 'plan']);
    expect(relayPlanArgs('cursor-cli')).toEqual(['--mode', 'plan']);
    expect(relayPlanArgs('codex-cli')).toBeNull();
  });
});
