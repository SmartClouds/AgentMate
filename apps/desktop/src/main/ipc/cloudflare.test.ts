import type { IpcMainInvokeEvent } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { IPC } from '../../shared/ipcChannels';
import type { CloudflareService } from '../deploy/cloudflare/service';
import { registerCloudflareHandlers } from './cloudflare';

/**
 * The Cloudflare channels answer only the app's main window, and check every argument before the
 * service sees it: ids, record types and contents, settings, URLs, rule builder input, addresses.
 */

type Listener = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

const ZONE = '023e105f4ecef8ad9ca31a8372d0c353';
const ACCOUNT = 'acct-1';
const RECORD = '372e67954025e0ba6aaa6d586b9e0b59';
const TOKEN = 'Gm4pR2e6Tq9VxYb1Lk0NsHjW3cZaDf7U8iOoPl5M';
const A_RECORD = {
  type: 'A',
  name: 'app.example.com',
  content: '203.0.113.10',
  ttl: 1,
  proxied: true,
};

function harness(trusted = true) {
  const handlers = new Map<string, Listener>();
  const names = Object.keys(IPC.cloudflare);
  const service = Object.fromEntries(names.map((name) => [name, vi.fn(async () => undefined)]));
  registerCloudflareHandlers({
    ipc: { handle: (channel, listener) => handlers.set(channel, listener) },
    service: service as unknown as CloudflareService,
    guard: () => trusted,
  });
  const call = (channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`No handler for ${channel}`);
    return handler({} as IpcMainInvokeEvent, ...args);
  };
  return { service, call, handlers };
}

