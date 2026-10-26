import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../shared/ipcChannels';
import { useTempUserData } from '../../test/main/ipcHarness';

const broadcasts: { channel: string; payload: unknown }[] = [];

vi.mock('../ipc/send', () => ({
  broadcastToWindows: (channel: string, payload: unknown) => {
    broadcasts.push({ channel, payload });
  },
}));

/** The service keeps suggestions in memory, so each test loads a fresh copy of it. */
async function load() {
  return import('./service');
}

const userData = useTempUserData();
const PORT_FILE = join(tmpdir(), 'unused-hook-server.json');

let folder: string;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'run-proposal-project-'));
  broadcasts.length = 0;
});

afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

function seedProject(runCommands = [{ id: 'dev', label: 'dev', command: 'npm run dev' }]): void {
  userData.writeData('projects.json', [
    {
      id: 'p1',
      name: 'Apollo',
      folderPath: folder,
      description: '',
      tags: [],
      agentType: 'claude-code',
      notes: '',
      runCommands,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ]);
}

function propose(overrides: Record<string, unknown> = {}) {
  return {
    projectId: 'p1',
    action: 'propose',
    label: 'android dev',
    command: 'flutter run',
    ...overrides,
  };
}

describe('run suggestions for a project', () => {
  it('refuses a suggestion until the project has the feature switched on', async () => {
    seedProject();
    const service = await load();

    const result = await service.handleRunCommandsRequest(propose());

    expect(result).toEqual({
      status: 403,
      payload: { ok: false, error: expect.stringContaining('off for this project') },
    });
    expect(service.listPendingRunProposals()).toEqual([]);
  });

  it('keeps a suggestion pending, announces it, and tells the agent it waits for approval', async () => {
    seedProject();
    const service = await load();
    await service.setRunProposalsEnabled('p1', true, PORT_FILE);

    const result = await service.handleRunCommandsRequest(
      propose({ command: 'flutter run -d emulator-5554' }),
    );

    expect(result.status).toBe(200);
    expect(result.payload).toMatchObject({
      ok: true,
      id: expect.any(String),
      message: expect.stringContaining('waits for the user to approve it'),
    });
    const [pending] = service.listPendingRunProposals();
    expect(pending).toMatchObject({
      id: result.payload.id,
      projectId: 'p1',
      projectName: 'Apollo',
      label: 'android dev',
      command: 'flutter run -d emulator-5554',
    });
    expect(broadcasts.at(-1)).toEqual({
      channel: IPC.runProposals.onChanged,
      payload: { pending: [pending] },
    });
  });

  it('refuses an invalid suggestion, and says why', async () => {
    seedProject();
    const service = await load();
    await service.setRunProposalsEnabled('p1', true, PORT_FILE);

    const result = await service.handleRunCommandsRequest(
      propose({ command: 'flutter run\nrm -rf /' }),
    );

    expect(result).toEqual({
      status: 400,
      payload: { ok: false, error: 'The command must be one line of text.' },
    });
    expect(service.listPendingRunProposals()).toEqual([]);
  });

  it('refuses a second copy of a suggestion that is still waiting', async () => {
    seedProject();
    const service = await load();
    await service.setRunProposalsEnabled('p1', true, PORT_FILE);
    await service.handleRunCommandsRequest(propose());

    const again = await service.handleRunCommandsRequest(propose({ label: 'again' }));

    expect(again).toEqual({
      status: 409,
      payload: {
        ok: false,
        error: 'Runova is already waiting for your approval of that command.',
      },
    });
    expect(service.listPendingRunProposals()).toHaveLength(1);
  });

  it('stops accepting suggestions for one project after ten are waiting', async () => {
    seedProject();
    const service = await load();
    await service.setRunProposalsEnabled('p1', true, PORT_FILE);
    for (let index = 0; index < 10; index += 1) {
      await service.handleRunCommandsRequest(propose({ command: `tool --step ${index}` }));
    }

    const eleventh = await service.handleRunCommandsRequest(propose({ command: 'tool --step 10' }));

    expect(eleventh).toEqual({
      status: 429,
      payload: {
        ok: false,
        error: 'Too many suggestions are waiting. Review them in Runova first.',
      },
    });
    expect(service.listPendingRunProposals()).toHaveLength(10);
  });

  it('adds an approved command to the project and takes it off the pending list', async () => {
    seedProject();
    const service = await load();
    await service.setRunProposalsEnabled('p1', true, PORT_FILE);
    const { payload } = await service.handleRunCommandsRequest(propose());

    const decided = await service.decideRunProposal(payload.id as string, 'add');

    // The saved command comes back, so the app can offer to run it straight away.
    expect(decided).toEqual({
      ok: true,
      projectId: 'p1',
      runCommand: { id: expect.any(String), label: 'android dev', command: 'flutter run' },
    });
    expect(service.listPendingRunProposals()).toEqual([]);
    const store = (await import('../store')).store;
    const [project] = await store.getProjects();
    expect(project.runCommands).toEqual([
      { id: 'dev', label: 'dev', command: 'npm run dev' },
      { id: expect.any(String), label: 'android dev', command: 'flutter run' },
    ]);
    expect(project.runCommands[1]).toEqual((decided as { runCommand: unknown }).runCommand);
  });

  it('discards a suggestion without touching the project', async () => {
    seedProject();
    const service = await load();
    await service.setRunProposalsEnabled('p1', true, PORT_FILE);
    const { payload } = await service.handleRunCommandsRequest(propose());

    const decided = await service.decideRunProposal(payload.id as string, 'discard');

    expect(decided).toEqual({ ok: true, projectId: 'p1' });
    expect(service.listPendingRunProposals()).toEqual([]);
    const store = (await import('../store')).store;
    const [project] = await store.getProjects();
    expect(project.runCommands).toHaveLength(1);
  });

  it('does not add a command the project got in the meantime, and clears the suggestion', async () => {
    seedProject();
    const service = await load();
    await service.setRunProposalsEnabled('p1', true, PORT_FILE);
    const { payload } = await service.handleRunCommandsRequest(propose({ command: 'npm run dev' }));
    expect(payload.ok).toBe(false);
    const { payload: second } = await service.handleRunCommandsRequest(
      propose({ command: 'npm run serve' }),
    );
    const store = (await import('../store')).store;
    const [project] = await store.getProjects();
    await store.setProjects([
      {
        ...project,
        runCommands: [...project.runCommands, { id: 'x', label: '', command: 'npm run serve' }],
      },
    ]);

    const decided = await service.decideRunProposal(second.id as string, 'add');

    expect(decided).toEqual({ ok: false, error: 'This project already has that run command.' });
    expect(service.listPendingRunProposals()).toEqual([]);
  });

  it('lists the run commands of a project that has the feature on', async () => {
    seedProject();
    const service = await load();
    await service.setRunProposalsEnabled('p1', true, PORT_FILE);

    const result = await service.handleRunCommandsRequest({ projectId: 'p1', action: 'list' });

    expect(result).toEqual({
      status: 200,
      payload: { ok: true, commands: [{ label: 'dev', command: 'npm run dev' }] },
    });
  });

  it('answers an unknown project, or an action it does not know, with an error', async () => {
    seedProject();
    const service = await load();

    expect(await service.handleRunCommandsRequest({ projectId: 'nope', action: 'list' })).toEqual({
      status: 404,
      payload: { ok: false, error: 'Runova does not know this project.' },
    });
    await service.setRunProposalsEnabled('p1', true, PORT_FILE);
    expect(await service.handleRunCommandsRequest({ projectId: 'p1', action: 'delete' })).toEqual({
      status: 400,
      payload: { ok: false, error: 'Unknown action.' },
    });
  });

  it('switching off clears that project suggestions and removes what it wrote', async () => {
    seedProject();
    const service = await load();
    await service.setRunProposalsEnabled('p1', true, PORT_FILE);
    await service.handleRunCommandsRequest(propose());
    expect(await service.getRunProposalsEnabled('p1')).toBe(true);

    const result = await service.setRunProposalsEnabled('p1', false, PORT_FILE);

    expect(result).toEqual({ ok: true });
    expect(service.listPendingRunProposals()).toEqual([]);
    expect(await service.getRunProposalsEnabled('p1')).toBe(false);
    expect(existsSync(join(folder, '.runova', 'run-commands-mcp.cjs'))).toBe(false);
    expect(readFileSync(join(folder, '.mcp.json'), 'utf-8').includes('runova')).toBe(false);
  });

  it('reports a project whose .mcp.json cannot be read, and changes nothing', async () => {
    seedProject();
    const service = await load();
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(folder, '.mcp.json'), '{ broken');

    const result = await service.setRunProposalsEnabled('p1', true, PORT_FILE);

    expect(result).toEqual({
      ok: false,
      error: '.mcp.json is not valid JSON, so it was left as it was.',
    });
    expect(await service.getRunProposalsEnabled('p1')).toBe(false);
  });
});
