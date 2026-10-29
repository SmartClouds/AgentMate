<?php
/**
 * Plugin Name: Runova Connector Guard
 * Description: Undoes a Runova deploy that breaks the site. Runova Connector installs it and keeps it up to date; it does nothing while no deploy is pending.
 * Version:     2.0.0
 *
 * While a deploy waits for confirmation it rolls the deploy back when the deadline passes or when
 * PHP dies of a fatal error in a file the deploy changed. It also answers Runova's /rescue/*
 * calls before regular plugins load, and registers `wp runova rescue`.
 *
 * @package Runova\Connector
 */

if (!defined('ABSPATH')) {
    exit;
}

// Filled in when the connector installs this file.
$runova_connector_dir = '';

// The guard 1.63 installed may still be here for a moment, and it runs first; it loads the same code.
if (!defined('RUNOVA_CONNECTOR_GUARD') && !defined('AGENTMATE_CONNECTOR_GUARD') && $runova_connector_dir !== '' && is_file($runova_connector_dir . '/src/Guard/GuardRuntime.php')) { // legacy-name
    define('RUNOVA_CONNECTOR_GUARD', __FILE__);
    // One autoloaded option: an empty string unless a deploy is pending. It kept its 1.63 name.
    $runova_connector_state = is_multisite() ? get_site_option('agentmate_connector_guard', '') : get_option('agentmate_connector_guard', ''); // legacy-name
    $runova_connector_maybe_rescue = isset($_SERVER['REQUEST_METHOD'], $_SERVER['REQUEST_URI'])
        && 'POST' === $_SERVER['REQUEST_METHOD']
        && false !== strpos((string) $_SERVER['REQUEST_URI'], 'rescue'); // phpcs:ignore WordPress.Security.ValidatedSanitizedInput -- only looked at; GuardRuntime checks the route exactly.
    if ('' !== $runova_connector_state || $runova_connector_maybe_rescue || (defined('WP_CLI') && WP_CLI)) {
        if (!class_exists('Runova\Connector\Autoloader', false)) {
            require_once $runova_connector_dir . '/src/Autoloader.php';
        }
        \Runova\Connector\Autoloader::register($runova_connector_dir . '/src');
        \Runova\Connector\Guard\GuardRuntime::run($runova_connector_dir, (string) $runova_connector_state, $runova_connector_maybe_rescue);
    }
}
