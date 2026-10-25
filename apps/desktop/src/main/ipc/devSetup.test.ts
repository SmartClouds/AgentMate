import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../shared/ipcChannels';
import {
  expectChannelsCovered,
  invoke,
  loadIpc,
  useTempUserData,
} from '../../test/main/ipcHarness';

/**
 * The Dev Setup checklist asks main what is installed. Item ids are the only thing the renderer
 * sends, and they are checked against the catalog here, because everything downstream (which
 * command runs, which file is read) is chosen from the catalog entry that id names.
 */

const service = vi.hoisted(() => ({
  environment: vi.fn(),
  detect: vi.fn(),
  peek: vi.fn(),
  updates: vi.fn(),
  install: vi.fn(),
  cancel: vi.fn(),
  addToPath: vi.fn(),
  jobState: vi.fn(),
}));

// The real runtime probes the machine and reads the settings store.
vi.mock('../devSetup/runtime', () => ({
  getDevSetupService: () => service,
}));

useTempUserData();

// onEvent is main talking to the renderer, so there is no handler to call.
expectChannelsCovered(IPC.devSetup, [IPC.devSetup.onEvent]);

beforeEach(async () => {
  service.environment.mockReset();
  service.detect.mockReset();
  service.peek.mockReset();
  service.updates.mockReset();
  service.install.mockReset();
  service.cancel.mockReset();
  service.addToPath.mockReset();
  service.jobState.mockReset();
  await loadIpc(
    () => import('./devSetup'),
    (module) => module.registerDevSetupHandlers(),
  );
});

describe('devSetup:environment', () => {
  it('returns the OS and the package managers found', async () => {
    const environment = { os: 'win32', arch: 'x64', packageManagers: ['winget'] };
    service.environment.mockResolvedValue(environment);

    await expect(invoke(IPC.devSetup.environment)).resolves.toEqual(environment);
    expect(service.environment).toHaveBeenCalledWith({ force: false });
  });

  it('looks again only when told to', async () => {
    service.environment.mockResolvedValue({});

    await invoke(IPC.devSetup.environment, { force: true });
    await invoke(IPC.devSetup.environment, { force: 'yes' });

    expect(service.environment).toHaveBeenNthCalledWith(1, { force: true });
    expect(service.environment).toHaveBeenNthCalledWith(2, { force: false });
  });
});

describe('devSetup:detect', () => {
  it('checks the item named', async () => {
    service.detect.mockResolvedValue({ state: 'absent' });

    await expect(invoke(IPC.devSetup.detect, 'node')).resolves.toEqual({ state: 'absent' });
    expect(service.detect).toHaveBeenCalledWith('node', { force: false });
  });

  it('forces a fresh check only when told to', async () => {
    service.detect.mockResolvedValue({ state: 'absent' });

    await invoke(IPC.devSetup.detect, 'node', { force: true });
    await invoke(IPC.devSetup.detect, 'node', { force: 1 });

    expect(service.detect).toHaveBeenNthCalledWith(1, 'node', { force: true });
    expect(service.detect).toHaveBeenNthCalledWith(2, 'node', { force: false });
  });

  it.each([
    ['an id that is not in the catalog', 'rm -rf /'],
    ['an inherited object key', 'constructor'],
    ['an empty string', ''],
    ['a number', 42],
    ['nothing', undefined],
    ['an object', { id: 'node' }],
  ])('refuses %s', async (_label, id) => {
    await expect(invoke(IPC.devSetup.detect, id)).rejects.toThrow('Unknown dev setup item.');
    expect(service.detect).not.toHaveBeenCalled();
  });
});

