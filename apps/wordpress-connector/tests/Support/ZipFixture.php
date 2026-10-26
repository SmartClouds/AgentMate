<?php
/**
 * Builds plugin zips the way scripts/wordpress-connector.mjs does (a top folder entry, then the
 * files), for tests of an update the site downloads. ZipArchive is not needed.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Tests\Support;

final class ZipFixture
{
    /**
     * @param array<string, string> $files by path under $root
     * @param int $method 8 deflates, 0 stores
     * @param int $flags general purpose flags for every file (bit 0 is encryption)
     */
    public static function build(array $files, string $root = 'runova-connector/', int $method = 8, int $flags = 0x0800): string
    {
        $entries = array($root => null) + array_combine(
            array_map(function ($path) use ($root) {
                return $root . $path;
            }, array_keys($files)),
            array_values($files)
        );
        $locals = '';
        $centrals = '';
        foreach ($entries as $name => $data) {
            $name = (string) $name;
            $bytes = $data === null ? '' : $data;
            $useMethod = $data === null ? 0 : $method;
            $packed = $useMethod === 8 ? (string) gzdeflate($bytes) : $bytes;
            $crc = crc32($bytes);
            $entryFlags = $data === null ? 0x0800 : $flags;
            $offset = strlen($locals);
            $locals .= pack('VvvvvvVVVvv', 0x04034b50, 20, $entryFlags, $useMethod, 0, 33, $crc, strlen($packed), strlen($bytes), strlen($name), 0) . $name . $packed;
            $centrals .= pack('VvvvvvvVVVvvvvvVV', 0x02014b50, 0x0314, 20, $entryFlags, $useMethod, 0, 33, $crc, strlen($packed), strlen($bytes), strlen($name), 0, 0, 0, 0, 0, $offset) . $name;
        }
        $count = count($entries);
        return $locals . $centrals . pack('VvvvvVVv', 0x06054b50, 0, 0, $count, $count, strlen($centrals), strlen($locals), 0);
    }
}
