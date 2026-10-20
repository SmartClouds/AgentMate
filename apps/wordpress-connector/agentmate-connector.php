<?php
/**
 * Plugin Name:       AgentMate Connector
 * Description:       Lets the AgentMate desktop app pull and deploy this site's theme and plugin files over a signed, paired connection.
 * Version:           1.59.0
 * Requires at least: 6.0
 * Requires PHP:      7.4
 * Author:            AgentMate
 * License:           GPL-2.0-or-later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       agentmate-connector
 * Network:           true
 *
 * @package AgentMate\Connector
 */

if (!defined('ABSPATH')) {
    exit;
}

// Keep in step with WP_CONNECTOR_VERSION in packages/core/src/deploy/wordpress/protocol.ts and the
// Version header above; the tests and the zip build check all three.
define('AGENTMATE_CONNECTOR_VERSION', '1.59.0');
// The guard mu-plugin may have defined it already, for the same file.
if (!defined('AGENTMATE_CONNECTOR_FILE')) {
    define('AGENTMATE_CONNECTOR_FILE', __FILE__);
}

require_once __DIR__ . '/src/Autoloader.php';
\AgentMate\Connector\Autoloader::register(__DIR__ . '/src');

register_activation_hook(__FILE__, array(\AgentMate\Connector\Activator::class, 'activate'));
register_deactivation_hook(__FILE__, array(\AgentMate\Connector\Activator::class, 'deactivate'));
\AgentMate\Connector\Plugin::boot();
