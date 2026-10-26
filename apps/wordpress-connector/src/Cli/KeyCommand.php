<?php
/**
 * `wp runova key create`: makes a one-time connection key from the command line.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Cli;

use Runova\Connector\Plugin;

/**
 * Creates connection keys for Runova.
 */
final class KeyCommand
{
    /**
     * Creates a one-time connection key. Paste it into Runova within 15 minutes.
     *
     * ## OPTIONS
     *
     * --scope=<scope>
     * : What the connection may do. A write key lets Runova change code on this site.
     * ---
     * options:
     *   - read
     *   - write
     * ---
     *
     * [--label=<label>]
     * : A name for the connection, up to 100 characters.
     *
     * [--expires-in=<days>]
     * : Days the connection lasts after pairing. Leave it out for a connection that never expires.
     *
     * [--porcelain]
     * : Print only the key.
     *
     * ## EXAMPLES
     *
     *     wp runova key create --scope=read --label="Laptop"
     *     wp runova key create --scope=write --expires-in=30 --porcelain
     *
     * @when after_wp_load
     *
     * @param string[] $args
     * @param array<string, string|bool> $assoc
     */
    public function create($args, $assoc): void
    {
        $scope = isset($assoc['scope']) ? (string) $assoc['scope'] : '';
        if ($scope !== 'read' && $scope !== 'write') {
            \WP_CLI::error('--scope is read or write.');
        }
        $label = isset($assoc['label']) ? (string) $assoc['label'] : '';
        $days = null;
        if (isset($assoc['expires-in'])) {
            $raw = (string) $assoc['expires-in'];
            if (preg_match('/^[0-9]{1,4}$/D', $raw) !== 1 || (int) $raw < 1 || (int) $raw > 3650) {
                \WP_CLI::error('--expires-in is a number of days from 1 to 3650.');
            }
            $days = (int) $raw;
        }
        try {
            $created = Plugin::keyService()->create($scope, $label, $days, 0, 'wp-cli');
        } catch (\InvalidArgumentException $error) {
            \WP_CLI::error($error->getMessage());
            return;
        }
        if (!empty($assoc['porcelain'])) {
            \WP_CLI::line($created['key']);
            return;
        }
        \WP_CLI::line($created['key']);
        \WP_CLI::success('Created a ' . $scope . ' key. It works once, for the next 15 minutes.');
        if ($scope === 'write') {
            \WP_CLI::warning('A write key lets Runova change code on this site.');
        }
    }
}
