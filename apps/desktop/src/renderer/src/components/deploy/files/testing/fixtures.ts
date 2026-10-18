import type {
  FileSite,
  FilesChangesSnapshot,
  FilesPendingFile,
  FilesPlanChange,
  FilesPlanView,
  FilesProgressEvent,
  FilesRunResult,
} from '@shared/deployFilesTypes';

/** Test data for FTP and SFTP sites in Deploy. Times are Unix milliseconds. */

export const SITE_ID = 'fs-1';

export function fileSite(overrides: Partial<FileSite> = {}): FileSite {
  return {
    id: SITE_ID,
    label: 'Bakery static',
    protocol: 'sftp',
    connection: {
      kind: 'custom',
      host: 'files.example',
      port: 22,
      username: 'deploy',
      authMethod: 'password',
      privateKeyPath: null,
      hostKeyFingerprint: 'ab'.repeat(32),
      tlsPin: null,
      tlsServername: null,
      hasSecret: true,
    },
    remoteRoot: '/var/www/site',
    localFolder: 'C:\\Sites\\bakery\\dist',
    projectIds: [],
    deployOnSave: false,
    quietSeconds: 5,
    ignorePatterns: [],
    capabilities: { atomicReplace: true, mtime: 'exact', checkedAt: Date.now() - 86_400_000 },
    lastDeploy: null,
    needsReview: null,
    createdAt: Date.now() - 7 * 86_400_000,
    updatedAt: Date.now() - 86_400_000,
    ...overrides,
  };
}

export function pending(
  path: string,
  change: FilesPendingFile['change'] = 'modified',
  size = 1024,
): FilesPendingFile {
  return { path, change, size };
}

export function snapshot(overrides: Partial<FilesChangesSnapshot> = {}): FilesChangesSnapshot {
  const files = overrides.files ?? [
    pending('index.html', 'modified', 2048),
    pending('css/site.css', 'added', 4096),
    pending('img/old.png', 'deleted', 10_240),
  ];
  const totals = overrides.totals ?? {
    added: files.filter((file) => file.change === 'added').length,
    modified: files.filter((file) => file.change === 'modified').length,
    deleted: files.filter((file) => file.change === 'deleted').length,
    bytes: files
      .filter((file) => file.change !== 'deleted')
      .reduce((sum, file) => sum + file.size, 0),
  };
  return {
    siteId: SITE_ID,
    computedAt: Date.now(),
    state: 'ready',
    error: null,
    leftOut: [],
    leftOutTruncated: false,
    localFileCount: 40,
    baseFileCount: 38,
    firstDeploy: false,
    ...overrides,
    files,
    totals,
  };
}

export function planChange(
  path: string,
  overrides: Partial<FilesPlanChange> = {},
): FilesPlanChange {
  const local = overrides.local ?? 'modified';
  return {
    path,
    local,
    remote: 'unchanged',
    action: local === 'deleted' ? 'deleteRemote' : 'upload',
    conflict: null,
    size: local === 'deleted' ? 0 : 1024,
    unverified: false,
    server: null,
    base: null,
    ...overrides,
  };
}

export function plan(overrides: Partial<FilesPlanView> = {}): FilesPlanView {
  const changes = overrides.changes ?? [
    planChange('index.html', { size: 2048 }),
    planChange('css/site.css', { local: 'added', remote: 'missing', size: 4096 }),
    planChange('img/old.png', { local: 'deleted' }),
  ];
  return {
    planId: 'plan-1',
    siteId: SITE_ID,
    createdAt: Date.now(),
    expiresAt: Date.now() + 600_000,
    uploadBytes: changes.reduce((sum, change) => sum + change.size, 0),
    deleteCount: changes.filter((change) => change.action === 'deleteRemote').length,
    serverOnlyDrift: [],
    missingOnServer: [],
    firstDeploy: null,
    clockShiftHours: null,
    massDelete: false,
    notices: [],
    ...overrides,
    changes,
  };
}

export function progressEvent(overrides: Partial<FilesProgressEvent> = {}): FilesProgressEvent {
  return {
    siteId: SITE_ID,
    runId: 'run-1',
    trigger: 'user',
    phase: 'uploading',
    filesDone: 1,
    filesTotal: 3,
    bytesDone: 2048,
    bytesTotal: 6144,
    currentPath: 'css/site.css',
    ...overrides,
  };
}

export function runResult(overrides: Partial<FilesRunResult> = {}): FilesRunResult {
  return {
    runId: 'run-1',
    siteId: SITE_ID,
    trigger: 'user',
    state: 'done',
    startedAt: Date.now() - 12_000,
    finishedAt: Date.now(),
    uploaded: 2,
    deleted: 1,
    adopted: 0,
    skipped: 0,
    bytes: 6144,
    failed: [],
    atomic: true,
    error: null,
    ...overrides,
  };
}
