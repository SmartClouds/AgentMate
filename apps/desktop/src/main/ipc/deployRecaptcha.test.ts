import type { IpcMainInvokeEvent } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { IPC } from '../../shared/ipcChannels';
import type { RecaptchaService } from '../deploy/recaptcha/service';
import { registerDeployRecaptchaHandlers } from './deployRecaptcha';

/**
 * The reCAPTCHA channels answer only the app's main window, and check every argument before the
 * service (and the Google sign-in) sees it.
 */

type Listener = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

const ACCOUNT = '3f2b9a8e-4c1d-4e5f-9a7b-1c2d3e4f5a6b';
const PROJECT = 'my-project-1';
const KEY = '6LcAbC-dEf_123';
const INVOKE = Object.entries(IPC.deployRecaptcha)
  .filter(([name]) => !name.startsWith('on'))
  .map(([, channel]) => channel);

function harness(trusted = true) {
  const handlers = new Map<string, Listener>();
  const service = {
    status: vi.fn(async () => 'status'),
    signIn: vi.fn(async () => 'account'),
    cancelSignIn: vi.fn(),
    removeAccount: vi.fn(async () => undefined),
    projects: vi.fn(async () => []),
    createProject: vi.fn(async () => 'project'),
    prepareProject: vi.fn(async () => undefined),
    keys: vi.fn(async () => []),
    createKey: vi.fn(async () => 'key'),
    updateKey: vi.fn(async () => 'key'),
    deleteKey: vi.fn(async () => undefined),
    secret: vi.fn(async () => 'secret'),
    usage: vi.fn(async () => 'usage'),
  };
  registerDeployRecaptchaHandlers({
    ipc: { handle: (channel, listener) => handlers.set(channel, listener) },
    service: service as unknown as RecaptchaService,
    guard: () => trusted,
  });
  const call = (channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`No handler for ${channel}`);
    return handler({} as IpcMainInvokeEvent, ...args);
  };
  return { service, call, handlers };
}

const ref = { accountId: ACCOUNT, projectId: PROJECT };
const keyRef = { ...ref, keyId: KEY };

