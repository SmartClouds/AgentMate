import type { IpcMainInvokeEvent } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { IPC } from '../../shared/ipcChannels';
import { wordPressError, wordPressErrorCode } from '../../shared/wordpressErrors';
import { type DeployWordPressApi, registerDeployWordPressHandlers } from './deployWordPress';

/**
 * The WordPress channels answer only the main window, check every argument before the service
 * hears of it, and never hand a connection key or an HTTP password back in an error, even when
 * the service itself would have.
 */

type Listener = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

const SITE = '6f1c2a9e-3b7d-4c51-9e0a-2d8f4b6c1a03';
const PROJECT = '0b8e5d2c-7a14-4f3e-b6c9-91d2e3f4a5b6';
const OPERATION = 'op-12345678';
const KEY = `amwp1.${'eyJ2IjoxLCJ1IjoiaHR0cHM6Ly9leGFtcGxlLnRlc3QiLCJyIjoiaHR0cHM6'.repeat(3)}`;
const PASSWORD = 'staging-secret-pass';
const THEME = { kind: 'theme', slug: 'twentytwentyfive' };
const FOLDER = process.platform === 'win32' ? 'C:\\Sites\\shop' : '/home/me/sites/shop';

function harness(trusted = true) {
  const handlers = new Map<string, Listener>();
  const fn = () => vi.fn(async (..._args: unknown[]): Promise<unknown> => ({}));
  const service = {
    listSites: fn(),
    connect: fn(),
    disconnect: fn(),
    updateSettings: fn(),
    siteInfo: fn(),
    listItems: fn(),
    history: fn(),
    rollback: fn(),
    audit: fn(),
    planPull: fn(),
    pull: fn(),
    planDeploy: fn(),
    deploy: fn(),
    cancel: fn(),
    createProject: fn(),
    setProjectItems: fn(),
    setProjectIgnore: fn(),
    localItems: fn(),
    linkProject: fn(),
    unlinkProject: fn(),
    localChanges: fn(),
    remoteFile: fn(),
    saveConnectorZip: fn(),
    updateConnector: fn(),
  };
  registerDeployWordPressHandlers({
    ipc: { handle: (channel, listener) => handlers.set(channel, listener) },
    service: service as unknown as DeployWordPressApi,
    guard: () => trusted,
  });
  const call = async (channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`No handler for ${channel}`);
    return handler({} as IpcMainInvokeEvent, ...args);
  };
  return { handlers, service, call };
}

async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('Expected the call to fail.');
}

