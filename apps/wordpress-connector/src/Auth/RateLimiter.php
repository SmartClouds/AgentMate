<?php
/**
 * Failed-auth limiting per client IP: 30 failures inside 10 minutes locks the IP out for 15
 * minutes. While locked, requests get an unsigned 429 without any further work.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Auth;

use Runova\Connector\Storage\Storage;
use Runova\Connector\Support\Json;

final class RateLimiter
{
    const MAX_FAILURES = 30;
    const WINDOW_SECONDS = 600;
    const LOCK_SECONDS = 900;

    /** @var Storage */
    private $storage;

    public function __construct(Storage $storage)
    {
        $this->storage = $storage;
    }

    /** Seconds left on a lockout, or 0 when the IP may go ahead. */
    public function lockedFor(string $ip, int $now): int
    {
        $state = $this->state($ip, $now);
        return $state['l'] > $now ? $state['l'] - $now : 0;
    }

    /** Counts one failure. True when it started a lockout. */
    public function recordFailure(string $ip, int $now): bool
    {
        $state = $this->state($ip, $now);
        if ($state['s'] === 0 || $now - $state['s'] >= self::WINDOW_SECONDS) {
            $state['s'] = $now;
            $state['c'] = 0;
        }
        $state['c']++;
        $started = false;
        if ($state['c'] >= self::MAX_FAILURES && $state['l'] <= $now) {
            $state['l'] = $now + self::LOCK_SECONDS;
            $started = true;
        }
        $expires = max($state['s'] + self::WINDOW_SECONDS, $state['l']);
        $this->storage->kvSet(self::key($ip), Json::encode($state), $expires);
        return $started;
    }

    /**
     * @return array{c: int, s: int, l: int} failures, window start, locked until
     */
    private function state(string $ip, int $now): array
    {
        $raw = $this->storage->kvGet(self::key($ip), $now);
        $data = is_string($raw) ? json_decode($raw, true) : null;
        if (!is_array($data)) {
            return array('c' => 0, 's' => 0, 'l' => 0);
        }
        return array(
            'c' => isset($data['c']) ? (int) $data['c'] : 0,
            's' => isset($data['s']) ? (int) $data['s'] : 0,
            'l' => isset($data['l']) ? (int) $data['l'] : 0,
        );
    }

    private static function key(string $ip): string
    {
        return 'rl:' . hash('sha256', $ip);
    }
}
