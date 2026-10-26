<?php
/**
 * Storage in the plugin's own tables through $wpdb. Every statement with a value in it goes
 * through $wpdb->prepare() or the $wpdb->insert() helpers. The tables keep the names the plugin
 * gave them before it was renamed (see Legacy::TABLE_PREFIX and Schema::table()).
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Storage;

// phpcs:disable WordPress.DB.DirectDatabaseQuery -- these are the plugin's own tables; caching would defeat replay and lock checks.

final class WpdbStorage implements Storage
{
    /** @var \wpdb */
    private $db;

    /**
     * @param \wpdb $db
     */
    public function __construct($db)
    {
        $this->db = $db;
    }

    public function insertConnection(array $row): void
    {
        $row = Rows::connection($row);
        $ok = $this->db->insert($this->db->base_prefix . 'agentmate_connections', $row); // legacy-name
        if ($ok === false) {
            throw new \RuntimeException('The connection could not be saved.');
        }
    }

    public function getConnection(string $id): ?array
    {
        $wpdb = $this->db;
        $row = $wpdb->get_row(
            $wpdb->prepare("SELECT * FROM {$wpdb->base_prefix}agentmate_connections WHERE id = %s", $id), // legacy-name
            ARRAY_A
        );
        return is_array($row) ? Rows::connection($row) : null;
    }

    public function listConnections(): array
    {
        $wpdb = $this->db;
        $rows = $wpdb->get_results("SELECT * FROM {$wpdb->base_prefix}agentmate_connections ORDER BY created_at DESC LIMIT 500", ARRAY_A); // legacy-name
        return array_map(array(Rows::class, 'connection'), is_array($rows) ? $rows : array());
    }

    public function revokeConnection(string $id, int $at): void
    {
        $wpdb = $this->db;
        $wpdb->query(
            $wpdb->prepare("UPDATE {$wpdb->base_prefix}agentmate_connections SET revoked_at = %d WHERE id = %s AND revoked_at IS NULL", $at, $id) // legacy-name
        );
    }

    public function touchConnection(string $id, int $at, string $ip): void
    {
        $wpdb = $this->db;
        $wpdb->query(
            $wpdb->prepare("UPDATE {$wpdb->base_prefix}agentmate_connections SET last_seen_at = %d, last_ip = %s WHERE id = %s", $at, $ip, $id) // legacy-name
        );
    }

    public function insertPairing(array $row): void
    {
        $row = Rows::pairing($row);
        $row['burned'] = $row['burned'] ? 1 : 0;
        $ok = $this->db->insert($this->db->base_prefix . 'agentmate_pairings', $row); // legacy-name
        if ($ok === false) {
            throw new \RuntimeException('The pairing could not be saved.');
        }
    }

    public function getPairing(string $id): ?array
    {
        $wpdb = $this->db;
        $row = $wpdb->get_row(
            $wpdb->prepare("SELECT * FROM {$wpdb->base_prefix}agentmate_pairings WHERE id = %s", $id), // legacy-name
            ARRAY_A
        );
        return is_array($row) ? Rows::pairing($row) : null;
    }

    public function addPairingAttempt(string $id): int
    {
        $wpdb = $this->db;
        $wpdb->query(
            $wpdb->prepare("UPDATE {$wpdb->base_prefix}agentmate_pairings SET attempts = attempts + 1 WHERE id = %s", $id) // legacy-name
        );
        $count = $wpdb->get_var(
            $wpdb->prepare("SELECT attempts FROM {$wpdb->base_prefix}agentmate_pairings WHERE id = %s", $id) // legacy-name
        );
        return (int) $count;
    }

    public function burnPairing(string $id): void
    {
        $wpdb = $this->db;
        $wpdb->query(
            $wpdb->prepare("UPDATE {$wpdb->base_prefix}agentmate_pairings SET burned = 1, secret = NULL WHERE id = %s", $id) // legacy-name
        );
    }

    public function usePairing(string $id, int $at): bool
    {
        $wpdb = $this->db;
        $changed = $wpdb->query(
            $wpdb->prepare(
                "UPDATE {$wpdb->base_prefix}agentmate_pairings SET used_at = %d, secret = NULL WHERE id = %s AND used_at IS NULL AND burned = 0", // legacy-name
                $at,
                $id
            )
        );
        return $changed === 1;
    }

    public function deletePairingsExpiredBefore(int $before): void
    {
        $wpdb = $this->db;
        $wpdb->query(
            $wpdb->prepare("DELETE FROM {$wpdb->base_prefix}agentmate_pairings WHERE expires_at < %d", $before) // legacy-name
        );
    }

    public function insertNonce(string $hash, int $expiresAt): bool
    {
        $wpdb = $this->db;
        // INSERT IGNORE and a row count, never select-then-insert: two copies of one request racing
        // each other must not both get in.
        $changed = $wpdb->query(
            $wpdb->prepare("INSERT IGNORE INTO {$wpdb->base_prefix}agentmate_nonces (nonce_hash, expires_at) VALUES (%s, %d)", $hash, $expiresAt) // legacy-name
        );
        if ($changed === false) {
            throw new \RuntimeException('The nonce could not be recorded.');
        }
        return $changed === 1;
    }

    public function addAudit(array $row): int
    {
        $row = Rows::audit($row + array('id' => 0));
        unset($row['id']);
        $wpdb = $this->db;
        $ok = $wpdb->insert($wpdb->base_prefix . 'agentmate_audit', $row); // legacy-name
        if ($ok === false) {
            return 0;
        }
        $id = (int) $wpdb->insert_id;
        // Each class has its own cap, so noise never pushes out real events.
        $noise = $row['noise'];
        $cap = $noise === 1 ? self::AUDIT_NOISE_CAP : self::AUDIT_CAP;
        $oldest = $wpdb->get_var(
            $wpdb->prepare("SELECT id FROM {$wpdb->base_prefix}agentmate_audit WHERE noise = %d ORDER BY id DESC LIMIT 1 OFFSET %d", $noise, $cap) // legacy-name
        );
        if ($oldest !== null) {
            $wpdb->query(
                $wpdb->prepare("DELETE FROM {$wpdb->base_prefix}agentmate_audit WHERE noise = %d AND id <= %d", $noise, (int) $oldest) // legacy-name
            );
        }
        return $id;
    }

    public function listAudit(int $limit, ?int $beforeId): array
    {
        $wpdb = $this->db;
        if ($beforeId === null) {
            $rows = $wpdb->get_results(
                $wpdb->prepare("SELECT * FROM {$wpdb->base_prefix}agentmate_audit ORDER BY id DESC LIMIT %d", $limit), // legacy-name
                ARRAY_A
            );
        } else {
            $rows = $wpdb->get_results(
                $wpdb->prepare("SELECT * FROM {$wpdb->base_prefix}agentmate_audit WHERE id < %d ORDER BY id DESC LIMIT %d", $beforeId, $limit), // legacy-name
                ARRAY_A
            );
        }
        return array_map(array(Rows::class, 'audit'), is_array($rows) ? $rows : array());
    }

    public function kvGet(string $key, int $now): ?string
    {
        $wpdb = $this->db;
        $row = $wpdb->get_row(
            $wpdb->prepare("SELECT v, expires_at FROM {$wpdb->base_prefix}agentmate_kv WHERE k = %s", $key), // legacy-name
            ARRAY_A
        );
        if (!is_array($row)) {
            return null;
        }
        if ($row['expires_at'] !== null && (int) $row['expires_at'] <= $now) {
            return null;
        }
        return (string) $row['v'];
    }

    public function kvSet(string $key, string $value, ?int $expiresAt): void
    {
        $wpdb = $this->db;
        if ($expiresAt === null) {
            $wpdb->query(
                $wpdb->prepare("REPLACE INTO {$wpdb->base_prefix}agentmate_kv (k, v, expires_at) VALUES (%s, %s, NULL)", $key, $value) // legacy-name
            );
            return;
        }
        $wpdb->query(
            $wpdb->prepare("REPLACE INTO {$wpdb->base_prefix}agentmate_kv (k, v, expires_at) VALUES (%s, %s, %d)", $key, $value, $expiresAt) // legacy-name
        );
    }

    public function kvDelete(string $key): void
    {
        $wpdb = $this->db;
        $wpdb->query($wpdb->prepare("DELETE FROM {$wpdb->base_prefix}agentmate_kv WHERE k = %s", $key)); // legacy-name
    }

    public function kvAdd(string $key, string $value, ?int $expiresAt, int $now): bool
    {
        $wpdb = $this->db;
        // An expired holder no longer counts; clear it so the insert below can win.
        $wpdb->query(
            $wpdb->prepare("DELETE FROM {$wpdb->base_prefix}agentmate_kv WHERE k = %s AND expires_at IS NOT NULL AND expires_at <= %d", $key, $now) // legacy-name
        );
        if ($expiresAt === null) {
            $changed = $wpdb->query(
                $wpdb->prepare("INSERT IGNORE INTO {$wpdb->base_prefix}agentmate_kv (k, v, expires_at) VALUES (%s, %s, NULL)", $key, $value) // legacy-name
            );
        } else {
            $changed = $wpdb->query(
                $wpdb->prepare("INSERT IGNORE INTO {$wpdb->base_prefix}agentmate_kv (k, v, expires_at) VALUES (%s, %s, %d)", $key, $value, $expiresAt) // legacy-name
            );
        }
        if ($changed === false) {
            throw new \RuntimeException('A lock could not be taken.');
        }
        return $changed === 1;
    }

    public function insertDeploy(array $row): void
    {
        $row = Rows::deploy($row);
        // Deploys started in the same second still list in the order they began.
        $row['started_us'] = (int) round(microtime(true) * 1000000);
        $ok = $this->db->insert($this->db->base_prefix . 'agentmate_deploys', $row); // legacy-name
        if ($ok === false) {
            throw new \RuntimeException('The deploy could not be saved.');
        }
    }

    public function getDeploy(string $id): ?array
    {
        $wpdb = $this->db;
        $row = $wpdb->get_row(
            $wpdb->prepare("SELECT * FROM {$wpdb->base_prefix}agentmate_deploys WHERE id = %s", $id), // legacy-name
            ARRAY_A
        );
        return is_array($row) ? Rows::deploy($row) : null;
    }

    public function updateDeploy(string $id, array $fields, ?string $expectedState = null): bool
    {
        $wpdb = $this->db;
        $sets = array();
        $values = array();
        foreach ($fields as $name => $value) {
            if (!in_array($name, Rows::DEPLOY_COLUMNS, true)) {
                throw new \InvalidArgumentException('Unknown deploy column.');
            }
            if ($value === null) {
                $sets[] = "`$name` = NULL";
                continue;
            }
            $sets[] = is_int($value) ? "`$name` = %d" : "`$name` = %s";
            $values[] = $value;
        }
        // rev always changes, so a matched row is always a changed row and the count is honest.
        $sets[] = '`rev` = `rev` + 1';
        $sql = "UPDATE {$wpdb->base_prefix}agentmate_deploys SET " . implode(', ', $sets) . ' WHERE id = %s'; // legacy-name
        $values[] = $id;
        if ($expectedState !== null) {
            $sql .= ' AND state = %s';
            $values[] = $expectedState;
        }
        // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared -- column names come from Rows::DEPLOY_COLUMNS; every value is a placeholder.
        $changed = $wpdb->query($wpdb->prepare($sql, $values));
        if ($changed === false) {
            throw new \RuntimeException('The deploy could not be saved.');
        }
        return $changed === 1;
    }

    public function listDeploys(int $limit): array
    {
        $wpdb = $this->db;
        $rows = $wpdb->get_results(
            $wpdb->prepare("SELECT * FROM {$wpdb->base_prefix}agentmate_deploys ORDER BY started_at DESC, started_us DESC LIMIT %d", $limit), // legacy-name
            ARRAY_A
        );
        return array_map(array(Rows::class, 'deploy'), is_array($rows) ? $rows : array());
    }

    public function deleteDeploy(string $id): void
    {
        $wpdb = $this->db;
        $wpdb->query($wpdb->prepare("DELETE FROM {$wpdb->base_prefix}agentmate_deploys WHERE id = %s", $id)); // legacy-name
    }

    public function getHashes(array $files): array
    {
        $out = array();
        $wpdb = $this->db;
        foreach (array_chunk(array_keys($files), 200) as $chunk) {
            $placeholders = implode(', ', array_fill(0, count($chunk), '%s'));
            // phpcs:ignore WordPress.DB.PreparedSQLPlaceholders.UnfinishedPrepare, WordPress.DB.PreparedSQL.InterpolatedNotPrepared -- placeholders are built from the chunk size.
            $rows = $wpdb->get_results($wpdb->prepare("SELECT path_hash, size, mtime, sha256 FROM {$wpdb->base_prefix}agentmate_hash_cache WHERE path_hash IN ($placeholders)", $chunk), ARRAY_A); // legacy-name
            foreach (is_array($rows) ? $rows : array() as $row) {
                $key = (string) $row['path_hash'];
                if (isset($files[$key]) && (int) $row['size'] === $files[$key]['size'] && (int) $row['mtime'] === $files[$key]['mtime']) {
                    $out[$key] = (string) $row['sha256'];
                }
            }
        }
        return $out;
    }

    public function putHash(string $pathHash, int $size, int $mtime, string $sha256, int $now): void
    {
        $wpdb = $this->db;
        $wpdb->query(
            $wpdb->prepare(
                "REPLACE INTO {$wpdb->base_prefix}agentmate_hash_cache (path_hash, size, mtime, sha256, checked_at) VALUES (%s, %d, %d, %s, %d)", // legacy-name
                $pathHash,
                $size,
                $mtime,
                $sha256,
                $now
            )
        );
    }

    public function purgeExpired(int $now): void
    {
        $wpdb = $this->db;
        $wpdb->query($wpdb->prepare("DELETE FROM {$wpdb->base_prefix}agentmate_nonces WHERE expires_at < %d LIMIT 1000", $now)); // legacy-name
        $wpdb->query($wpdb->prepare("DELETE FROM {$wpdb->base_prefix}agentmate_kv WHERE expires_at IS NOT NULL AND expires_at <= %d LIMIT 1000", $now)); // legacy-name
        // Cached hashes nobody looked at for 30 days belong to files that are long gone.
        $wpdb->query($wpdb->prepare("DELETE FROM {$wpdb->base_prefix}agentmate_hash_cache WHERE checked_at < %d LIMIT 1000", $now - 2592000)); // legacy-name
    }
}
