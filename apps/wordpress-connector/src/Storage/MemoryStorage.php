<?php
/**
 * Storage in plain arrays, with the same semantics as the database adapter. For unit tests.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Storage;

final class MemoryStorage implements Storage
{
    /** @var array<string, array<string, mixed>> */
    public $connections = array();

    /** @var array<string, array<string, mixed>> */
    public $pairings = array();

    /** @var array<string, int> */
    public $nonces = array();

    /** @var array<int, array<string, mixed>> */
    public $audit = array();

    /** @var array<string, array{v: string, e: int|null}> */
    public $kv = array();

    /** @var array<string, array{size: int, mtime: int, sha256: string}> */
    public $hashes = array();

    /** @var int */
    private $auditId = 0;

    public function insertConnection(array $row): void
    {
        $this->connections[(string) $row['id']] = Rows::connection($row);
    }

    public function getConnection(string $id): ?array
    {
        return isset($this->connections[$id]) ? $this->connections[$id] : null;
    }

    public function listConnections(): array
    {
        $rows = array_values($this->connections);
        usort($rows, function ($a, $b) {
            return $b['created_at'] <=> $a['created_at'];
        });
        return $rows;
    }

    public function revokeConnection(string $id, int $at): void
    {
        if (isset($this->connections[$id]) && $this->connections[$id]['revoked_at'] === null) {
            $this->connections[$id]['revoked_at'] = $at;
        }
    }

    public function touchConnection(string $id, int $at, string $ip): void
    {
        if (isset($this->connections[$id])) {
            $this->connections[$id]['last_seen_at'] = $at;
            $this->connections[$id]['last_ip'] = $ip;
        }
    }

    public function insertPairing(array $row): void
    {
        $this->pairings[(string) $row['id']] = Rows::pairing($row);
    }

    public function getPairing(string $id): ?array
    {
        return isset($this->pairings[$id]) ? $this->pairings[$id] : null;
    }

    public function addPairingAttempt(string $id): int
    {
        if (!isset($this->pairings[$id])) {
            return 0;
        }
        $this->pairings[$id]['attempts']++;
        return $this->pairings[$id]['attempts'];
    }

    public function burnPairing(string $id): void
    {
        if (isset($this->pairings[$id])) {
            $this->pairings[$id]['burned'] = true;
            $this->pairings[$id]['secret'] = null;
        }
    }

    public function usePairing(string $id, int $at): bool
    {
        if (!isset($this->pairings[$id])) {
            return false;
        }
        $row = $this->pairings[$id];
        if ($row['used_at'] !== null || $row['burned']) {
            return false;
        }
        $this->pairings[$id]['used_at'] = $at;
        $this->pairings[$id]['secret'] = null;
        return true;
    }

    public function deletePairingsExpiredBefore(int $before): void
    {
        foreach ($this->pairings as $id => $row) {
            if ($row['expires_at'] < $before) {
                unset($this->pairings[$id]);
            }
        }
    }

    public function insertNonce(string $hash, int $expiresAt): bool
    {
        if (isset($this->nonces[$hash])) {
            return false;
        }
        $this->nonces[$hash] = $expiresAt;
        return true;
    }

    public function addAudit(array $row): int
    {
        $id = ++$this->auditId;
        $row['id'] = $id;
        $row = Rows::audit($row);
        $this->audit[$id] = $row;
        // Each class has its own cap, so noise never pushes out real events.
        $cap = $row['noise'] === 1 ? self::AUDIT_NOISE_CAP : self::AUDIT_CAP;
        $same = array_keys(array_filter($this->audit, function ($entry) use ($row) {
            return $entry['noise'] === $row['noise'];
        }));
        foreach (array_slice($same, 0, max(0, count($same) - $cap)) as $old) {
            unset($this->audit[$old]);
        }
        return $id;
    }

    public function listAudit(int $limit, ?int $beforeId): array
    {
        $rows = array();
        foreach (array_reverse($this->audit, true) as $id => $row) {
            if ($beforeId !== null && $id >= $beforeId) {
                continue;
            }
            $rows[] = $row;
            if (count($rows) >= $limit) {
                break;
            }
        }
        return $rows;
    }

    public function kvGet(string $key, int $now): ?string
    {
        if (!isset($this->kv[$key])) {
            return null;
        }
        $entry = $this->kv[$key];
        if ($entry['e'] !== null && $entry['e'] <= $now) {
            return null;
        }
        return $entry['v'];
    }

    public function kvSet(string $key, string $value, ?int $expiresAt): void
    {
        $this->kv[$key] = array('v' => $value, 'e' => $expiresAt);
    }

    public function kvDelete(string $key): void
    {
        unset($this->kv[$key]);
    }

    public function kvAdd(string $key, string $value, ?int $expiresAt, int $now): bool
    {
        if ($this->kvGet($key, $now) !== null) {
            return false;
        }
        $this->kv[$key] = array('v' => $value, 'e' => $expiresAt);
        return true;
    }

    /** @var array<string, array<string, mixed>> */
    public $deploys = array();

    /** @var int */
    private $deployOrder = 0;

    /** @var array<string, int> */
    private $deploySeq = array();

    public function insertDeploy(array $row): void
    {
        $row = Rows::deploy($row);
        $this->deploys[$row['id']] = $row;
        $this->deploySeq[$row['id']] = ++$this->deployOrder;
    }

    public function getDeploy(string $id): ?array
    {
        return isset($this->deploys[$id]) ? $this->deploys[$id] : null;
    }

    public function updateDeploy(string $id, array $fields, ?string $expectedState = null): bool
    {
        if (!isset($this->deploys[$id])) {
            return false;
        }
        if ($expectedState !== null && $this->deploys[$id]['state'] !== $expectedState) {
            return false;
        }
        foreach ($fields as $name => $value) {
            if (!in_array($name, Rows::DEPLOY_COLUMNS, true)) {
                throw new \InvalidArgumentException('Unknown deploy column ' . $name);
            }
            $this->deploys[$id][$name] = $value;
        }
        $this->deploys[$id] = Rows::deploy($this->deploys[$id]);
        return true;
    }

    public function listDeploys(int $limit): array
    {
        $rows = array_values($this->deploys);
        $seq = $this->deploySeq;
        usort($rows, function ($a, $b) use ($seq) {
            $order = $b['started_at'] <=> $a['started_at'];
            return $order !== 0 ? $order : $seq[$b['id']] <=> $seq[$a['id']];
        });
        return array_slice($rows, 0, $limit);
    }

    public function deleteDeploy(string $id): void
    {
        unset($this->deploys[$id], $this->deploySeq[$id]);
    }

    public function getHashes(array $files): array
    {
        $out = array();
        foreach ($files as $pathHash => $stat) {
            if (!isset($this->hashes[$pathHash])) {
                continue;
            }
            $cached = $this->hashes[$pathHash];
            if ($cached['size'] === $stat['size'] && $cached['mtime'] === $stat['mtime']) {
                $out[$pathHash] = $cached['sha256'];
            }
        }
        return $out;
    }

    public function putHash(string $pathHash, int $size, int $mtime, string $sha256, int $now): void
    {
        $this->hashes[$pathHash] = array('size' => $size, 'mtime' => $mtime, 'sha256' => $sha256);
    }

    public function purgeExpired(int $now): void
    {
        foreach ($this->nonces as $hash => $expiresAt) {
            if ($expiresAt < $now) {
                unset($this->nonces[$hash]);
            }
        }
        foreach ($this->kv as $key => $entry) {
            if ($entry['e'] !== null && $entry['e'] <= $now) {
                unset($this->kv[$key]);
            }
        }
    }
}
