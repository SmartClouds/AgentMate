/**
 * Runova Connector names from before the plugin was renamed from AgentMate Connector. Sites in
 * the field run the 1.63 plugin under them until they update once, and the plugin mirrors these
 * in apps/wordpress-connector/src/Legacy.php. Every line that spells an old name carries the
 * marker "legacy-name" so the rename script leaves it alone.
 *
 * - The REST namespace, ajax action and signing prefix stay until 1.63 desktops are dropped: a
 *   site answers both sets, and an app uses the old set while it still has the old addresses.
 * - The bridge package is the only update a 1.63 site takes. It has to keep the old folder, main
 *   file, version constant and release zip name, and the old repository address (GitHub
 *   redirects it to the renamed repository).
 */

/** First line of every canonical string a 1.63 desktop or site signs. */
export const WP_LEGACY_PROTOCOL_PREFIX = 'agentmate-wp/v1'; // legacy-name
export const WP_LEGACY_REST_NAMESPACE = 'agentmate/v1'; // legacy-name
export const WP_LEGACY_AJAX_ACTION = 'agentmate_connector'; // legacy-name

/** The bridge package: the 1.63 folder, main file and version constant. */
export const WP_LEGACY_CONNECTOR_ZIP = 'agentmate-connector.zip'; // legacy-name
export const WP_LEGACY_CONNECTOR_SLUG = 'agentmate-connector'; // legacy-name
export const WP_LEGACY_CONNECTOR_MAIN = 'agentmate-connector.php'; // legacy-name
export const WP_LEGACY_CONNECTOR_NAME = 'AgentMate Connector'; // legacy-name
export const WP_LEGACY_VERSION_CONSTANT = 'AGENTMATE_CONNECTOR_VERSION'; // legacy-name

/**
 * The bridge zip on the release of a version, under the repository's old address: the only one
 * a 1.63 site downloads from.
 */
export function wpLegacyConnectorReleaseUrl(version: string): string {
  return `https://github.com/SmartClouds/AgentMate/releases/download/v${version}/${WP_LEGACY_CONNECTOR_ZIP}`; // legacy-name
}

/**
 * True for a REST address under the old namespace: a site connected before the rename, whose
 * calls then go out the 1.63 way (old ajax action, old signing prefix) until the app saves the
 * new addresses the site reports.
 */
export function isWpLegacyRestUrl(restUrl: string): boolean {
  try {
    const url = new URL(restUrl);
    const route = url.searchParams.get('rest_route') ?? url.pathname;
    return route.replace(/\/+$/, '').endsWith(`/${WP_LEGACY_REST_NAMESPACE}`);
  } catch {
    return false;
  }
}
