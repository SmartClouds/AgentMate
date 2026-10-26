<?php
/**
 * base64url without padding (RFC 4648 section 5), strict: one accepted spelling per byte string.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Crypto;

final class Base64Url
{
    public static function encode(string $bytes): string
    {
        return rtrim(strtr(base64_encode($bytes), '+/', '-_'), '=');
    }

    /**
     * Null for padding, other alphabets, a length that cannot be base64, or stray low bits in the
     * last character.
     */
    public static function decode(string $text): ?string
    {
        $length = strlen($text);
        if ($length % 4 === 1) {
            return null;
        }
        if ($length === 0) {
            return '';
        }
        if (!preg_match('/^[A-Za-z0-9_-]+$/D', $text)) {
            return null;
        }
        $padded = strtr($text, '-_', '+/') . str_repeat('=', (4 - $length % 4) % 4);
        $bytes = base64_decode($padded, true);
        if ($bytes === false) {
            return null;
        }
        // Re-encoding catches non-zero unused bits, which base64_decode lets through.
        return self::encode($bytes) === $text ? $bytes : null;
    }

    /**
     * True when $text is base64url of exactly $length bytes.
     *
     * @param mixed $text
     */
    public static function isBytes($text, int $length): bool
    {
        if (!is_string($text)) {
            return false;
        }
        $bytes = self::decode($text);
        return $bytes !== null && strlen($bytes) === $length;
    }
}
