<?php
/**
 * String helpers that count and trim the way JavaScript does, so rules shared with the desktop
 * give the same answer on both sides.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Support;

final class Text
{
    /** JavaScript's \s: ASCII whitespace plus the Unicode spaces and the BOM. */
    const JS_SPACE = '[\x{0009}-\x{000D}\x{0020}\x{00A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}]';

    public static function isUtf8(string $text): bool
    {
        return preg_match('//u', $text) === 1;
    }

    /** Code points, like [...text].length. Null for invalid UTF-8. */
    public static function codePoints(string $text): ?int
    {
        if ($text === '') {
            return 0;
        }
        $count = preg_match_all('/./su', $text);
        return $count === false ? null : $count;
    }

    /** UTF-16 code units, like text.length. Null for invalid UTF-8. */
    public static function utf16Length(string $text): ?int
    {
        $points = self::codePoints($text);
        if ($points === null) {
            return null;
        }
        // Each code point above U+FFFF is four bytes in UTF-8 and two units in UTF-16.
        $astral = preg_match_all('/[\x{10000}-\x{10FFFF}]/u', $text);
        return $points + (int) $astral;
    }

    /** Drops every JavaScript whitespace character. Null for invalid UTF-8. */
    public static function removeSpaces(string $text): ?string
    {
        $out = preg_replace('/' . self::JS_SPACE . '+/u', '', $text);
        return is_string($out) ? $out : null;
    }

    /** String.prototype.trim(). Null for invalid UTF-8. */
    public static function jsTrim(string $text): ?string
    {
        $out = preg_replace('/^' . self::JS_SPACE . '+|' . self::JS_SPACE . '+$/Du', '', $text);
        return is_string($out) ? $out : null;
    }

    public static function hasControl(string $text): bool
    {
        return preg_match('/[\x00-\x1f\x7f]/', $text) === 1;
    }

    /** For text from outside that ends up in a log line: no control characters, bounded length. */
    public static function clean(string $text, int $max = 500): string
    {
        $text = (string) preg_replace('/[\x00-\x1f\x7f]+/', ' ', $text);
        if (!self::isUtf8($text)) {
            $text = (string) preg_replace('/[\x80-\xff]/', '?', $text);
        }
        // C1 controls (terminal escapes), bidi overrides and zero-width characters.
        $text = (string) preg_replace('/[\x{0080}-\x{009F}\x{061C}\x{200B}-\x{200F}\x{202A}-\x{202E}\x{2060}-\x{2069}\x{FEFF}]/u', '', $text);
        if (strlen($text) > $max) {
            $cut = function_exists('mb_strcut') ? mb_strcut($text, 0, $max, 'UTF-8') : substr($text, 0, $max);
            $text = $cut . '...';
        }
        return $text;
    }

    /** Lowercase the way JavaScript's toLowerCase does for the names we compare. */
    public static function lower(string $text): string
    {
        if (function_exists('mb_strtolower') && self::isUtf8($text)) {
            return mb_strtolower($text, 'UTF-8');
        }
        return strtolower($text);
    }

    /** Lookalikes NFKC folds into ASCII, for hosts without ext-intl. */
    const NFKC_FALLBACK = array(
        "\u{017F}" => 's',
        "\u{2024}" => '.',
        "\u{FE52}" => '.',
        "\u{FB00}" => 'ff',
        "\u{FB01}" => 'fi',
        "\u{FB02}" => 'fl',
        "\u{FB03}" => 'ffi',
        "\u{FB04}" => 'ffl',
        "\u{FB05}" => 'st',
        "\u{FB06}" => 'st',
    );

    /**
     * Unicode NFKC, as String.prototype.normalize('NFKC'). Best effort without ext-intl: fullwidth
     * ASCII, the long s, one-dot leaders and the Latin ligatures are folded by hand, which covers
     * the lookalikes that matter for the deny list.
     */
    public static function nfkc(string $text): string
    {
        if (preg_match('/[\x80-\xff]/', $text) !== 1 || !self::isUtf8($text)) {
            return $text;
        }
        if (class_exists('Normalizer')) {
            $normal = \Normalizer::normalize($text, \Normalizer::FORM_KC);
            if (is_string($normal)) {
                return $normal;
            }
        }
        $text = (string) preg_replace_callback('/[\x{FF01}-\x{FF5E}]/u', function (array $match): string {
            $bytes = $match[0];
            $point = ((ord($bytes[0]) & 0x0F) << 12) | ((ord($bytes[1]) & 0x3F) << 6) | (ord($bytes[2]) & 0x3F);
            return chr($point - 0xFEE0);
        }, $text);
        return strtr($text, self::NFKC_FALLBACK);
    }

    /**
     * A name someone else chose (a device name, a label), made safe to show anywhere: no control
     * characters (C1 includes terminal escapes), no bidi overrides or zero-width characters that
     * could make it read as something else, single spaces, at most $max characters.
     */
    public static function displaySafe(string $text, int $max = 100): string
    {
        if (!self::isUtf8($text)) {
            $text = (string) preg_replace('/[\x80-\xff]/', '?', $text);
        }
        $text = (string) preg_replace('/[\x{0000}-\x{001F}\x{007F}-\x{009F}\x{061C}\x{200B}-\x{200F}\x{202A}-\x{202E}\x{2060}-\x{2069}\x{FEFF}]/u', '', $text);
        $text = (string) preg_replace('/\s+/u', ' ', $text);
        $text = trim($text);
        if (self::codePoints($text) > $max) {
            preg_match('/^.{0,' . $max . '}/su', $text, $match);
            $text = rtrim($match[0]);
        }
        return $text;
    }
}
