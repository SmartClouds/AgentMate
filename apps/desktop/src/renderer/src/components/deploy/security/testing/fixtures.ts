import type {
  AuditEventInfo,
  DeviceInfo,
  SessionInfo,
  UserInfo,
} from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { DeployAccess, DeployServer } from '@shared/deployTypes';

/** One server with a core and the people and machines on it, for the Security area's tests. */

export const NOW = Date.now();
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export const SERVER: DeployServer = {
  id: 'srv-1',
  nickname: 'Production',
  host: 'prod.example',
  port: 22,
  username: 'deployer',
  core: {
    version: '1.53.0',
    release: '/opt/runova-core/releases/1.53.0-abababababab',
    transport: 'streamlocal',
    installedAt: NOW - 3 * DAY,
    os: 'Ubuntu 24.04.1 LTS',
    architecture: 'x86_64',
  },
  enrolled: true,
};

export function signedIn(roles: string[] = ['owner'], userName = 'maria'): DeployAccess {
  return { state: 'signed-in', user: { userName, roles, twoFactorEnabled: false } };
}

export const MARIA: UserInfo = {
  id: '11111111-1111-4111-8111-111111111111',
  userName: 'maria',
  role: 'owner',
  twoFactorEnabled: true,
  disabled: false,
  lastSignInAtUnixMs: NOW - 5 * MINUTE,
  createdAtUnixMs: NOW - 30 * DAY,
  devices: 2,
  current: true,
};

export const SAM: UserInfo = {
  id: '22222222-2222-4222-8222-222222222222',
  userName: 'sam',
  role: 'operator',
  twoFactorEnabled: false,
  disabled: false,
  createdAtUnixMs: NOW - 2 * DAY,
  devices: 0,
  current: false,
};

export const LEE: UserInfo = {
  id: '33333333-3333-4333-8333-333333333333',
  userName: 'lee',
  role: 'viewer',
  twoFactorEnabled: false,
  disabled: false,
  lockedOutUntilUnixMs: NOW + 12 * MINUTE,
  lastSignInAtUnixMs: NOW - 3 * DAY,
  createdAtUnixMs: 0,
  devices: 1,
  current: false,
};

export const KIM: UserInfo = {
  id: '44444444-4444-4444-8444-444444444444',
  userName: 'kim',
  role: 'admin',
  twoFactorEnabled: false,
  disabled: true,
  createdAtUnixMs: NOW - DAY,
  devices: 1,
  current: false,
};

export const THIS_COMPUTER: DeviceInfo = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  userName: 'maria',
  name: 'Maria-PC',
  createdAtUnixMs: NOW - 30 * DAY,
  lastSeenAtUnixMs: NOW - MINUTE,
  revoked: false,
  current: true,
};

export const LAPTOP: DeviceInfo = {
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  userName: 'lee',
  name: 'lee-laptop',
  createdAtUnixMs: NOW - 10 * DAY,
  lastSeenAtUnixMs: NOW - 3 * DAY,
  revoked: false,
  current: false,
};

export const OLD_DESKTOP: DeviceInfo = {
  id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  userName: 'maria',
  name: 'old-desktop',
  createdAtUnixMs: NOW - 90 * DAY,
  revoked: true,
  current: false,
};

export const THIS_SESSION: SessionInfo = {
  id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  deviceId: THIS_COMPUTER.id,
  deviceName: 'Maria-PC',
  createdAtUnixMs: NOW - 2 * HOUR,
  lastRenewedAtUnixMs: NOW - MINUTE,
  expiresAtUnixMs: NOW + 170 * DAY,
  current: true,
};

export const TABLET_SESSION: SessionInfo = {
  id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  deviceId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
  deviceName: 'maria-tablet',
  createdAtUnixMs: NOW - 4 * DAY,
  lastRenewedAtUnixMs: NOW - DAY,
  expiresAtUnixMs: NOW + 100 * DAY,
  current: false,
};

export function auditEvent(id: number, overrides: Partial<AuditEventInfo> = {}): AuditEventInfo {
  return {
    id,
    atUnixMs: NOW - id * MINUTE,
    actorUserId: MARIA.id,
    actorUserName: 'maria',
    deviceId: THIS_COMPUTER.id,
    deviceName: 'Maria-PC',
    action: 'auth.login',
    target: 'maria',
    result: 'success',
    ...overrides,
  };
}

/** What the main process passes on when the core refuses a hub call for want of a step-up. */
export const UNAUTHORIZED =
  "Error invoking remote method 'deploySecurity:createUser': Error: Failed to invoke 'CreateUser' because user is unauthorized";