describe('registerDeployRecaptchaHandlers', () => {
  it('handles every invoke channel in the group', () => {
    expect([...harness().handlers.keys()].sort()).toEqual([...INVOKE].sort());
  });

  it('answers only the main window', async () => {
    const { service, call } = harness(false);
    await expect(call(IPC.deployRecaptcha.status)).rejects.toThrow(/main window/);
    await expect(call(IPC.deployRecaptcha.signIn, { mode: 'runova' })).rejects.toThrow(
      /main window/,
    );
    expect(service.status).not.toHaveBeenCalled();
    expect(service.signIn).not.toHaveBeenCalled();
  });

  it('passes checked arguments through to the service', async () => {
    const { service, call } = harness();
    expect(await call(IPC.deployRecaptcha.status)).toBe('status');
    await call(IPC.deployRecaptcha.signIn, { mode: 'runova' });
    await call(IPC.deployRecaptcha.signIn, {
      mode: 'own',
      clientId: ' id.apps ',
      clientSecret: 's',
    });
    await call(IPC.deployRecaptcha.signIn, { mode: 'own', clientId: 'id', clientSecret: '' });
    expect(service.signIn.mock.calls).toEqual([
      [{ mode: 'runova' }],
      [{ mode: 'own', clientId: 'id.apps', clientSecret: 's' }],
      [{ mode: 'own', clientId: 'id' }],
    ]);
    await call(IPC.deployRecaptcha.cancelSignIn);
    await call(IPC.deployRecaptcha.removeAccount, ACCOUNT);
    await call(IPC.deployRecaptcha.listProjects, ACCOUNT);
    await call(IPC.deployRecaptcha.createProject, ACCOUNT);
    await call(IPC.deployRecaptcha.prepareProject, ref);
    await call(IPC.deployRecaptcha.listKeys, ref);
    await call(IPC.deployRecaptcha.createKey, ref, {
      name: '  Shop  ',
      type: 'checkbox',
      domains: ['shop.com', 'www.shop.com'],
      challenge: 'security',
    });
    await call(IPC.deployRecaptcha.updateKey, keyRef, 'score', {
      name: 'Shop',
      domains: ['shop.com'],
    });
    await call(IPC.deployRecaptcha.deleteKey, keyRef);
    expect(await call(IPC.deployRecaptcha.secret, keyRef)).toBe('secret');
    await call(IPC.deployRecaptcha.usage, ref);

    expect(service.cancelSignIn).toHaveBeenCalled();
    expect(service.removeAccount).toHaveBeenCalledWith(ACCOUNT);
    expect(service.prepareProject).toHaveBeenCalledWith(ref);
    expect(service.createKey).toHaveBeenCalledWith(ref, {
      name: 'Shop',
      type: 'checkbox',
      domains: ['shop.com', 'www.shop.com'],
      challenge: 'security',
    });
    expect(service.updateKey).toHaveBeenCalledWith(keyRef, 'score', {
      name: 'Shop',
      domains: ['shop.com'],
    });
    expect(service.deleteKey).toHaveBeenCalledWith(keyRef);
  });

  it('takes a domain-scoped project id', async () => {
    const { service, call } = harness();
    await call(IPC.deployRecaptcha.listKeys, {
      accountId: ACCOUNT,
      projectId: 'example.com:shop-site',
    });
    expect(service.keys).toHaveBeenCalled();
  });

  it.each([
    ['an unknown sign-in mode', IPC.deployRecaptcha.signIn, [{ mode: 'other' }]],
    ['an own client without an id', IPC.deployRecaptcha.signIn, [{ mode: 'own', clientId: ' ' }]],
    ['a client id over two lines', IPC.deployRecaptcha.signIn, [{ mode: 'own', clientId: 'a\nb' }]],
    ['a bad account id', IPC.deployRecaptcha.listProjects, ['../x']],
    [
      'a bad project id',
      IPC.deployRecaptcha.listKeys,
      [{ accountId: ACCOUNT, projectId: 'Bad/Project' }],
    ],
    ['a bad key id', IPC.deployRecaptcha.secret, [{ ...ref, keyId: 'a b' }]],
    ['no ref', IPC.deployRecaptcha.listKeys, [null]],
    [
      'an empty name',
      IPC.deployRecaptcha.createKey,
      [ref, { name: ' ', type: 'score', domains: ['a.com'] }],
    ],
    [
      'a long name',
      IPC.deployRecaptcha.createKey,
      [ref, { name: 'x'.repeat(101), type: 'score', domains: ['a.com'] }],
    ],
    [
      'an unknown type',
      IPC.deployRecaptcha.createKey,
      [ref, { name: 'A', type: 'enterprise', domains: ['a.com'] }],
    ],
    ['no domains', IPC.deployRecaptcha.createKey, [ref, { name: 'A', type: 'score', domains: [] }]],
    [
      'a URL for a domain',
      IPC.deployRecaptcha.createKey,
      [ref, { name: 'A', type: 'score', domains: ['https://a.com'] }],
    ],
    [
      'an unknown difficulty',
      IPC.deployRecaptcha.createKey,
      [ref, { name: 'A', type: 'checkbox', domains: ['a.com'], challenge: 'max' }],
    ],
    [
      'an unknown type on update',
      IPC.deployRecaptcha.updateKey,
      [keyRef, 'nope', { name: 'A', domains: ['a.com'] }],
    ],
  ])('refuses %s', async (_what, channel, args) => {
    const { service, call } = harness();
    await expect(call(channel, ...args)).rejects.toThrow();
    for (const method of Object.values(service)) expect(method).not.toHaveBeenCalled();
  });
});
