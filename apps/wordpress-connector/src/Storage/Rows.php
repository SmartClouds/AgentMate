<?php
/**
 * Normalizes rows from either adapter, since $wpdb hands back every column as a string.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Storage;

final class Rows
{
    /**
     * @param array<string, mixed> $row
     * @return array<string, mixed>
     */
    public static function connection(array $row): array
    {
        return array(
            'id' => (string) $row['id'],
            'label' => isset($row['label']) ? (string) $row['label'] : '',
            'scope' => (string) $row['scope'],
            'public_key' => (string) $row['public_key'],
            'device_name' => isset($row['device_name']) ? (string) $row['device_name'] : '',
            'created_at' => (int) $row['created_at'],
            'expires_at' => self::intOrNull($row, 'expires_at'),
            'revoked_at' => self::intOrNull($row, 'revoked_at'),
            'last_seen_at' => self::intOrNull($row, 'last_seen_at'),
            'last_ip' => isset($row['last_ip']) ? (string) $row['last_ip'] : '',
            'created_by' => isset($row['created_by']) ? (int) $row['created_by'] : 0,
        );
    }

    /**
     * @param array<string, mixed> $row
     * @return array<string, mixed>
     */
    public static function pairing(array $row): array
    {
        return array(
            'id' => (string) $row['id'],
            'secret' => isset($row['secret']) && $row['secret'] !== '' ? (string) $row['secret'] : null,
            'scope' => (string) $row['scope'],
            'label' => isset($row['label']) ? (string) $row['label'] : '',
            'connection_ttl' => self::intOrNull($row, 'connection_ttl'),
            'created_at' => (int) $row['created_at'],
            'expires_at' => (int) $row['expires_at'],
            'attempts' => isset($row['attempts']) ? (int) $row['attempts'] : 0,
            'burned' => !empty($row['burned']),
            'used_at' => self::intOrNull($row, 'used_at'),
            'created_by' => isset($row['created_by']) ? (int) $row['created_by'] : 0,
        );
    }

    /**
     * @param array<string, mixed> $row
     * @return array<string, mixed>
     */
    public static function audit(array $row): array
    {
        return array(
            'id' => (int) $row['id'],
            'at' => (int) $row['at'],
            'event' => (string) $row['event'],
            'connection_id' => isset($row['connection_id']) && $row['connection_id'] !== '' ? (string) $row['connection_id'] : null,
            'connection_label' => isset($row['connection_label']) ? (string) $row['connection_label'] : null,
            'ip' => isset($row['ip']) ? (string) $row['ip'] : '',
            'detail' => isset($row['detail']) ? (string) $row['detail'] : '',
            'noise' => !empty($row['noise']) ? 1 : 0,
        );
    }

    /** Columns a deploy update may set. */
    const DEPLOY_COLUMNS = array('connection_label', 'label', 'state', 'reason', 'updated_at', 'finished_at', 'deadline', 'puts', 'deletes', 'data');

    /**
     * @param array<string, mixed> $row
     * @return array<string, mixed>
     */
    public static function deploy(array $row): array
    {
        return array(
            'id' => (string) $row['id'],
            'connection_id' => isset($row['connection_id']) ? (string) $row['connection_id'] : '',
            'connection_label' => isset($row['connection_label']) ? (string) $row['connection_label'] : '',
            'label' => isset($row['label']) ? (string) $row['label'] : '',
            'state' => (string) $row['state'],
            'reason' => isset($row['reason']) && $row['reason'] !== '' ? (string) $row['reason'] : null,
            'started_at' => (int) $row['started_at'],
            'updated_at' => isset($row['updated_at']) ? (int) $row['updated_at'] : (int) $row['started_at'],
            'finished_at' => self::intOrNull($row, 'finished_at'),
            'deadline' => self::intOrNull($row, 'deadline'),
            'puts' => isset($row['puts']) ? (int) $row['puts'] : 0,
            'deletes' => isset($row['deletes']) ? (int) $row['deletes'] : 0,
            'data' => isset($row['data']) ? (string) $row['data'] : '{}',
        );
    }

    /**
     * @param array<string, mixed> $row
     */
    private static function intOrNull(array $row, string $key): ?int
    {
        return isset($row[$key]) && $row[$key] !== '' ? (int) $row[$key] : null;
    }
}
