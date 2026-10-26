/**
 * Names a server core from before the rename (release 1.63 and older) uses, on the server and on
 * the wire. A server keeps them until its core migrates to the Runova layout, and an old core
 * only answers to the old wire names, so the app sends those until it knows the core is newer
 * (every newer core takes both, for good). Kept while servers on the old layout are supported.
 */
export const LEGACY_CORE_NAMES = {
  root: '/opt/agentmate-core', // legacy-name
  binary: 'agentmate-core', // legacy-name
  socketPath: '/run/agentmate-core/core.sock', // legacy-name
  dataDirectory: '/var/lib/agentmate-core', // legacy-name
  configDirectory: '/etc/agentmate-core', // legacy-name
  unit: 'agentmate-core', // legacy-name
  group: 'agentmate', // legacy-name
  tarballPrefix: 'agentmate-core-', // legacy-name
  host: 'agentmate-core', // legacy-name
  authPrefix: 'agentmate-core/auth/v1', // legacy-name
  execPrefix: 'agentmate-core/exec/v1', // legacy-name
  versionHeader: 'x-agentmate-core-version', // legacy-name
  fileHeader: 'x-agentmate-core-file', // legacy-name
  sha256Header: 'x-agentmate-core-sha256', // legacy-name
  mtimeHeader: 'x-agentmate-mtime-ms', // legacy-name
  /** Backups the core made before the rename, and the files saved from them. */
  backupPrefix: 'agentmate-', // legacy-name
  backupExtension: 'ambackup',
} as const;
