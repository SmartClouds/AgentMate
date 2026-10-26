<?php
/**
 * Plugin Name:       AgentMate Connector
 * Plugin URI:        https://runovahq.com
 * Description:       AgentMate is now Runova. This is Runova Connector in its old folder: it works as before, and moves itself to its own folder the next time the Runova app connects.
 * Version:           1.63.0
 * Requires at least: 6.0
 * Requires PHP:      7.4
 * Author:            Runova
 * Author URI:        https://runovahq.com
 * License:           GPL-2.0-or-later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       runova-connector
 * Network:           true
 *
 * The main file of the bridge package (agentmate-connector.zip). A 1.63 connector only takes an
 * update in its own folder, under this plugin name and with this version constant, so this file
 * keeps all three and runs the Runova code beside it. The Runova main file waits in layout/ until
 * LayoutMigration moves the site to runova-connector/. Its version must match the Runova main
 * file's; the zip build checks that.
 *
 * @package Runova\Connector
 */

if (!defined('ABSPATH')) {
    exit;
}

// Once the site runs Runova Connector from its own folder, this copy only waits to be removed.
// Loading it as well would declare every class twice.
$agentmate_connector_runova = 'runova-connector/runova-connector.php';
$agentmate_connector_active = (array) get_option('active_plugins', array());
$agentmate_connector_network = is_multisite() ? (array) get_site_option('active_sitewide_plugins', array()) : array();
if (
    in_array($agentmate_connector_runova, $agentmate_connector_active, true)
    || isset($agentmate_connector_network[$agentmate_connector_runova])
    || (defined('RUNOVA_CONNECTOR_FILE') && wp_normalize_path(dirname(RUNOVA_CONNECTOR_FILE)) !== wp_normalize_path(__DIR__))
) {
    return;
}

define('AGENTMATE_CONNECTOR_VERSION', '1.63.0');
define('RUNOVA_CONNECTOR_VERSION', AGENTMATE_CONNECTOR_VERSION);
// The guard mu-plugin may have defined it already, for the same file.
if (!defined('RUNOVA_CONNECTOR_FILE')) {
    define('RUNOVA_CONNECTOR_FILE', __FILE__);
}

if (!class_exists('Runova\\Connector\\Autoloader', false)) {
    require_once __DIR__ . '/src/Autoloader.php';
}
\Runova\Connector\Autoloader::register(__DIR__ . '/src');

register_activation_hook(__FILE__, array(\Runova\Connector\Activator::class, 'activate'));
register_deactivation_hook(__FILE__, array(\Runova\Connector\Activator::class, 'deactivate'));
\Runova\Connector\Plugin::boot();
