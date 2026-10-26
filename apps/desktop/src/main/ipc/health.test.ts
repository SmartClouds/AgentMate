import { readFileSync } from 'node:fs';
import { buildHealthSpecMarkdown, HEALTH_ENV } from '@runova/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  HealthCreateResult,
  HealthSecretReveal,
  HealthSetupPrompt,
  HealthTargetDetail,
  HealthTargetInput,
  HealthTargetSummary,
} from '../../shared/healthTypes';
import { IPC } from '../../shared/ipcChannels';
import { FakeBrowserWindow } from '../../test/main/electronMock';
import { json, type LocalServer, startHttpServer, tempDir } from '../../test/main/fixtures';
import {
  expectChannelsCovered,
  invoke,
  loadIpc,
  useTempUserData,
} from '../../test/main/ipcHarness';
import type { HeadlessPromptResult } from '../cli/headlessPrompt';
import { sha256Hex } from '../health/token';

/**
 * The Health page's channels. The one rule above the rest: a target's key or password comes back
 * exactly twice in its life, from create and from rotate, and never in any other payload. The
 * probes here run for real over the app's net.fetch (Node's fetch in the electron mock) against
 * a local endpoint, so the key that is checked is the one that was actually sent.
 */

const cli = vi.hoisted(() => ({
  run: vi.fn<(...args: unknown[]) => Promise<HeadlessPromptResult>>(),
  cancel: vi.fn(() => true),
}));

vi.mock('../cli/headlessPrompt', () => ({
  runHeadlessCliPrompt: cli.run,
  cancelHeadlessPrompt: cli.cancel,
}));

const userData = useTempUserData();
// onChanged is main to renderer, checked through the windows' sent messages instead.
expectChannelsCovered(IPC.health, [IPC.health.onChanged]);

let endpoint: LocalServer;
let respond: { status: number; body: unknown } = { status: 200, body: { status: 'pass' } };
const sent: string[] = [];

function input(overrides: Partial<HealthTargetInput> = {}): HealthTargetInput {
  return {
    projectId: 'p1',
    environmentId: 'e1',
    name: 'API',
    serverLabel: 'web-1',
    serverLink: null,
    url: `${endpoint.url}/_runova/health`,
    intervalSec: 60,
    timeoutSec: 5,
    authMode: 'bearer',
    basicUser: null,
    allowInsecure: false,
    autoDiagnose: false,
    ...overrides,
  };
}

/** Everything a payload could hide a secret in. */
function expectNoSecret(payload: unknown, secret: string) {
  const text = JSON.stringify(payload);
  expect(text).not.toContain(secret);
  expect(text).not.toContain('secretEnvelope');
  expect(text).not.toContain('ciphertext');
}

async function create(overrides: Partial<HealthTargetInput> = {}) {
  return invoke<HealthCreateResult>(IPC.health.create, input(overrides));
}

const failing = {
  status: 'fail',
  checks: {
    'postgres:connection': [
      { status: 'fail', output: 'connect ECONNREFUSED', runova: { detail: 'password=hunter2' } },
    ],
  },
};

beforeEach(async () => {
  respond = { status: 200, body: { status: 'pass' } };
  sent.length = 0;
  endpoint = await startHttpServer((request, response) => {
    sent.push(String(request.headers.authorization ?? ''));
    json(response, respond.body, respond.status);
  });
  userData.writeData('projects.json', [
    { id: 'p1', name: 'Shop', folderPath: tempDir(), createdAt: '2026-01-01T00:00:00Z' },
    { id: 'p2', name: 'Blog', folderPath: tempDir(), createdAt: '2026-01-01T00:00:00Z' },
  ]);
  userData.writeData('project-environments.json', [
    {
      id: 'e1',
      projectId: 'p1',
      name: 'Production',
      kind: 'production',
      order: 0,
      files: [],
      credentials: [],
    },
  ]);
  cli.run.mockReset();
  cli.run.mockResolvedValue({
    ok: true,
    text: 'Likely cause: the database is down.',
    cliName: 'Claude Code',
  });
  cli.cancel.mockClear();
  const electron = await import('../../test/main/electronMock');
  electron.net.fetch.mockImplementation((url: string, init: RequestInit) => fetch(url, init));
  await loadIpc(
    () => import('./health'),
    (module) => module.registerHealthHandlers(),
  );
  return () => endpoint.close();
});

