import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTempUserData } from '../../test/main/ipcHarness';

/**
 * The bridge reaches Runova through the same loopback server as the hooks, at /run-commands.
 * These cases are about who may ask: the secret written next to the port, and nothing else.
 */

vi.mock('../ipc/terminal', () => ({
  SESSION_ID_PATTERN: /^[A-Za-z0-9_-]{1,128}$/,
  findSessionIdForProject: () => null,
  writeToSession: () => undefined,
}));

vi.mock('../agents/statusTracker', () => ({
  agentStatus: { hook: () => true, runInfo: async () => undefined },
}));

vi.mock('../notifications/petNotifier', () => ({
  speakOnPet: () => true,
}));

vi.mock('../ipc/send', () => ({
  broadcastToWindows: () => undefined,
}));

const userData = useTempUserData();

let folder: string;
let stopServer: (() => void) | null = null;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'run-route-project-'));
  userData.writeData('projects.json', [
    {
      id: 'p1',
      name: 'Apollo',
      folderPath: folder,
      description: '',
      tags: [],
      agentType: 'claude-code',
      notes: '',
      runCommands: [{ id: 'dev', label: 'dev', command: 'npm run dev' }],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ]);
});

afterEach(() => {
  stopServer?.();
  stopServer = null;
  rmSync(folder, { recursive: true, force: true });
});

interface PortFile {
  port: number;
  token: string;
}

/** Starts the real hook server, and returns the port and secret it wrote for scripts to use. */
async function startAndRead(): Promise<PortFile> {
  const hook = await import('../notifications/hookServer');
  await hook.startHookServer();
  stopServer = hook.stopHookServer;
  return JSON.parse(readFileSync(hook.portFilePath(), 'utf-8')) as PortFile;
}

async function enableForProject(file: PortFile): Promise<void> {
  const hook = await import('../notifications/hookServer');
  const service = await import('./service');
  const result = await service.setRunProposalsEnabled('p1', true, hook.portFilePath());
  expect(result).toEqual({ ok: true });
  void file;
}

async function askRunCommands(
  port: number,
  body: string,
): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const response = await fetch(`http://127.0.0.1:${port}/run-commands`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
  const json = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  return { status: response.status, json };
}

describe('POST /run-commands', () => {
  it('refuses a request without the secret, and suggests nothing', async () => {
    const file = await startAndRead();
    await enableForProject(file);

    const result = await askRunCommands(
      file.port,
      JSON.stringify({ projectId: 'p1', action: 'propose', command: 'flutter run' }),
    );

    expect(result.status).toBe(401);
    const service = await import('./service');
    expect(service.listPendingRunProposals()).toEqual([]);
  });

  it('refuses a secret of the right length that is not the right one', async () => {
    const file = await startAndRead();
    await enableForProject(file);

    const result = await askRunCommands(
      file.port,
      JSON.stringify({
        token: 'f'.repeat(file.token.length),
        projectId: 'p1',
        action: 'propose',
        command: 'flutter run',
      }),
    );

    expect(result.status).toBe(401);
  });

  it('accepts a suggestion carrying the secret, and answers with its id and the message', async () => {
    const file = await startAndRead();
    await enableForProject(file);

    const result = await askRunCommands(
      file.port,
      JSON.stringify({
        token: file.token,
        projectId: 'p1',
        action: 'propose',
        label: 'android dev',
        command: 'flutter run -d emulator-5554',
      }),
    );

    expect(result.status).toBe(200);
    expect(result.json).toMatchObject({ ok: true, id: expect.any(String) });
    const service = await import('./service');
    expect(service.listPendingRunProposals()).toEqual([
      expect.objectContaining({ command: 'flutter run -d emulator-5554', label: 'android dev' }),
    ]);
  });

  it('answers the list action with the project run commands', async () => {
    const file = await startAndRead();
    await enableForProject(file);

    const result = await askRunCommands(
      file.port,
      JSON.stringify({ token: file.token, projectId: 'p1', action: 'list' }),
    );

    expect(result).toEqual({
      status: 200,
      json: { ok: true, commands: [{ label: 'dev', command: 'npm run dev' }] },
    });
  });

  it('rejects a body that is not JSON', async () => {
    const file = await startAndRead();

    const result = await askRunCommands(file.port, 'not json');

    expect(result.status).toBe(400);
  });

  it('cuts off a body far larger than any suggestion', async () => {
    const file = await startAndRead();

    const response = await fetch(`http://127.0.0.1:${file.port}/run-commands`, {
      method: 'POST',
      body: 'x'.repeat(200_000),
    }).catch(() => null);

    // Either the 413 lands or the socket is cut. What matters is that nothing was processed.
    expect(response === null || response.status === 413).toBe(true);
  });
});
