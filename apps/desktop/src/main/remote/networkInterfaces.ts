import { networkInterfaces } from 'node:os';
import type { RemoteNetworkInterface } from '../../shared/apiTypes';

/**
 * Lists the machine's usable IPv4 addresses so the operator can pick which one
 * to bind the remote server to. Loopback and internal addresses are excluded,
 * since a peer on another machine can never reach 127.0.0.1.
 */
export function listNetworkInterfaces(): RemoteNetworkInterface[] {
  const result: RemoteNetworkInterface[] = [];
  const ifaces = networkInterfaces();
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const addr of addrs ?? []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      result.push({ name, address: addr.address });
    }
  }
  // Private LAN ranges first, those are the addresses another Runova on the
  // same network will actually be able to dial.
  result.sort((a, b) => Number(isPrivate(b.address)) - Number(isPrivate(a.address)));
  return result;
}

function isPrivate(ip: string): boolean {
  return (
    ip.startsWith('192.168.') || ip.startsWith('10.') || /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)
  );
}
