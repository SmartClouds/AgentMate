<?php
/**
 * Creates one-time connection keys (wp-admin and WP-CLI). A key is good once, for 15 minutes.
 * Its secret is stored only until the key is used, burned or expired, and never logged.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Auth;

use Runova\Connector\Audit\AuditLog;
use Runova\Connector\Crypto\Base64Url;
use Runova\Connector\Crypto\Crypto;
use Runova\Connector\Crypto\SiteKeys;
use Runova\Connector\Env\Environment;
use Runova\Connector\Protocol;
use Runova\Connector\Storage\Storage;
use Runova\Connector\Support\Text;

final class KeyService
{
    const MAX_LABEL = 100;
    const MAX_DAYS = 3650;

    /** @var Storage */
    private $storage;

    /** @var Environment */
    private $env;

    /** @var SiteKeys */
    private $keys;

    /** @var AuditLog */
    private $audit;

    public function __construct(Storage $storage, Environment $env, SiteKeys $keys, AuditLog $audit)
    {
        $this->storage = $storage;
        $this->env = $env;
        $this->keys = $keys;
        $this->audit = $audit;
    }

    /** Trims a label and checks it. Null when it cannot be used. */
    public static function cleanLabel(string $label): ?string
    {
        $label = Text::jsTrim($label);
        if ($label === null || Text::hasControl($label) || Text::codePoints($label) > self::MAX_LABEL) {
            return null;
        }
        // Shown in wp-admin, WP-CLI and Runova: nothing that could make it read as something else.
        return Text::displaySafe($label, self::MAX_LABEL);
    }

    /**
     * @param string $scope read or write
     * @param int|null $days how long the connection lasts after pairing; null for no expiry
     * @return array{key: string, expiresAt: int, pairingId: string}
     */
    public function create(string $scope, string $label, ?int $days, int $userId, string $ip): array
    {
        if ($scope !== 'read' && $scope !== 'write') {
            throw new \InvalidArgumentException('The scope is read or write.');
        }
        $clean = self::cleanLabel($label);
        if ($clean === null) {
            throw new \InvalidArgumentException('A label is up to 100 characters, with no line breaks.');
        }
        if ($days !== null && ($days < 1 || $days > self::MAX_DAYS)) {
            throw new \InvalidArgumentException('A connection lasts from 1 to 3650 days.');
        }
        $now = $this->env->now();
        $this->storage->deletePairingsExpiredBefore($now - 86400);
        $pairingId = Crypto::uuid4();
        $secret = Base64Url::encode(Crypto::randomBytes(32));
        $expiresAt = $now + Protocol::PAIRING_TTL_SECONDS;
        $this->storage->insertPairing(array(
            'id' => $pairingId,
            'secret' => $secret,
            'scope' => $scope,
            'label' => $clean,
            'connection_ttl' => $days === null ? null : $days * 86400,
            'created_at' => $now,
            'expires_at' => $expiresAt,
            'attempts' => 0,
            'burned' => false,
            'used_at' => null,
            'created_by' => $userId,
        ));
        $key = array(
            'siteUrl' => $this->env->homeUrl(),
            'restUrl' => $this->env->restUrl(),
            'ajaxUrl' => $this->env->ajaxUrl(),
            'pairingId' => $pairingId,
            'pairingSecret' => $secret,
            'sitePublicKey' => $this->keys->publicKeyBase64(),
            'scope' => $scope,
            'expiresAt' => $expiresAt,
        );
        if ($clean !== '') {
            $key['label'] = $clean;
        }
        $detail = 'Created a ' . $scope . ' key'
            . ($clean !== '' ? ' labelled "' . $clean . '"' : '')
            . ($days === null ? ', no connection expiry.' : ', connection lasts ' . $days . ' days.');
        $this->audit->add('keyCreated', $now, $ip, $detail);
        return array('key' => ConnectionKey::format($key), 'expiresAt' => $expiresAt, 'pairingId' => $pairingId);
    }
}
