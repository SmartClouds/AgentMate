import type {
  BackupDestinationInfo,
  BackupPlanInfo,
  BackupRunInfo,
  PendingServerRestore,
  StoredBackupInfo,
} from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { DeployServer } from '@shared/deployTypes';
import { SERVER } from '../../security/testing/fixtures';

/** A server with two destinations, a nightly plan and a run that half worked, for E28's tests. */

export { SERVER };

export const DAY = 86_400_000;
export const NOW = Date.UTC(2026, 9, 22, 9, 0);

export const OTHER_SERVER: DeployServer = {
  ...SERVER,
  id: 'srv-2',
  nickname: 'Staging',
  host: 'staging.example',
};

export const DISK: BackupDestinationInfo = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Local disk',
  kind: 'folder',
  summary: '/srv/backups',
  settings: { path: '/srv/backups' },
  hasSecret: false,
};

export const BOX: BackupDestinationInfo = {
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Storage box',
  kind: 'sftp',
  summary: 'u1@box.example:/backups',
  settings: { host: 'box.example', port: 22, userName: 'u1', path: '/backups' },
  hasSecret: true,
  lastError: 'Connection refused',
};

export const PLAN: BackupPlanInfo = {
  id: '33333333-3333-4333-8333-333333333333',
  name: 'Nightly',
  enabled: true,
  cron: '30 3 * * *',
  timeZone: 'Europe/Berlin',
  keepLast: 7,
  destinationIds: [DISK.id, BOX.id],
  nextRunAtUnixMs: NOW + DAY,
};

export const RUN: BackupRunInfo = {
  id: '44444444-4444-4444-8444-444444444444',
  planId: PLAN.id,
  planName: 'Nightly',
  trigger: 'schedule',
  state: 'partlyFailed',
  startedAtUnixMs: NOW - DAY,
  finishedAtUnixMs: NOW - DAY + 60_000,
  sizeBytes: 2 * 1024 ** 3,
  targets: [
    {
      destinationId: DISK.id,
      destinationName: 'Local disk',
      state: 'succeeded',
      attempts: 1,
      pruned: 1,
    },
    {
      destinationId: BOX.id,
      destinationName: 'Storage box',
      state: 'failed',
      attempts: 3,
      pruned: 0,
      error: 'Connection refused',
    },
  ],
};

export const STORED: StoredBackupInfo = {
  backupId: RUN.id,
  destinationId: DISK.id,
  planId: PLAN.id,
  serverName: 'web-1',
  createdAtUnixMs: NOW - DAY,
  sizeBytes: 2 * 1024 ** 3,
  parts: 2,
  coreVersion: '1.62.0',
  keyId: 'k1',
};

export const PENDING: PendingServerRestore = {
  hostName: 'web-1',
  createdAtUnixMs: NOW - DAY,
  oldAddresses: ['203.0.113.10'],
  newAddresses: ['198.51.100.7'],
  volumes: 4,
  savedImages: 1,
  pulledImages: 6,
  containers: 7,
  projects: ['shop', 'blog'],
  firewallRules: [{ action: 'allow', protocol: 'tcp', port: 443 }],
  addressChanges: [
    {
      area: 'Cloudflare DNS',
      target: 'shop.example',
      from: '203.0.113.10',
      to: '198.51.100.7',
      automatic: true,
    },
    {
      area: 'DNS',
      target: 'blog.example',
      from: '203.0.113.10',
      to: '198.51.100.7',
      automatic: false,
      note: 'Not on Cloudflare',
    },
  ],
  liveCopy: true,
};

/** A step-up window that is still open, so the dialog does not get in the way. */
export const STEPPED_UP = {
  'deploy.account': async () => ({
    twoFactorEnabled: false,
    stepUpUntilUnixMs: Date.now() + 600_000,
  }),
};

export function ownerAccess(roles = ['owner']) {
  return {
    'deploy.access': async () => ({
      state: 'signed-in',
      user: { userName: 'maria', roles, twoFactorEnabled: false },
    }),
  };
}