describe('create and rotate, the only two that reveal a secret', () => {
  it('makes a Bearer key, keeps only its sealed form and reveals it once', async () => {
    const window = new FakeBrowserWindow();
    const { target, secret } = await create();
    expect(secret).toEqual({
      targetId: target.id,
      authMode: 'bearer',
      secret: expect.stringMatching(/^rnh_[A-Za-z0-9_-]{43}$/),
      sha256: sha256Hex(secret.secret),
      basicUser: null,
      hashEnvVar: HEALTH_ENV.tokenHash,
    } satisfies HealthSecretReveal);
    expect(target).toMatchObject({ name: 'API', hasSecret: true, state: 'pending', paused: false });
    expectNoSecret(target, secret.secret);
    expect(readFileSync(userData.dataFile('health-targets.json'), 'utf-8')).not.toContain(
      secret.secret,
    );
    expect(window.webContents.sentOn(IPC.health.onChanged)).toEqual([[{ targetIds: [target.id] }]]);
  });

  it('makes a Basic password with the password hash variable', async () => {
    const { secret } = await create({ authMode: 'basic', basicUser: 'runova' });
    expect(secret).toMatchObject({
      authMode: 'basic',
      basicUser: 'runova',
      hashEnvVar: HEALTH_ENV.passwordHash,
    });
    expect(secret.secret).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(secret.sha256).toBe(sha256Hex(secret.secret));
  });

  it('rotates to a new key that the next probe sends', async () => {
    const { target, secret } = await create();
    const rotated = await invoke<HealthSecretReveal>(IPC.health.rotateSecret, target.id);
    expect(rotated.secret).not.toBe(secret.secret);
    expect(rotated.sha256).toBe(sha256Hex(rotated.secret));
    const [listed] = await invoke<HealthTargetSummary[]>(IPC.health.list);
    expect(listed.secretRotatedAt).toEqual(expect.any(Number));
    expectNoSecret(listed, rotated.secret);

    await invoke(IPC.health.checkNow, target.id);
    expect(sent).toEqual([`Bearer ${rotated.secret}`]);
  });

  it('says the vault is locked instead of saving a key it cannot seal', async () => {
    const { randomBytes } = await import('node:crypto');
    const { deriveKey, encryptWithKey } = await import('../crypto/aesGcm');
    const salt = randomBytes(16).toString('base64');
    const key = await deriveKey('a passkey nobody typed', salt);
    userData.writeData('ssh-vault.json', {
      salt,
      verifier: Buffer.from(
        JSON.stringify(encryptWithKey('agentmate-ssh-vault', key) /* legacy-name */),
      ).toString('base64'),
    });
    await expect(create()).rejects.toThrow('The vault is locked.');
  });
});

describe('reading targets', () => {
  it('lists summaries, optionally for one project, with no secret in them', async () => {
    const { target, secret } = await create();
    const other = await create({ projectId: 'p2', environmentId: null, name: 'Blog' });
    const all = await invoke<HealthTargetSummary[]>(IPC.health.list);
    expect(all.map((one) => one.id)).toEqual([target.id, other.target.id]);
    expectNoSecret(all, secret.secret);
    expectNoSecret(all, other.secret.secret);
    const shop = await invoke<HealthTargetSummary[]>(IPC.health.list, { projectId: 'p1' });
    expect(shop.map((one) => one.id)).toEqual([target.id]);
  });

  it('gets the detail of one target, or null when it is gone', async () => {
    const { target, secret } = await create();
    const detail = await invoke<HealthTargetDetail>(IPC.health.get, target.id);
    expect(detail).toMatchObject({ report: null, incidents: [], samples: [] });
    expectNoSecret(detail, secret.secret);
    expect(await invoke(IPC.health.get, 'missing')).toBeNull();
  });

  it('returns the protocol document', async () => {
    expect(await invoke(IPC.health.spec)).toBe(buildHealthSpecMarkdown());
  });
});

