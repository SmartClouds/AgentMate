<?php
/**
 * Plugin Name:       Runova Connector
 * Plugin URI:        https://runovahq.com
 * Description:       Lets the Runova desktop app pull and deploy this site's theme and plugin files over a signed, paired connection.
 * Version:           2.2.0
 * Requires at least: 6.0
 * Requires PHP:      7.4
 * Author:            Runova
 * Author URI:        https://runovahq.com
 * License:           GPL-2.0-or-later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       runova-connector
 * Network:           true
 *
 * @package Runova\Connector
 */

if (!defined('ABSPATH')) {
    exit;
}

// Keep in step with WP_CONNECTOR_VERSION in packages/core/src/deploy/wordpress/protocol.ts and the
// Version header above; the tests and the zip build check all three.
define('RUNOVA_CONNECTOR_VERSION', '2.2.0');
// The guard mu-plugin may have defined it already, for the same file.
if (!defined('RUNOVA_CONNECTOR_FILE')) {
    define('RUNOVA_CONNECTOR_FILE', __FILE__);
}

// The guard may have loaded the autoloader already.
if (!class_exists('Runova\\Connector\\Autoloader', false)) {
    require_once __DIR__ . '/src/Autoloader.php';
}
\Runova\Connector\Autoloader::register(__DIR__ . '/src');

register_activation_hook(__FILE__, array(\Runova\Connector\Activator::class, 'activate'));
register_deactivation_hook(__FILE__, array(\Runova\Connector\Activator::class, 'deactivate'));
\Runova\Connector\Plugin::boot();