describe('devSetup:peek', () => {
  it('returns what is remembered for the items asked about', async () => {
    service.peek.mockReturnValue({ node: { state: 'absent' }, git: undefined });

    await expect(invoke(IPC.devSetup.peek, ['node', 'git'])).resolves.toEqual({
      node: { state: 'absent' },
      git: undefined,
    });
    expect(service.peek).toHaveBeenCalledWith(['node', 'git']);
  });

  it('lists each item once', async () => {
    service.peek.mockReturnValue({});

    await invoke(IPC.devSetup.peek, ['node', 'node', 'git']);

    expect(service.peek).toHaveBeenCalledWith(['node', 'git']);
  });

  it.each([
    ['not a list', 'node'],
    ['an object', { 0: 'node' }],
    ['a list with an unknown id', ['node', 'nope']],
    ['a list with a non-string', ['node', 7]],
    ['a list with null', [null]],
    ['more ids than the catalog could have', Array.from({ length: 61 }, () => 'node')],
  ])('refuses %s', async (_label, ids) => {
    // The oversize case repeats a valid id on purpose: the size check has to come before the
    // de-duplication, or it would pass as a single id.
    await expect(invoke(IPC.devSetup.peek, ids)).rejects.toThrow('Invalid dev setup items.');
    expect(service.peek).not.toHaveBeenCalled();
  });

  it('accepts an empty list', async () => {
    service.peek.mockReturnValue({});

    await expect(invoke(IPC.devSetup.peek, [])).resolves.toEqual({});
  });
});

describe('devSetup:updates', () => {
  it('asks about the items named and hands back what the check found', async () => {
    const found = { node: { state: 'update', latest: '24.22.1', installed: '24.20.0' } };
    service.updates.mockResolvedValue(found);

    await expect(invoke(IPC.devSetup.updates, ['node', 'node', 'gh'])).resolves.toEqual(found);
    expect(service.updates).toHaveBeenCalledWith(['node', 'gh'], { force: false });
  });

  it('asks again only when told to, and only with exactly true', async () => {
    service.updates.mockResolvedValue({});

    await invoke(IPC.devSetup.updates, ['node'], { force: true });
    await invoke(IPC.devSetup.updates, ['node'], { force: 'yes' });

    expect(service.updates).toHaveBeenNthCalledWith(1, ['node'], { force: true });
    expect(service.updates).toHaveBeenNthCalledWith(2, ['node'], { force: false });
  });

  it.each([
    ['not a list', 'node'],
    ['a list with an unknown id', ['node', 'nope']],
    ['more ids than the catalog could have', Array.from({ length: 61 }, () => 'node')],
  ])('refuses %s', async (_label, ids) => {
    await expect(invoke(IPC.devSetup.updates, ids)).rejects.toThrow('Invalid dev setup items.');
    expect(service.updates).not.toHaveBeenCalled();
  });
});

