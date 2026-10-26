/**
 * Names from before the app was renamed from AgentMate to Runova that live outside the app: in
 * users' projects, in their deployed apps and in files they exported. New code writes the Runova
 * names; these are still read, so nothing made before the rename stops working. Every line that
 * spells an old name carries the marker "legacy-name" so the rename script leaves it alone.
 */

/** The app's own folder in a project (context files, installed skills, hooks, bridge scripts). */
export const LEGACY_PROJECT_DIR = '.agentmate'; // legacy-name

/** A user-written ignore file for deploys. Still read; `.runovaignore` wins when both exist. */
export const LEGACY_IGNORE_FILE = '.agentmateignore'; // legacy-name

/** The server name of the run-commands bridge in a project's `.mcp.json`. */
export const LEGACY_MCP_SERVER_NAME = 'agentmate'; // legacy-name

/** The key a health endpoint built before the rename puts each check's error details under. */
export const LEGACY_HEALTH_CHECK_KEY = 'agentmate'; // legacy-name

/** The scheme blueprint attachments were linked with before the rename. */
export const LEGACY_BLUEPRINT_FILE_SCHEME = 'agentmate-file'; // legacy-name

/** The marker line of the PATH block Dev Setup writes into shell startup files. */
export const LEGACY_DEV_SETUP_MARKER = '# >>> AgentMate Dev Setup'; // legacy-name
export const LEGACY_DEV_SETUP_END = '# <<< AgentMate Dev Setup <<<'; // legacy-name

/** Local Docker containers and volumes the tool catalog made before the rename. */
export const LEGACY_DOCKER_PREFIX = 'agentmate-'; // legacy-name
