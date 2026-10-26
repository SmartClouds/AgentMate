import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { relayCapabilities } from '@runova/core';
import { app } from 'electron';
import { portFilePath } from '../../notifications/hookServer';
import { RELAY_MCP_SCRIPT, RELAY_MCP_SERVER, relayBridgeScriptSource } from './bridgeScript';

/**
 * The Relay MCP server is handed to each leg's CLI on its command line, never written into the
 * project: one shared script and config in the app's data folder serve every leg, since the
 * script finds its leg through the session id in its environment.
 */

function relayDir(): string {
  return join(app.getPath('userData'), 'relay');
}

async function writeIfChanged(path: string, content: string): Promise<void> {
  const current = await readFile(path, 'utf8').catch(() => null);
  if (current !== content) await writeFile(path, content, 'utf8');
}

export interface RelayMcpFiles {
  script: string;
  /** `--mcp-config` for Claude Code. */
  claudeConfig: string;
  /** `--additional-mcp-config @file` for Copilot, which wants a type and a tool list. */
  copilotConfig: string;
}

let prepared: Promise<RelayMcpFiles | null> | null = null;

export function relayMcpFiles(): Promise<RelayMcpFiles | null> {
  prepared ??= (async () => {
    const dir = relayDir();
    await mkdir(dir, { recursive: true });
    const script = join(dir, RELAY_MCP_SCRIPT);
    const claudeConfig = join(dir, 'mcp.json');
    const copilotConfig = join(dir, 'copilot-mcp.json');
    await writeIfChanged(script, relayBridgeScriptSource({ portFile: portFilePath() }));
    const server = { command: 'node', args: [script] };
    await writeIfChanged(
      claudeConfig,
      `${JSON.stringify({ mcpServers: { [RELAY_MCP_SERVER]: server } }, null, 2)}\n`,
    );
    await writeIfChanged(
      copilotConfig,
      `${JSON.stringify({ mcpServers: { [RELAY_MCP_SERVER]: { type: 'local', ...server, tools: ['*'] } } }, null, 2)}\n`,
    );
    return { script, claudeConfig, copilotConfig };
  })().catch(() => {
    prepared = null;
    return null;
  });
  return prepared;
}

/**
 * The flags that give a CLI the Relay MCP server for one session, or none for a CLI that cannot
 * take one on its command line. Paths use forward slashes, which every one of these accepts. Codex
 * values are TOML literal strings (single quotes): Windows PowerShell 5.1 mangles double quotes
 * inside an argument it hands a native program.
 */
export async function relayMcpLaunchArgs(cliId: string): Promise<string[]> {
  const kind = relayCapabilities(cliId).mcp;
  if (!kind) return [];
  const files = await relayMcpFiles();
  if (!files) return [];
  const slash = (path: string) => path.replaceAll('\\', '/');
  switch (kind) {
    case 'claude':
      return [
        '--mcp-config',
        slash(files.claudeConfig),
        '--allowedTools',
        `mcp__${RELAY_MCP_SERVER}__*`,
      ];
    case 'codex':
      return [
        '-c',
        `mcp_servers.${RELAY_MCP_SERVER}.command='node'`,
        '-c',
        `mcp_servers.${RELAY_MCP_SERVER}.args=['${slash(files.script)}']`,
      ];
    case 'copilot':
      return ['--additional-mcp-config', `@${slash(files.copilotConfig)}`];
  }
}
