<?php
/**
 * /pair: turns a one-time connection key into a connection. The checks, in order: the request
 * names no connection and is on time; the pairing exists, is not used or burned, and has not
 * expired; the HMAC proof matches (5 misses burn the pairing); the request is signed by the
 * desktop key in the body; the nonce is new. Only then is the pairing used up, its secret
 * forgotten, and the connection created.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Auth;

use Runova\Connector\Audit\AuditLog;
use Runova\Connector\Crypto\Base64Url;
use Runova\Connector\Crypto\Crypto;
use Runova\Connector\Env\Environment;
use Runova\Connector\Http\ApiError;
use Runova\Connector\Http\Bundle;
use Runova\Connector\Http\BundleReader;
use Runova\Connector\Protocol;
use Runova\Connector\Storage\Storage;
use Runova\Connector\Support\Text;

final class Pairing
{
    /** @var Storage */
    private $storage;

    /** @var Environment */
    private $env;

    /** @var AuditLog */
    private $audit;

    public function __construct(Storage $storage, Environment $env, AuditLog $audit)
    {
        $this->storage = $storage;
        $this->env = $env;
        $this->audit = $audit;
    }

    /**
     * @param array{connectionId: ?string, timestamp: int, nonce: string, signature: ?string} $auth
     * @return array<string, mixed> the WpPairResponse
     */
    public function pair(array $auth, ?Bundle $bundle, string $ip): array
    {
        $now = $this->env->now();
        if ($auth['connectionId'] !== null || $auth['signature'] === null) {
            throw ApiError::auth('unauthorized', 'A pair request names no connection and is signed with the new key.');
        }
        if (abs($now - $auth['timestamp']) > Protocol::TIMESTAMP_WINDOW_SECONDS) {
            throw ApiError::auth('staleTimestamp', 'The request time is too far from the site clock.', array('serverTime' => $now));
        }
        if ($bundle === null) {
            throw ApiError::badRequest('The request has no bundle.');
        }
        $limit = Protocol::MAX_UNAUTHENTICATED_BUNDLE_BYTES;
        $frame = BundleReader::open($bundle, Protocol::ROUTES['pair'], $limit, $limit);
        $body = $frame->body;
        $pairingId = is_array($body) && isset($body['pairingId']) ? $body['pairingId'] : null;
        $publicKey = is_array($body) && isset($body['desktopPublicKey']) ? $body['desktopPublicKey'] : null;
        $deviceName = is_array($body) && isset($body['deviceName']) ? $body['deviceName'] : null;
        $proof = is_array($body) && isset($body['proof']) ? $body['proof'] : null;
        if (
            !is_string($pairingId) || preg_match(ConnectionKey::PAIRING_ID, $pairingId) !== 1
            || !Base64Url::isBytes($publicKey, 32)
            || !is_string($deviceName) || !Canonical::isValidDeviceName($deviceName)
            || !Base64Url::isBytes($proof, 32)
        ) {
            throw ApiError::badRequest('The pair request is missing a field or has one in the wrong form.');
        }

        $pairing = $this->storage->getPairing($pairingId);
        if ($pairing === null) {
            throw ApiError::auth('pairingInvalid', 'This site does not know that connection key. Create a new one in wp-admin.');
        }
        if ($pairing['burned'] || $pairing['used_at'] !== null || $pairing['secret'] === null) {
            throw ApiError::auth('pairingInvalid', 'That connection key was already used or has been locked. Create a new one.');
        }
        if ($pairing['expires_at'] <= $now) {
            throw ApiError::auth('pairingExpired', 'That connection key has expired. Create a new one.');
        }

        $secret = Base64Url::decode($pairing['secret']);
        $given = Base64Url::decode($proof);
        if ($secret === null || $given === null || !hash_equals(Crypto::hmac($secret, Canonical::pair($pairingId, $publicKey, $deviceName, $auth['timestamp'], $auth['nonce'])), $given)) {
            $this->failAttempt($pairing, $ip, $now);
            throw ApiError::auth('pairingInvalid', 'The connection key proof did not match.');
        }

        $signature = Base64Url::decode((string) $auth['signature']);
        $text = Canonical::request(Protocol::ROUTES['pair'], $auth['timestamp'], $auth['nonce'], null, $bundle->sha256());
        if ($signature === null || !Crypto::verify($signature, $text, (string) Base64Url::decode($publicKey))) {
            $this->failAttempt($pairing, $ip, $now);
            throw ApiError::auth('badSignature', 'The pair request is not signed by the key it carries.');
        }
        if (!$this->storage->insertNonce(hash('sha256', "pair\n" . $auth['nonce']), $now + 2 * Protocol::TIMESTAMP_WINDOW_SECONDS + 60)) {
            throw ApiError::auth('replayed', 'This request was already used.');
        }
        if ($this->env->constantOn('RUNOVA_CONNECTOR_DISABLED')) {
            throw new ApiError('disabled', 'Runova Connector is switched off in wp-config.php.');
        }
        if (!$this->storage->usePairing($pairingId, $now)) {
            throw ApiError::auth('pairingInvalid', 'That connection key was already used.');
        }

        // The device name is whatever the other side sent: keep only what is safe to show.
        $device = Text::displaySafe($deviceName, 64);
        if ($device === '') {
            $device = 'Unnamed device';
        }
        $label = Text::displaySafe($pairing['label'], KeyService::MAX_LABEL);
        $connection = array(
            'id' => Crypto::uuid4(),
            'label' => $label !== '' ? $label : $device,
            'scope' => $pairing['scope'],
            'public_key' => $publicKey,
            'device_name' => $device,
            'created_at' => $now,
            'expires_at' => $pairing['connection_ttl'] !== null ? $now + $pairing['connection_ttl'] : null,
            'revoked_at' => null,
            'last_seen_at' => $now,
            'last_ip' => $ip,
            'created_by' => $pairing['created_by'],
        );
        $this->storage->insertConnection($connection);
        $connection = $this->storage->getConnection($connection['id']);
        if ($connection === null) {
            throw new \RuntimeException('The new connection was not saved.');
        }
        $this->audit->add('paired', $now, $ip, 'Paired "' . $device . '" with ' . $connection['scope'] . ' access.', $connection);

        return array(
            'connectionId' => $connection['id'],
            'scope' => $connection['scope'],
            'label' => $connection['label'],
            'expiresAt' => $connection['expires_at'],
            'siteName' => $this->env->siteName(),
            'serverTime' => $now,
        );
    }

    /**
     * @param array<string, mixed> $pairing
     */
    private function failAttempt(array $pairing, string $ip, int $now): void
    {
        $attempts = $this->storage->addPairingAttempt($pairing['id']);
        if ($attempts >= Protocol::PAIRING_MAX_ATTEMPTS) {
            $this->storage->burnPairing($pairing['id']);
            $this->audit->add('pairFailed', $now, $ip, 'A connection key was locked after ' . $attempts . ' wrong proofs.');
        }
    }
}
