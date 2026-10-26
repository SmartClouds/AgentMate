<?php
/**
 * Connection keys and /pair: success, single use, expiry, burning after five wrong proofs, the
 * secret being forgotten, and the request signature checked against the key in the body.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Tests\Unit;

use Runova\Connector\Audit\AuditLog;
use Runova\Connector\Auth\Canonical;
use Runova\Connector\Auth\ConnectionKey;
use Runova\Connector\Auth\KeyService;
use Runova\Connector\Crypto\Base64Url;
use Runova\Connector\Crypto\Crypto;
use Runova\Connector\Tests\Support\TestCase;

final class PairingTest extends TestCase
{
    protected function setUp(): void
    {
        parent::setUp();
        $this->makeSite();
    }

    /**
     * @return array<string, mixed> the parsed key
     */
    private function newKey(string $scope = 'write', string $label = '', ?int $days = null): array
    {
        $service = new KeyService($this->storage, $this->env, $this->siteKeys, new AuditLog($this->storage));
        $created = $service->create($scope, $label, $days, 7, '198.51.100.1');
        $parsed = ConnectionKey::parse($created['key'], $this->env->now);
        $this->assertTrue($parsed['ok']);
        return $parsed['key'];
    }

    /**
     * @param array<string, mixed> $key
     * @param array<string, mixed> $options proofSecret, deviceName, publicKey, secretKey, timestamp, nonce
     * @return array<string, mixed>
     */
    private function pair(array $key, array $options = array()): array
    {
        $timestamp = isset($options['timestamp']) ? $options['timestamp'] : $this->env->now;
        $nonce = isset($options['nonce']) ? $options['nonce'] : self::nonce();
        $device = isset($options['deviceName']) ? $options['deviceName'] : 'Laptop café ✓';
        $publicKey = isset($options['publicKey']) ? $options['publicKey'] : Base64Url::encode($this->desktop['public']);
        $secret = isset($options['proofSecret']) ? $options['proofSecret'] : (string) Base64Url::decode($key['pairingSecret']);
        try {
            $proof = Base64Url::encode(Crypto::hmac($secret, Canonical::pair($key['pairingId'], $publicKey, $device, $timestamp, $nonce)));
        } catch (\InvalidArgumentException $unsignable) {
            $proof = Base64Url::encode(random_bytes(32));
        }
        $body = array('pairingId' => $key['pairingId'], 'desktopPublicKey' => $publicKey, 'deviceName' => $device, 'proof' => $proof);
        $call = array('timestamp' => $timestamp, 'nonce' => $nonce);
        if (isset($options['secretKey'])) {
            $call['secretKey'] = $options['secretKey'];
        }
        return $this->call('/pair', $body, $call);
    }

    public function testKeyFormatAndFirstPairing(): void
    {
        $key = $this->newKey('write', '  Staging  ', 30);
        $this->assertSame('https://example.test', $key['siteUrl']);
        $this->assertSame('https://example.test/wp-json/runova/v1', $key['restUrl']);
        $this->assertSame('https://example.test/wp-admin/admin-ajax.php', $key['ajaxUrl']);
        $this->assertSame(self::vectors()['keys']['site']['publicKey'], $key['sitePublicKey']);
        $this->assertSame('write', $key['scope']);
        $this->assertSame($this->env->now + 900, $key['expiresAt']);
        $this->assertSame('Staging', $key['label']);

        $data = $this->assertOk($this->pair($key));
        $this->assertSame('write', $data['scope']);
        $this->assertSame('Staging', $data['label']);
        $this->assertSame($this->env->now + 30 * 86400, $data['expiresAt']);
        $this->assertSame('Test Site', $data['siteName']);
        $this->assertSame($this->env->now, $data['serverTime']);
        $this->assertTrue(Canonical::isConnectionId($data['connectionId']));

        $connection = $this->storage->getConnection($data['connectionId']);
        $this->assertSame(Base64Url::encode($this->desktop['public']), $connection['public_key']);
        $this->assertSame('Laptop café ✓', $connection['device_name']);
        $this->assertSame(7, $connection['created_by']);

        $pairing = $this->storage->getPairing($key['pairingId']);
        $this->assertNull($pairing['secret'], 'The secret is forgotten once used.');
        $this->assertSame($this->env->now, $pairing['used_at']);

        // The new connection works straight away.
        $this->assertOk($this->call('/site/info', null, array('connectionId' => $data['connectionId'])));
        $events = array_column($this->storage->audit, 'event');
        $this->assertSame(array('keyCreated', 'paired'), $events);
    }

    public function testDeviceNameIsTheLabelWhenTheKeyHasNone(): void
    {
        $key = $this->newKey('read');
        $this->assertArrayNotHasKey('label', $key);
        $data = $this->assertOk($this->pair($key, array('deviceName' => 'Studio Mac')));
        $this->assertSame('Studio Mac', $data['label']);
        $this->assertNull($data['expiresAt']);
        $this->assertSame('read', $data['scope']);
    }

    public function testAKeyPairsOnlyOnce(): void
    {
        $key = $this->newKey();
        $this->assertOk($this->pair($key));
        $this->assertError('pairingInvalid', $this->pair($key), 401);
        $this->assertCount(1, $this->storage->connections);
    }

    public function testExpiredKey(): void
    {
        $key = $this->newKey();
        $this->env->now += 900;
        $this->assertError('pairingExpired', $this->pair($key), 410);
        $this->assertCount(0, $this->storage->connections);
    }

    public function testUnknownPairing(): void
    {
        $key = $this->newKey();
        $key['pairingId'] = Crypto::uuid4();
        $this->assertError('pairingInvalid', $this->pair($key));
    }

    public function testFiveWrongProofsBurnThePairing(): void
    {
        $key = $this->newKey();
        for ($attempt = 1; $attempt <= 5; $attempt++) {
            $this->assertError('pairingInvalid', $this->pair($key, array('proofSecret' => str_repeat("\x01", 32))));
        }
        $pairing = $this->storage->getPairing($key['pairingId']);
        $this->assertTrue($pairing['burned']);
        $this->assertNull($pairing['secret']);
        // Even the right proof is refused now.
        $this->assertError('pairingInvalid', $this->pair($key));
        $this->assertCount(0, $this->storage->connections);
        $this->assertContains('pairFailed', array_column($this->storage->audit, 'event'));
    }

    public function testFourWrongProofsStillLeaveTheKeyUsable(): void
    {
        $key = $this->newKey();
        for ($attempt = 1; $attempt <= 4; $attempt++) {
            $this->pair($key, array('proofSecret' => str_repeat("\x01", 32)));
        }
        $this->assertOk($this->pair($key));
    }

    public function testRequestMustBeSignedByTheKeyInTheBody(): void
    {
        $key = $this->newKey();
        $other = Crypto::keypairFromSeed(str_repeat("\x09", 32));
        $this->assertError('badSignature', $this->pair($key, array('secretKey' => $other['secret'])));
        $this->assertSame(1, $this->storage->getPairing($key['pairingId'])['attempts']);
        $this->assertCount(0, $this->storage->connections);
    }

    public function testStaleTimestamp(): void
    {
        $key = $this->newKey();
        $result = $this->pair($key, array('timestamp' => $this->env->now - 400));
        $this->assertError('staleTimestamp', $result);
        $this->assertSame($this->env->now, $result['body']['error']['details']['serverTime']);
    }

    public function testBadFields(): void
    {
        $key = $this->newKey();
        $this->assertError('badRequest', $this->pair($key, array('deviceName' => "bad\nname")));
        $this->assertError('badRequest', $this->pair($key, array('publicKey' => 'short')));
        $this->assertError('badRequest', $this->call('/pair', array('pairingId' => $key['pairingId'])));
    }

    public function testPairRequestNamingAConnectionIsRefused(): void
    {
        $key = $this->newKey();
        $result = $this->call('/pair', array('pairingId' => $key['pairingId']), array('connectionId' => $this->connect()));
        $this->assertError('unauthorized', $result);
    }

    public function testOversizedPairBundleIsRefusedBeforeItIsOpened(): void
    {
        $key = $this->newKey();
        $big = random_bytes(70000);
        $result = $this->call('/pair', array('pairingId' => $key['pairingId']), array('blobs' => array($big)));
        $this->assertError('tooLarge', $result, 413);
    }

    public function testDisabledSiteDoesNotUseUpTheKey(): void
    {
        $key = $this->newKey();
        $this->env->constants['RUNOVA_CONNECTOR_DISABLED'] = true;
        $this->assertError('disabled', $this->pair($key));
        $this->env->constants = array();
        $this->assertOk($this->pair($key));
    }

    public function testKeyServiceValidation(): void
    {
        $service = new KeyService($this->storage, $this->env, $this->siteKeys, new AuditLog($this->storage));
        foreach (array(array('admin', '', null), array('read', str_repeat('x', 101), null), array('read', "a\nb", null), array('read', '', 0), array('read', '', 3651)) as $case) {
            try {
                $service->create($case[0], $case[1], $case[2], 1, '');
                $this->fail('Should refuse ' . json_encode($case));
            } catch (\InvalidArgumentException $expected) {
                $this->assertNotSame('', $expected->getMessage());
            }
        }
        $this->assertCount(0, $this->storage->pairings);
    }

    public function testAuditNeverHoldsTheSecret(): void
    {
        $key = $this->newKey('write', 'Office');
        $this->pair($key, array('proofSecret' => str_repeat("\x01", 32)));
        $this->pair($key);
        $dump = json_encode($this->storage->audit);
        $this->assertStringNotContainsString($key['pairingSecret'], (string) $dump);
    }

    public function testOldPairingsAreCleanedUp(): void
    {
        $key = $this->newKey();
        $this->env->now += 86400 + 1000;
        $this->newKey();
        $this->assertNull($this->storage->getPairing($key['pairingId']));
    }
}
