<?php
/**
 * `wp runova rescue status|rollback`: for when a deploy broke the site and Runova cannot
 * reach it. Registered by the guard, so it still works with `--skip-plugins`.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Cli;

use Runova\Connector\Plugin;

/**
 * Inspects and undoes a pending Runova deploy.
 */
final class RescueCommand
{
    /**
     * Shows the pending deploy, if any, and the last finished one.
     *
     * ## EXAMPLES
     *
     *     wp runova rescue status
     *     wp runova rescue status --skip-plugins
     *
     * @when after_wp_load
     *
     * @param string[] $args
     * @param array<string, string|bool> $assoc
     */
    public function status($args, $assoc): void
    {
        $status = Plugin::deployService()->rescueStatus();
        $pending = $status['pending'];
        if ($pending === null) {
            \WP_CLI::line('No deploy is pending.');
        } else {
            \WP_CLI::line('Pending deploy ' . $pending['deployId'] . ' is ' . $pending['state'] . ', deadline ' . gmdate('Y-m-d H:i:s', $pending['deadline']) . ' UTC.');
        }
        $last = $status['last'];
        if ($last !== null) {
            $reason = isset($last['reason']) ? ' (' . $last['reason'] . ')' : '';
            \WP_CLI::line('Last finished deploy ' . $last['deployId'] . ' "' . $last['label'] . '" is ' . $last['state'] . $reason . '.');
        }
    }

    /**
     * Rolls back the pending deploy and restores every file it changed.
     *
     * ## OPTIONS
     *
     * [--yes]
     * : Do it without asking.
     *
     * ## EXAMPLES
     *
     *     wp runova rescue rollback --skip-plugins --yes
     *
     * @when after_wp_load
     *
     * @param string[] $args
     * @param array<string, string|bool> $assoc
     */
    public function rollback($args, $assoc): void
    {
        $service = Plugin::deployService();
        $pending = $service->pending();
        if ($pending === null) {
            \WP_CLI::success('No deploy is pending, so there is nothing to roll back.');
            return;
        }
        \WP_CLI::confirm('Roll back deploy ' . $pending['deployId'] . ' and restore the files it changed?', $assoc);
        $result = $service->rescueRollback(array('deployId' => $pending['deployId']));
        \WP_CLI::success('The deploy is now ' . $result['state'] . '.');
    }
}