describe('registerDeployWordPressHandlers', () => {
  it('handles every invoke channel of the group, and no push channel', () => {
    const { handlers } = harness();
    const invokes = Object.entries(IPC.deployWordPress)
      .filter(([name]) => !name.startsWith('on'))
      .map(([, channel]) => channel);

    expect([...handlers.keys()].sort()).toEqual(invokes.sort());
    expect(handlers.has(IPC.deployWordPress.onProgress)).toBe(false);
  });

  it('answers only the main window', async () => {
    const { handlers, service } = harness(false);
    for (const [channel, handler] of handlers) {
      await expect(
        Promise.resolve(handler({} as IpcMainInvokeEvent, { connectionKey: KEY })),
        channel,
      ).rejects.toThrow('only available in the main window');
    }
    for (const method of Object.values(service)) expect(method).not.toHaveBeenCalled();
  });

  it('passes checked arguments through to the service', async () => {
    const { service, call } = harness();
    await call(IPC.deployWordPress.listSites);
    await call(IPC.deployWordPress.siteInfo, SITE);
    await call(IPC.deployWordPress.listItems, SITE);
    await call(IPC.deployWordPress.history, SITE);
    await call(IPC.deployWordPress.cancel, OPERATION);
    await call(IPC.deployWordPress.unlinkProject, PROJECT);
    await call(IPC.deployWordPress.localChanges, PROJECT);
    await call(IPC.deployWordPress.saveConnectorZip);
    await call(IPC.deployWordPress.updateConnector, SITE);

    expect(service.siteInfo).toHaveBeenCalledWith(SITE);
    expect(service.listItems).toHaveBeenCalledWith(SITE);
    expect(service.history).toHaveBeenCalledWith(SITE);
    expect(service.cancel).toHaveBeenCalledWith(OPERATION);
    expect(service.unlinkProject).toHaveBeenCalledWith(PROJECT);
    expect(service.localChanges).toHaveBeenCalledWith(PROJECT);
    expect(service.listSites).toHaveBeenCalledTimes(1);
    expect(service.saveConnectorZip).toHaveBeenCalledTimes(1);
    expect(service.updateConnector).toHaveBeenCalledWith(SITE);
  });

  it('reads a connect call, dropping the line breaks a pasted key picks up', async () => {
    const { service, call } = harness();
    const wrapped = `  ${KEY.slice(0, 40)}\n${KEY.slice(40)}  `;
    await call(IPC.deployWordPress.connect, {
      connectionKey: wrapped,
      label: '  Shop  ',
      allowPlainHttp: true,
      httpAuth: { username: 'stage', password: PASSWORD },
    });
    expect(service.connect).toHaveBeenCalledWith({
      connectionKey: KEY,
      label: 'Shop',
      allowPlainHttp: true,
      httpAuth: { username: 'stage', password: PASSWORD },
    });

    await call(IPC.deployWordPress.connect, { connectionKey: KEY, label: '', httpAuth: null });
    expect(service.connect).toHaveBeenLastCalledWith({ connectionKey: KEY });
  });

  it('refuses a key that is not one, without repeating it', async () => {
    const { service, call } = harness();
    const bad = [
      undefined,
      42,
      'amwp1.short',
      `amwp2.${'A'.repeat(40)}`,
      `xyz.${'A'.repeat(40)}`,
      `amwp1.${'A'.repeat(4100)}`,
      'x'.repeat(20_000),
    ];
    for (const connectionKey of bad) {
      const message = await rejection(call(IPC.deployWordPress.connect, { connectionKey }));
      expect(wordPressErrorCode(new Error(message))).toBe('keyInvalid');
      if (typeof connectionKey === 'string' && connectionKey.length > 10) {
        expect(message).not.toContain(connectionKey.slice(6, 30));
      }
    }
    expect(service.connect).not.toHaveBeenCalled();
  });

  it('checks the rest of a connect call', async () => {
    const { service, call } = harness();
    const cases: unknown[] = [
      null,
      { connectionKey: KEY, label: 'a\nb' },
      { connectionKey: KEY, label: 'x'.repeat(101) },
      { connectionKey: KEY, allowPlainHttp: 'yes' },
      { connectionKey: KEY, httpAuth: { username: 'a:b', password: 'p' } },
      { connectionKey: KEY, httpAuth: { username: '', password: 'p' } },
      { connectionKey: KEY, httpAuth: { username: 'u', password: '' } },
      { connectionKey: KEY, httpAuth: { username: 'u', password: 'a\nb' } },
      { connectionKey: KEY, httpAuth: 'u:p' },
    ];
    for (const input of cases) {
      await expect(call(IPC.deployWordPress.connect, input)).rejects.toThrow();
    }
    expect(service.connect).not.toHaveBeenCalled();
  });

  it('never lets a secret back out in an error from the service', async () => {
    const { service, call } = harness();
    service.connect.mockRejectedValueOnce(new Error(`Could not read ${KEY}`));
    const keyMessage = await rejection(
      call(IPC.deployWordPress.connect, { connectionKey: KEY, label: 'Shop' }),
    );
    expect(keyMessage).not.toContain(KEY);
    expect(keyMessage).not.toContain(KEY.slice(6, 38));
    expect(wordPressErrorCode(new Error(keyMessage))).toBe('internal');

    service.connect.mockRejectedValueOnce(new Error(`bad body ${KEY.slice(6, 60)}`));
    const partMessage = await rejection(call(IPC.deployWordPress.connect, { connectionKey: KEY }));
    expect(partMessage).not.toContain(KEY.slice(6, 38));

    service.updateSettings.mockRejectedValueOnce(new Error(`login failed for ${PASSWORD}`));
    const passwordMessage = await rejection(
      call(IPC.deployWordPress.updateSettings, {
        siteId: SITE,
        httpAuth: { username: 'stage', password: PASSWORD },
      }),
    );
    expect(passwordMessage).not.toContain(PASSWORD);

    // An ordinary failure passes through untouched.
    service.connect.mockRejectedValueOnce(wordPressError('pairingExpired', 'Make a new key.'));
    const plain = await rejection(call(IPC.deployWordPress.connect, { connectionKey: KEY }));
    expect(plain).toBe('[wp:pairingExpired] Make a new key.');
  });

  it('reads disconnects, settings and audit queries', async () => {
    const { service, call } = harness();
    await call(IPC.deployWordPress.disconnect, { siteId: SITE, revokeOnSite: true });
    expect(service.disconnect).toHaveBeenCalledWith({ siteId: SITE, revokeOnSite: true });
    await expect(call(IPC.deployWordPress.disconnect, { siteId: SITE })).rejects.toThrow(
      'Say whether',
    );

    await call(IPC.deployWordPress.updateSettings, { siteId: SITE, httpAuth: null, label: 'A' });
    expect(service.updateSettings).toHaveBeenLastCalledWith({
      siteId: SITE,
      label: 'A',
      httpAuth: null,
    });
    await call(IPC.deployWordPress.updateSettings, { siteId: SITE, allowPlainHttp: false });
    expect(service.updateSettings).toHaveBeenLastCalledWith({
      siteId: SITE,
      allowPlainHttp: false,
    });

    await call(IPC.deployWordPress.audit, { siteId: SITE, limit: 50, before: 9 });
    expect(service.audit).toHaveBeenCalledWith({ siteId: SITE, limit: 50, before: 9 });
    await call(IPC.deployWordPress.audit, { siteId: SITE, limit: 1 });
    for (const query of [
      { siteId: SITE, limit: 0 },
      { siteId: SITE, limit: 501 },
      { siteId: SITE, limit: 1.5 },
      { siteId: SITE, limit: 10, before: 0 },
      { siteId: 'not a site', limit: 10 },
    ]) {
      await expect(call(IPC.deployWordPress.audit, query)).rejects.toThrow();
    }
  });

  it('refuses ids that are not ids', async () => {
    const { call } = harness();
    for (const id of [undefined, '', '../etc', 'a b', '-starts-with-dash', 'x'.repeat(65)]) {
      await expect(call(IPC.deployWordPress.siteInfo, id)).rejects.toThrow(
        'not a connected WordPress site',
      );
      await expect(call(IPC.deployWordPress.updateConnector, id)).rejects.toThrow(
        'not a connected WordPress site',
      );
    }
    await expect(call(IPC.deployWordPress.localChanges, 'a/b')).rejects.toThrow('not a project');
    await expect(call(IPC.deployWordPress.cancel, 'short')).rejects.toThrow('operation id');
  });

  it('reads rollbacks', async () => {
    const { service, call } = harness();
    const input = { operationId: OPERATION, siteId: SITE, deployId: 'd-1', force: true };
    await call(IPC.deployWordPress.rollback, input);
    expect(service.rollback).toHaveBeenCalledWith(input);
    await call(IPC.deployWordPress.rollback, { ...input, force: undefined });
    expect(service.rollback).toHaveBeenLastCalledWith({
      operationId: OPERATION,
      siteId: SITE,
      deployId: 'd-1',
    });
    await expect(
      call(IPC.deployWordPress.rollback, { ...input, deployId: '../x' }),
    ).rejects.toThrow('not a deploy');
    await expect(call(IPC.deployWordPress.rollback, { ...input, force: 1 })).rejects.toThrow();
  });

  it('reads plans and runs', async () => {
    const { service, call } = harness();
    await call(IPC.deployWordPress.planDeploy, { projectId: PROJECT });
    expect(service.planDeploy).toHaveBeenCalledWith({ projectId: PROJECT });
    await call(IPC.deployWordPress.planPull, { projectId: PROJECT, items: [THEME, THEME] });
    expect(service.planPull).toHaveBeenCalledWith({ projectId: PROJECT, items: [THEME] });

    const run = { planId: 'plan-1', operationId: OPERATION, force: false };
    await call(IPC.deployWordPress.deploy, run);
    expect(service.deploy).toHaveBeenCalledWith(run);
    const resolutions = { 'theme:t/style.css': 'keepLocal', 'theme:t/a.php': 'takeRemote' };
    await call(IPC.deployWordPress.pull, { ...run, resolutions });
    expect(service.pull).toHaveBeenCalledWith({ ...run, resolutions });

    for (const bad of [
      { operationId: OPERATION, force: false },
      { planId: 'plan-1', operationId: OPERATION },
      { ...run, resolutions: { a: 'merge' } },
      { ...run, resolutions: { '': 'keepLocal' } },
      { ...run, resolutions: 'all' },
    ]) {
      await expect(call(IPC.deployWordPress.pull, bad)).rejects.toThrow();
    }
    for (const items of [
      [],
      [{ kind: 'widget', slug: 'x' }],
      [{ kind: 'theme', slug: '../x' }],
      [{ kind: 'plugin', slug: '.claude' }],
      [{ kind: 'theme', slug: 'CON' }],
      Array.from({ length: 201 }, (_, index) => ({ kind: 'plugin', slug: `p${index}` })),
      'theme:x',
      [null],
    ]) {
      await expect(
        call(IPC.deployWordPress.planDeploy, { projectId: PROJECT, items }),
      ).rejects.toThrow();
    }
    expect(service.planDeploy).toHaveBeenCalledTimes(1);
  });

  it('reads new projects and item changes', async () => {
    const { service, call } = harness();
    const input = {
      operationId: OPERATION,
      siteId: SITE,
      items: [THEME],
      folderPath: FOLDER,
      name: ' Shop ',
      agentType: 'claude-code',
      description: 'The shop',
      tags: ['wp'],
    };
    await call(IPC.deployWordPress.createProject, input);
    expect(service.createProject).toHaveBeenCalledWith({ ...input, name: 'Shop' });

    for (const bad of [
      { ...input, folderPath: 'relative/path' },
      { ...input, folderPath: `${FOLDER}\0x` },
      { ...input, agentType: 'robot' },
      { ...input, name: '' },
      { ...input, description: 5 },
      { ...input, tags: ['ok', 'a\nb'] },
      { ...input, tags: 'wp' },
      { ...input, items: [] },
    ]) {
      await expect(call(IPC.deployWordPress.createProject, bad)).rejects.toThrow();
    }

    await call(IPC.deployWordPress.setProjectItems, {
      operationId: OPERATION,
      projectId: PROJECT,
      items: [THEME, { kind: 'mu-plugin', slug: 'loader.php' }],
    });
    expect(service.setProjectItems).toHaveBeenCalledWith({
      operationId: OPERATION,
      projectId: PROJECT,
      items: [THEME, { kind: 'mu-plugin', slug: 'loader.php' }],
    });
    await call(IPC.deployWordPress.setProjectItems, {
      operationId: OPERATION,
      projectId: PROJECT,
      siteId: SITE,
      items: [THEME],
    });
    expect(service.setProjectItems).toHaveBeenLastCalledWith({
      operationId: OPERATION,
      projectId: PROJECT,
      siteId: SITE,
      items: [THEME],
    });
    await expect(
      call(IPC.deployWordPress.setProjectItems, {
        operationId: OPERATION,
        projectId: PROJECT,
        siteId: '../x',
        items: [THEME],
      }),
    ).rejects.toThrow('not a connected WordPress site');

    const link = { operationId: OPERATION, projectId: PROJECT, siteId: SITE, items: [THEME] };
    await call(IPC.deployWordPress.linkProject, { ...link, extra: true });
    expect(service.linkProject).toHaveBeenCalledWith(link);
    for (const bad of [
      { ...link, siteId: undefined },
      { ...link, items: [] },
      { ...link, projectId: 42 },
    ]) {
      await expect(call(IPC.deployWordPress.linkProject, bad)).rejects.toThrow();
    }
  });

  it('reads the new items of an item change and a link, and lists a project folder', async () => {
    const { service, call } = harness();
    const fresh = { kind: 'plugin', slug: 'fresh' };
    await call(IPC.deployWordPress.setProjectItems, {
      operationId: OPERATION,
      projectId: PROJECT,
      items: [THEME, fresh],
      newItems: [fresh, fresh],
    });
    expect(service.setProjectItems).toHaveBeenLastCalledWith({
      operationId: OPERATION,
      projectId: PROJECT,
      items: [THEME, fresh],
      newItems: [fresh],
    });
    await call(IPC.deployWordPress.linkProject, {
      operationId: OPERATION,
      projectId: PROJECT,
      siteId: SITE,
      items: [fresh],
      newItems: [fresh],
    });
    expect(service.linkProject).toHaveBeenLastCalledWith({
      operationId: OPERATION,
      projectId: PROJECT,
      siteId: SITE,
      items: [fresh],
      newItems: [fresh],
    });
    for (const newItems of [
      'x',
      [{ kind: 'widget', slug: 'w' }],
      [{ kind: 'plugin', slug: '../x' }],
    ]) {
      await expect(
        call(IPC.deployWordPress.setProjectItems, {
          operationId: OPERATION,
          projectId: PROJECT,
          items: [THEME],
          newItems,
        }),
      ).rejects.toThrow();
    }

    await call(IPC.deployWordPress.localItems, PROJECT);
    expect(service.localItems).toHaveBeenCalledWith(PROJECT);
    await expect(call(IPC.deployWordPress.localItems, '../x')).rejects.toThrow('not a project');
  });

  it('reads the ignore list a project saves, and refuses what is not one', async () => {
    const { service, call } = harness();
    const ignore = { '*': ['*.map'], 'theme:twentytwentyfive': ['/src/', '/docs/'] };
    await call(IPC.deployWordPress.setProjectIgnore, { projectId: PROJECT, ignore, extra: 1 });
    expect(service.setProjectIgnore).toHaveBeenCalledWith({ projectId: PROJECT, ignore });
    await call(IPC.deployWordPress.setProjectIgnore, { projectId: PROJECT, ignore: {} });
    expect(service.setProjectIgnore).toHaveBeenLastCalledWith({ projectId: PROJECT, ignore: {} });

    const many = Object.fromEntries(
      Array.from({ length: 300 }, (_, index) => [`plugin:p${index}`, ['/x/']]),
    );
    for (const bad of [
      { ignore },
      { projectId: 42, ignore },
      { projectId: PROJECT },
      { projectId: PROJECT, ignore: ['/src/'] },
      { projectId: PROJECT, ignore: { '*': '/src/' } },
      { projectId: PROJECT, ignore: { '*': [7] } },
      { projectId: PROJECT, ignore: { '*': ['a\nb'] } },
      { projectId: PROJECT, ignore: { '*': ['x'.repeat(5000)] } },
      {
        projectId: PROJECT,
        ignore: { '*': Array.from({ length: 2000 }, (_, index) => `/f${index}`) },
      },
      { projectId: PROJECT, ignore: many },
    ]) {
      await expect(call(IPC.deployWordPress.setProjectIgnore, bad)).rejects.toThrow();
    }
  });

  it('reads remote file requests and refuses paths the policy refuses', async () => {
    const { service, call } = harness();
    const input = { projectId: PROJECT, item: THEME, path: 'inc/setup.php' };
    await call(IPC.deployWordPress.remoteFile, input);
    expect(service.remoteFile).toHaveBeenCalledWith(input);
    for (const path of ['../wp-config.php', '/etc/passwd', 'C:x', '.claude/settings.json', '']) {
      await expect(call(IPC.deployWordPress.remoteFile, { ...input, path })).rejects.toThrow(
        'not one AgentMate syncs',
      );
    }
  });
});
