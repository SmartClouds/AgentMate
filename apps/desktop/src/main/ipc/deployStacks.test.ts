import type { IpcMainInvokeEvent } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { IPC } from '../../shared/ipcChannels';
import type { DeployStacks } from '../deploy/stacks/service';
import { registerDeployStacksHandlers } from './deployStacks';

/**
 * The Apps' channels answer only the main window and check every argument before the main
 * process reads a project or the core hears of anything.
 */

type Listener = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

const SERVER = 'srv-1';
const STACK = '0f8fad5b-d9cb-469f-a165-70867728950e';
const SOURCE = { projectId: 'p1', composePath: 'compose.yaml', environmentId: 'env_1' };

function harness(trusted = true) {
  const handlers = new Map<string, Listener>();
  const stacks = Object.fromEntries(
    [
      'discover',
      'preview',
      'list',
      'get',
      'files',
      'create',
      'upload',
      'acknowledge',
      'deploy',
      'rollback',
      'action',
      'delete',
      'makePrivate',
    ].map((name) => [name, vi.fn(async () => ({ ok: name }))]),
  ) as unknown as Record<string, ReturnType<typeof vi.fn>>;
  registerDeployStacksHandlers({
    ipc: { handle: (channel, listener) => handlers.set(channel, listener) },
    stacks: stacks as unknown as DeployStacks,
    guard: () => trusted,
  });
  const call = (channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`No handler for ${channel}`);
    return handler({} as IpcMainInvokeEvent, ...args);
  };
  return { handlers, stacks, call };
}

