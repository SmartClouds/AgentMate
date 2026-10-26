<?php
/**
 * What happens when the site key is renewed because the site's address changed (a staging copy,
 * a restored backup): every connection and unused connection key belonged to the old site, so
 * they all stop working, and the audit log says why.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Auth;

use Runova\Connector\Audit\AuditLog;
use Runova\Connector\Storage\Storage;

final class SiteMove
{
    public static function apply(Storage $storage, int $now, string $from, string $to): void
    {
        $revoked = 0;
        foreach ($storage->listConnections() as $connection) {
            if ($connection['revoked_at'] === null) {
                $storage->revokeConnection($connection['id'], $now);
                $revoked++;
            }
        }
        // Unused keys carry the old public key; none of them may pair with the new one.
        $storage->deletePairingsExpiredBefore(PHP_INT_MAX);
        (new AuditLog($storage))->add(
            'revoked',
            $now,
            '',
            "This site's address changed from " . $from . ' to ' . $to . ', so its key was renewed and its connections were revoked (' . $revoked . ').'
        );
    }
}
