<?php
/**
 * Plugin Name: AgentMate Connector Guard
 * Description: Undoes an AgentMate deploy that breaks the site. AgentMate Connector installs it and keeps it up to date; it does nothing while no deploy is pending.
 * Version:     1.59.0
 *
 * While a deploy waits for confirmation it rolls the deploy back when the deadline passes or when
 * PHP dies of a fatal error in a file the deploy changed. It also answers AgentMate's /rescue/*
 * calls before regular plugins load, and registers `wp agentmate rescue`.
 *
 * @package AgentMate\Connector
 */

if (!defined('ABSPATH')) {
    exit;
}

// Filled in when the connector installs this file.
$agentmate_connector_dir = '';

if (!defined('AGENTMATE_CONNECTOR_GUARD') && $agentmate_connector_dir !== '' && is_file($agentmate_connector_dir . '/src/Guard/GuardRuntime.php')) {
    define('AGENTMATE_CONNECTOR_GUARD', __FILE__);
    // One autoloaded option: an empty string unless a deploy is pending.
    $agentmate_connector_state = is_multisite() ? get_site_option('agentmate_connector_guard', '') : get_option('agentmate_connector_guard', '');
    $agentmate_connector_maybe_rescue = isset($_SERVER['REQUEST_METHOD'], $_SERVER['REQUEST_URI'])
        && 'POST' === $_SERVER['REQUEST_METHOD']
        && false !== strpos((string) $_SERVER['REQUEST_URI'], 'rescue'); // phpcs:ignore WordPress.Security.ValidatedSanitizedInput -- only looked at; GuardRuntime checks the route exactly.
    if ('' !== $agentmate_connector_state || $agentmate_connector_maybe_rescue || (defined('WP_CLI') && WP_CLI)) {
        require_once $agentmate_connector_dir . '/src/Autoloader.php';
        \AgentMate\Connector\Autoloader::register($agentmate_connector_dir . '/src');
        \AgentMate\Connector\Guard\GuardRuntime::run($agentmate_connector_dir, (string) $agentmate_connector_state, $agentmate_connector_maybe_rescue);
    }
}
