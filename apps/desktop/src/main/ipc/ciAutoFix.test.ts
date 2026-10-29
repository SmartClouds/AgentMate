import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../shared/ipcChannels';
import {
  expectChannelsCovered,
  invoke,
  loadIpc,
  useTempUserData,
} from '../../test/main/ipcHarness';

/**
 * Switching auto-fix on lets an agent commit and push to a branch, so every field the renderer
 * sends is checked before it reaches the service: a branch or repo that is not one, or a run id
 * that is not a number, is refused rather than passed on.
 */

const service = vi.hoisted(() => ({
  list: vi.fn(),
  enable: vi.fn(),
  stop: vi.fn(),
  commitNow: vi.fn(),
  retry: vi.fn(),
  dismiss: vi.fn(),
}));

vi.mock('../pipelines/autoFix/wiring', () => ({ ciAutoFixService: () => service }));

useTempUserData();

expectChannelsCovered(IPC.ciAutoFix, [IPC.ciAutoFix.onChanged, IPC.ciAutoFix.onTab]);

beforeEach(async () => {
  for (const fn of Object.values(service)) fn.mockReset();
  await loadIpc(
    () => import('./ciAutoFix'),
    (module) => module.registerCiAutoFixHandlers(),
  );
});

const valid = {
  projectId: 'proj-1',
  repo: 'acme/shop',
  workflowId: 9,
  workflowName: 'CI',
  branch: 'release/2.0',
  runId: 100,
  runNumber: 7,
  cliId: 'claude-code',
  runArgs: ['--model', 'opus'],
  runLabel: 'Opus',
  maxAttempts: 2,
};

describe('ciAutoFix:list', () => {
  it('passes the sessions back', async () => {
    service.list.mockReturnValue([{ id: 'fix-1' }]);
    await expect(invoke(IPC.ciAutoFix.list)).resolves.toEqual([{ id: 'fix-1' }]);
  });
});

describe('ciAutoFix:start', () => {
  it('hands a valid request to the service', async () => {
    service.enable.mockResolvedValue({ ok: true, session: { id: 'fix-1' } });
    await expect(invoke(IPC.ciAutoFix.start, valid)).resolves.toEqual({
      ok: true,
      session: { id: 'fix-1' },
    });
    expect(service.enable).toHaveBeenCalledWith(valid);
  });

  it('keeps only the fields it knows, and allows leaving the optional ones out', async () => {
    service.enable.mockResolvedValue({ ok: true, session: { id: 'fix-1' } });
    await invoke(IPC.ciAutoFix.start, {
      projectId: 'proj-1',
      repo: 'acme/shop',
      workflowId: 9,
      workflowName: 'CI',
      branch: 'main',
      extra: 'dropped',
    });
    expect(service.enable).toHaveBeenCalledWith({
      projectId: 'proj-1',
      repo: 'acme/shop',
      workflowId: 9,
      workflowName: 'CI',
      branch: 'main',
    });
  });

  it.each([
    ['no input', undefined],
    ['a repo that is not owner/name', { ...valid, repo: 'acme' }],
    ['a branch that starts with a dash', { ...valid, branch: '--upload-pack=x' }],
    ['a branch with spaces', { ...valid, branch: 'my branch' }],
    ['a workflow id that is not a whole number', { ...valid, workflowId: '9' }],
    ['a run id below 1', { ...valid, runId: 0 }],
    ['run arguments that are not strings', { ...valid, runArgs: [1] }],
    ['an empty project id', { ...valid, projectId: '' }],
  ])('refuses %s', async (_name, input) => {
    await expect(invoke(IPC.ciAutoFix.start, input)).resolves.toEqual({
      ok: false,
      error: 'That auto-fix request was not valid.',
    });
    expect(service.enable).not.toHaveBeenCalled();
  });
});

describe('session actions', () => {
  it.each([
    [IPC.ciAutoFix.stop, 'stop'],
    [IPC.ciAutoFix.commitNow, 'commitNow'],
    [IPC.ciAutoFix.retry, 'retry'],
  ] as const)('%s passes the id on', async (channel, method) => {
    service[method].mockResolvedValue({ id: 'fix-1' });
    await expect(invoke(channel, 'fix-1')).resolves.toEqual({ id: 'fix-1' });
    expect(service[method]).toHaveBeenCalledWith('fix-1');
    await expect(invoke(channel, 42)).resolves.toBeNull();
  });

  it('ciAutoFix:dismiss clears a finished session', async () => {
    service.dismiss.mockResolvedValue(true);
    await expect(invoke(IPC.ciAutoFix.dismiss, 'fix-1')).resolves.toBe(true);
    await expect(invoke(IPC.ciAutoFix.dismiss, null)).resolves.toBe(false);
    expect(service.dismiss).toHaveBeenCalledTimes(1);
  });
});