describe('editing targets', () => {
  it('updates a target and keeps its key', async () => {
    const { target, secret } = await create();
    const updated = await invoke<HealthTargetSummary>(IPC.health.update, target.id, {
      name: '  Storefront ',
      intervalSec: 300,
    });
    expect(updated).toMatchObject({ id: target.id, name: 'Storefront', intervalSec: 300 });
    expect(updated.updatedAt).toBeGreaterThanOrEqual(target.updatedAt);
    expectNoSecret(updated, secret.secret);
    await invoke(IPC.health.checkNow, target.id);
    expect(sent).toEqual([`Bearer ${secret.secret}`]);
  });

  it('refuses an update that does not hold up, or a target that is gone', async () => {
    const { target } = await create();
    await expect(
      invoke(IPC.health.update, target.id, { url: 'https://u:p@example.com/h' }),
    ).rejects.toThrow(/username or password/);
    await expect(invoke(IPC.health.update, 'missing', { name: 'x' })).rejects.toThrow(
      /no longer exists/,
    );
  });

  it('pauses and resumes a target, which is checked again right after', async () => {
    const { target } = await create();
    await invoke(IPC.health.checkNow, target.id);
    const paused = await invoke<HealthTargetSummary>(IPC.health.setPaused, target.id, true);
    expect(paused).toMatchObject({ paused: true, state: 'paused' });
    const resumed = await invoke<HealthTargetSummary>(IPC.health.setPaused, target.id, false);
    expect(resumed).toMatchObject({ paused: false, state: 'pass', nextCheckAt: null });
  });

  it('removes a target and what it found', async () => {
    const { target } = await create();
    await invoke(IPC.health.checkNow, target.id);
    await invoke(IPC.health.remove, target.id);
    expect(await invoke(IPC.health.list)).toEqual([]);
    expect(await invoke(IPC.health.get, target.id)).toBeNull();
    const results = JSON.parse(readFileSync(userData.dataFile('health-results.json'), 'utf-8'));
    expect(results).toEqual({});
  });
});

describe('probing and incidents', () => {
  it('checks a target now and returns what it found, sending the key', async () => {
    const { target, secret } = await create();
    const detail = await invoke<HealthTargetDetail>(IPC.health.checkNow, target.id);
    expect(sent).toEqual([`Bearer ${secret.secret}`]);
    expect(detail.target.state).toBe('pass');
    expect(detail.samples).toHaveLength(1);
    expect(detail.target.uptime24h).toBe(1);
    expectNoSecret(detail, secret.secret);
  });

  it('builds the fix prompt from the last report, redacted, and null before one', async () => {
    const { target, secret } = await create();
    expect(await invoke(IPC.health.fixPrompt, target.id)).toBeNull();
    respond = { status: 503, body: failing };
    await invoke(IPC.health.checkNow, target.id);
    const prompt = await invoke<string>(IPC.health.fixPrompt, target.id);
    expect(prompt).toContain('postgres:connection');
    expect(prompt).toContain('Environment: Production');
    expect(prompt).not.toContain('hunter2');
    expect(prompt).not.toContain(secret.secret);
  });

  it('analyzes the open incident on request, read-only, and adds it to the fix prompt', async () => {
    const { target } = await create();
    respond = { status: 503, body: failing };
    await invoke(IPC.health.checkNow, target.id);
    await invoke(IPC.health.checkNow, target.id);
    const detail = await invoke<HealthTargetDetail>(IPC.health.get, target.id);
    expect(detail.target.openIncident).not.toBeNull();
    expect(cli.run).not.toHaveBeenCalled();

    await invoke(IPC.health.diagnoseNow, target.id);
    await vi.waitFor(async () => {
      const now = await invoke<HealthTargetDetail>(IPC.health.get, target.id);
      expect(now.incidents[0].diagnosis?.status).toBe('done');
    });
    expect(cli.run).toHaveBeenCalledOnce();
    expect(cli.run.mock.calls[0][2]).toMatchObject({ allowWrites: false });
    expect(await invoke(IPC.health.fixPrompt, target.id)).toContain('the database is down');
  });

  it('runs the analysis on its own when the incident opens on a target that asks for it', async () => {
    const { target } = await create({ autoDiagnose: true });
    respond = { status: 503, body: failing };
    await invoke(IPC.health.checkNow, target.id);
    await invoke(IPC.health.checkNow, target.id);
    await vi.waitFor(() => expect(cli.run).toHaveBeenCalledOnce());
  });

  it('stops a running analysis', async () => {
    const { target } = await create();
    respond = { status: 503, body: failing };
    await invoke(IPC.health.checkNow, target.id);
    await invoke(IPC.health.checkNow, target.id);
    let finish!: (result: HeadlessPromptResult) => void;
    cli.run.mockImplementation(() => new Promise((resolve) => (finish = resolve)));

    await invoke(IPC.health.diagnoseNow, target.id);
    await invoke(IPC.health.cancelDiagnose, target.id);
    expect(cli.cancel).toHaveBeenCalledWith(
      (cli.run.mock.calls[0][2] as { requestId: string }).requestId,
    );
    finish({ ok: false, text: '', cliName: 'Claude Code', cancelled: true });
    await vi.waitFor(async () => {
      const now = await invoke<HealthTargetDetail>(IPC.health.get, target.id);
      expect(now.incidents[0].diagnosis?.status).toBe('cancelled');
    });
  });

  it('writes the setup prompt for the endpoint with no secret in it', async () => {
    const { target, secret } = await create();
    const setup = await invoke<HealthSetupPrompt>(IPC.health.setupPrompt, target.id);
    expect(setup.spec).toBe(buildHealthSpecMarkdown());
    expect(setup.prompt).toContain('Add a healthcheck endpoint to Shop');
    expect(setup.prompt).toContain('the Production environment, server web-1');
    expect(setup.prompt).toContain('`/_runova/health`');
    expect(setup.prompt).toContain(HEALTH_ENV.tokenHash);
    expect(setup.prompt).not.toContain(secret.secret);
    expect(setup.prompt).not.toContain(secret.sha256);
  });

  it('suggests the default path when the URL has none', async () => {
    const { target } = await create({ url: endpoint.url });
    const setup = await invoke<HealthSetupPrompt>(IPC.health.setupPrompt, target.id);
    expect(setup.prompt).toContain('`/_runova/health`');
  });
});

