<?php
/**
 * Regression tests for the security review: audit flooding, the shared-IP lockout, the new
 * hard-deny names with NFKC lookalikes, and key renewal when a copy of the site appears elsewhere.
 * (The stored XSS in the admin views is covered by AdminViewsTest.)
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Tests\Unit;

use Runova\Connector\Audit\AuditLog;
use Runova\Connector\Auth\SiteMove;
use Runova\Connector\Crypto\Base64Url;
use Runova\Connector\Crypto\Crypto;
use Runova\Connector\Crypto\SiteKeys;
use Runova\Connector\Files\PathPolicy;
use Runova\Connector\Http\IncomingRequest;
use Runova\Connector\Storage\MemoryStorage;
use Runova\Connector\Support\Text;
use Runova\Connector\Tests\Support\TestCase;

final class SecurityFixesTest extends TestCase
{
    public function testCredentialFilesAreHardDenied(): void
    {
        foreach (array('.npmrc', 'auth.json', '.netrc', '.git-credentials', 'sub/AUTH.JSON', 'a/.NETRC/b') as $path) {
            $this->assertSame('hardDenied', PathPolicy::validate($path), $path);
        }
        $this->assertNull(PathPolicy::validate('auth.json.dist'));
    }

    public function testLookalikesAreJudgedAsTheNameTheyBecome(): void
    {
        $lookalikes = array(
            ".cur\u{017F}or/rules.mdc",
            "\u{FF21}\u{FF27}\u{FF25}\u{FF2E}\u{FF34}\u{FF33}.md",
            "\u{2024}claude/settings.json",
            "x/\u{FF0E}git/HEAD",
            ".git-credential\u{017F}",
        );
        foreach ($lookalikes as $path) {
            $this->assertSame('hardDenied', PathPolicy::validate($path), $path);
        }
        $this->assertSame('.cursor', Text::nfkc(".cur\u{017F}or"));
        $this->assertSame('AGENTS.md', Text::nfkc("\u{FF21}\u{FF27}\u{FF25}\u{FF2E}\u{FF34}\u{FF33}.md"));
        $this->assertSame("caf\u{e9}.php", Text::nfkc("caf\u{e9}.php"));
        $this->assertNull(PathPolicy::validate("caf\u{e9}/\u{0444}\u{0430}\u{0439}\u{043b}.php"));
    }

    public function testNoiseNeverPushesOutRealEvents(): void
    {
        $storage = new MemoryStorage();
        $audit = new AuditLog($storage);
        $audit->add('paired', 1, '203.0.113.1', 'Paired "Laptop" with write access.');
        $audit->add('deployDone', 2, '', 'Finished: "x".');
        for ($index = 0; $index < 3000; $index++) {
            $audit->add($index % 2 === 0 ? 'authFailed' : 'rateLimited', 3 + $index, '198.51.100.' . ($index % 250), 'junk');
        }
        $events = array_column($storage->audit, 'event');
        $this->assertContains('paired', $events);
        $this->assertContains('deployDone', $events);
        $noise = count(array_filter($storage->audit, function ($row) {
            return $row['noise'] === 1;
        }));
        $this->assertSame(500, $noise);
    }

    public function testAnonymousFailuresAreCountedButNotLogged(): void
    {
        $this->makeSite();
        $connection = $this->connect();
        $this->env->put('themes/demo/style.css', 'x');
        for ($index = 0; $index < 29; $index++) {
            $this->call('/site/info', null, array('connectionId' => Crypto::uuid4(), 'ip' => '198.51.100.' . $index));
            $this->dispatcher()->handle(new IncomingRequest('/hello', 'garbage', null, '198.51.100.' . $index));
        }
        $this->assertSame(array(), array_column($this->storage->audit, 'event'), 'Junk from anyone leaves no rows.');
        // From one address: 30 failures lock it out, with exactly one rateLimited row.
        for ($index = 0; $index < 40; $index++) {
            $this->call('/site/info', null, array('connectionId' => Crypto::uuid4(), 'ip' => '192.0.2.50'));
        }
        $this->assertSame(array('rateLimited'), array_values(array_column($this->storage->audit, 'event')));
        $this->assertOk($this->call('/site/info', null, array('connectionId' => $connection)));
    }

    public function testThePairedAppGetsThroughALockoutOnASharedAddress(): void
    {
        $this->makeSite();
        $connection = $this->connect();
        $shared = '192.0.2.77';
        for ($index = 0; $index < 30; $index++) {
            $this->call('/site/info', null, array('connectionId' => Crypto::uuid4(), 'ip' => $shared));
        }
        // Unknown, unsigned, hello and pair stay locked out with the unsigned 429.
        $unknown = $this->call('/site/info', null, array('connectionId' => Crypto::uuid4(), 'ip' => $shared));
        $this->assertError('rateLimited', $unknown, 429);
        $this->assertSame('', $unknown['meta']['sig']);
        $this->assertError('rateLimited', $this->call('/hello', null, array('unsigned' => true, 'ip' => $shared)), 429);
        $this->assertError('rateLimited', $this->call('/site/info', null, array('connectionId' => $connection, 'unsigned' => true, 'ip' => $shared)), 429);
        $revoked = $this->connect('read', array('revoked_at' => $this->env->now - 1));
        $this->assertError('rateLimited', $this->call('/site/info', null, array('connectionId' => $revoked, 'ip' => $shared)), 429);

        // The paired app on the same address is verified as usual.
        $this->assertOk($this->call('/site/info', null, array('connectionId' => $connection, 'ip' => $shared)));
        // A forged request naming it is refused by its signature, and counted.
        $other = Crypto::keypairFromSeed(str_repeat("\x03", 32));
        $before = $this->storage->kvGet('rl:' . hash('sha256', $shared), $this->env->now);
        $forged = $this->call('/site/info', null, array('connectionId' => $connection, 'ip' => $shared, 'secretKey' => $other['secret']));
        $this->assertError('badSignature', $forged, 401);
        $this->assertNotSame('', $forged['meta']['sig']);
        $this->assertNotSame($before, $this->storage->kvGet('rl:' . hash('sha256', $shared), $this->env->now));
    }

    public function testKeyRenewalWhenTheAddressChanges(): void
    {
        $first = SiteKeys::resolve(null, 'https://example.test');
        $this->assertNotNull($first['store']);
        $this->assertNull($first['renewedFrom']);
        $stored = $first['store'];
        $this->assertSame('https://example.test', json_decode($stored, true)['home']);

        $same = SiteKeys::resolve($stored, 'http://EXAMPLE.test/');
        $this->assertNull($same['store'], 'A switch to HTTPS, case or a trailing slash is the same site.');
        $this->assertSame($first['seed'], $same['seed']);

        $moved = SiteKeys::resolve($stored, 'https://staging.example.test');
        $this->assertSame('https://example.test', $moved['renewedFrom']);
        $this->assertNotSame($first['seed'], $moved['seed']);
        $this->assertSame('https://staging.example.test', json_decode($moved['store'], true)['home']);

        $sub = SiteKeys::resolve($stored, 'https://example.test/blog');
        $this->assertSame('https://example.test', $sub['renewedFrom'], 'Another path is another site.');

        // Written before addresses were recorded: keep the key, record the address.
        $legacy = SiteKeys::resolve(json_encode(array('v' => 1, 'seed' => Base64Url::encode($first['seed']))), 'https://example.test');
        $this->assertSame($first['seed'], $legacy['seed']);
        $this->assertNull($legacy['renewedFrom']);
        $this->assertSame('https://example.test', json_decode($legacy['store'], true)['home']);

        // No address to compare (rescue paths that cannot tell): nothing changes.
        $this->assertNull(SiteKeys::resolve($stored, null)['store']);
    }

    public function testAMovedSiteRevokesEveryConnectionAndKey(): void
    {
        $this->makeSite();
        $connection = $this->connect('write');
        $this->connect('read');
        $this->storage->insertPairing(array('id' => 'p-0000001', 'secret' => 'abc', 'scope' => 'read', 'label' => '', 'connection_ttl' => null, 'created_at' => 1, 'expires_at' => $this->env->now + 900));
        SiteMove::apply($this->storage, $this->env->now, 'https://example.test', 'https://copy.example.test');
        foreach ($this->storage->connections as $row) {
            $this->assertSame($this->env->now, $row['revoked_at']);
        }
        $this->assertCount(0, $this->storage->pairings);
        $last = end($this->storage->audit);
        $this->assertSame('revoked', $last['event']);
        $this->assertSame("This site's address changed from https://example.test to https://copy.example.test, so its key was renewed and its connections were revoked (2).", $last['detail']);
        $this->assertSame(0, $last['noise']);
        $this->assertError('revoked', $this->call('/site/info', null, array('connectionId' => $connection)));
    }
}
