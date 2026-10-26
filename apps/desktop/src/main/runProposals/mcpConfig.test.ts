import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  disableRunProposals,
  enableRunProposals,
  isRunProposalsEnabled,
  moveLegacyRunProposals,
  runCommandsScriptPath,
} from './mcpConfig';

let folder: string;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'run-proposals-'));
});

afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

function mcpJson(): { mcpServers?: Record<string, unknown>; [key: string]: unknown } {
  return JSON.parse(readFileSync(join(folder, '.mcp.json'), 'utf-8'));
}

describe('run suggestions in .mcp.json', () => {
  it('writes the bridge script, and a server entry that starts it with node', async () => {
    await enableRunProposals(folder, '// bridge source');

    expect(readFileSync(runCommandsScriptPath(folder), 'utf-8')).toBe('// bridge source');
    expect(mcpJson().mcpServers?.runova).toEqual({
      command: 'node',
      args: [runCommandsScriptPath(folder)],
    });
    expect(await isRunProposalsEnabled(folder)).toBe(true);
  });

  it('keeps the servers and keys already in .mcp.json', async () => {
    writeFileSync(
      join(folder, '.mcp.json'),
      JSON.stringify({ mcpServers: { existing: { command: 'uvx' } }, keep: true }),
    );

    await enableRunProposals(folder, 'source');

    expect(mcpJson()).toMatchObject({
      keep: true,
      mcpServers: { existing: { command: 'uvx' }, runova: { command: 'node' } },
    });
  });

  it('leaves a .mcp.json it cannot read exactly as it was', async () => {
    writeFileSync(join(folder, '.mcp.json'), '{ not json');

    await expect(enableRunProposals(folder, 'source')).rejects.toThrow(
      '.mcp.json is not valid JSON',
    );
    expect(readFileSync(join(folder, '.mcp.json'), 'utf-8')).toBe('{ not json');
    expect(existsSync(runCommandsScriptPath(folder))).toBe(false);
  });

  it('refuses to replace a runova server it did not write', async () => {
    writeFileSync(
      join(folder, '.mcp.json'),
      JSON.stringify({ mcpServers: { runova: { command: 'other' } } }),
    );

    await expect(enableRunProposals(folder, 'source')).rejects.toThrow(
      "already has a 'runova' server",
    );
    expect(await isRunProposalsEnabled(folder)).toBe(false);
  });

  it('removes only its own entry and script when switched off', async () => {
    writeFileSync(
      join(folder, '.mcp.json'),
      JSON.stringify({ mcpServers: { existing: { command: 'uvx' } } }),
    );
    await enableRunProposals(folder, 'source');

    await disableRunProposals(folder);

    expect(mcpJson().mcpServers).toEqual({ existing: { command: 'uvx' } });
    expect(existsSync(runCommandsScriptPath(folder))).toBe(false);
    expect(await isRunProposalsEnabled(folder)).toBe(false);
  });

  it('switching off a project that never had it does nothing', async () => {
    await expect(disableRunProposals(folder)).resolves.toBeUndefined();
    expect(existsSync(join(folder, '.mcp.json'))).toBe(false);
  });

  it('counts as off when the entry is there but its script is gone', async () => {
    await enableRunProposals(folder, 'source');
    rmSync(runCommandsScriptPath(folder));

    expect(await isRunProposalsEnabled(folder)).toBe(false);
  });

  it('refuses a project with no folder, so nothing is written into the working directory', async () => {
    await expect(enableRunProposals('', 'source')).rejects.toThrow('This project has no folder.');
  });
});

describe('a bridge entry from before the rename', () => {
  // How a project set up before the rename looks once its folder has moved to .runova.
  function legacySetup(scriptFolder: string): string {
    const script = join(folder, scriptFolder, 'run-commands-mcp.cjs');
    writeFileSync(
      join(folder, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          agentmate: { command: 'node', args: [script] }, // legacy-name
          other: { command: 'other-server' },
        },
      }),
    );
    return script;
  }

  it('is swapped for the current entry, with a fresh script', async () => {
    legacySetup('.agentmate'); // legacy-name

    expect(await moveLegacyRunProposals(folder, '// new bridge')).toBe(true);

    const servers = mcpJson().mcpServers ?? {};
    expect(Object.keys(servers).sort()).toEqual(['other', 'runova']);
    expect(readFileSync(runCommandsScriptPath(folder), 'utf-8')).toBe('// new bridge');
    expect(await isRunProposalsEnabled(folder)).toBe(true);
  });

  it('is left alone when it is not ours', async () => {
    writeFileSync(
      join(folder, '.mcp.json'),
      JSON.stringify({ mcpServers: { agentmate: { command: 'npx', args: ['something-else'] } } }), // legacy-name
    );

    expect(await moveLegacyRunProposals(folder, '// new bridge')).toBe(false);
    expect(Object.keys(mcpJson().mcpServers ?? {})).toEqual(['agentmate']); // legacy-name
    expect(existsSync(runCommandsScriptPath(folder))).toBe(false);
  });

  it('does nothing in a project without one', async () => {
    expect(await moveLegacyRunProposals(folder, '// new bridge')).toBe(false);
    expect(existsSync(join(folder, '.mcp.json'))).toBe(false);
  });
});
