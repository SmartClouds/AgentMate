import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { useTempUserData } from '../../../test/main/ipcHarness';

const userData = useTempUserData();

describe('relayMcpLaunchArgs', () => {
  it('hands Claude Code the shared config and allows only the relay tools', async () => {
    const { relayMcpLaunchArgs } = await import('./config');
    const args = await relayMcpLaunchArgs('claude-code');
    expect(args[0]).toBe('--mcp-config');
    expect(args[1]).toMatch(/relay\/mcp\.json$/);
    expect(args[1]).not.toContain('\\');
    expect(args.slice(2)).toEqual(['--allowedTools', 'mcp__runova_relay__*']);
    const config = JSON.parse(readFileSync(args[1], 'utf-8'));
    expect(config.mcpServers.runova_relay.command).toBe('node');
    expect(readFileSync(config.mcpServers.runova_relay.args[0], 'utf-8')).toContain(
      'RUNOVA_SESSION_ID',
    );
    expect(userData.dir).toBeTruthy();
  });

  it('gives Codex TOML overrides and Copilot an extra config file', async () => {
    const { relayMcpLaunchArgs } = await import('./config');
    const codex = await relayMcpLaunchArgs('codex-cli');
    expect(codex[0]).toBe('-c');
    expect(codex[1]).toBe("mcp_servers.runova_relay.command='node'");
    expect(codex[3]).toMatch(/^mcp_servers\.runova_relay\.args=\['.*relay-mcp\.cjs'\]$/);
    expect(codex.join(' ')).not.toContain('"');

    const copilot = await relayMcpLaunchArgs('copilot-cli');
    expect(copilot[0]).toBe('--additional-mcp-config');
    const file = JSON.parse(readFileSync(copilot[1].slice(1), 'utf-8'));
    expect(file.mcpServers.runova_relay).toMatchObject({ type: 'local', tools: ['*'] });
  });

  it('adds nothing for a CLI that cannot take the server', async () => {
    const { relayMcpLaunchArgs } = await import('./config');
    expect(await relayMcpLaunchArgs('gemini-cli')).toEqual([]);
  });
});
