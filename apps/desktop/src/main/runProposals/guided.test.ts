import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTempUserData } from '../../test/main/ipcHarness';

/**
 * A run setup started from Runova: the agent is launched with its own MCP config, so the project
 * needs no .mcp.json entry. The config lives outside the project folder, and the permission to
 * suggest lasts for a limited time.
 */

vi.mock('../ipc/send', () => ({
  broadcastToWindows: () => undefined,
}));

const userData = useTempUserData();
const PORT_FILE = join(tmpdir(), 'unused-hook-server.json');

async function load() {
  return import('./service');
}

let folder: string;
let directory: string;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'guided-project-'));
  directory = mkdtempSync(join(tmpdir(), 'guided-sessions-'));
  seedProject('p1');
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(folder, { recursive: true, force: true });
  rmSync(directory, { recursive: true, force: true });
});

function seedProject(id: string): void {
  userData.writeData('projects.json', [
    {
      id,
      name: 'Apollo',
      folderPath: folder,
      description: '',
      tags: [],
      agentType: 'claude-code',
      notes: '',
      runCommands: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ]);
}

const proposal = {
  projectId: 'p1',
  action: 'propose',
  label: 'android dev',
  command: 'flutter run',
};

describe('guided run setup', () => {
  it('writes the bridge and an MCP config outside the project folder', async () => {
    const service = await load();

    const result = await service.startGuidedRunSession('p1', { directory, portFile: PORT_FILE });

    expect(result).toEqual({
      ok: true,
      mcpConfigPath: join(directory, 'p1', 'mcp.json'),
      allowedTools: ['mcp__runova__list_run_commands', 'mcp__runova__propose_run_command'],
    });
    const config = JSON.parse(readFileSync(join(directory, 'p1', 'mcp.json'), 'utf-8')) as {
      mcpServers: { runova: { command: string; args: string[] } };
    };
    expect(config.mcpServers.runova.command).toBe('node');
    const script = config.mcpServers.runova.args[0];
    expect(script).toBe(join(directory, 'p1', 'run-commands-mcp.cjs'));
    expect(readFileSync(script, 'utf-8')).toContain('"p1"');
    expect(existsSync(join(folder, '.mcp.json'))).toBe(false);
    expect(existsSync(join(folder, '.runova'))).toBe(false);
  });

  it('accepts a suggestion for a project that never switched the feature on', async () => {
    const service = await load();
    await service.startGuidedRunSession('p1', { directory, portFile: PORT_FILE });

    const result = await service.handleRunCommandsRequest(proposal);

    expect(result.status).toBe(200);
    expect(result.payload).toMatchObject({ ok: true });
    expect(await service.getRunProposalsEnabled('p1')).toBe(false);
  });

  it('refuses a suggestion before a setup was started', async () => {
    const service = await load();

    const result = await service.handleRunCommandsRequest(proposal);

    expect(result.status).toBe(403);
  });

  it('stops accepting suggestions after two hours', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-16T10:00:00.000Z'));
    const service = await load();
    await service.startGuidedRunSession('p1', { directory, portFile: PORT_FILE });

    vi.setSystemTime(new Date('2026-10-16T11:59:00.000Z'));
    expect((await service.handleRunCommandsRequest(proposal)).status).toBe(200);

    vi.setSystemTime(new Date('2026-10-16T12:00:01.000Z'));
    const late = await service.handleRunCommandsRequest({
      ...proposal,
      command: 'flutter run --release',
    });
    expect(late.status).toBe(403);
  });

  it('refuses a project Runova does not know', async () => {
    const service = await load();

    const result = await service.startGuidedRunSession('nope', { directory, portFile: PORT_FILE });

    expect(result).toEqual({ ok: false, error: 'Runova does not know this project.' });
  });

  it('refuses a project id that cannot be a folder name', async () => {
    seedProject('../escape');
    const service = await load();

    const result = await service.startGuidedRunSession('../escape', {
      directory,
      portFile: PORT_FILE,
    });

    expect(result).toEqual({ ok: false, error: 'This project cannot start a run setup.' });
    expect(existsSync(join(directory, '..', 'escape'))).toBe(false);
  });
});
