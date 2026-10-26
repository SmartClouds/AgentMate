import type { HealthIncident, HealthReport } from '@runova/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../shared/ipcChannels';
import { FakeBrowserWindow } from '../../test/main/electronMock';
import { tempDir } from '../../test/main/fixtures';
import { useTempUserData } from '../../test/main/ipcHarness';
import type { HeadlessPromptOptions, HeadlessPromptResult } from '../cli/headlessPrompt';
import type { HealthDiagnoseDeps } from './diagnose';
import type { StoredHealthTarget } from './store';

/**
 * The read-only AI analysis of an incident. It runs once per incident, never with write access,
 * never more than once in ten minutes per target on its own, and what it says is redacted before
 * it is stored. The user can also start it, and stop it.
 */

const userData = useTempUserData();
const NOW = 1_760_000_000_000;
const KEY = 'rnh_theKeyMustNeverReachAPrompt_0123456789abcdefgh';
let health: typeof import('./store');
let folder = '';

const report: HealthReport = {
  state: 'fail',
  httpStatus: 503,
  latencyMs: 12,
  checkedAt: NOW,
  serviceId: null,
  description: null,
  releaseId: '1.2.3',
  version: null,
  output: null,
  services: [
    {
      key: 'postgres:connection',
      name: 'postgres',
      measurement: 'connection',
      componentId: null,
      componentType: 'datastore',
      status: 'fail',
      observedValue: null,
      observedUnit: null,
      time: null,
      error: {
        message: 'auth failed for postgres://app:hunter2@db:5432/shop',
        code: null,
        detail: 'password=hunter2',
        stack: null,
        hint: null,
        since: null,
      },
    },
  ],
  problem: null,
  raw: null,
};

function incident(overrides: Partial<HealthIncident> = {}): HealthIncident {
  return {
    id: 'i1',
    targetId: 't1',
    openedAt: NOW,
    resolvedAt: null,
    state: 'fail',
    summary: 'postgres down',
    failingServices: ['postgres:connection'],
    diagnosis: null,
    ...overrides,
  };
}

async function seed(
  overrides: Partial<StoredHealthTarget> = {},
  incidents: HealthIncident[] = [incident()],
) {
  const vault = await import('../ssh/vault');
  const target: StoredHealthTarget = {
    id: 't1',
    projectId: 'p1',
    environmentId: 'e1',
    name: 'API',
    serverLabel: 'web-1',
    serverLink: null,
    url: 'https://shop.example.com/health?x=1',
    intervalSec: 60,
    timeoutSec: 10,
    authMode: 'bearer',
    basicUser: null,
    allowInsecure: false,
    autoDiagnose: true,
    createdAt: 1,
    updatedAt: 1,
    paused: false,
    secretEnvelope: await vault.encryptSecret(KEY),
    secretRotatedAt: null,
    ...overrides,
  };
  await health.mutateHealth((state) => {
    state.targets = [target];
    state.results = { t1: { ...health.emptyHealthResult(), report, incidents } };
  });
}

type Run = HealthDiagnoseDeps['run'];

