<?php
/**
 * `wp runova connections list|revoke`.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Cli;

use Runova\Connector\Audit\AuditLog;
use Runova\Connector\Plugin;

/**
 * Lists and revokes the computers paired with this site.
 */
final class ConnectionsCommand
{
    const FIELDS = array('id', 'label', 'scope', 'device', 'created', 'last_seen', 'last_ip', 'expires', 'status');

    /**
     * Lists connections, newest first.
     *
     * ## OPTIONS
     *
     * [--format=<format>]
     * : How to print them.
     * ---
     * default: table
     * options:
     *   - table
     *   - json
     *   - csv
     *   - yaml
     *   - ids
     * ---
     *
     * [--active]
     * : Only connections that still work.
     *
     * @subcommand list
     * @when after_wp_load
     *
     * @param string[] $args
     * @param array<string, string|bool> $assoc
     */
    public function list_($args, $assoc): void
    {
        $now = time();
        $rows = array();
        foreach (Plugin::storage()->listConnections() as $connection) {
            $expired = $connection['expires_at'] !== null && $connection['expires_at'] <= $now;
            $status = $connection['revoked_at'] !== null ? 'revoked' : ($expired ? 'expired' : 'active');
            if (!empty($assoc['active']) && $status !== 'active') {
                continue;
            }
            $rows[] = array(
                'id' => $connection['id'],
                'label' => $connection['label'],
                'scope' => $connection['scope'],
                'device' => $connection['device_name'],
                'created' => self::date($connection['created_at']),
                'last_seen' => self::date($connection['last_seen_at']),
                'last_ip' => $connection['last_ip'],
                'expires' => $connection['expires_at'] === null ? 'never' : self::date($connection['expires_at']),
                'status' => $status,
            );
        }
        $format = isset($assoc['format']) ? (string) $assoc['format'] : 'table';
        if ($format === 'ids') {
            \WP_CLI::line(implode(' ', array_column($rows, 'id')));
            return;
        }
        \WP_CLI\Utils\format_items($format, $rows, self::FIELDS);
    }

    /**
     * Revokes a connection. Runova on that computer loses access at once.
     *
     * ## OPTIONS
     *
     * <id>
     * : The connection id (see `wp runova connections list`).
     *
     * [--yes]
     * : Do it without asking.
     *
     * @when after_wp_load
     *
     * @param string[] $args
     * @param array<string, string|bool> $assoc
     */
    public function revoke($args, $assoc): void
    {
        $id = isset($args[0]) ? (string) $args[0] : '';
        $storage = Plugin::storage();
        $connection = $storage->getConnection($id);
        if ($connection === null) {
            \WP_CLI::error('There is no connection with that id.');
            return;
        }
        if ($connection['revoked_at'] !== null) {
            \WP_CLI::success('That connection was already revoked.');
            return;
        }
        \WP_CLI::confirm('Revoke "' . $connection['label'] . '"?', $assoc);
        $now = time();
        $storage->revokeConnection($id, $now);
        (new AuditLog($storage))->add('revoked', $now, 'wp-cli', 'Revoked with WP-CLI.', $connection);
        \WP_CLI::success('Revoked "' . $connection['label'] . '".');
    }

    private static function date(?int $timestamp): string
    {
        return $timestamp === null ? '' : gmdate('Y-m-d H:i:s', $timestamp) . ' UTC';
    }
}