describe('registerDeployStacksHandlers', () => {
  it('handles every invoke channel of the group', () => {
    const { handlers } = harness();
    expect([...handlers.keys()].sort()).toEqual(
      Object.entries(IPC.deployStacks)
        .filter(([name]) => !name.startsWith('on'))
        .map(([, channel]) => channel)
        .sort(),
    );
  });

  it('answers only the main window', async () => {
    const { call, stacks } = harness(false);
    await expect(call(IPC.deployStacks.list, SERVER)).rejects.toThrow(
      'Deploy is only available in the main window.',
    );
    expect(stacks.list).not.toHaveBeenCalled();
  });

  it('passes checked arguments through', async () => {
    const { call, stacks } = harness();
    await call(IPC.deployStacks.discover, 'p1');
    await call(IPC.deployStacks.preview, {
      ...SOURCE,
      proxiedServices: ['web'],
      selinuxEnforcing: true,
    });
    await call(IPC.deployStacks.preview, { ...SOURCE, environmentId: null });
    await call(IPC.deployStacks.list, SERVER);
    await call(IPC.deployStacks.get, { serverId: SERVER, stackId: STACK });
    await call(IPC.deployStacks.files, { serverId: SERVER, stackId: STACK, revision: 2 });
    await call(IPC.deployStacks.create, {
      ...SOURCE,
      serverId: SERVER,
      name: 'shop',
      proxiedServices: ['web'],
      acknowledgedRisks: ['privileged:web'],
    });
    await call(IPC.deployStacks.upload, {
      ...SOURCE,
      serverId: SERVER,
      stackId: STACK,
      proxiedServices: [],
      acknowledgedRisks: [],
    });
    await call(IPC.deployStacks.acknowledge, {
      serverId: SERVER,
      stackId: STACK,
      revision: 1,
      riskIds: ['a'],
    });
    await call(IPC.deployStacks.deploy, { serverId: SERVER, stackId: STACK, revision: 1 });
    await call(IPC.deployStacks.rollback, { serverId: SERVER, stackId: STACK, revision: 1 });
    await call(IPC.deployStacks.action, { serverId: SERVER, stackId: STACK, action: 'down' });
    await call(IPC.deployStacks.delete, { serverId: SERVER, stackId: STACK, removeVolumes: true });

    expect(stacks.discover).toHaveBeenCalledWith('p1');
    expect(stacks.preview).toHaveBeenNthCalledWith(1, {
      ...SOURCE,
      proxiedServices: ['web'],
      selinuxEnforcing: true,
    });
    expect(stacks.preview).toHaveBeenNthCalledWith(2, { ...SOURCE, environmentId: null });
    expect(stacks.get).toHaveBeenCalledWith(SERVER, STACK);
    expect(stacks.files).toHaveBeenCalledWith(SERVER, STACK, 2);
    expect(stacks.create).toHaveBeenCalledWith({
      ...SOURCE,
      serverId: SERVER,
      name: 'shop',
      proxiedServices: ['web'],
      acknowledgedRisks: ['privileged:web'],
    });
    expect(stacks.upload).toHaveBeenCalledWith(expect.objectContaining({ stackId: STACK }));
    expect(stacks.acknowledge).toHaveBeenCalledWith(SERVER, STACK, 1, ['a']);
    expect(stacks.deploy).toHaveBeenCalledWith(SERVER, STACK, 1);
    expect(stacks.rollback).toHaveBeenCalledWith(SERVER, STACK, 1);
    expect(stacks.action).toHaveBeenCalledWith(SERVER, STACK, 'down');
    expect(stacks.delete).toHaveBeenCalledWith(SERVER, STACK, true);
  });

  it('passes the picked env files through, once each, and only with an environment', async () => {
    const { call, stacks } = harness();
    await call(IPC.deployStacks.preview, { ...SOURCE, envFileIds: ['f2', 'f1', 'f2'] });
    await call(IPC.deployStacks.preview, { ...SOURCE, envFileIds: null });
    await call(IPC.deployStacks.preview, { ...SOURCE, environmentId: null, envFileIds: ['f1'] });
    await call(IPC.deployStacks.create, {
      ...SOURCE,
      envFileIds: ['f1'],
      serverId: SERVER,
      name: 'shop',
      proxiedServices: [],
      acknowledgedRisks: [],
    });
    await call(IPC.deployStacks.upload, {
      ...SOURCE,
      envFileIds: ['f2'],
      serverId: SERVER,
      stackId: STACK,
      proxiedServices: [],
      acknowledgedRisks: [],
    });
    expect(stacks.preview).toHaveBeenNthCalledWith(1, { ...SOURCE, envFileIds: ['f2', 'f1'] });
    expect(stacks.preview).toHaveBeenNthCalledWith(2, SOURCE);
    expect(stacks.preview).toHaveBeenNthCalledWith(3, { ...SOURCE, environmentId: null });
    expect(stacks.create).toHaveBeenCalledWith(expect.objectContaining({ envFileIds: ['f1'] }));
    expect(stacks.upload).toHaveBeenCalledWith(expect.objectContaining({ envFileIds: ['f2'] }));
  });

  it('refuses env files that are not a list of ids', async () => {
    const { call, stacks } = harness();
    const tooMany = Array.from({ length: 101 }, (_, i) => `f${i}`);
    for (const envFileIds of ['f1', [''], ['a b'], [42], tooMany]) {
      await expect(call(IPC.deployStacks.preview, { ...SOURCE, envFileIds })).rejects.toThrow(
        /env files/,
      );
    }
    expect(stacks.preview).not.toHaveBeenCalled();
  });

  it('makes the named services of an app private', async () => {
    const { call, stacks } = harness();
    await call(IPC.deployStacks.makePrivate, {
      serverId: SERVER,
      stackId: STACK,
      services: ['web'],
      extra: 'dropped',
    });
    expect(stacks.makePrivate).toHaveBeenCalledWith({
      serverId: SERVER,
      stackId: STACK,
      services: ['web'],
    });
  });

  it('refuses arguments the core would refuse anyway', async () => {
    const { call, stacks } = harness();
    const refused: Array<[string, unknown, string]> = [
      [IPC.deployStacks.discover, '../p1', 'That is not a project.'],
      [IPC.deployStacks.preview, { ...SOURCE, composePath: '' }, 'Pick a compose file.'],
      [
        IPC.deployStacks.preview,
        { ...SOURCE, environmentId: 'a b' },
        'That is not an environment.',
      ],
      [
        IPC.deployStacks.preview,
        { ...SOURCE, proxiedServices: ['bad name'] },
        'One of the services is not valid.',
      ],
      [IPC.deployStacks.get, { serverId: SERVER, stackId: 'nope' }, 'That is not an app.'],
      [
        IPC.deployStacks.files,
        { serverId: SERVER, stackId: STACK, revision: 0 },
        'A revision is a whole number from 1.',
      ],
      [
        IPC.deployStacks.create,
        { ...SOURCE, serverId: SERVER, name: '', proxiedServices: [], acknowledgedRisks: [] },
        'Give the app a name of at most 63 characters.',
      ],
      [
        IPC.deployStacks.create,
        { ...SOURCE, serverId: SERVER, name: 'shop', proxiedServices: [], acknowledgedRisks: 'x' },
        'Send risk ids as a list of at most 500.',
      ],
      [
        IPC.deployStacks.acknowledge,
        { serverId: SERVER, stackId: STACK, revision: 1, riskIds: [''] },
        'One of the risk ids is not valid.',
      ],
      [
        IPC.deployStacks.action,
        { serverId: SERVER, stackId: STACK, action: 'kill' },
        'An app can be started',
      ],
      [
        IPC.deployStacks.delete,
        { serverId: SERVER, stackId: STACK },
        "Say whether the app's volumes go too.",
      ],
      [IPC.deployStacks.list, 42, 'That is not a saved server.'],
      [
        IPC.deployStacks.makePrivate,
        { serverId: SERVER, stackId: STACK, services: [] },
        'Name a service to make private.',
      ],
      [
        IPC.deployStacks.makePrivate,
        { serverId: SERVER, stackId: STACK, services: ['web; rm'] },
        'One of the services is not valid.',
      ],
    ];
    for (const [channel, value, message] of refused) {
      await expect(call(channel, value), channel).rejects.toThrow(message);
    }
    for (const method of Object.values(stacks)) expect(method).not.toHaveBeenCalled();
  });
});
