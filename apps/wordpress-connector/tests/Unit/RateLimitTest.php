<?php
/**
 * 30 failed requests in 10 minutes lock an address out for 15 minutes, with unsigned 429s.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Tests\Unit;

use Runova\Connector\Auth\RateLimiter;
use Runova\Connector\Crypto\Crypto;
use Runova\Connector\Storage\MemoryStorage;
use Runova\Connector\Tests\Support\TestCase;

final class RateLimitTest extends TestCase
{
    public function testLimiterCountsInAWindow(): void
    {
        $limiter = new RateLimiter(new MemoryStorage());
        $now = 1000;
        for ($index = 1; $index < 30; $index++) {
            $this->assertFalse($limiter->recordFailure('192.0.2.1', $now));
        }
        $this->assertSame(0, $limiter->lockedFor('192.0.2.1', $now));
        $this->assertTrue($limiter->recordFailure('192.0.2.1', $now));
        $this->assertSame(900, $limiter->lockedFor('192.0.2.1', $now));
        $this->assertSame(0, $limiter->lockedFor('192.0.2.2', $now));
        $this->assertSame(0, $limiter->lockedFor('192.0.2.1', $now + 900));
    }

    public function testFailuresOutsideTheWindowDoNotAddUp(): void
    {
        $limiter = new RateLimiter(new MemoryStorage());
        for ($index = 0; $index < 29; $index++) {
            $limiter->recordFailure('192.0.2.1', 1000);
        }
        $this->assertFalse($limiter->recordFailure('192.0.2.1', 1600));
        $this->assertSame(0, $limiter->lockedFor('192.0.2.1', 1600));
    }

    public function testLockedOutAddressGetsUnsignedRateLimitedReplies(): void
    {
        $this->makeSite();
        $connection = $this->connect();
        $unknown = Crypto::uuid4();
        for ($index = 0; $index < 30; $index++) {
            $this->assertError('unknownConnection', $this->call('/site/info', null, array('connectionId' => $unknown)));
        }
        $result = $this->call('/site/info', null, array('connectionId' => $unknown));
        $this->assertError('rateLimited', $result, 429);
        $this->assertSame('', $result['meta']['sig']);
        $this->assertSame('900', $result['response']->headers['Retry-After']);
        $this->assertSame(900, $result['body']['error']['details']['retryAfter']);
        $this->assertError('rateLimited', $this->call('/hello', null, array('unsigned' => true)), 429);
        // Another address is not affected.
        $this->assertError('unknownConnection', $this->call('/site/info', null, array('connectionId' => $unknown, 'ip' => '203.0.113.77')));
        // The paired app behind the same address still gets through to full verification.
        $this->assertOk($this->call('/site/info', null, array('connectionId' => $connection)));
        $events = array_column($this->storage->audit, 'event');
        $this->assertSame(1, count(array_keys($events, 'rateLimited', true)));

        $this->env->now += 900;
        $this->assertError('unknownConnection', $this->call('/site/info', null, array('connectionId' => $unknown)));
    }

    public function testGoodRequestsDoNotCount(): void
    {
        $this->makeSite();
        $connection = $this->connect();
        for ($index = 0; $index < 40; $index++) {
            $this->assertOk($this->call('/items/list', null, array('connectionId' => $connection)));
        }
    }
}
