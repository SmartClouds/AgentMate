<?php
/**
 * The authentication order, replay protection, kill switches and the signed replies.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Tests\Unit;

use Runova\Connector\Auth\Canonical;
use Runova\Connector\Crypto\Base64Url;
use Runova\Connector\Crypto\Crypto;
use Runova\Connector\Http\Envelope;
use Runova\Connector\Http\Gzip;
use Runova\Connector\Http\IncomingRequest;
use Runova\Connector\Http\StringBundle;
use Runova\Connector\Tests\Support\TestCase;

final class AuthTest extends TestCase
{
    protected function setUp(): void
    {
        parent::setUp();
        $this->makeSite();
    }

    public function testHelloIsUnsignedAndItsReplyIsSigned(): void
    {
        $data = $this->assertOk($this->call('/hello', null, array('unsigned' => true, 'timestamp' => 0)));
        $this->assertSame(1, $data['protocol']);
        $this->assertSame('1.0.0', $data['pluginVersion']);
        $this->assertSame(self::vectors()['keys']['site']['publicKey'], $data['sitePublicKey']);
        $this->assertSame($this->env->now, $data['serverTime']);
        $this->assertSame('Test Site', $data['siteName']);
        $this->assertFalse($data['multisite']);
        $this->assertNull($data['rescueUrl']);
        $this->assertContains('read', $data['capabilities']);
        $this->assertSame('application/octet-stream', $this->call('/hello', null, array('unsigned' => true))['response']->headers['Content-Type']);
    }

    public function testSignedReadRouteSucceeds(): void
    {
        $connection = $this->connect();
        $data = $this->assertOk($this->call('/site/info', null, array('connectionId' => $connection)));
        $this->assertSame($connection, $data['connection']['id']);
        $this->assertSame($this->env->now, $this->storage->getConnection($connection)['last_seen_at']);
    }

    public function testReplayedNonceIsRefused(): void
    {
        $connection = $this->connect();
        $nonce = self::nonce();
        $this->assertOk($this->call('/site/info', null, array('connectionId' => $connection, 'nonce' => $nonce)));
        $this->assertError('replayed', $this->call('/site/info', null, array('connectionId' => $connection, 'nonce' => $nonce)), 401);
    }

    public function testAForgedRequestDoesNotBurnItsNonce(): void
    {
        $connection = $this->connect();
        $nonce = self::nonce();
        $other = Crypto::keypairFromSeed(str_repeat("\x07", 32));
        $this->assertError('badSignature', $this->call('/site/info', null, array('connectionId' => $connection, 'nonce' => $nonce, 'secretKey' => $other['secret'])), 401);
        $this->assertOk($this->call('/site/info', null, array('connectionId' => $connection, 'nonce' => $nonce)));
    }

    public function testStaleTimestampCarriesServerTime(): void
    {
        $connection = $this->connect();
        $result = $this->call('/site/info', null, array('connectionId' => $connection, 'timestamp' => $this->env->now - 301));
        $this->assertError('staleTimestamp', $result, 401);
        $this->assertSame($this->env->now, $result['body']['error']['details']['serverTime']);
        $this->assertOk($this->call('/site/info', null, array('connectionId' => $connection, 'timestamp' => $this->env->now + 300)));
    }

    public function testTamperedBundleFailsTheSignature(): void
    {
        $connection = $this->connect();
        $nonce = self::nonce();
        $bundle = self::bundle('/site/info', new \stdClass());
        $text = Canonical::request('/site/info', $this->env->now, $nonce, $connection, hash('sha256', $bundle));
        $auth = Canonical::formatAuth($connection, $this->env->now, $nonce, Base64Url::encode(Crypto::sign($text, $this->desktop['secret'])));
        $other = self::bundle('/site/info', array('x' => 1));
        $result = $this->call('/site/info', null, array('connectionId' => $connection, 'nonce' => $nonce, 'auth' => $auth, 'bundle' => $other));
        $this->assertError('badSignature', $result);
    }

    public function testSignatureForAnotherRouteFails(): void
    {
        $connection = $this->connect();
        $nonce = self::nonce();
        $bundle = self::bundle('/items/list', new \stdClass());
        $text = Canonical::request('/site/info', $this->env->now, $nonce, $connection, hash('sha256', $bundle));
        $auth = Canonical::formatAuth($connection, $this->env->now, $nonce, Base64Url::encode(Crypto::sign($text, $this->desktop['secret'])));
        $this->assertError('badSignature', $this->call('/items/list', null, array('connectionId' => $connection, 'nonce' => $nonce, 'auth' => $auth, 'bundle' => $bundle)));
    }

    public function testFrameMustBeForTheRouteThatWasCalled(): void
    {
        $connection = $this->connect();
        $bundle = self::bundle('/items/list', new \stdClass());
        $this->assertError('badRequest', $this->call('/site/info', null, array('connectionId' => $connection, 'bundle' => $bundle)), 400);
    }

    public function testUnknownRevokedAndExpiredConnections(): void
    {
        $unknown = Crypto::uuid4();
        $this->assertError('unknownConnection', $this->call('/site/info', null, array('connectionId' => $unknown)), 401);

        $revoked = $this->connect('read', array('revoked_at' => $this->env->now - 5));
        $this->assertError('revoked', $this->call('/site/info', null, array('connectionId' => $revoked)));

        $expired = $this->connect('read', array('expires_at' => $this->env->now));
        $result = $this->call('/site/info', null, array('connectionId' => $expired));
        $this->assertError('revoked', $result);
        $this->assertTrue($result['body']['error']['details']['expired']);
    }

    public function testMissingOrGarbledAuthIsUnauthorized(): void
    {
        $result = $this->dispatcher()->handle(new IncomingRequest('/site/info', null, new StringBundle(self::bundle('/site/info', new \stdClass())), '203.0.113.9'));
        $opened = $this->open($result, '/site/info', '-', null);
        $this->assertError('unauthorized', $opened, 401);

        $result = $this->dispatcher()->handle(new IncomingRequest('/site/info', 'v1.nope', null, '203.0.113.9'));
        $this->assertError('unauthorized', $this->open($result, '/site/info', '-', null));
    }

    public function testUnknownRouteIsABadRequest(): void
    {
        $result = $this->dispatcher()->handle(new IncomingRequest('/nope', null, null, '203.0.113.9'));
        $this->assertSame(400, $result->status);
        $envelope = Envelope::decode($result->body);
        // Signed over '-' for the route and nonce, since neither is known.
        $text = Canonical::response('-', '-', null, $envelope['meta']['ts'], 400, hash('sha256', $envelope['payload']));
        $this->assertTrue(Crypto::verify((string) Base64Url::decode($envelope['meta']['sig']), $text, $this->siteKeys->publicKey()));
        // An unknown route is not an auth failure.
        $this->assertCount(0, $this->storage->audit);
    }

    public function testReadOnlyScopeIsRefusedOnWriteRoutes(): void
    {
        $connection = $this->connect('read');
        foreach (array('/deploy/begin', '/deploy/upload', '/deploy/commit', '/deploy/verify', '/deploy/finalize', '/deploy/rollback', '/deploy/abort', '/connector/update', '/rescue/rollback') as $route) {
            $this->assertError('readOnly', $this->call($route, array('deployId' => 'x'), array('connectionId' => $connection)), 403);
        }
    }

    public function testWriteRoutesReachTheDeployServiceAfterAuth(): void
    {
        $connection = $this->connect('write');
        $result = $this->call('/deploy/begin', array('label' => 'x', 'items' => array(), 'ops' => array()), array('connectionId' => $connection));
        $this->assertError('badRequest', $result, 400);
    }

    public function testKillSwitches(): void
    {
        $write = $this->connect('write');
        $read = $this->connect('read');

        $this->env->constants['RUNOVA_CONNECTOR_DISABLED'] = true;
        $this->assertError('disabled', $this->call('/site/info', null, array('connectionId' => $read)), 503);
        $this->assertError('disabled', $this->call('/hello', null, array('unsigned' => true)), 503);
        $this->env->constants = array();

        $this->env->constants['RUNOVA_CONNECTOR_READ_ONLY'] = true;
        $result = $this->call('/deploy/begin', new \stdClass(), array('connectionId' => $write));
        $this->assertError('readOnly', $result, 403);
        $this->assertTrue($result['body']['error']['details']['byConstant']);
        $this->assertOk($this->call('/site/info', null, array('connectionId' => $read)));
        $this->env->constants = array();

        $this->env->fileModsAllowed = false;
        $this->assertError('fileModsDisabled', $this->call('/deploy/begin', new \stdClass(), array('connectionId' => $write)), 403);
        $this->env->fileModsAllowed = true;

        $this->env->filesystemMethod = 'ftpext';
        $result = $this->call('/deploy/begin', new \stdClass(), array('connectionId' => $write));
        $this->assertError('notDirect', $result, 403);
        $this->assertSame('ftpext', $result['body']['error']['details']['method']);
    }

    public function testErrorsAreSignedWithTheConnectionTheRequestNamed(): void
    {
        $unknown = Crypto::uuid4();
        // open() verifies the signature over this connection id and nonce.
        $result = $this->call('/site/info', null, array('connectionId' => $unknown));
        $this->assertNotSame('', $result['meta']['sig']);
    }

    public function testTooLargeBodyIsASignedTooLargeError(): void
    {
        $connection = $this->connect();
        $result = $this->call('/site/info', null, array('connectionId' => $connection, 'tooLarge' => true));
        $this->assertError('tooLarge', $result, 413);
        $this->assertSame(1677721, $result['body']['error']['details']['maxRequestBytes']);
        $this->assertNotSame('', $result['meta']['sig']);
    }

    public function testRevokeRoute(): void
    {
        $connection = $this->connect();
        $data = $this->assertOk($this->call('/connection/revoke', null, array('connectionId' => $connection)));
        $this->assertSame(array('revoked' => true), $data);
        $this->assertSame($this->env->now, $this->storage->getConnection($connection)['revoked_at']);
        $this->assertError('revoked', $this->call('/site/info', null, array('connectionId' => $connection)));
    }

    public function testAuditListShowsFailuresAndPagesBackwards(): void
    {
        $connection = $this->connect();
        // A refusal for a connection nobody has is not logged (the rate limiter still counts it).
        $this->call('/site/info', null, array('connectionId' => Crypto::uuid4()));
        $this->call('/site/info', null, array('connectionId' => $connection, 'timestamp' => 1));
        $this->call('/site/info', null, array('connectionId' => $connection, 'timestamp' => 2));
        $data = $this->assertOk($this->call('/audit/list', array('limit' => 10), array('connectionId' => $connection)));
        $this->assertCount(2, $data['entries']);
        $this->assertSame('authFailed', $data['entries'][0]['event']);
        $this->assertSame('staleTimestamp on /site/info', $data['entries'][0]['detail']);
        $this->assertSame('Laptop', $data['entries'][0]['connectionLabel']);
        $older = $this->assertOk($this->call('/audit/list', array('limit' => 10, 'before' => $data['entries'][0]['id']), array('connectionId' => $connection)));
        $this->assertCount(1, $older['entries']);
        $this->assertError('badRequest', $this->call('/audit/list', array('limit' => 0), array('connectionId' => $connection)));
    }

    public function testAuditLogIsCapped(): void
    {
        for ($index = 0; $index < 2005; $index++) {
            $this->storage->addAudit(array('at' => $index, 'event' => 'pulled', 'ip' => '', 'detail' => (string) $index));
        }
        $this->assertCount(2000, $this->storage->audit);
        $this->assertSame('2004', $this->storage->listAudit(1, null)[0]['detail']);
    }

    public function testInternalErrorsAreSignedAndLogged(): void
    {
        $connection = $this->connect();
        $this->env->themes = array(array('slug' => 'broken'));
        $result = $this->call('/items/list', null, array('connectionId' => $connection));
        $this->assertError('internal', $result, 500);
        $this->assertStringNotContainsString('/', $result['body']['error']['message']);
        $this->assertNotEmpty($this->logged);
    }

    public function testRawEnvelopeIsWhatTheDesktopReads(): void
    {
        $response = $this->call('/hello', null, array('unsigned' => true))['response'];
        $envelope = Envelope::decode($response->body);
        $this->assertSame(200, $envelope['meta']['status']);
        $this->assertNotNull(Gzip::decode($envelope['payload'], 1 << 20));
    }
}
