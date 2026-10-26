import type { Project, WpItem, WpPlannedChange } from '@runova/core';
import type { DeployWordPressPlan, DeployWordPressSite } from '@shared/deployWordPressTypes';

/** Sample data for the WordPress project tests (E21). */

export function wpSite(overrides: Partial<DeployWordPressSite> = {}): DeployWordPressSite {
  return {
    id: 'site-1',
    label: 'Acme Shop',
    siteUrl: 'https://shop.example.com',
    siteName: 'Acme Shop',
    scope: 'write',
    transport: 'https',
    allowPlainHttp: false,
    hasHttpAuth: false,
    pluginVersion: '1.0.0',
    protocol: 1,
    connectedAt: 1_700_000_000_000,
    lastSeenAt: null,
    ...overrides,
  };
}

export function wpItem(overrides: Partial<WpItem> & Pick<WpItem, 'kind' | 'slug'>): WpItem {
  return {
    name: overrides.slug,
    version: '1.0',
    isFile: false,
    active: false,
    networkActive: false,
    writable: true,
    protected: false,
    ...overrides,
  };
}

export const SITE_ITEMS: WpItem[] = [
  wpItem({ kind: 'theme', slug: 'storefront', name: 'Storefront', version: '4.5', active: true }),
  wpItem({ kind: 'theme', slug: 'twentytwentyfive', name: 'Twenty Twenty-Five', version: '1.2' }),
  wpItem({
    kind: 'plugin',
    slug: 'woocommerce',
    name: 'WooCommerce',
    version: '9.1',
    active: true,
  }),
  wpItem({
    kind: 'plugin',
    slug: 'runova-connector',
    name: 'Runova Connector',
    protected: true,
  }),
  wpItem({ kind: 'mu-plugin', slug: 'tweaks.php', name: 'Tweaks', isFile: true }),
];

export function change(overrides: Partial<WpPlannedChange> & { path: string }): WpPlannedChange {
  return {
    item: { kind: 'theme', slug: 'storefront' },
    local: 'modified',
    remote: null,
    action: 'upload',
    expectedRemote: 'abc',
    size: 2048,
    ...overrides,
  };
}

export function wpPlan(overrides: Partial<DeployWordPressPlan> = {}): DeployWordPressPlan {
  return {
    planId: 'plan-1',
    projectId: 'p1',
    siteId: 'site-1',
    direction: 'deploy',
    changes: [
      change({ path: 'style.css' }),
      change({ path: 'inc/new.php', local: 'added', expectedRemote: null, size: 512 }),
      change({ path: 'old.php', local: 'deleted', action: 'deleteRemote', size: 0 }),
    ],
    conflicts: [],
    leftOut: [],
    warnings: [],
    uploadBytes: 2560,
    downloadBytes: 0,
    expiresAt: Date.now() + 15 * 60_000,
    ...overrides,
  };
}

export function wpProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'Acme Shop',
    folderPath: 'C:\\code\\acme-shop',
    description: '',
    tags: [],
    agentType: 'claude-code',
    notes: '',
    runCommands: [],
    prompt: '',
    notifications: {
      completion: { enabled: false, cliId: null, message: '' },
      confirmation: { enabled: false, cliId: null, message: '' },
      pet: { enabled: false, cliId: null, message: '' },
    },
    cliId: null,
    iconDataUrl: null,
    iconFile: null,
    iconBgColor: null,
    iconColor: null,
    websiteUrl: '',
    repoUrl: '',
    githubActionsMuted: [],
    worktreeSetup: { command: '', copyGlobs: null },
    pinned: false,
    archived: false,
    wordpress: {
      siteId: 'site-1',
      items: [
        { kind: 'theme', slug: 'storefront' },
        { kind: 'plugin', slug: 'woocommerce' },
      ],
      linkedAt: '2026-10-01T00:00:00.000Z',
    },
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
