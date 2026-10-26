<?php
/**
 * Runova Connector rescue endpoint: the last way back when a deploy broke something that loads
 * before the guard (another mu-plugin, say). It loads WordPress with SHORTINIT, so no plugin,
 * mu-plugin or theme runs, and answers only /rescue/status and /rescue/rollback, with the same
 * signed requests and replies as every other route: POST rescue.php?route=/rescue/status.
 *
 * @package Runova\Connector
 */

// phpcs:disable WordPress.Security.ValidatedSanitizedInput, WordPress.Security.NonceVerification -- checked by the signature, like every route.

if (!isset($_SERVER['REQUEST_METHOD']) || 'POST' !== $_SERVER['REQUEST_METHOD']) {
    http_response_code(405);
    header('Allow: POST');
    exit;
}

$runova_connector_load = null;
$runova_connector_config = __DIR__ . '/rescue-config.php';
if (is_file($runova_connector_config)) {
    $runova_connector_settings = include $runova_connector_config;
    if (is_array($runova_connector_settings) && isset($runova_connector_settings['abspath']) && is_string($runova_connector_settings['abspath'])
        && is_file(rtrim($runova_connector_settings['abspath'], '/\\') . '/wp-load.php')) {
        $runova_connector_load = rtrim($runova_connector_settings['abspath'], '/\\') . '/wp-load.php';
    }
}
if (null === $runova_connector_load) {
    // The usual layout: wp-content/plugins/<this folder>/rescue.php.
    $runova_connector_up = __DIR__;
    for ($runova_connector_level = 0; $runova_connector_level < 6 && null === $runova_connector_load; $runova_connector_level++) {
        $runova_connector_up = dirname($runova_connector_up);
        if (is_file($runova_connector_up . '/wp-load.php')) {
            $runova_connector_load = $runova_connector_up . '/wp-load.php';
        }
    }
}
if (null === $runova_connector_load) {
    http_response_code(503);
    exit;
}

define('SHORTINIT', true);
require $runova_connector_load;
require_once __DIR__ . '/src/Autoloader.php';
\Runova\Connector\Autoloader::register(__DIR__ . '/src');
\Runova\Connector\Guard\Rescue::serve(__DIR__);
