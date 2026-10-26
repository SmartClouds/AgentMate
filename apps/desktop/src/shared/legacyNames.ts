/**
 * Names from before the app was renamed from AgentMate to Runova that are still out in the world:
 * in data folders, in users' projects, in running terminals and on phones. New code writes the
 * Runova names; these are only read, so an install from before the rename keeps working and moves
 * over. Every line that spells an old name carries the marker "legacy-name" so the rename script
 * leaves it alone and a search finds them all.
 */

/** The app's name, which named its data folder and its OS keychain entry. */
export const LEGACY_APP_NAME = 'AgentMate'; // legacy-name
export const LEGACY_DEV_APP_NAME = 'AgentMate Dev'; // legacy-name

/** Profile override documented in the help before the rename. */
export const LEGACY_USER_DATA_ENV = 'AGENTMATE_USER_DATA_DIR'; // legacy-name

/** The terminal host's Windows pipe and spare Unix socket prefixes. */
export const LEGACY_PTY_PIPE_PREFIX = 'agentmate-pty-host-'; // legacy-name
export const LEGACY_PTY_SOCKET_PREFIX = 'agentmate-pty-'; // legacy-name

/** The in-app browser's saved session folder under Partitions. */
export const LEGACY_BROWSER_PARTITION_DIR = 'agentmate-browser'; // legacy-name

/** Prefixes of the renderer's saved UI state in localStorage. */
export const LEGACY_STORAGE_KEY_PREFIXES = ['agentmate-', 'agentmate.', 'agentmate:']; // legacy-name