describe('registerCloudflareHandlers', () => {
  it('handles every channel in the cloudflare group', () => {
    const { handlers } = harness();
    expect([...handlers.keys()].sort()).toEqual(Object.values(IPC.cloudflare).sort());
  });

  it('answers only the main window', async () => {
    const { service, call } = harness(false);
    await expect(call(IPC.cloudflare.status)).rejects.toThrow(/main window/);
    await expect(call(IPC.cloudflare.saveToken, { token: TOKEN })).rejects.toThrow(/main window/);
    expect(service.status).not.toHaveBeenCalled();
    expect(service.saveToken).not.toHaveBeenCalled();
  });

  it('passes checked arguments through to the service', async () => {
    const { service, call } = harness();

    await call(IPC.cloudflare.status);
    await call(IPC.cloudflare.saveToken, { token: ` ${TOKEN}\n`, label: 'Work' });
    await call(IPC.cloudflare.saveToken, { token: TOKEN, accountId: ACCOUNT });
    await call(IPC.cloudflare.checkToken, ACCOUNT);
    await call(IPC.cloudflare.removeToken, ACCOUNT);
    await call(IPC.cloudflare.listZones, ACCOUNT);
    await call(IPC.cloudflare.listRecords, ZONE);
    await call(IPC.cloudflare.createRecord, ZONE, { ...A_RECORD, extra: 'dropped' });
    await call(IPC.cloudflare.updateRecord, ZONE, RECORD, {
      type: 'SRV',
      name: '_sip._tcp.example.com',
      srv: { priority: 1, weight: 2, port: 5060, target: 'sip.example.com' },
      ttl: 300,
      comment: 'Phones',
    });
    await call(IPC.cloudflare.deleteRecord, ZONE, RECORD);
    await call(IPC.cloudflare.zoneSettings, ZONE);
    await call(IPC.cloudflare.changeSetting, ZONE, {
      setting: 'securityLevel',
      value: 'under_attack',
    });
    await call(IPC.cloudflare.purgeCache, ZONE, { everything: true });
    await call(IPC.cloudflare.purgeCache, ZONE, { urls: ['https://example.com/a.css'] });
    await call(IPC.cloudflare.listCustomRules, ZONE);
    await call(IPC.cloudflare.createCustomRule, ZONE, {
      description: 'Block CN',
      spec: { kind: 'block-countries', countries: ['CN'] },
    });
    await call(IPC.cloudflare.setCustomRuleEnabled, ZONE, RECORD, false);
    await call(IPC.cloudflare.deleteCustomRule, ZONE, RECORD);
    await call(IPC.cloudflare.listAccessRules, ZONE);
    await call(IPC.cloudflare.createAccessRule, ZONE, {
      mode: 'block',
      value: '203.0.113.0/24',
      notes: '',
    });
    await call(IPC.cloudflare.deleteAccessRule, ZONE, RECORD);
    const point = { zoneId: ZONE, name: '@', serverId: 'srv-1', includeWww: true, proxied: true };
    await call(IPC.cloudflare.planPointDomain, point);
    await call(IPC.cloudflare.pointDomain, point);

    expect(service.saveToken).toHaveBeenCalledWith({ token: TOKEN, label: 'Work' });
    expect(service.saveToken).toHaveBeenCalledWith({ token: TOKEN, accountId: ACCOUNT });
    expect(service.checkToken).toHaveBeenCalledWith(ACCOUNT);
    expect(service.removeToken).toHaveBeenCalledWith(ACCOUNT);
    expect(service.listZones).toHaveBeenCalledWith(ACCOUNT);
    expect(service.createRecord).toHaveBeenCalledWith(ZONE, A_RECORD);
    expect(service.updateRecord).toHaveBeenCalledWith(ZONE, RECORD, {
      type: 'SRV',
      name: '_sip._tcp.example.com',
      srv: { priority: 1, weight: 2, port: 5060, target: 'sip.example.com' },
      ttl: 300,
      comment: 'Phones',
    });
    expect(service.changeSetting).toHaveBeenCalledWith(ZONE, {
      setting: 'securityLevel',
      value: 'under_attack',
    });
    expect(service.purgeCache).toHaveBeenNthCalledWith(1, ZONE, { everything: true });
    expect(service.purgeCache).toHaveBeenNthCalledWith(2, ZONE, {
      urls: ['https://example.com/a.css'],
    });
    expect(service.createCustomRule).toHaveBeenCalledWith(ZONE, {
      description: 'Block CN',
      spec: { kind: 'block-countries', countries: ['CN'] },
    });
    expect(service.setCustomRuleEnabled).toHaveBeenCalledWith(ZONE, RECORD, false);
    expect(service.createAccessRule).toHaveBeenCalledWith(ZONE, {
      mode: 'block',
      value: '203.0.113.0/24',
      notes: '',
    });
    expect(service.planPointDomain).toHaveBeenCalledWith(point);
    expect(service.pointDomain).toHaveBeenCalledWith(point);
    for (const name of Object.keys(IPC.cloudflare)) expect(service[name], name).toHaveBeenCalled();
  });

  it('passes the SSL/TLS and caching settings through with their values', async () => {
    const { service, call } = harness();
    const changes = [
      { setting: 'automaticHttpsRewrites', value: 'on' },
      { setting: 'minTlsVersion', value: '1.2' },
      { setting: 'tls13', value: 'off' },
      { setting: 'cacheLevel', value: 'basic' },
      { setting: 'browserCacheTtl', value: 14400 },
      { setting: 'browserCacheTtl', value: 0 },
    ];
    for (const change of changes) await call(IPC.cloudflare.changeSetting, ZONE, change);
    expect(service.changeSetting.mock.calls).toEqual(changes.map((change) => [ZONE, change]));
  });

  it('refuses ids that are not Cloudflare ids', async () => {
    const { service, call } = harness();
    for (const id of [42, '', 'x'.repeat(32), '../zones', `${ZONE}/dns_records`, null]) {
      await expect(call(IPC.cloudflare.listRecords, id)).rejects.toThrow(/zone/);
      await expect(call(IPC.cloudflare.deleteRecord, ZONE, id)).rejects.toThrow(/record/);
    }
    expect(service.listRecords).not.toHaveBeenCalled();
    expect(service.deleteRecord).not.toHaveBeenCalled();
  });

  it('refuses a token that is not text, or far too long to be one', async () => {
    const { service, call } = harness();
    await expect(call(IPC.cloudflare.saveToken, 7)).rejects.toThrow(/token/);
    await expect(call(IPC.cloudflare.saveToken, { token: 7 })).rejects.toThrow(/token/);
    await expect(call(IPC.cloudflare.saveToken, { token: 'x'.repeat(5000) })).rejects.toThrow(
      /token/,
    );
    expect(service.saveToken).not.toHaveBeenCalled();
  });

  it('refuses account ids and names of the wrong shape', async () => {
    const { service, call } = harness();
    for (const bad of [7, '', 'has space', '../x', 'x'.repeat(65)]) {
      await expect(call(IPC.cloudflare.checkToken, bad)).rejects.toThrow(/Cloudflare account/);
      await expect(call(IPC.cloudflare.removeToken, bad)).rejects.toThrow(/Cloudflare account/);
      await expect(call(IPC.cloudflare.listZones, bad)).rejects.toThrow(/Cloudflare account/);
      await expect(
        call(IPC.cloudflare.saveToken, { token: TOKEN, accountId: bad }),
      ).rejects.toThrow(/Cloudflare account/);
    }
    await expect(call(IPC.cloudflare.saveToken, { token: TOKEN, label: 7 })).rejects.toThrow(
      /name/,
    );
    await expect(
      call(IPC.cloudflare.saveToken, { token: TOKEN, label: 'x'.repeat(201) }),
    ).rejects.toThrow(/name/);
    expect(service.checkToken).not.toHaveBeenCalled();
    expect(service.saveToken).not.toHaveBeenCalled();
  });

  it('refuses records of the wrong shape or with bad contents', async () => {
    const { service, call } = harness();
    const bad: unknown[] = [
      null,
      { ...A_RECORD, type: 'NS' },
      { ...A_RECORD, content: '2001:db8::1' },
      { ...A_RECORD, proxied: 'yes' },
      { ...A_RECORD, ttl: '300' },
      { ...A_RECORD, name: 7 },
      { ...A_RECORD, name: 'x'.repeat(300) },
      { ...A_RECORD, comment: 5 },
      { type: 'MX', name: 'example.com', content: 'mail.example.com', ttl: 1 },
      { type: 'CAA', name: 'example.com', caa: 'issue letsencrypt.org', ttl: 1 },
      { type: 'SRV', name: '_sip._tcp.example.com', srv: { priority: 1 }, ttl: 1 },
      { type: 'TXT', name: 'example.com', content: 'x'.repeat(5000), ttl: 1 },
    ];
    for (const record of bad) {
      await expect(
        call(IPC.cloudflare.createRecord, ZONE, record),
        JSON.stringify(record),
      ).rejects.toThrow();
    }
    expect(service.createRecord).not.toHaveBeenCalled();
  });

  it('refuses settings, purges and rules it does not know', async () => {
    const { service, call } = harness();
    await expect(
      call(IPC.cloudflare.changeSetting, ZONE, { setting: 'ssl', value: 'origin_pull' }),
    ).rejects.toThrow(/setting/);
    await expect(
      call(IPC.cloudflare.changeSetting, ZONE, { setting: 'minify', value: 'on' }),
    ).rejects.toThrow(/setting/);
    for (const change of [
      { setting: 'browserCacheTtl', value: 12345 },
      { setting: 'browserCacheTtl', value: '14400' },
      { setting: 'cacheLevel', value: 'cache_everything' },
      { setting: 'tls13', value: 'zrt' },
      { setting: 'minTlsVersion', value: 1.2 },
      { setting: 'developmentMode', value: 1 },
    ]) {
      await expect(
        call(IPC.cloudflare.changeSetting, ZONE, change),
        change.setting,
      ).rejects.toThrow(/setting/);
    }
    await expect(call(IPC.cloudflare.purgeCache, ZONE, { everything: 'yes' })).rejects.toThrow(
      /purge/,
    );
    await expect(
      call(IPC.cloudflare.purgeCache, ZONE, { urls: 'https://example.com' }),
    ).rejects.toThrow(/purge/);
    await expect(
      call(IPC.cloudflare.purgeCache, ZONE, { urls: ['ftp://example.com/a'] }),
    ).rejects.toThrow(/web address/);
    await expect(
      call(IPC.cloudflare.createCustomRule, ZONE, {
        description: '',
        spec: { kind: 'allow-ips', ips: ['203.0.113.1'] },
      }),
    ).rejects.toThrow(/description/);
    await expect(
      call(IPC.cloudflare.createCustomRule, ZONE, {
        description: 'x',
        spec: { kind: 'raw', expression: 'true' },
      }),
    ).rejects.toThrow(/rule/);
    await expect(
      call(IPC.cloudflare.createCustomRule, ZONE, {
        description: 'x',
        spec: { kind: 'challenge-path', path: '/a" or true or "', match: 'exact' },
      }),
    ).rejects.toThrow(/quotes/);
    await expect(
      call(IPC.cloudflare.createCustomRule, ZONE, {
        description: 'x',
        spec: { kind: 'challenge-path', path: '/admin', match: 'regex' },
      }),
    ).rejects.toThrow(/match/);
    await expect(
      call(IPC.cloudflare.createCustomRule, ZONE, {
        description: 'x',
        spec: { kind: 'allow-ips', ips: '1.1.1.1' },
      }),
    ).rejects.toThrow(/list/);
    await expect(call(IPC.cloudflare.setCustomRuleEnabled, ZONE, RECORD, 'no')).rejects.toThrow(
      /on or off/,
    );
    expect(service.changeSetting).not.toHaveBeenCalled();
    expect(service.purgeCache).not.toHaveBeenCalled();
    expect(service.createCustomRule).not.toHaveBeenCalled();
    expect(service.setCustomRuleEnabled).not.toHaveBeenCalled();
  });

  it('refuses access rules and point-domain requests of the wrong shape', async () => {
    const { service, call } = harness();
    await expect(
      call(IPC.cloudflare.createAccessRule, ZONE, {
        mode: 'allow',
        value: '203.0.113.10',
        notes: '',
      }),
    ).rejects.toThrow(/mode/);
    await expect(
      call(IPC.cloudflare.createAccessRule, ZONE, {
        mode: 'block',
        value: '203.0.0.0/8',
        notes: '',
      }),
    ).rejects.toThrow(/16 or \/24/);
    await expect(
      call(IPC.cloudflare.createAccessRule, ZONE, {
        mode: 'block',
        value: '203.0.113.10',
        notes: 'x'.repeat(600),
      }),
    ).rejects.toThrow(/notes/);
    const point = { zoneId: ZONE, name: '@', serverId: 'srv-1', includeWww: true, proxied: true };
    for (const wrong of [
      { ...point, zoneId: 'nope' },
      { ...point, serverId: '../srv' },
      { ...point, name: '' },
      { ...point, includeWww: 'yes' },
      { ...point, proxied: undefined },
      'example.com',
    ]) {
      await expect(
        call(IPC.cloudflare.pointDomain, wrong),
        JSON.stringify(wrong),
      ).rejects.toThrow();
    }
    expect(service.createAccessRule).not.toHaveBeenCalled();
    expect(service.pointDomain).not.toHaveBeenCalled();
  });
});
