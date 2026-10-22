import { describe, expect, it } from 'vitest';
import type { StoredSshServer } from '../../../shared/apiTypes';
import type { StoredHealthTarget } from '../../health/store';
import type { StoredFileSite } from '../files/types';
import type { StoredWpSite } from '../wordpress/state';
import { addressMap, moveAddressRecords, movedUrl } from './addressMoves';

/**
 * After a restore onto a new server, this computer's own records that named the old server's
 * address move to the new one: saved servers (not the one restored onto), health checks, FTP and
 * SFTP sites and WordPress sites. A trusted host key or certificate pin is dropped with the move,
 * since the new server has keys of its own.
 */

const PENDING = {
  oldAddresses: ['203.0.113.10', '2001:db8::10'],
  newAddresses: ['198.51.100.7', '2001:db8::77'],
};

describe('addressMap', () => {
  it('pairs each old address with a new one of the same family', () => {
    expect([...addressMap(PENDING, 'new.example')]).toEqual([
      ['203.0.113.10', '198.51.100.7'],
      ['2001:db8::10', '2001:db8::77'],
    ]);
  });

  it('falls back to the address this computer reaches the server at', () => {
    expect([
      ...addressMap({ oldAddresses: ['203.0.113.10'], newAddresses: [] }, 'new.example'),
    ]).toEqual([['203.0.113.10', 'new.example']]);
  });

  it('leaves an address the new server still has', () => {
    expect(addressMap({ oldAddresses: ['10.0.0.1'], newAddresses: ['10.0.0.1'] }, 'x').size).toBe(
      0,
    );
  });
});

describe('movedUrl', () => {
  const map = addressMap(PENDING, 'new.example');
  it('swaps the host of a URL and keeps the rest', () => {
    expect(movedUrl('http://203.0.113.10:8080/health?x=1', map)).toBe(
      'http://198.51.100.7:8080/health?x=1',
    );
    expect(movedUrl('https://[2001:db8::10]/ok', map)).toBe('https://[2001:db8::77]/ok');
    expect(movedUrl('https://shop.example/ok', map)).toBeNull();
    expect(movedUrl('not a url', map)).toBeNull();
  });
});

function ssh(id: string, host: string): StoredSshServer {
  return {
    id,
    nickname: id,
    host,
    port: 22,
    username: 'root',
    authMethod: 'password',
    hostKeyFingerprint: 'SHA256:old',
    createdAt: 1,
    lastConnectedAt: null,
  } as StoredSshServer;
}

describe('moveAddressRecords', () => {
  it('moves every record that named the old address and says so', async () => {
    let servers = [
      ssh('old', '203.0.113.10'),
      ssh('new', '198.51.100.7'),
      ssh('other', 'x.example'),
    ];
    const targets = [
      { id: 'h1', name: 'API', url: 'http://203.0.113.10/health' } as StoredHealthTarget,
      { id: 'h2', name: 'Shop', url: 'https://shop.example/health' } as StoredHealthTarget,
    ];
    const sites = [
      {
        id: 'f1',
        label: 'Static',
        connection: {
          kind: 'custom',
          host: '203.0.113.10',
          port: 22,
          hostKeyFingerprint: 'ab',
          tlsPin: null,
        },
      } as unknown as StoredFileSite,
      {
        id: 'f2',
        label: 'Saved',
        connection: { kind: 'saved', sshServerId: 'old' },
      } as unknown as StoredFileSite,
    ];
    const wp = [
      {
        id: 'w1',
        label: 'Blog',
        siteUrl: 'http://203.0.113.10',
        restUrl: 'http://203.0.113.10/wp-json',
        ajaxUrl: 'http://203.0.113.10/wp-admin/admin-ajax.php',
        rescueUrl: null,
      } as unknown as StoredWpSite,
    ];
    const changed: string[][] = [];

    const moved = await moveAddressRecords(
      {
        sshServers: {
          list: async () => servers,
          save: async (next) => {
            servers = next;
          },
        },
        healthTargets: {
          mutate: async (change) => change(targets),
          changed: (ids) => changed.push(ids),
        },
        fileSites: { mutate: async (change) => change(sites) },
        wordpressSites: {
          list: async () => wp,
          update: async (id, change) => {
            const at = wp.findIndex((site) => site.id === id);
            wp[at] = change(wp[at] as StoredWpSite);
          },
        },
      },
      { targetServerId: 'new', map: addressMap(PENDING, 'new.example') },
    );

    expect(moved).toEqual([
      { area: 'server', name: 'old', from: '203.0.113.10', to: '198.51.100.7', trustReset: true },
      {
        area: 'healthCheck',
        name: 'API',
        from: 'http://203.0.113.10/health',
        to: 'http://198.51.100.7/health',
      },
      {
        area: 'fileSite',
        name: 'Static',
        from: '203.0.113.10',
        to: '198.51.100.7',
        trustReset: true,
      },
      {
        area: 'wordpressSite',
        name: 'Blog',
        from: 'http://203.0.113.10',
        to: 'http://198.51.100.7',
      },
    ]);
    expect(servers.find((server) => server.id === 'old')?.hostKeyFingerprint).toBeUndefined();
    expect(servers.find((server) => server.id === 'new')?.hostKeyFingerprint).toBe('SHA256:old');
    expect(targets[0]?.url).toBe('http://198.51.100.7/health');
    expect(changed).toEqual([['h1']]);
    const site = sites[0]?.connection as { host: string; hostKeyFingerprint: string | null };
    expect(site.host).toBe('198.51.100.7');
    expect(site.hostKeyFingerprint).toBeNull();
    expect(wp[0]?.restUrl).toBe('http://198.51.100.7/wp-json');
  });

  it('changes nothing when no address moved', async () => {
    const moved = await moveAddressRecords(
      {
        sshServers: {
          list: async () => [ssh('a', '203.0.113.10')],
          save: async () => {
            throw new Error('should not save');
          },
        },
        healthTargets: { mutate: async (change) => change([]), changed: () => undefined },
        fileSites: { mutate: async (change) => change([]) },
        wordpressSites: null,
      },
      { targetServerId: 'a', map: new Map() },
    );
    expect(moved).toEqual([]);
  });
});
