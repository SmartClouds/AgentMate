import { describe, expect, it, vi } from 'vitest';
import { coreErrorCode } from '../../../shared/coreErrors';
import type { ICoreHub } from '../../../shared/deploy/protocol/generated/TypedSignalR.Client/Runova.ServerCore.Contracts';
import {
  FAKE_CORE_PASSWORD,
  FAKE_CORE_TLS_PIN,
  FakeCore,
} from '../../../shared/deploy/testing/fakeCore';
import { DeployState } from '../state';
import { DeployDirectTls } from './service';

const OTHER_PIN = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';

function memoryState(): DeployState {
  let content: unknown = null;
  return new DeployState({
    read: async () => content,
    write: async (value) => {
      content = JSON.parse(JSON.stringify(value));
    },
  });
}

function setup(roles = ['owner']) {
  const core = new FakeCore(() => 1_000);
  core.roles = roles;
  const state = memoryState();
  const viaSsh = vi.fn();
  const changed = vi.fn();
  /** Whether this computer still tried direct TLS when each call went out. */
  const localEnabled: Array<boolean | undefined> = [];
  const directTls = new DeployDirectTls({
    service: {
      withSshHub: async <T>(serverId: string, work: (hub: ICoreHub) => Promise<T>) => {
        viaSsh(serverId);
        localEnabled.push((await state.directTls(serverId))?.enabled);
        return work(core.connect());
      },
      directTlsChanged: changed,
      directTlsHost: async () => 'prod.example.com',
    },
    state,
    roles: () => core.roles,
    now: () => 5_000,
  });
  return { core, state, directTls, viaSsh, changed, localEnabled };
}

describe('DeployDirectTls', () => {
  it('reads the mode over SSH and pins the key on the first read', async () => {
    const { directTls, state, viaSsh } = setup();

    const info = await directTls.status('srv');

    expect(viaSsh).toHaveBeenCalledWith('srv');
    expect(info.status.enabled).toBe(false);
    expect(info.pinned).toEqual({
      enabled: false,
      port: 7443,
      pin: FAKE_CORE_TLS_PIN,
      pinnedAt: 5_000,
    });
    expect(info.pinChanged).toBe(false);
    expect(info.host).toBe('prod.example.com');
    expect(await state.directTls('srv')).toEqual(info.pinned);
  });

  it('turns it on with a step-up, pins the key and has the link try it', async () => {
    const { directTls, state, core, changed } = setup();

    const info = await directTls.enable({
      serverId: 'srv',
      port: 9443,
      sources: ['10.0.0.0/8'],
      password: FAKE_CORE_PASSWORD,
    });

    expect(core.directTls).toMatchObject({ enabled: true, port: 9443, sources: ['10.0.0.0/8'] });
    expect(info.pinned).toMatchObject({ enabled: true, port: 9443, pin: FAKE_CORE_TLS_PIN });
    expect(await state.directTls('srv')).toMatchObject({ enabled: true, port: 9443 });
    expect(changed).toHaveBeenCalledWith('srv');
  });

  it('steps up with an authenticator code too', async () => {
    const { directTls, core } = setup();
    const stepUp = vi.spyOn(core, 'connect');

    await directTls
      .enable({ serverId: 'srv', port: 9443, sources: [], totpCode: '123456' })
      .catch(() => undefined);

    expect(stepUp).toHaveBeenCalled();
  });

  it('asks for a step-up when the core wants one, and says forbidden below Owner', async () => {
    const owner = setup();
    const refused = await owner.directTls
      .enable({ serverId: 'srv', port: 9443, sources: [] })
      .catch((error: unknown) => error);
    expect(coreErrorCode(refused)).toBe('stepUpRequired');

    const admin = setup(['admin']);
    const denied = await admin.directTls
      .enable({ serverId: 'srv', port: 9443, sources: [], password: FAKE_CORE_PASSWORD })
      .catch((error: unknown) => error);
    expect(coreErrorCode(denied)).toBe('forbidden');
    expect(await admin.state.directTls('srv')).toBeNull();
  });

  it('stops using the port on this computer before closing it on the core', async () => {
    const { directTls, core, changed, localEnabled } = setup();
    await directTls.enable({
      serverId: 'srv',
      port: 9443,
      sources: [],
      password: FAKE_CORE_PASSWORD,
    });
    changed.mockClear();

    const info = await directTls.disable('srv');

    expect(localEnabled.at(-1)).toBe(false);
    expect(changed).toHaveBeenCalledWith('srv');
    expect(core.directTls.enabled).toBe(false);
    expect(info.status.enabled).toBe(false);
    expect(info.pinned?.enabled).toBe(false);
  });

  it('reports a key that changed instead of taking it, until the user accepts it', async () => {
    const { directTls, state, core, changed } = setup();
    await directTls.enable({
      serverId: 'srv',
      port: 9443,
      sources: [],
      password: FAKE_CORE_PASSWORD,
    });
    core.directTls = { ...core.directTls, pin: OTHER_PIN };
    changed.mockClear();

    const reported = await directTls.status('srv');

    expect(reported.pinChanged).toBe(true);
    expect(reported.pinned?.pin).toBe(FAKE_CORE_TLS_PIN);
    expect((await state.directTls('srv'))?.pin).toBe(FAKE_CORE_TLS_PIN);
    expect(changed).not.toHaveBeenCalled();

    const accepted = await directTls.acceptPin('srv');

    expect(accepted.pinChanged).toBe(false);
    expect((await state.directTls('srv'))?.pin).toBe(OTHER_PIN);
    expect(changed).toHaveBeenCalledWith('srv');
  });
});
