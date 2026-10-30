<?php
/**
 * The exact text each side signs or proves, and the am_auth field. Mirrors
 * packages/core/src/deploy/wordpress/canonical.ts line for line. Lines are joined with "\n" and
 * there is no trailing newline.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Auth;

use Runova\Connector\Protocol;
use Runova\Connector\Support\Text;

final class Canonical
{
    const HEX_SHA256 = '/^[0-9a-f]{64}$/D';
    /** 16 random bytes, base64url without padding. */
    const NONCE = '/^[A-Za-z0-9_-]{22}$/D';
    /** An Ed25519 signature: 64 bytes, base64url without padding. */
    const SIGNATURE = '/^[A-Za-z0-9_-]{86}$/D';
    /** Starts with a letter or digit, so it can never be the "-" that means "no connection". */
    const CONNECTION_ID = '/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/D';
    const TIMESTAMP = '/^[0-9]{1,12}$/D';

    public static function isNonce(string $value): bool
    {
        return preg_match(self::NONCE, $value) === 1;
    }

    public static function isConnectionId(string $value): bool
    {
        return preg_match(self::CONNECTION_ID, $value) === 1;
    }

    /** What the desktop signs for every request. */
    public static function request(string $route, int $timestamp, string $nonce, ?string $connectionId, string $bodySha256): string
    {
        return implode("\n", array(
            Protocol::PREFIX,
            self::line('The route', $route),
            self::timestamp($timestamp),
            self::line('The nonce', $nonce),
            $connectionId === null ? '-' : self::line('The connection id', $connectionId),
            self::hash($bodySha256),
        ));
    }

    /** What the plugin signs with the site key for every reply. */
    public static function response(string $route, string $requestNonce, ?string $connectionId, int $timestamp, int $httpStatus, string $bodySha256): string
    {
        if ($httpStatus < 100 || $httpStatus > 599) {
            throw new \InvalidArgumentException('An HTTP status runs from 100 to 599.');
        }
        return implode("\n", array(
            Protocol::PREFIX . '/response',
            self::line('The route', $route),
            self::line('The nonce', $requestNonce),
            $connectionId === null ? '-' : self::line('The connection id', $connectionId),
            self::timestamp($timestamp),
            (string) $httpStatus,
            self::hash($bodySha256),
        ));
    }

    /** What the pair proof is an HMAC of, keyed with the pairing secret. */
    public static function pair(string $pairingId, string $desktopPublicKey, string $deviceName, int $timestamp, string $nonce): string
    {
        return implode("\n", array(
            Protocol::PREFIX . '/pair',
            self::line('The pairing id', $pairingId),
            self::line('The public key', $desktopPublicKey),
            self::line('The device name', $deviceName),
            self::timestamp($timestamp),
            self::line('The nonce', $nonce),
        ));
    }

    /** 1 to 64 characters, no control characters. */
    public static function isValidDeviceName(string $value): bool
    {
        $length = Text::codePoints($value);
        return $length !== null && $length >= 1 && $length <= 64 && !Text::hasControl($value);
    }

    public static function formatAuth(?string $connectionId, int $timestamp, string $nonce, ?string $signature): string
    {
        if ($connectionId !== null && !self::isConnectionId($connectionId)) {
            throw new \InvalidArgumentException('That connection id cannot go in am_auth.');
        }
        if (!self::isNonce($nonce)) {
            throw new \InvalidArgumentException('A nonce is 16 bytes, base64url.');
        }
        if ($signature !== null && preg_match(self::SIGNATURE, $signature) !== 1) {
            throw new \InvalidArgumentException('A signature is 64 bytes, base64url.');
        }
        return implode('.', array(
            'v1',
            $connectionId === null ? '-' : $connectionId,
            self::timestamp($timestamp),
            $nonce,
            $signature === null ? '-' : $signature,
        ));
    }

    /**
     * Null for anything that is not exactly `v1.<connectionId>.<timestamp>.<nonce>.<signature>`.
     *
     * @return array{connectionId: ?string, timestamp: int, nonce: string, signature: ?string}|null
     */
    public static function parseAuth(string $value): ?array
    {
        $parts = explode('.', $value);
        if (count($parts) !== 5 || $parts[0] !== 'v1') {
            return null;
        }
        list(, $connection, $timestamp, $nonce, $signature) = $parts;
        if ($connection !== '-' && !self::isConnectionId($connection)) {
            return null;
        }
        if (preg_match(self::TIMESTAMP, $timestamp) !== 1) {
            return null;
        }
        if (!self::isNonce($nonce)) {
            return null;
        }
        if ($signature !== '-' && preg_match(self::SIGNATURE, $signature) !== 1) {
            return null;
        }
        return array(
            'connectionId' => $connection === '-' ? null : $connection,
            'timestamp' => (int) $timestamp,
            'nonce' => $nonce,
            'signature' => $signature === '-' ? null : $signature,
        );
    }

    private static function line(string $name, string $value): string
    {
        if ($value === '' || strpbrk($value, "\r\n") !== false) {
            throw new \InvalidArgumentException($name . ' cannot be empty or hold a line break.');
        }
        return $value;
    }

    private static function timestamp(int $value): string
    {
        if ($value < 0 || $value > 999999999999) {
            throw new \InvalidArgumentException('A timestamp must be whole Unix seconds.');
        }
        return (string) $value;
    }

    private static function hash(string $value): string
    {
        if (preg_match(self::HEX_SHA256, $value) !== 1) {
            throw new \InvalidArgumentException('A body hash must be lowercase hex SHA-256.');
        }
        return $value;
    }
}
