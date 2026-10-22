<?php
/**
 * Reads the files out of a plugin zip in memory, without ZipArchive (many hosts lack it). Only
 * what the release zip uses is understood: stored or deflated entries, no encryption, no zip64.
 * Every offset is checked against the bytes, so a damaged or hostile zip ends in null, never in a
 * read past the end. The caller still checks each file against the hash it expects.
 *
 * @package AgentMate\Connector
 */

namespace AgentMate\Connector\Update;

final class ZipReader
{
    const END = "PK\x05\x06";
    const CENTRAL = "PK\x01\x02";
    const LOCAL = "PK\x03\x04";

    /**
     * The files under $root (`agentmate-connector/`), by their path below it. Folders are left
     * out. Null when the bytes are not a zip this reader takes, a file sits outside $root, or the
     * limits are passed.
     *
     * @return array<string, string>|null
     */
    public static function read(string $zip, string $root, int $maxFiles, int $maxFileBytes, int $maxTotalBytes): ?array
    {
        $end = self::findEnd($zip);
        if ($end === null) {
            return null;
        }
        $header = unpack('vdisk/vcdDisk/vhere/ventries/Vsize/Voffset', substr($zip, $end + 4, 16));
        if (!is_array($header) || $header['disk'] !== 0 || $header['cdDisk'] !== 0 || $header['here'] !== $header['entries']) {
            return null;
        }
        $count = $header['entries'];
        $at = $header['offset'];
        if ($count === 0xFFFF || $at === 0xFFFFFFFF || $at + $header['size'] > $end) {
            return null;
        }

        $files = array();
        $total = 0;
        for ($index = 0; $index < $count; $index++) {
            if ($at + 46 > $end || substr($zip, $at, 4) !== self::CENTRAL) {
                return null;
            }
            $entry = unpack('vflags/vmethod', substr($zip, $at + 8, 4));
            $sizes = unpack('Vpacked/Vsize/vname/vextra/vcomment', substr($zip, $at + 20, 14));
            $local = unpack('Voffset', substr($zip, $at + 42, 4));
            if (!is_array($entry) || !is_array($sizes) || !is_array($local)) {
                return null;
            }
            $name = substr($zip, $at + 46, $sizes['name']);
            $at += 46 + $sizes['name'] + $sizes['extra'] + $sizes['comment'];
            if (strlen($name) !== $sizes['name'] || $at > $end) {
                return null;
            }
            if (substr($name, -1) === '/') {
                continue;
            }
            if (strncmp($name, $root, strlen($root)) !== 0 || strlen($name) === strlen($root)) {
                return null;
            }
            // Bit 0 is encryption. Sizes in the central directory are the ones trusted.
            if (($entry['flags'] & 1) !== 0 || count($files) >= $maxFiles || $sizes['size'] > $maxFileBytes) {
                return null;
            }
            $total += $sizes['size'];
            if ($total > $maxTotalBytes) {
                return null;
            }
            $bytes = self::data($zip, $local['offset'], $sizes['packed'], $sizes['size'], $entry['method']);
            $path = substr($name, strlen($root));
            if ($bytes === null || isset($files[$path])) {
                return null;
            }
            $files[$path] = $bytes;
        }
        return $files;
    }

    /** Where the end-of-central-directory record starts, or null. It sits in the last 64 KiB. */
    private static function findEnd(string $zip): ?int
    {
        $length = strlen($zip);
        if ($length < 22) {
            return null;
        }
        $from = max(0, $length - 22 - 0xFFFF);
        $at = strrpos(substr($zip, $from), self::END);
        if ($at === false || $from + $at + 22 > $length) {
            return null;
        }
        return $from + $at;
    }

    private static function data(string $zip, int $offset, int $packed, int $size, int $method): ?string
    {
        if ($offset + 30 > strlen($zip) || substr($zip, $offset, 4) !== self::LOCAL) {
            return null;
        }
        $lengths = unpack('vname/vextra', substr($zip, $offset + 26, 4));
        if (!is_array($lengths)) {
            return null;
        }
        $start = $offset + 30 + $lengths['name'] + $lengths['extra'];
        if ($start + $packed > strlen($zip)) {
            return null;
        }
        $raw = (string) substr($zip, $start, $packed);
        if ($method === 0) {
            $bytes = $raw;
        } elseif ($method === 8) {
            if ($size === 0) {
                $bytes = '';
            } else {
                // The limit stops a forged size from inflating into more than the entry claims.
                $bytes = @gzinflate($raw, $size); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
            }
        } else {
            return null;
        }
        return is_string($bytes) && strlen($bytes) === $size ? $bytes : null;
    }
}