describe('devSetup:install', () => {
  it('passes on an update, and treats any other intent as an install', async () => {
    service.install.mockResolvedValue({});

    await invoke(IPC.devSetup.install, { ids: ['gh'], intent: 'update' });
    await invoke(IPC.devSetup.install, { ids: ['gh'], intent: 'rm -rf /' });
    await invoke(IPC.devSetup.install, { ids: ['gh'], intent: 'install' });

    expect(service.install).toHaveBeenNthCalledWith(1, {
      ids: ['gh'],
      consented: false,
      intent: 'update',
    });
    expect(service.install).toHaveBeenNthCalledWith(2, { ids: ['gh'], consented: false });
    expect(service.install).toHaveBeenNthCalledWith(3, { ids: ['gh'], consented: false });
  });

  it('starts the installs for the items named and hands back the state', async () => {
    service.install.mockResolvedValue({ running: true });

    await expect(invoke(IPC.devSetup.install, { ids: ['git', 'node'] })).resolves.toEqual({
      running: true,
    });
    expect(service.install).toHaveBeenCalledWith({ ids: ['git', 'node'], consented: false });
  });

  it('passes on that the person accepted the agreements only when it is exactly true', async () => {
    service.install.mockResolvedValue({});

    await invoke(IPC.devSetup.install, { ids: ['android-licenses'], consented: true });
    await invoke(IPC.devSetup.install, { ids: ['android-licenses'], consented: 'yes' });
    await invoke(IPC.devSetup.install, { ids: ['android-licenses'], consented: 1 });

    expect(service.install).toHaveBeenNthCalledWith(1, {
      ids: ['android-licenses'],
      consented: true,
    });
    expect(service.install).toHaveBeenNthCalledWith(2, {
      ids: ['android-licenses'],
      consented: false,
    });
    expect(service.install).toHaveBeenNthCalledWith(3, {
      ids: ['android-licenses'],
      consented: false,
    });
  });

  it('lists each item once and drops anything else the caller attached', async () => {
    service.install.mockResolvedValue({});

    await invoke(IPC.devSetup.install, {
      ids: ['git', 'git', 'node'],
      command: 'rm -rf /',
      extra: 1,
    });

    expect(service.install).toHaveBeenCalledWith({ ids: ['git', 'node'], consented: false });
  });

  it.each([
    ['nothing', undefined],
    ['a list instead of a request', ['git']],
    ['a request without ids', {}],
    ['ids that are not a list', { ids: 'git' }],
    ['an id that is not in the catalog', { ids: ['git', 'definitely-not-real'] }],
    ['a command in place of an id', { ids: ['winget install evil'] }],
    ['a non-string id', { ids: ['git', 7] }],
    ['more ids than the catalog could have', { ids: Array.from({ length: 61 }, () => 'git') }],
  ])('refuses %s', async (_label, request) => {
    await expect(invoke(IPC.devSetup.install, request)).rejects.toThrow('Invalid dev setup items.');
    expect(service.install).not.toHaveBeenCalled();
  });

  it('lets an agreement that was not accepted come through as the error it is', async () => {
    service.install.mockRejectedValue(new Error('consent-required'));

    await expect(invoke(IPC.devSetup.install, { ids: ['android-licenses'] })).rejects.toThrow(
      'consent-required',
    );
  });
});

describe('devSetup:cancel', () => {
  it('stops everything when no item is named', async () => {
    await invoke(IPC.devSetup.cancel);

    expect(service.cancel).toHaveBeenCalledWith(undefined);
  });

  it('takes one item out of the queue when it is named', async () => {
    await invoke(IPC.devSetup.cancel, 'node');

    expect(service.cancel).toHaveBeenCalledWith('node');
  });

  it.each([
    ['an id that is not in the catalog', 'nope'],
    ['a number', 3],
    ['an object', { id: 'node' }],
  ])('refuses %s', async (_label, id) => {
    await expect(invoke(IPC.devSetup.cancel, id)).rejects.toThrow('Unknown dev setup item.');
    expect(service.cancel).not.toHaveBeenCalled();
  });
});

describe('devSetup:addToPath', () => {
  it('puts the item named on the PATH and hands back what happened', async () => {
    service.addToPath.mockResolvedValue({ changed: true, where: 'your user PATH' });

    await expect(invoke(IPC.devSetup.addToPath, 'flutter')).resolves.toEqual({
      changed: true,
      where: 'your user PATH',
    });
    expect(service.addToPath).toHaveBeenCalledWith('flutter');
  });

  it('lets a refusal from the service come through as the error it is', async () => {
    service.addToPath.mockRejectedValue(new Error('That folder cannot go on the PATH.'));

    await expect(invoke(IPC.devSetup.addToPath, 'flutter')).rejects.toThrow(
      'That folder cannot go on the PATH.',
    );
  });

  it.each([
    ['an id that is not in the catalog', 'C:\\Windows\\System32'],
    ['an inherited object key', 'constructor'],
    ['an empty string', ''],
    ['a number', 42],
    ['an object', { id: 'flutter' }],
    ['a list', ['flutter']],
    ['nothing', undefined],
  ])('refuses %s', async (_label, id) => {
    await expect(invoke(IPC.devSetup.addToPath, id)).rejects.toThrow('Unknown dev setup item.');
    expect(service.addToPath).not.toHaveBeenCalled();
  });
});

describe('devSetup:jobState', () => {
  it('returns the state of the run, for a window that opened part way through', async () => {
    service.jobState.mockReturnValue({ running: true, order: ['git'] });

    await expect(invoke(IPC.devSetup.jobState)).resolves.toEqual({ running: true, order: ['git'] });
  });
});
