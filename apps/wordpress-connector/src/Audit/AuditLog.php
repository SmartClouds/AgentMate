<?php
/**
 * The capped audit log: pairings, pulls, deploys, rollbacks and auth failures. Details are plain
 * text written by the plugin, never a secret.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Audit;

use Runova\Connector\Storage\Storage;
use Runova\Connector\Support\Text;

final class AuditLog
{
    const EVENTS = array(
        'keyCreated',
        'paired',
        'pairFailed',
        'authFailed',
        'rateLimited',
        'revoked',
        'pulled',
        'deployStarted',
        'deployDone',
        'deployRolledBack',
        'deployAborted',
        'connectorUpdated',
        'connectorRolledBack',
        'settingsChanged',
    );

    /**
     * Events anyone on the internet can cause. They are kept apart, under a smaller cap, so a flood
     * of them never pushes pairings, revokes, new keys or deploys out of the log.
     */
    const NOISE = array('authFailed', 'rateLimited');

    /** @var Storage */
    private $storage;

    public function __construct(Storage $storage)
    {
        $this->storage = $storage;
    }

    /**
     * @param array<string, mixed>|null $connection the connection row, when there is one
     */
    public function add(string $event, int $at, string $ip, string $detail, ?array $connection = null): void
    {
        if (!in_array($event, self::EVENTS, true)) {
            throw new \InvalidArgumentException('Unknown audit event.');
        }
        $this->storage->addAudit(array(
            'at' => $at,
            'event' => $event,
            'connection_id' => $connection !== null ? $connection['id'] : null,
            'connection_label' => $connection !== null ? $connection['label'] : null,
            'ip' => Text::clean($ip, 64),
            'detail' => Text::clean($detail, 500),
            'noise' => in_array($event, self::NOISE, true),
        ));
    }

    /**
     * WpAuditEntry records, newest first.
     *
     * @return array<int, array<string, mixed>>
     */
    public function entries(int $limit, ?int $beforeId): array
    {
        $out = array();
        foreach ($this->storage->listAudit($limit, $beforeId) as $row) {
            $out[] = array(
                'id' => $row['id'],
                'at' => $row['at'],
                'event' => $row['event'],
                'connectionLabel' => $row['connection_label'],
                'ip' => $row['ip'],
                'detail' => $row['detail'],
            );
        }
        return $out;
    }
}
