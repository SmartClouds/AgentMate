<?php
/**
 * The connection key an admin copies out of wp-admin or WP-CLI: `amwp1.` then base64url of a JSON
 * object with the keys v, u, r, a, i, s, k, c, x and l, in that order. Mirrors connectionKey.ts.
 *
 * The plugin only ever writes keys. parse() exists so the shared vectors can prove both sides read
 * the format the same way; its URL check is an approximation of the WHATWG parser.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Auth;

use Runova\Connector\Crypto\Base64Url;
use Runova\Connector\Protocol;
use Runova\Connector\Support\Text;

final class ConnectionKey
{
    const PREFIX = 'amwp1.';
    const PAIRING_ID = '/^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/D';
    const MAX_SAFE_INTEGER = 9007199254740991;

    /**
     * @param array{siteUrl: string, restUrl: string, ajaxUrl: string, pairingId: string, pairingSecret: string, sitePublicKey: string, scope: string, expiresAt: int, label?: string} $key
     */
    public static function format(array $key): string
    {
        $json = array(
            'v' => Protocol::VERSION,
            'u' => $key['siteUrl'],
            'r' => $key['restUrl'],
            'a' => $key['ajaxUrl'],
            'i' => $key['pairingId'],
            's' => $key['pairingSecret'],
            'k' => $key['sitePublicKey'],
            'c' => $key['scope'],
            'x' => $key['expiresAt'],
        );
        if (isset($key['label'])) {
            $json['l'] = $key['label'];
        }
        $text = json_encode($json, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        if (!is_string($text)) {
            throw new \InvalidArgumentException('The connection key could not be written.');
        }
        return self::PREFIX . Base64Url::encode($text);
    }

    /**
     * @return array{ok: true, key: array<string, mixed>}|array{ok: false, error: string}
     */
    public static function parse(string $text, int $now): array
    {
        $compact = Text::removeSpaces($text);
        if ($compact === null) {
            return self::fail('format');
        }
        if (strncmp($compact, 'amwp', 4) !== 0 || Text::utf16Length($compact) > 4096) {
            return self::fail('format');
        }
        if (strncmp($compact, self::PREFIX, strlen(self::PREFIX)) !== 0) {
            return self::fail('version');
        }
        $bytes = Base64Url::decode(substr($compact, strlen(self::PREFIX)));
        if ($bytes === null || !Text::isUtf8($bytes)) {
            return self::fail('format');
        }
        // JavaScript's TextDecoder drops a leading byte order mark before JSON.parse sees it.
        if (strncmp($bytes, "\xEF\xBB\xBF", 3) === 0) {
            $bytes = substr($bytes, 3);
        }
        $value = json_decode($bytes, false);
        if (json_last_error() !== JSON_ERROR_NONE || !($value instanceof \stdClass)) {
            return self::fail('format');
        }
        $raw = get_object_vars($value);
        $v = array_key_exists('v', $raw) ? $raw['v'] : null;
        if (!self::isNumber($v) || (float) $v !== (float) Protocol::VERSION) {
            return self::fail('version');
        }
        $i = array_key_exists('i', $raw) ? $raw['i'] : null;
        $s = array_key_exists('s', $raw) ? $raw['s'] : null;
        $k = array_key_exists('k', $raw) ? $raw['k'] : null;
        $c = array_key_exists('c', $raw) ? $raw['c'] : null;
        $x = array_key_exists('x', $raw) ? $raw['x'] : null;
        $hasLabel = array_key_exists('l', $raw);
        $l = $hasLabel ? $raw['l'] : null;
        if (
            !is_string($i)
            || preg_match(self::PAIRING_ID, $i) !== 1
            || !Base64Url::isBytes($s, 32)
            || !Base64Url::isBytes($k, 32)
            || ($c !== 'read' && $c !== 'write')
            || !self::isSafeInteger($x)
            || ($hasLabel && (!is_string($l) || Text::codePoints($l) > 100))
        ) {
            return self::fail('fields');
        }
        $u = array_key_exists('u', $raw) ? $raw['u'] : null;
        $r = array_key_exists('r', $raw) ? $raw['r'] : null;
        $a = array_key_exists('a', $raw) ? $raw['a'] : null;
        if (!self::isHttpUrl($u) || !self::isHttpUrl($r) || !self::isHttpUrl($a)) {
            return self::fail('url');
        }
        if ((float) $x <= $now) {
            return self::fail('expired');
        }
        $key = array(
            'siteUrl' => $u,
            'restUrl' => $r,
            'ajaxUrl' => $a,
            'pairingId' => $i,
            'pairingSecret' => $s,
            'sitePublicKey' => $k,
            'scope' => $c,
            'expiresAt' => (int) $x,
        );
        if (is_string($l)) {
            $trimmed = Text::jsTrim($l);
            if ($trimmed !== null && $trimmed !== '') {
                $key['label'] = $trimmed;
            }
        }
        return array('ok' => true, 'key' => $key);
    }

    /**
     * @param mixed $value
     */
    private static function isNumber($value): bool
    {
        return is_int($value) || is_float($value);
    }

    /**
     * Number.isSafeInteger: an int, or a float with no fraction, within 2^53 - 1 either way.
     *
     * @param mixed $value
     */
    public static function isSafeInteger($value): bool
    {
        if (is_int($value)) {
            return $value >= -self::MAX_SAFE_INTEGER && $value <= self::MAX_SAFE_INTEGER;
        }
        if (is_float($value)) {
            return is_finite($value) && floor($value) === $value && abs($value) <= self::MAX_SAFE_INTEGER;
        }
        return false;
    }

    /**
     * @param mixed $value
     */
    private static function isHttpUrl($value): bool
    {
        if (!is_string($value) || Text::utf16Length($value) === null || Text::utf16Length($value) > 2048) {
            return false;
        }
        $parts = parse_url($value);
        if (!is_array($parts) || !isset($parts['scheme'], $parts['host']) || $parts['host'] === '') {
            return false;
        }
        $scheme = strtolower($parts['scheme']);
        if ($scheme !== 'https' && $scheme !== 'http') {
            return false;
        }
        $user = isset($parts['user']) ? $parts['user'] : '';
        $pass = isset($parts['pass']) ? $parts['pass'] : '';
        return $user === '' && $pass === '';
    }

    /**
     * @return array{ok: false, error: string}
     */
    private static function fail(string $error): array
    {
        return array('ok' => false, 'error' => $error);
    }
}