function deferred() {
  let resolve!: (result: HeadlessPromptResult) => void;
  const promise = new Promise<HeadlessPromptResult>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function diagnoser(run: Run, now = () => NOW) {
  const cancel = vi.fn();
  const { createHealthDiagnoser } = await import('./diagnose');
  return { cancel, diagnoser: createHealthDiagnoser({ run, cancel, now }) };
}

async function diagnosis() {
  return (await health.readHealthState()).results.t1.incidents[0].diagnosis;
}

const answered: Run = async () => ({
  ok: true,
  text: 'Summary: db password wrong',
  cliName: 'Claude',
});

beforeEach(async () => {
  folder = tempDir();
  userData.writeData('projects.json', [
    { id: 'p1', name: 'Shop', folderPath: folder, cliId: 'codex', createdAt: '2026-01-01' },
  ]);
  userData.writeData('project-environments.json', [
    { id: 'e1', projectId: 'p1', name: 'Production', kind: 'production', order: 0, files: [] },
  ]);
  health = await import('./store');
});

describe('automatic diagnosis', () => {
  it('runs read-only in the project folder and stores the redacted answer', async () => {
    await seed();
    const run = vi.fn<Run>(async () => ({
      ok: true,
      text: 'Cause: DB_PASSWORD=hunter2 is wrong',
      cliName: 'Claude Code',
    }));
    const { diagnoser: d } = await diagnoser(run);
    const window = new FakeBrowserWindow();

    await d.onIncidentOpened('t1', 'i1');
    await d.idle();

    expect(run).toHaveBeenCalledOnce();
    const [prompt, cwd, options] = run.mock.calls[0] as [string, string, HeadlessPromptOptions];
    expect(cwd).toBe(folder);
    expect(options).toMatchObject({
      allowWrites: false,
      timeoutMs: 180_000,
      preferredCliId: 'codex',
    });
    expect(options.requestId).toMatch(/^health-/);
    expect(prompt).toContain('Do not change any files');
    expect(prompt).toContain('Environment: Production');
    expect(prompt).toContain('Server: web-1');
    expect(prompt).toContain('https://shop.example.com/health');
    expect(prompt).not.toContain('x=1');
    expect(prompt).not.toContain('hunter2');
    expect(prompt).not.toContain(KEY);

    expect(await diagnosis()).toEqual({
      status: 'done',
      startedAt: NOW,
      finishedAt: NOW,
      cliName: 'Claude Code',
      text: 'Cause: DB_PASSWORD=[redacted] is wrong',
    });
    expect(window.webContents.sentOn(IPC.health.onChanged).length).toBeGreaterThanOrEqual(2);
  });

  it('shows that it is running until the CLI answers', async () => {
    await seed();
    const pending = deferred();
    const { diagnoser: d } = await diagnoser(() => pending.promise);
    await d.onIncidentOpened('t1', 'i1');
    expect(await diagnosis()).toMatchObject({ status: 'running', finishedAt: null, text: null });
    pending.resolve({ ok: true, text: 'ok', cliName: 'Codex' });
    await d.idle();
    expect(await diagnosis()).toMatchObject({ status: 'done', text: 'ok' });
  });

  it('runs once per incident', async () => {
    await seed({}, [
      incident({
        diagnosis: { status: 'done', startedAt: 1, finishedAt: 2, cliName: null, text: 'x' },
      }),
    ]);
    const run = vi.fn<Run>(answered);
    const { diagnoser: d } = await diagnoser(run);
    await d.onIncidentOpened('t1', 'i1');
    await d.idle();
    expect(run).not.toHaveBeenCalled();
  });

  it('does nothing when the target does not ask for it', async () => {
    await seed({ autoDiagnose: false });
    const run = vi.fn<Run>(answered);
    const { diagnoser: d } = await diagnoser(run);
    await d.onIncidentOpened('t1', 'i1');
    await d.idle();
    expect(run).not.toHaveBeenCalled();
    expect(await diagnosis()).toBeNull();
  });

  it('skips a second incident within ten minutes of the last run', async () => {
    await seed({}, [incident({ id: 'i2' }), incident({ id: 'i1', resolvedAt: NOW })]);
    let clock = NOW;
    const run = vi.fn<Run>(answered);
    const { diagnoser: d } = await diagnoser(run, () => clock);
    await d.onIncidentOpened('t1', 'i1');
    await d.idle();
    clock += 5 * 60_000;
    await d.onIncidentOpened('t1', 'i2');
    await d.idle();
    expect(run).toHaveBeenCalledOnce();
    const incidents = (await health.readHealthState()).results.t1.incidents;
    expect(incidents[0].diagnosis).toMatchObject({ status: 'skipped' });

    clock += 6 * 60_000;
    await d.diagnoseNow('t1');
    await d.idle();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('records a CLI that failed or found nothing to say', async () => {
    await seed();
    const { diagnoser: d } = await diagnoser(async () => ({
      ok: false,
      text: '',
      cliName: null,
      error: `No AI CLI is installed ${KEY}`,
    }));
    await d.onIncidentOpened('t1', 'i1');
    await d.idle();
    const failed = await diagnosis();
    expect(failed).toMatchObject({ status: 'failed' });
    expect(failed?.text).toMatch(/No AI CLI/);
    expect(failed?.text).not.toContain(KEY);

    await seed();
    const { diagnoser: empty } = await diagnoser(async () => ({
      ok: true,
      text: '  ',
      cliName: 'X',
    }));
    await empty.diagnoseNow('t1');
    await empty.idle();
    expect(await diagnosis()).toMatchObject({
      status: 'failed',
      text: expect.stringMatching(/no answer/),
    });
  });

  it('records a run that threw', async () => {
    await seed();
    const { diagnoser: d } = await diagnoser(async () => {
      throw new Error('spawn failed');
    });
    await d.diagnoseNow('t1');
    await d.idle();
    expect(await diagnosis()).toMatchObject({ status: 'failed', text: 'spawn failed' });
  });

  it('ignores a target or incident that is gone', async () => {
    const run = vi.fn<Run>(answered);
    const { diagnoser: d } = await diagnoser(run);
    await d.onIncidentOpened('nope', 'i1');
    await seed();
    await d.onIncidentOpened('t1', 'nope');
    await d.idle();
    expect(run).not.toHaveBeenCalled();
  });

  it('drops the answer when the target was removed while it ran', async () => {
    await seed();
    const pending = deferred();
    const { diagnoser: d } = await diagnoser(() => pending.promise);
    await d.onIncidentOpened('t1', 'i1');
    await health.mutateHealth((state) => {
      state.targets = [];
      state.results = {};
    });
    pending.resolve({ ok: true, text: 'late', cliName: 'X' });
    await d.idle();
    expect((await health.readHealthState()).results).toEqual({});
  });
});

describe('diagnoseNow and cancel', () => {
  it('runs for the open incident even when automatic diagnosis is off', async () => {
    await seed({ autoDiagnose: false });
    const run = vi.fn<Run>(answered);
    const { diagnoser: d } = await diagnoser(run);
    await d.diagnoseNow('t1');
    await d.idle();
    expect(run).toHaveBeenCalledOnce();
    expect(await diagnosis()).toMatchObject({ status: 'done' });
  });

  it('runs for the latest incident when none is open', async () => {
    await seed({}, [incident({ resolvedAt: NOW + 1 })]);
    const run = vi.fn<Run>(answered);
    const { diagnoser: d } = await diagnoser(run);
    await d.diagnoseNow('t1');
    await d.idle();
    expect(run).toHaveBeenCalledOnce();
  });

  it('refuses when nothing has failed yet, or the target is gone', async () => {
    await seed({}, []);
    const { diagnoser: d } = await diagnoser(answered);
    await expect(d.diagnoseNow('t1')).rejects.toThrow(/nothing to analyze/);
    await expect(d.diagnoseNow('gone')).rejects.toThrow(/no longer exists/);
  });

  it('does not start a second run while one is going', async () => {
    await seed();
    const pending = deferred();
    const run = vi.fn<Run>(() => pending.promise);
    const { diagnoser: d } = await diagnoser(run);
    await d.diagnoseNow('t1');
    await d.diagnoseNow('t1');
    pending.resolve({ ok: true, text: 'x', cliName: 'X' });
    await d.idle();
    expect(run).toHaveBeenCalledOnce();
  });

  it('stops a running analysis and records that it was stopped', async () => {
    await seed();
    const pending = deferred();
    const run = vi.fn<Run>(() => pending.promise);
    const { diagnoser: d, cancel } = await diagnoser(run);
    await d.diagnoseNow('t1');
    d.cancel('t1');
    const requestId = (run.mock.calls[0][2] as HeadlessPromptOptions).requestId;
    expect(cancel).toHaveBeenCalledWith(requestId);
    pending.resolve({ ok: false, text: '', cliName: 'X', cancelled: true });
    await d.idle();
    expect(await diagnosis()).toMatchObject({ status: 'cancelled' });

    // Nothing running: nothing to stop.
    d.cancel('t1');
    expect(cancel).toHaveBeenCalledOnce();
  });
});