describe('arguments', () => {
  it.each([
    ['a number for the URL', { url: 42 }],
    ['a missing name', { name: undefined }],
    ['an unknown auth mode', { authMode: 'digest' }],
    ['a string interval', { intervalSec: '60' }],
    ['a bad server link', { serverLink: { kind: 'ftp', id: 'x' } }],
  ])('refuses %s', async (_label, overrides) => {
    await expect(invoke(IPC.health.create, { ...input(), ...overrides })).rejects.toThrow(
      /healthcheck/i,
    );
  });

  it('refuses ids and flags of the wrong type', async () => {
    await expect(invoke(IPC.health.get, 42)).rejects.toThrow();
    await expect(invoke(IPC.health.remove, '')).rejects.toThrow();
    const { target } = await create();
    await expect(invoke(IPC.health.setPaused, target.id, 'yes')).rejects.toThrow();
    await expect(invoke(IPC.health.list, { projectId: 7 })).rejects.toThrow();
    await expect(invoke(IPC.health.update, target.id, 'nope')).rejects.toThrow();
  });

  it('answers only the windows the guard lets through', async () => {
    const { electronState } = await import('../../test/main/ipcHarness');
    electronState.handlers.clear();
    const { registerHealthHandlers } = await import('./health');
    registerHealthHandlers({ guard: () => false });
    await expect(invoke(IPC.health.list)).rejects.toThrow(/main window/);
  });
});

describe('pruning with projects and environments', () => {
  it('drops the targets of a deleted project', async () => {
    await loadIpc(
      () => import('./projects'),
      (module) => module.registerProjectHandlers(),
    );
    const blog = await create({ projectId: 'p2', environmentId: null });
    const shop = await create();
    await invoke(IPC.projects.delete, 'p2');
    const left = await invoke<HealthTargetSummary[]>(IPC.health.list);
    expect(left.map((one) => one.id)).toEqual([shop.target.id]);
    expect(await invoke(IPC.health.get, blog.target.id)).toBeNull();
  });

  it('keeps a target whose environment was deleted, without it', async () => {
    await loadIpc(
      () => import('./environments'),
      (module) => module.registerEnvironmentHandlers(),
    );
    const { target } = await create();
    await invoke(IPC.environments.remove, 'e1');
    const [left] = await invoke<HealthTargetSummary[]>(IPC.health.list);
    expect(left).toMatchObject({ id: target.id, environmentId: null });
  });
});
