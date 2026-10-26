/**
 * Deploy names from before the rename (release 1.63 and older) that are still out on servers:
 * the server core's old folders, which a migrated server keeps as links to the new ones, and the
 * App Store block in compose files written back then. Read for good; nothing writes them now.
 */

/** Where a core from before the rename keeps its binary, settings, data and socket. */
export const LEGACY_CORE_PATHS = [
  '/var/lib/agentmate-core',
  '/etc/agentmate-core',
  '/opt/agentmate-core',
  '/run/agentmate-core',
];

/** The App Store block's key in a compose file an app was installed with before the rename. */
export const LEGACY_CATALOG_EXTENSION_KEY = 'x-agentmate';
