<?php
/**
 * Everything the plugin keeps between requests. Production uses the custom tables through $wpdb;
 * tests use the in-memory adapter. Rows come back normalized: ints are ints, missing is null.
 *
 * Connection row: id, label, scope, public_key, device_name, created_at, expires_at, revoked_at,
 * last_seen_at, last_ip, created_by.
 * Pairing row: id, secret (null once used or burned), scope, label, connection_ttl, created_at,
 * expires_at, attempts, burned, used_at, created_by.
 * Audit row: id, at, event, connection_id, connection_label, ip, detail.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Storage;

interface Storage
{
    /** Real events kept: pairings, keys, revokes, pulls, deploys. */
    const AUDIT_CAP = 2000;

    /** Refused requests and lockouts kept, on their own so they cannot push out real events. */
    const AUDIT_NOISE_CAP = 500;

    /**
     * @param array<string, mixed> $row
     */
    public function insertConnection(array $row): void;

    /**
     * @return array<string, mixed>|null
     */
    public function getConnection(string $id): ?array;

    /**
     * @return array<int, array<string, mixed>> newest first
     */
    public function listConnections(): array;

    public function revokeConnection(string $id, int $at): void;

    public function touchConnection(string $id, int $at, string $ip): void;

    /**
     * @param array<string, mixed> $row
     */
    public function insertPairing(array $row): void;

    /**
     * @return array<string, mixed>|null
     */
    public function getPairing(string $id): ?array;

    /** Adds one failed attempt and returns the new count. */
    public function addPairingAttempt(string $id): int;

    /** Marks a pairing burned and forgets its secret. */
    public function burnPairing(string $id): void;

    /** Marks a pairing used and forgets its secret. False when it was already used or burned. */
    public function usePairing(string $id, int $at): bool;

    /** Drops pairings that expired before $before. */
    public function deletePairingsExpiredBefore(int $before): void;

    /** Records a nonce. False when it was already there (a replay). */
    public function insertNonce(string $hash, int $expiresAt): bool;

    /**
     * Appends to the audit log and trims it to the newest AUDIT_CAP rows.
     *
     * @param array<string, mixed> $row
     */
    public function addAudit(array $row): int;

    /**
     * @return array<int, array<string, mixed>> newest first
     */
    public function listAudit(int $limit, ?int $beforeId): array;

    public function kvGet(string $key, int $now): ?string;

    public function kvSet(string $key, string $value, ?int $expiresAt): void;

    public function kvDelete(string $key): void;

    /**
     * Adds a key only when it is not there (or has expired). The atomic building block for locks:
     * false means someone else holds it.
     */
    public function kvAdd(string $key, string $value, ?int $expiresAt, int $now): bool;

    /**
     * Deploy row: id, connection_id, connection_label, label, state, reason, started_at,
     * updated_at, finished_at, deadline, puts, deletes, data (JSON text).
     *
     * @param array<string, mixed> $row
     */
    public function insertDeploy(array $row): void;

    /**
     * @return array<string, mixed>|null
     */
    public function getDeploy(string $id): ?array;

    /**
     * Updates the given columns. With $expectedState, only when the row is still in that state
     * (compare-and-set); false when it was not.
     *
     * @param array<string, mixed> $fields
     */
    public function updateDeploy(string $id, array $fields, ?string $expectedState = null): bool;

    /**
     * @return array<int, array<string, mixed>> newest first
     */
    public function listDeploys(int $limit): array;

    public function deleteDeploy(string $id): void;

    /**
     * Cached hashes by path hash, for entries whose size and mtime still match.
     *
     * @param array<string, array{size: int, mtime: int}> $files path hash => stat
     * @return array<string, string> path hash => sha256
     */
    public function getHashes(array $files): array;

    public function putHash(string $pathHash, int $size, int $mtime, string $sha256, int $now): void;

    /** Removes expired nonces and kv entries. */
    public function purgeExpired(int $now): void;
}
