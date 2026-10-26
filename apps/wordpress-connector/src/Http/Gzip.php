<?php
/**
 * Gzip with a hard ceiling on what a payload may inflate to, so a small upload cannot become a
 * huge string in memory.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Http;

final class Gzip
{
    public static function encode(string $bytes, int $level = 6): string
    {
        $out = gzencode($bytes, $level);
        if (!is_string($out)) {
            throw new \RuntimeException('gzip failed.');
        }
        return $out;
    }

    /**
     * The size the gzip trailer claims (modulo 2^32). Only a hint: a forged trailer is still caught
     * by the limit in decode().
     */
    public static function claimedSize(string $gzip): ?int
    {
        if (strlen($gzip) < 18 || substr($gzip, 0, 2) !== "\x1f\x8b") {
            return null;
        }
        $unpacked = unpack('V', substr($gzip, -4));
        return is_array($unpacked) ? $unpacked[1] : null;
    }

    /**
     * Null for anything that is not gzip, or that would inflate past $maxBytes.
     */
    public static function decode(string $gzip, int $maxBytes): ?string
    {
        if (strlen($gzip) < 18 || substr($gzip, 0, 2) !== "\x1f\x8b") {
            return null;
        }
        // gzdecode warns when the limit is hit; the null return is the answer.
        $out = @gzdecode($gzip, $maxBytes); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
        if (!is_string($out) || strlen($out) > $maxBytes) {
            return null;
        }
        return $out;
    }
}
