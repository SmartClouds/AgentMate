import {
  formatWpConnectionKey,
  type Project,
  type WpAuditEntry,
  type WpConnectionKey,
  type WpDeployRecord,
  type WpItem,
  wpBase64UrlEncode,
} from '@runova/core';
import type { DeployWordPressSite, DeployWordPressSiteInfo } from '@shared/deployWordPressTypes';

/** Test data for WordPress sites in Deploy. Times the site sends are Unix seconds. */

export const NOW_SECONDS = Math.floor(Date.now() / 1000);

export function wpSite(overrides: Partial<DeployWordPressSite> = {}): DeployWordPressSite {
  return {
    id: '7d1c6a3e-1111-4c4c-9a9a-000000000001',
    label: 'Bakery',
    siteUrl: 'https://bakery.example',
    siteName: 'The Bakery',
    scope: 'write',
    transport: 'https',
    allowPlainHttp: false,
    hasHttpAuth: false,
    pluginVersion: '1.0.0',
    protocol: 1,
    connectedAt: Date.now() - 86_400_000,
    lastSeenAt: Date.now() - 5 * 60_000,
    ...overrides,
  };
}

export function wpSiteInfo(
  overrides: Partial<DeployWordPressSiteInfo> = {},
): DeployWordPressSiteInfo {
  return {
    siteName: 'The Bakery',
    homeUrl: 'https://bakery.example',
    siteUrl: 'https://bakery.example',
    wpVersion: '6.6.2',
    phpVersion: '8.2.12',
    pluginVersion: '1.0.0',
    protocol: 1,
    multisite: false,
    activeTheme: { stylesheet: 'crumb-child', template: 'crumb' },
    https: true,
    serverTime: NOW_SECONDS,
    fileModsDisabled: false,
    fileEditDisabled: false,
    filesystemMethod: 'direct',
    readOnlyByConstant: false,
    sodium: 'native',
    limits: {
      maxRequestBytes: 8 * 1024 * 1024,
      maxResponseBytes: 16 * 1024 * 1024,
      maxFileBytes: 64 * 1024 * 1024,
      timeBudgetSeconds: 15,
      maxPathsPerRead: 200,
      manifestPageSize: 2000,
      maxFilesPerItem: 20_000,
    },
    guard: { installed: true, rescueUrl: 'https://bakery.example/wp-content/rescue.php' },
    loopback: 'ok',
    connection: {
      id: 'conn-1',
      label: 'Maria laptop',
      scope: 'write',
      createdAt: NOW_SECONDS - 86_400,
      expiresAt: null,
    },
    pendingDeploy: null,
    checkedAt: Date.now(),
    ...overrides,
  };
}

export function wpItem(overrides: Partial<WpItem> = {}): WpItem {
  return {
    kind: 'theme',
    slug: 'crumb-child',
    name: 'Crumb Child',
    version: '1.2.0',
    isFile: false,
    active: true,
    networkActive: false,
    writable: true,
    protected: false,
    parentTheme: 'crumb',
    ...overrides,
  };
}

export function wpRecord(overrides: Partial<WpDeployRecord> = {}): WpDeployRecord {
  return {
    deployId: 'dep-1',
    state: 'done',
    label: 'Header tweaks',
    startedAt: NOW_SECONDS - 3600,
    finishedAt: NOW_SECONDS - 3590,
    connectionLabel: 'Maria laptop',
    puts: 3,
    deletes: 1,
    canRollback: true,
    ...overrides,
  };
}

export function wpAudit(id: number, overrides: Partial<WpAuditEntry> = {}): WpAuditEntry {
  return {
    id,
    at: NOW_SECONDS - id * 60,
    event: 'pulled',
    connectionLabel: 'Maria laptop',
    ip: '203.0.113.7',
    detail: `entry ${id}`,
    ...overrides,
  };
}

export function wpProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'proj-1',
    name: 'Bakery theme',
    folderPath: 'C:\\Projects\\bakery',
    description: '',
    tags: [],
    agentType: 'claude',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    wordpress: {
      siteId: wpSite().id,
      items: [{ kind: 'theme', slug: 'crumb-child' }],
      linkedAt: new Date().toISOString(),
    },
    ...overrides,
  } as Project;
}

/** A connection key as wp-admin would hand it over, good for ten minutes by default. */
export function wpKey(overrides: Partial<WpConnectionKey> = {}): string {
  return formatWpConnectionKey({
    siteUrl: 'https://bakery.example',
    restUrl: 'https://bakery.example/wp-json/runova/v1',
    ajaxUrl: 'https://bakery.example/wp-admin/admin-ajax.php',
    pairingId: 'pair-0001abcd',
    pairingSecret: wpBase64UrlEncode(new Uint8Array(32).fill(7)),
    sitePublicKey: wpBase64UrlEncode(new Uint8Array(32).fill(9)),
    scope: 'write',
    expiresAt: NOW_SECONDS + 600,
    ...overrides,
  });
}
