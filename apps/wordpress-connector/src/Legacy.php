<?php
/**
 * Names from before the plugin was renamed from AgentMate Connector to Runova Connector, in one
 * place. Sites in the field run the 1.63 plugin under these names, and some of them are kept for
 * good:
 * - The tables, the network options and the data folder keep their names. Renaming a table needs
 *   rights many hosts do not grant, and only a database admin ever sees them.
 * - The wp-config.php switches and the client IP filter belong to site owners, so the old names
 *   keep working next to the new ones, forever.
 * - The REST namespace, the ajax action (with the ping the 1.63 updater checks) and the signing
 *   prefix stay until 1.63 desktops are no longer supported.
 * - The bridge package (agentmate-connector.zip) needs the old folder, main file, header and
 *   version constant, so the 1.63 updater accepts it.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector;

final class Legacy
{
    /** The plugin folder and main file of 1.63 and of the bridge. */
    const SLUG = 'agentmate-connector';
    const MAIN = 'agentmate-connector.php';
    const BASENAME = 'agentmate-connector/agentmate-connector.php';
    /** The plugin header the 1.63 updater insists on. */
    const PLUGIN_NAME = 'AgentMate Connector';
    /** The constant the 1.63 updater reads the version from. */
    const VERSION_CONSTANT = 'AGENTMATE_CONNECTOR_VERSION';

    /** The 1.63 guard in mu-plugins, and the line that tells it is ours. */
    const GUARD_FILE = '00-agentmate-connector-guard.php';
    const GUARD_MARKER = 'Plugin Name: AgentMate Connector Guard';
    const GUARD_CONSTANT = 'AGENTMATE_CONNECTOR_GUARD';

    /** The wire names 1.63 desktops use. */
    const REST_NAMESPACE = 'agentmate/v1';
    const AJAX_ACTION = 'agentmate_connector';
    const PING_REPLY = 'agentmate-pong';
    const PROTOCOL_PREFIX = 'agentmate-wp/v1';

    /** Kept for good: tables, options, the data folder. */
    const TABLE_PREFIX = 'agentmate_';
    const OPTION_PREFIX = 'agentmate_connector_';
    const DATA_DIR_PREFIX = 'agentmate-connector-';

    /** Folders a crashed 1.63 update can leave beside the plugin. */
    const SIBLING = '/^\.agentmate-connector-(?:new|old|failed)-[0-9a-f]{12}$/D';

    /** The PHP namespace of 1.63, which its guard mu-plugin still calls into. */
    const PHP_NAMESPACE = 'AgentMate\\Connector\\';

    /** Site owners' names, honored next to the new ones. */
    const CLIENT_IP_FILTER = 'agentmate_connector_client_ip';
    const CLI_COMMAND = 'agentmate';

    /**
     * The old name of a wp-config.php switch, or null when it never had one.
     * RUNOVA_CONNECTOR_READ_ONLY becomes AGENTMATE_CONNECTOR_READ_ONLY.
     */
    public static function constant(string $name): ?string
    {
        $prefix = 'RUNOVA_CONNECTOR_';
        if (strncmp($name, $prefix, strlen($prefix)) !== 0) {
            return null;
        }
        return 'AGENTMATE_CONNECTOR_' . substr($name, strlen($prefix));
    }
}
